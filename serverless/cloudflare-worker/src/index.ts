import {
  buildDiscoveryDocument,
  CORS_HEADERS,
  DISCOVERY_PATH,
  jsonResponse,
  type DiscoveryEnv,
} from "./discovery.js";

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function logRequest(pathname: string, method: string, status: number, configured: boolean, startMs: number): void {
  console.log(
    JSON.stringify({
      event: "nuvio_discovery_request",
      method,
      pathname,
      status,
      configured,
      duration_ms: Math.max(0, Date.now() - startMs),
    }),
  );
}

function handleDiscovery(request: Request, validation: ReturnType<typeof buildDiscoveryDocument>): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(
      { error: "method_not_allowed", message: "Use GET or HEAD for discovery." },
      405,
      request.method,
      { allow: "GET, HEAD, OPTIONS" },
    );
  }

  if (!validation.ok) {
    return jsonResponse(
      {
        error: "discovery_not_configured",
        message: "Configure SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in your Worker variables.",
        issues: validation.issues,
      },
      503,
      request.method,
    );
  }

  return jsonResponse(validation.document, 200, request.method);
}

function handleHealth(request: Request, validation: ReturnType<typeof buildDiscoveryDocument>): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(
      { error: "method_not_allowed" },
      405,
      request.method,
      { allow: "GET, HEAD, OPTIONS" },
    );
  }

  if (!validation.ok) {
    return jsonResponse(
      {
        ok: false,
        service: "nuvio-serverless-discovery",
        configured: false,
        issues: validation.issues,
      },
      503,
      request.method,
    );
  }

  return jsonResponse(
    {
      ok: true,
      service: "nuvio-serverless-discovery",
      configured: true,
      backend_url: validation.document.backend_url,
      capabilities: validation.document.capabilities,
    },
    200,
    request.method,
  );
}

function handleRoot(request: Request, url: URL, validation: ReturnType<typeof buildDiscoveryDocument>): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(
      { error: "method_not_allowed" },
      405,
      request.method,
      { allow: "GET, HEAD, OPTIONS" },
    );
  }

  return jsonResponse(
    {
      service: "nuvio-serverless-discovery",
      configured: validation.ok,
      discovery_url: `${url.origin}${DISCOVERY_PATH}`,
      health_url: `${url.origin}/health`,
    },
    200,
    request.method,
  );
}

const worker: ExportedHandler<DiscoveryEnv> = {
  async fetch(request: Request, env: DiscoveryEnv): Promise<Response> {
    const startMs = Date.now();
    const url = new URL(request.url);
    const pathname = normalizePathname(url.pathname);
    const validation = buildDiscoveryDocument(env);

    let response: Response;
    if (request.method === "OPTIONS") {
      response = new Response(null, { status: 204, headers: CORS_HEADERS });
    } else if (pathname === DISCOVERY_PATH) {
      response = handleDiscovery(request, validation);
    } else if (pathname === "/health" || pathname === "/healthz") {
      response = handleHealth(request, validation);
    } else if (pathname === "/") {
      response = handleRoot(request, url, validation);
    } else {
      response = jsonResponse({ error: "not_found" }, 404, request.method);
    }

    logRequest(pathname, request.method, response.status, validation.ok, startMs);
    return response;
  },
};

export default worker;
