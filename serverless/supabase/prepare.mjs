#!/usr/bin/env node
/**
 * Generates or verifies the `supabase/` Cloud deployment directory from upstream
 * `database/migrations/` and `volumes/functions/` without mutating upstream files.
 *
 * Usage:
 *   node serverless/supabase/prepare.mjs         # write supabase/ files
 *   node serverless/supabase/prepare.mjs --check # fail if supabase/ has drifted
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const EDGE_FUNCTION_SLUGS = [
  "delete-account",
  "health-check",
  "tracker-tv-logins-exchange",
  "tv-logins-exchange",
];

const TEXT_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".json", ".toml", ".sql", ".md", ".txt", ".env"]);

function normalizeLf(text) {
  return text.replace(/\r\n/g, "\n");
}

/** Builds a cloud-compatible `CREATE OR REPLACE FUNCTION public.sync_restore_account_backup` from baseline SQL. */
function buildCloudSafeSyncRestoreAccountBackup(baselineSql) {
  const fnMatch = baselineSql.match(
    /CREATE FUNCTION public\.sync_restore_account_backup\(p_backup jsonb, p_mode text DEFAULT 'replace'::text\) RETURNS jsonb\n[\s\S]*?\nEND;\n\$_\$;/,
  );
  if (!fnMatch) {
    throw new Error("Could not locate sync_restore_account_backup definition in baseline migration");
  }

  let fnSql = fnMatch[0];
  fnSql = fnSql.replace(
    "CREATE FUNCTION public.sync_restore_account_backup(p_backup jsonb, p_mode text DEFAULT 'replace'::text) RETURNS jsonb",
    "CREATE OR REPLACE FUNCTION public.sync_restore_account_backup(p_backup jsonb, p_mode text DEFAULT 'replace'::text) RETURNS jsonb",
  );
  fnSql = fnSql.replace(
    "    SET search_path TO 'public'",
    "    SET search_path = pg_catalog, public, auth, extensions, pg_temp",
  );
  fnSql = fnSql.replace(
    "    v_counts jsonb;\nBEGIN",
    "    v_counts jsonb;\n    v_prev_skip_defaults text;\nBEGIN\n    v_prev_skip_defaults := COALESCE(pg_catalog.current_setting('nuvio.skip_profile_defaults', true), '');\n    PERFORM pg_catalog.set_config('nuvio.skip_profile_defaults', 'on', true);",
  );
  fnSql = fnSql.replace(
    "    RETURN jsonb_build_object(",
    "    PERFORM pg_catalog.set_config('nuvio.skip_profile_defaults', v_prev_skip_defaults, true);\n\n    RETURN jsonb_build_object(",
  );

  if (
    !fnSql.includes("PERFORM pg_catalog.set_config('nuvio.skip_profile_defaults', 'on', true);") ||
    !fnSql.includes("PERFORM pg_catalog.set_config('nuvio.skip_profile_defaults', v_prev_skip_defaults, true);")
  ) {
    throw new Error("Failed to inject dynamic skip_profile_defaults guard into sync_restore_account_backup");
  }

  return fnSql;
}

/** Transforms upstream self-hosted migration SQL to run safely as Supabase Cloud `postgres`. */
export function sanitizeMigrationSql(rawSql, fileName, context = {}) {
  let sql = normalizeLf(rawSql);

  // Managed Supabase Cloud instances do not allow non-superuser `postgres` to create `supabase_monitor`.
  sql = sql.replace(
    /DO \$\$\r?\nBEGIN\r?\n\s+IF NOT EXISTS \(\r?\n\s+SELECT 1\r?\n\s+FROM pg_catalog\.pg_roles\r?\n\s+WHERE rolname = 'supabase_monitor'\r?\n\s+\) THEN\r?\n\s+CREATE ROLE supabase_monitor NOLOGIN;\r?\n\s+END IF;\r?\nEND;\r?\n\$\$;\n?/g,
    "",
  );

  // `transaction_timeout` was added in PostgreSQL 17; drop it for compatibility across PG 15+.
  sql = sql.replace(/^SET transaction_timeout = 0;\n?/gm, "");

  // Scope empty search_path to the migration transaction so Supabase CLI migration tracking stays intact.
  sql = sql.replace(
    /SELECT pg_catalog\.set_config\('search_path', '', false\);/g,
    "SELECT pg_catalog.set_config('search_path', '', true);",
  );

  // Strip self-hosted monitoring grants and `supabase_admin` default privileges.
  sql = sql.replace(/^[ \t]*GRANT\s+[^\n;]*\s+TO\s+supabase_monitor;\n?/gm, "");
  sql = sql.replace(
    /^[ \t]*ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin\b[^\n;]*;\n?/gm,
    "",
  );
  // Omit explicit `FOR ROLE postgres` so default privileges bind cleanly to whichever owner role runs migrations.
  sql = sql.replace(
    /^([ \t]*)ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public\b/gm,
    "$1ALTER DEFAULT PRIVILEGES IN SCHEMA public",
  );

  // Non-superuser roles on Postgres 15+ cannot attach custom GUCs via `ALTER FUNCTION ... SET nuvio.*`.
  // Replace with dynamic transaction-local `set_config` inside `sync_restore_account_backup`.
  if (fileName === "00000000000007_clean_account_restore.sql") {
    const alterPattern = /ALTER FUNCTION public\.sync_restore_account_backup\(jsonb, text\)\s+SET nuvio\.skip_profile_defaults = 'on';/;
    if (!alterPattern.test(sql)) {
      throw new Error("Expected ALTER FUNCTION sync_restore_account_backup statement missing in 07_clean_account_restore.sql");
    }
    const replacementFn = buildCloudSafeSyncRestoreAccountBackup(context.baselineSql || "");
    sql = sql.replace(alterPattern, replacementFn);
  }

  // Collapse excess blank lines left by removed blocks while preserving single trailing newline.
  sql = sql.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  const banner = `-- Generated by serverless/supabase/prepare.mjs from database/migrations/${fileName}. Do not edit directly.\n\n`;
  return banner + sql;
}

export function buildConfigToml() {
  const lines = [
    "# Generated by serverless/supabase/prepare.mjs. Do not edit directly.",
    'project_id = "nuvio-self-host"',
    "",
    "[storage.buckets.avatars]",
    "public = true",
    'file_size_limit = "5MiB"',
    'allowed_mime_types = ["image/png", "image/jpeg", "image/webp"]',
    "",
    "[storage.buckets.covers]",
    "public = true",
    'file_size_limit = "5MiB"',
    "",
  ];

  for (const slug of EDGE_FUNCTION_SLUGS) {
    lines.push(`[functions.${slug}]`, "verify_jwt = false", "");
  }

  return lines.join("\n");
}

function collectFilesRecursive(dirPath, basePrefix = "") {
  const files = new Map();
  if (!fs.existsSync(dirPath)) return files;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absPath = path.join(dirPath, entry.name);
    const relPath = basePrefix ? `${basePrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of collectFilesRecursive(absPath, relPath)) {
        files.set(k, v);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (TEXT_EXTENSIONS.has(ext)) {
        files.set(relPath, Buffer.from(normalizeLf(fs.readFileSync(absPath, "utf8")), "utf8"));
      } else {
        files.set(relPath, fs.readFileSync(absPath));
      }
    }
  }
  return files;
}

export function buildExpectedSupabaseTree(rootDir = repoRoot) {
  const expected = new Map();
  expected.set("config.toml", Buffer.from(buildConfigToml(), "utf8"));

  const migrationsDir = path.join(rootDir, "database", "migrations");
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const baselineSql = normalizeLf(
    fs.readFileSync(path.join(migrationsDir, "00000000000000_baseline.sql"), "utf8"),
  );

  for (const fileName of migrationFiles) {
    const rawSql = fs.readFileSync(path.join(migrationsDir, fileName), "utf8");
    const sanitized = sanitizeMigrationSql(rawSql, fileName, { baselineSql });
    expected.set(`migrations/${fileName}`, Buffer.from(sanitized, "utf8"));
  }

  for (const slug of EDGE_FUNCTION_SLUGS) {
    const fnDir = path.join(rootDir, "volumes", "functions", slug);
    if (!fs.existsSync(fnDir)) {
      throw new Error(`Expected edge function directory missing: ${fnDir}`);
    }
    const fnFiles = collectFilesRecursive(fnDir, `functions/${slug}`);
    for (const [relPath, content] of fnFiles) {
      expected.set(relPath, content);
    }
  }

  return expected;
}

function collectActualSupabaseTree(supabaseDir) {
  const actual = new Map();
  if (!fs.existsSync(supabaseDir)) return actual;

  const walk = (dirPath, prefix = "") => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relPath === ".temp" || relPath === ".branches" || relPath.startsWith(".temp/") || relPath.startsWith(".branches/")) {
        continue;
      }
      const absPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (TEXT_EXTENSIONS.has(ext)) {
          actual.set(relPath, Buffer.from(normalizeLf(fs.readFileSync(absPath, "utf8")), "utf8"));
        } else {
          actual.set(relPath, fs.readFileSync(absPath));
        }
      }
    }
  };

  walk(supabaseDir);
  return actual;
}

function writeSupabaseTree(supabaseDir, expected) {
  for (const managedDir of ["migrations", "functions"]) {
    const target = path.join(supabaseDir, managedDir);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  for (const [relPath, buf] of expected) {
    const outPath = path.join(supabaseDir, relPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
  }
  console.log(`Generated ${expected.size} files in ${path.relative(repoRoot, supabaseDir) || "supabase"}/`);
}

function checkSupabaseTree(supabaseDir, expected) {
  const actual = collectActualSupabaseTree(supabaseDir);
  const errors = [];

  for (const [relPath, expectedBuf] of expected) {
    const actualBuf = actual.get(relPath);
    if (!actualBuf) {
      errors.push(`Missing file: supabase/${relPath}`);
    } else if (!actualBuf.equals(expectedBuf)) {
      errors.push(`Drifted file: supabase/${relPath}`);
    }
  }

  for (const relPath of actual.keys()) {
    if (!expected.has(relPath)) {
      errors.push(`Unexpected file: supabase/${relPath}`);
    }
  }

  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`ERROR: ${err}`);
    }
    console.error("Run `node serverless/supabase/prepare.mjs` to regenerate supabase/.");
    process.exit(1);
  }

  console.log(`OK  supabase/ is in sync (${expected.size} files verified)`);
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const supabaseDir = path.join(repoRoot, "supabase");
const expected = buildExpectedSupabaseTree(repoRoot);

if (checkOnly) {
  checkSupabaseTree(supabaseDir, expected);
} else {
  writeSupabaseTree(supabaseDir, expected);
}
