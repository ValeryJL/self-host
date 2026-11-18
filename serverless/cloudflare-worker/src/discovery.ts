const OFFICIAL_NUVIO_HOST = "api.nuvio.tv";
const DISCOVERY_PATH = "/.well-known/nuvio";

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type, accept",
  "access-control-max-age": "86400",
};

export interface DiscoveryEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  TV_LOGIN_ENABLED?: string;
  WATCH_PARTY_ENABLED?: string;
}

export interface DiscoveryCapabilities {
  email_password_auth: true;
  tv_login: boolean;
  watch_party?: boolean;
}

export interface DiscoveryDocument {
  version: 1;
  service: "nuvio";
  self_hosted: true;
  backend_url: string;
  publishable_key: string;
  capabilities: DiscoveryCapabilities;
}

export type ValidationResult =
  | { ok: true; document: DiscoveryDocument }
  | { ok: false; issues: string[] };

/** Parses boolean-like string configuration values with an explicit fallback default. */
export function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== "string") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return defaultValue;
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return defaultValue;
}

/** Validates and canonicalizes a backend URL to match Nuvio client discovery checks. */
export function normalizeBackendUrl(rawValue: string | undefined): { url?: string; error?: string } {
  const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!trimmed) {
    return { error: "SUPABASE_URL is not configured." };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "SUPABASE_URL must be a valid http(s) URL." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { error: "SUPABASE_URL must use http or https." };
  }
  if (!parsed.hostname) {
    return { error: "SUPABASE_URL must include a hostname." };
  }
  if (parsed.username || parsed.password) {
    return { error: "SUPABASE_URL must not embed credentials." };
  }
  if (parsed.search || parsed.hash) {
    return { error: "SUPABASE_URL must not include query parameters or fragments." };
  }
  if (parsed.hostname.toLowerCase() === OFFICIAL_NUVIO_HOST) {
    return { error: "SUPABASE_URL must point to your own backend, not api.nuvio.tv." };
  }

  return { url: trimmed.replace(/\/+$/, "") };
}

/** Validates the public Supabase client key and blocks accidental secret-key exposure. */
export function normalizePublishableKey(rawValue: string | undefined): { key?: string; error?: string } {
  const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!trimmed) {
    return { error: "SUPABASE_PUBLISHABLE_KEY is not configured." };
  }
  if (trimmed.startsWith("sb_secret_")) {
    return { error: "SUPABASE_PUBLISHABLE_KEY must not contain a Supabase secret key." };
  }
  return { key: trimmed };
}

/** Evaluates environment bindings into a valid Nuvio discovery payload or actionable errors. */
export function buildDiscoveryDocument(env: DiscoveryEnv): ValidationResult {
  const urlResult = normalizeBackendUrl(env.SUPABASE_URL);
  const keyResult = normalizePublishableKey(env.SUPABASE_PUBLISHABLE_KEY);

  const issues: string[] = [];
  if (urlResult.error) issues.push(urlResult.error);
  if (keyResult.error) issues.push(keyResult.error);

  if (issues.length > 0 || !urlResult.url || !keyResult.key) {
    return { ok: false, issues };
  }

  const capabilities: DiscoveryCapabilities = {
    email_password_auth: true,
    tv_login: parseBooleanFlag(env.TV_LOGIN_ENABLED, true),
  };

  // Match upstream Kong discovery payload unless Watch Party is explicitly enabled.
  if (parseBooleanFlag(env.WATCH_PARTY_ENABLED, false)) {
    capabilities.watch_party = true;
  }

  return {
    ok: true,
    document: {
      version: 1,
      service: "nuvio",
      self_hosted: true,
      backend_url: urlResult.url,
      publishable_key: keyResult.key,
      capabilities,
    },
  };
}

/** Creates a CORS-enabled JSON response (suppressing body bytes for HEAD requests). */
export function jsonResponse(
  body: unknown,
  status: number,
  method: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...CORS_HEADERS,
    ...extraHeaders,
  });

  if (method.toUpperCase() === "HEAD") {
    return new Response(null, { status, headers });
  }

  return new Response(JSON.stringify(body), { status, headers });
}

export { DISCOVERY_PATH };
