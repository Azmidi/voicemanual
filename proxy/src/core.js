// The heart of the proxy. It uses only web-standard Request and Response, so the
// exact same code runs on Cloudflare Workers (worker.js) and on a normal Node.js
// server (server.js). Hosting-specific code lives only in those two small files.
//
//   POST /api/ask      { question, manual, history?, name? }  ->  { answer, sectionId, model }
//   GET  /api/health   quick check that the server is set up (shows no secrets)
import { ProxyError } from "./errors.js";
import { buildPrompt, parseReply } from "./prompt.js";
import { createRateLimiter } from "./rate-limit.js";
import { getProvider } from "./providers/index.js";

const LIMITS = { question: 1000, historyTurns: 6, historyText: 2000, name: 40 };

function settings(env) {
  const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
  return {
    allowedOrigins: String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
    perMinute: num(env.RATE_LIMIT_PER_MINUTE, 30),
    perDay: num(env.RATE_LIMIT_PER_DAY, 1000),
    maxBodyBytes: num(env.MAX_BODY_BYTES, 2_000_000),
  };
}

// Which websites may call the proxy. Empty list = only pages on this same server.
function originAllowed(origin, requestUrl, allowed) {
  if (allowed.includes("*")) return true;
  if (!origin) return false;
  if (origin === new URL(requestUrl).origin) return true;
  return allowed.includes(origin);
}

function corsHeaders(origin, cfg) {
  const h = { Vary: "Origin" };
  if (origin && (cfg.allowedOrigins.includes("*") || cfg.allowedOrigins.includes(origin))) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

async function readBody(request, maxBytes) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new ProxyError("too_large", "The request is too big.", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new ProxyError("too_large", "The request is too big.", 413);
  try { return JSON.parse(text); } catch (_) { throw new ProxyError("bad_request", "The request is not valid JSON.", 400); }
}

function validate(body) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const question = str(body?.question);
  const manual = str(body?.manual);
  if (!question) throw new ProxyError("bad_request", "Missing question.", 400);
  if (question.length > LIMITS.question) throw new ProxyError("bad_request", "The question is too long.", 400);
  if (!manual) throw new ProxyError("bad_request", "Missing manual text.", 400);
  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-LIMITS.historyTurns)
    .filter((t) => t && typeof t.q === "string" && typeof t.a === "string")
    .map((t) => ({ q: t.q.slice(0, LIMITS.historyText), a: t.a.slice(0, LIMITS.historyText) }));
  const name = (str(body.name) || "Manuel").slice(0, LIMITS.name).replace(/[^\p{L}\p{N} ._-]/gu, "");
  return { question, manual, history, name };
}

export function createHandler() {
  const rateLimit = createRateLimiter();

  return async function handle(request, env = {}, { clientIp = "unknown" } = {}) {
    const cfg = settings(env);
    const url = new URL(request.url);
    const origin = (request.headers.get("origin") || "").replace(/\/+$/, "");
    const cors = corsHeaders(origin, cfg);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        const provider = getProvider(env);
        return json({ ok: true, provider: provider?.name || null, configured: !!provider?.isConfigured(env) }, 200, cors);
      }
      if (url.pathname !== "/api/ask") throw new ProxyError("not_found", "Not found.", 404);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: originAllowed(origin, request.url, cfg.allowedOrigins) ? 204 : 403, headers: cors });
      }
      if (request.method !== "POST") throw new ProxyError("bad_request", "Use POST.", 405);
      if (!originAllowed(origin, request.url, cfg.allowedOrigins)) {
        throw new ProxyError("forbidden", "This website is not allowed to use the assistant server.", 403);
      }

      const provider = getProvider(env);
      if (!provider || !provider.isConfigured(env)) {
        throw new ProxyError("not_configured", "The assistant server has no AI key set up yet.", 500);
      }

      const limit = rateLimit(clientIp, cfg);
      if (!limit.ok) {
        throw new ProxyError("rate_limited", "Too many questions from this network. Please wait a moment.", 429, { retryAfter: limit.retryAfter });
      }

      const input = validate(await readBody(request, cfg.maxBodyBytes));
      const { text, model } = await provider.answer(buildPrompt(input), env);
      const reply = parseReply(text);
      if (!reply.answer) throw new ProxyError("upstream", "The AI sent an empty answer.", 502);
      return json({ ...reply, model }, 200, cors);
    } catch (err) {
      const e = err instanceof ProxyError ? err : new ProxyError("upstream", "Unexpected server error.", 500);
      if (!(err instanceof ProxyError)) console.error("[proxy] Unexpected error:", err);
      const headers = { ...cors };
      if (e.retryAfter) headers["Retry-After"] = String(e.retryAfter);
      return json({ error: { code: e.code, message: e.message } }, e.status, headers);
    }
  };
}
