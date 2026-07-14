const expectedSecretSha256 = "00c97fea3b0673699c2824585b3bbcc0d9c70dd5d4ff36e388e394e2dbadc986";

const allowedTables = new Set([
  "agent_cursors",
  "conflicts",
  "documents",
  "events",
  "proposals",
  "turn_summaries",
]);

const allowedRpcs = new Set([
  "approve_document_proposal",
  "create_document_proposal",
  "delete_canonical_document",
  "record_agent_turn",
  "reject_document_proposal",
  "rename_canonical_document",
  "search_canonical_documents",
  "upsert_canonical_document",
  "upsert_canonical_documents_batch",
]);

const forwardedRequestHeaders = new Set([
  "accept",
  "accept-profile",
  "content-profile",
  "content-type",
  "prefer",
  "range",
  "range-unit",
]);

const forwardedResponseHeaders = new Set([
  "content-type",
  "content-range",
  "preference-applied",
  "location",
]);

function json(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function allowedPath(path: string, method: string): boolean {
  const url = new URL(path, "https://proxy.invalid");
  if (url.origin !== "https://proxy.invalid" || !url.pathname.startsWith("/rest/v1/")) return false;
  const parts = url.pathname.slice("/rest/v1/".length).split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "rpc") return method === "POST" && parts.length === 2 && allowedRpcs.has(parts[1]);
  return parts.length === 1 && allowedTables.has(parts[0]) && ["GET", "HEAD", "POST", "PATCH", "DELETE"].includes(method);
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json(405, "method not allowed");
  if (Number(request.headers.get("content-length") ?? 0) > 3_000_000) return json(413, "request too large");

  const suppliedSecret = request.headers.get("x-cubus-proxy-secret") ?? "";
  if (suppliedSecret.length < 32 || await sha256Hex(suppliedSecret) !== expectedSecretSha256) {
    return json(401, "unauthorized");
  }

  try {
    const payload = await request.json() as {
      path?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    const method = payload.method?.toUpperCase() ?? "";
    if (!payload.path || !allowedPath(payload.path, method)) return json(403, "target not allowed");
    if ((payload.body?.length ?? 0) > 2_800_000) return json(413, "body too large");

    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
    const serviceKey = secretKeys.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!serviceKey || !supabaseUrl) return json(500, "backend credentials unavailable");

    const headers = new Headers();
    headers.set("apikey", serviceKey);
    if (!serviceKey.startsWith("sb_secret_")) headers.set("authorization", `Bearer ${serviceKey}`);
    for (const [name, value] of Object.entries(payload.headers ?? {})) {
      if (forwardedRequestHeaders.has(name.toLowerCase())) headers.set(name, value);
    }

    const upstream = await fetch(`${supabaseUrl}${payload.path}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : payload.body,
    });
    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
      if (forwardedResponseHeaders.has(name.toLowerCase())) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return json(400, "invalid proxy request");
  }
});
