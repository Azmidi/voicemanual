// Plain Node.js server (Node 18 or newer, no extra packages needed).
// Use this on a company server, a virtual machine, Azure App Service, AWS, or in Docker.
//
// It does two jobs:
//   1. Answers /api/ask and /api/health using the same code as the Cloudflare Worker.
//   2. Optionally serves the manual itself (set STATIC_DIR), so the manual and the
//      assistant live on one server and no cross-site settings are needed.
//
// Start it with:  node server.js      (settings are read from a .env file next to this one)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "./src/core.js";
import { getProvider } from "./src/providers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Read KEY=value lines from .env, without overwriting settings already in the environment.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(here, ".env"));

const env = process.env;
const port = Number(env.PORT || 8787);
const host = env.HOST || "0.0.0.0";
const trustProxy = /^(1|true|yes)$/i.test(env.TRUST_PROXY || "");
const maxBody = Number(env.MAX_BODY_BYTES || 2_000_000);
const staticDir = env.STATIC_DIR ? path.resolve(here, env.STATIC_DIR) : "";

const handle = createHandler();

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".pdf": "application/pdf", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

function clientIp(req) {
  if (trustProxy) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || "unknown";
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (_) { rel = ""; }
  let file = path.resolve(staticDir, "." + rel);
  const inside = file === staticDir || file.startsWith(staticDir + path.sep);
  // Never serve hidden files (like .env) or the proxy's own folder.
  const blocked = !inside || rel.split("/").some((p) => p.startsWith(".")) || file === here || file.startsWith(here + path.sep);
  if (blocked) { res.writeHead(404).end("Not found"); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (!url.pathname.startsWith("/api/")) {
    if (staticDir && (req.method === "GET" || req.method === "HEAD")) return serveStatic(req, res, url.pathname);
    res.writeHead(404).end("Not found");
    return;
  }

  // Collect the body (with a size cap), then hand a standard Request to the shared code.
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) {
      res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: "too_large", message: "The request is too big." } }));
      return;
    }
    chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const request = new Request(url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });

  try {
    const response = await handle(request, env, { clientIp: clientIp(req) });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error("[proxy] Server error:", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "upstream", message: "Unexpected server error." } }));
  }
});

server.listen(port, host, () => {
  console.log(`[proxy] Listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(`[proxy] AI provider: ${getProvider(env)?.name || `unknown (${env.AI_PROVIDER})`}${staticDir ? `, serving the manual from ${staticDir}` : ""}`);
});
