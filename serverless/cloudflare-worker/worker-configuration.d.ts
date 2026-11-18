// Placeholder matching `npx wrangler types`; regenerated in CI via `npm run cf-typegen`.
interface Env {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  TV_LOGIN_ENABLED: string;
  WATCH_PARTY_ENABLED: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ExportedHandler<Env = unknown> {
  fetch?(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}
