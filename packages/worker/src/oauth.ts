import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
  ApprovalInputSchema,
  BatchUpsertInputSchema,
  ProposePatchInputSchema,
  ProposalStatusSchema,
  RecordTurnSummaryInputSchema,
  RejectionInputSchema,
  SearchInputSchema,
  SyncContextInputSchema,
  UpsertDocumentInputSchema,
} from "@cubus/shared";
import type { AppEnv, OAuthProps } from "./env.js";
import { bearerToken, sealState, secureEqual, securityHeaders, sha256Hex, unsealState } from "./security.js";
import { CollabService } from "./service.js";

type Bindings = AppEnv & { OAUTH_PROVIDER: OAuthHelpers };
export const app = new Hono<{ Bindings: Bindings }>();

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
}

function setCookie(name: string, value: string, maxAge = 600): string {
  return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function isAuthRequest(value: unknown): value is AuthRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  const resource = request.resource;
  return typeof request.responseType === "string"
    && typeof request.clientId === "string"
    && typeof request.redirectUri === "string"
    && Array.isArray(request.scope)
    && request.scope.every((scope) => typeof scope === "string")
    && typeof request.state === "string"
    && (request.codeChallenge === undefined || typeof request.codeChallenge === "string")
    && (request.codeChallengeMethod === undefined || typeof request.codeChallengeMethod === "string")
    && (resource === undefined || typeof resource === "string"
      || (Array.isArray(resource) && resource.every((entry) => typeof entry === "string")));
}

function renderConsent(client: ClientInfo | null, consentToken: string, csrf: string): Response {
  const clientName = escapeHtml(client?.clientName ?? "Unknown MCP client");
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CUBUS 연결 승인</title><style>body{font-family:system-ui;background:#f6f6f3;color:#20201e;margin:0}.card{max-width:560px;margin:8vh auto;background:white;border:1px solid #ddd;border-radius:16px;padding:32px;box-shadow:0 12px 40px #0001}button{padding:12px 18px;border:0;border-radius:10px;background:#181817;color:white;font-weight:700}code{background:#f1f1ed;padding:2px 5px;border-radius:4px}</style></head><body><main class="card"><h1>CUBUS 협업 허브 연결</h1><p><strong>${clientName}</strong>에서 CUBUS 정본 조회와 변경 제안 도구를 사용하려고 합니다.</p><p>AI 변경은 승인 전까지 정본에 반영되지 않습니다. 승인·거절 도구는 현재 대화에서 사용자가 명시적으로 지시한 경우에만 사용해야 합니다.</p><form method="post" action="/authorize"><input type="hidden" name="consent_token" value="${escapeHtml(consentToken)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button type="submit">GitHub로 본인 확인</button></form></main></body></html>`;
  return new Response(html, {
    headers: {
      ...securityHeaders(),
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": setCookie("__Host-CUBUS_CSRF", csrf),
    },
  });
}

app.get("/authorize", async (c) => {
  const oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthRequest.clientId) return c.text("Invalid OAuth request", 400);
  const consentToken = await sealState(oauthRequest, c.env.COOKIE_ENCRYPTION_KEY);
  const csrf = crypto.randomUUID();
  return renderConsent(await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId), consentToken, csrf);
});

app.post("/authorize", async (c) => {
  const form = await c.req.raw.formData();
  const consentToken = form.get("consent_token");
  const csrf = form.get("csrf_token");
  const csrfCookie = cookie(c.req.raw, "__Host-CUBUS_CSRF");
  if (typeof consentToken !== "string" || typeof csrf !== "string" || !csrfCookie || !(await secureEqual(csrf, csrfCookie))) {
    return c.text("Invalid or expired consent", 400);
  }
  const oauthRequest = await unsealState(consentToken, c.env.COOKIE_ENCRYPTION_KEY);
  if (!isAuthRequest(oauthRequest)) return c.text("Expired consent", 400);

  const state = await sealState(oauthRequest, c.env.COOKIE_ENCRYPTION_KEY);
  const stateHash = await sha256Hex(state);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", new URL("/callback", c.req.url).href);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.href,
      "Set-Cookie": setCookie("__Host-CUBUS_STATE", stateHash),
    },
  });
});

type GitHubTokenResponse = { access_token?: string; error?: string };
type GitHubUser = { login: string; name: string | null; email: string | null };

app.get("/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const boundState = cookie(c.req.raw, "__Host-CUBUS_STATE");
  if (!state || !code || !boundState || !(await secureEqual(await sha256Hex(state), boundState))) {
    return c.text("Invalid OAuth callback", 400);
  }
  const oauthRequest = await unsealState(state, c.env.COOKIE_ENCRYPTION_KEY);
  if (!isAuthRequest(oauthRequest)) return c.text("Expired OAuth callback", 400);

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/callback", c.req.url).href,
    }),
  });
  if (!tokenResponse.ok) return c.text("GitHub token exchange failed", 502);
  const token = await tokenResponse.json<GitHubTokenResponse>();
  if (!token.access_token) return c.text("GitHub token missing", 502);

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token.access_token}`,
      "User-Agent": "cubus-collab-hub",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!userResponse.ok) return c.text("GitHub identity lookup failed", 502);
  const user = await userResponse.json<GitHubUser>();
  if (user.login !== c.env.ALLOWED_GITHUB_LOGIN) return c.text("This GitHub account is not allowed", 403);

  const props: OAuthProps = { login: user.login, name: user.name ?? user.login, email: user.email };
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: user.login,
    metadata: { label: props.name },
    scope: oauthRequest.scope,
    props,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTo,
      "Set-Cookie": setCookie("__Host-CUBUS_STATE", "", 0),
    },
  });
});

async function allowed(request: Request, expected: string): Promise<boolean> {
  const token = bearerToken(request);
  return token.length > 0 && secureEqual(token, expected);
}

function bodyTooLarge(request: Request): boolean {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  return Number.isFinite(length) && length > 2_500_000;
}

app.get("/", (c) => c.json({
  name: "CUBUS Collaboration Hub",
  status: "ok",
  mcp: "/mcp",
  openapi: "https://github.com/tony816/cubus-collab-hub/blob/main/openapi/cubus-collab-actions.yaml",
}));

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/api/actions/*", async (c, next) => {
  if (!(await allowed(c.req.raw, c.env.ACTIONS_API_TOKEN))) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

app.use("/api/bridge/*", async (c, next) => {
  if (!(await allowed(c.req.raw, c.env.BRIDGE_API_TOKEN))) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

app.post("/api/actions/sync-context", async (c) => {
  const input = SyncContextInputSchema.parse(await c.req.json());
  return c.json(await new CollabService(c.env).syncContext(input));
});

app.get("/api/actions/documents", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);
  return c.json(await new CollabService(c.env).getDocument(path));
});

app.post("/api/actions/search", async (c) => {
  const input = SearchInputSchema.parse(await c.req.json());
  return c.json(await new CollabService(c.env).search(input.query, input.limit));
});

app.get("/api/actions/proposals", async (c) => {
  const rawStatus = c.req.query("status");
  const status = rawStatus ? ProposalStatusSchema.parse(rawStatus) : undefined;
  return c.json(await new CollabService(c.env).listProposals(status));
});

app.post("/api/actions/proposals", async (c) => {
  if (bodyTooLarge(c.req.raw)) return c.json({ error: "Payload too large" }, 413);
  const input = ProposePatchInputSchema.parse(await c.req.json());
  return c.json(await new CollabService(c.env).propose(input), 201);
});

app.post("/api/actions/turn-summaries", async (c) => {
  const input = RecordTurnSummaryInputSchema.parse(await c.req.json());
  return c.json(await new CollabService(c.env).recordTurn(input), 201);
});

app.post("/api/actions/proposals/:id/approve", async (c) => {
  const input = ApprovalInputSchema.parse({ ...(await c.req.json()), proposalId: c.req.param("id") });
  return c.json(await new CollabService(c.env).approve(input.proposalId, input.instruction));
});

app.post("/api/actions/proposals/:id/reject", async (c) => {
  const input = RejectionInputSchema.parse({ ...(await c.req.json()), proposalId: c.req.param("id") });
  return c.json(await new CollabService(c.env).reject(input.proposalId, input.instruction, input.reason));
});

app.post("/api/bridge/documents", async (c) => {
  if (bodyTooLarge(c.req.raw)) return c.json({ error: "Payload too large" }, 413);
  const input = UpsertDocumentInputSchema.parse(await c.req.json());
  return c.json(await new CollabService(c.env).upsertDocument(input));
});

app.post("/api/bridge/documents/batch", async (c) => {
  if (bodyTooLarge(c.req.raw)) return c.json({ error: "Payload too large" }, 413);
  const input = BatchUpsertInputSchema.parse(await c.req.json());
  return c.json({ results: await new CollabService(c.env).upsertDocuments(input.documents) });
});

app.post("/api/bridge/documents/rename", async (c) => {
  const input = await c.req.json<{ oldPath?: string; newPath?: string; expectedVersion?: number }>();
  if (!input.oldPath || !input.newPath || !Number.isInteger(input.expectedVersion)) {
    return c.json({ error: "oldPath, newPath and expectedVersion are required" }, 400);
  }
  return c.json(await new CollabService(c.env).renameDocument(input.oldPath, input.newPath, input.expectedVersion ?? 0));
});

app.delete("/api/bridge/documents", async (c) => {
  const path = c.req.query("path");
  const version = Number(c.req.query("expectedVersion"));
  if (!path || !Number.isInteger(version) || version <= 0) return c.json({ error: "path and expectedVersion are required" }, 400);
  return c.json(await new CollabService(c.env).deleteDocument(path, version));
});

app.get("/api/bridge/documents", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);
  return c.json(await new CollabService(c.env).getDocument(path));
});

app.get("/api/bridge/manifest", async (c) => c.json({ documents: await new CollabService(c.env).manifest() }));

app.get("/api/bridge/events", async (c) => {
  const after = Number(c.req.query("after") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) return c.json({ error: "after must be a non-negative integer" }, 400);
  return c.json({ events: await new CollabService(c.env).eventsAfter(after) });
});

app.get("/api/bridge/conflicts/:id", async (c) => c.json(await new CollabService(c.env).getConflict(c.req.param("id"))));

type WebhookRecord = {
  id?: string;
  kind?: string;
  entity_type?: string;
  metadata?: Record<string, unknown>;
};

app.post("/webhooks/supabase", async (c) => {
  const provided = c.req.header("X-CUBUS-Webhook-Secret") ?? "";
  if (!(await secureEqual(provided, c.env.WEBHOOK_SHARED_SECRET))) return c.json({ error: "Unauthorized" }, 401);
  const payload = await c.req.json<{ type?: string; table?: string; record?: WebhookRecord }>();
  if (payload.table !== "events" || !payload.record) return c.json({ accepted: false, reason: "ignored table" }, 202);
  const event = payload.record;
  const alertKinds = new Set(["proposal.created", "proposal.approved", "proposal.rejected", "conflict.created"]);
  if (!event.kind || !alertKinds.has(event.kind)) return c.json({ accepted: false, reason: "ignored event" }, 202);
  if (!c.env.DISCORD_WEBHOOK_URL) return c.json({ accepted: false, reason: "discord not configured" }, 202);

  const path = typeof event.metadata?.path === "string" ? event.metadata.path : "(unknown path)";
  const proposalId = typeof event.metadata?.proposalId === "string" ? event.metadata.proposalId : undefined;
  const safeMessage = [`CUBUS · ${event.kind}`, `문서: ${path}`, proposalId ? `제안: ${proposalId}` : ""].filter(Boolean).join("\n");
  c.executionCtx.waitUntil(fetch(c.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: safeMessage, allowed_mentions: { parse: [] } }),
  }).then((response) => {
    if (!response.ok) console.error(JSON.stringify({ message: "discord webhook failed", status: response.status }));
  }));
  return c.json({ accepted: true }, 202);
});

app.onError((error, c) => {
  console.error(JSON.stringify({
    message: "request failed",
    error: error.message,
    name: error.name,
    stack: error.stack?.slice(0, 800),
    path: c.req.path,
  }));
  const status = error.name === "ZodError" ? 400 : 500;
  return c.json({ error: status === 400 ? error.message : "Internal server error" }, status);
});
