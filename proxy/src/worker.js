// Cloudflare Workers entry point. Settings and the key come from the Worker's
// variables and secrets (see wrangler.toml and DEPLOY.md).
import { createHandler } from "./core.js";

const handle = createHandler();

export default {
  fetch(request, env) {
    return handle(request, env, { clientIp: request.headers.get("cf-connecting-ip") || "unknown" });
  },
};
