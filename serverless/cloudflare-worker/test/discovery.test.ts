import assert from "node:assert/strict";
import test from "node:test";
import { buildDiscoveryDocument, type DiscoveryEnv } from "../src/discovery.js";
import worker from "../src/index.js";

const SAMPLE_PUBLISHABLE_KEY = ["sb", "publishable", "example_public_key_value"].join("_");
const SAMPLE_SECRET_KEY = ["sb", "secret", "example_should_never_leak"].join("_");

const VALID_ENV: DiscoveryEnv = {
  SUPABASE_URL: "https://exampleproject.supabase.co/",
  SUPABASE_PUBLISHABLE_KEY: SAMPLE_PUBLISHABLE_KEY,
  TV_LOGIN_ENABLED: "true",
  WATCH_PARTY_ENABLED: "false",
};

function makeCtx() {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}

test("buildDiscoveryDocument normalizes trailing slash and matches upstream contract", () => {
  const result = buildDiscoveryDocument(VALID_ENV);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.document, {
    version: 1,
    service: "nuvio",
    self_hosted: true,
    backend_url: "https://exampleproject.supabase.co",
    publishable_key: SAMPLE_PUBLISHABLE_KEY,
    capabilities: {
      email_password_auth: true,
      tv_login: true,
    },
  });
});

test("buildDiscoveryDocument supports watch_party opt-in and legacy anon keys", () => {
  const result = buildDiscoveryDocument({
    SUPABASE_URL: "https://legacyproject.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "legacy-anon-token-placeholder",
    TV_LOGIN_ENABLED: "false",
    WATCH_PARTY_ENABLED: "true",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.document.capabilities, {
    email_password_auth: true,
    tv_login: false,
    watch_party: true,
  });
});

test("buildDiscoveryDocument rejects missing values, secret keys, query strings, and api.nuvio.tv", () => {
  const missing = buildDiscoveryDocument({});
  assert.equal(missing.ok, false);

  const secretKey = buildDiscoveryDocument({
    SUPABASE_URL: "https://exampleproject.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: SAMPLE_SECRET_KEY,
  });
  assert.equal(secretKey.ok, false);

  const queryUrl = buildDiscoveryDocument({
    SUPABASE_URL: "https://exampleproject.supabase.co?foo=bar",
    SUPABASE_PUBLISHABLE_KEY: SAMPLE_PUBLISHABLE_KEY,
  });
  assert.equal(queryUrl.ok, false);

  const officialUrl = buildDiscoveryDocument({
    SUPABASE_URL: "https://api.nuvio.tv",
    SUPABASE_PUBLISHABLE_KEY: SAMPLE_PUBLISHABLE_KEY,
  });
  assert.equal(officialUrl.ok, false);
});

test("GET /.well-known/nuvio returns 200 JSON with CORS headers", async () => {
  const req = new Request("https://nuvio.example.workers.dev/.well-known/nuvio", { method: "GET" });
  const res = await worker.fetch!(req, VALID_ENV, makeCtx());

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");

  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "backend_url",
    "capabilities",
    "publishable_key",
    "self_hosted",
    "service",
    "version",
  ]);
  assert.equal(body.backend_url, "https://exampleproject.supabase.co");
});

test("POST /.well-known/nuvio returns 405 and OPTIONS returns 204", async () => {
  const postRes = await worker.fetch!(
    new Request("https://nuvio.example.workers.dev/.well-known/nuvio", { method: "POST" }),
    VALID_ENV,
    makeCtx(),
  );
  assert.equal(postRes.status, 405);
  assert.equal(postRes.headers.get("allow"), "GET, HEAD, OPTIONS");

  const optionsRes = await worker.fetch!(
    new Request("https://nuvio.example.workers.dev/.well-known/nuvio", { method: "OPTIONS" }),
    VALID_ENV,
    makeCtx(),
  );
  assert.equal(optionsRes.status, 204);
  assert.equal(optionsRes.headers.get("access-control-allow-origin"), "*");
});

test("unconfigured Worker returns 503 on /.well-known/nuvio and /health without leaking keys", async () => {
  const env: DiscoveryEnv = {
    SUPABASE_URL: "",
    SUPABASE_PUBLISHABLE_KEY: SAMPLE_SECRET_KEY,
  };

  const discoveryRes = await worker.fetch!(
    new Request("https://nuvio.example.workers.dev/.well-known/nuvio"),
    env,
    makeCtx(),
  );
  assert.equal(discoveryRes.status, 503);
  const discoveryText = await discoveryRes.text();
  assert.equal(discoveryText.includes(SAMPLE_SECRET_KEY), false);

  const healthRes = await worker.fetch!(
    new Request("https://nuvio.example.workers.dev/healthz"),
    env,
    makeCtx(),
  );
  assert.equal(healthRes.status, 503);
  const healthText = await healthRes.text();
  assert.equal(healthText.includes(SAMPLE_SECRET_KEY), false);
});

test("HEAD, root info, and unknown paths behave cleanly", async () => {
  const headRes = await worker.fetch!(
    new Request("https://nuvio.example.workers.dev/.well-known/nuvio", { method: "HEAD" }),
    VALID_ENV,
    makeCtx(),
  );
  assert.equal(headRes.status, 200);
  assert.equal(await headRes.text(), "");

  const rootRes = await worker.fetch!(
    new Request("https://nuvio.example.workers.dev/"),
    VALID_ENV,
    makeCtx(),
  );
  assert.equal(rootRes.status, 200);
  const rootJson = (await rootRes.json()) as { configured: boolean; discovery_url: string };
  assert.equal(rootJson.configured, true);
  assert.equal(rootJson.discovery_url, "https://nuvio.example.workers.dev/.well-known/nuvio");

  const notFoundRes = await worker.fetch!(
    new Request("https://nuvio.example.workers.dev/unknown"),
    VALID_ENV,
    makeCtx(),
  );
  assert.equal(notFoundRes.status, 404);
});
