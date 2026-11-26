// Your company's internal AI gateway (one endpoint in front of several AI models).
//
// The address, header names and model names are company-internal, so none of them
// are written here: they all come from settings (see .env.example and DEPLOY.md).
//   GATEWAY_URL          full address of the gateway's chat endpoint
//   GATEWAY_API_KEY      the key
//   GATEWAY_KEY_HEADER   name of the header that carries the key
//   GATEWAY_MODEL        model id, or several separated by commas (tried in order)
//   GATEWAY_CLIENT_HEADER, GATEWAY_CLIENT_ID   optional app identifier header
//   GATEWAY_USER_ID      optional, the user that usage is booked to
//   GATEWAY_MAX_TOKENS   optional, longest answer (default 1024)
//   GATEWAY_TIMEOUT_MS   optional, default 45000
//
// Each question is sent on its own (no stored chat sessions on the gateway): the
// manual and the last few questions travel with it, the same as for Gemini.
import { ProxyError } from "../errors.js";

const REQUIRED = ["GATEWAY_URL", "GATEWAY_API_KEY", "GATEWAY_KEY_HEADER", "GATEWAY_MODEL"];

export function isConfigured(env) {
  return REQUIRED.every((k) => !!env[k]);
}

function models(env) {
  return String(env.GATEWAY_MODEL || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Everything goes into one prompt: the gateway ignores separate system
// instructions for some models, and the manual must never be dropped.
function promptText({ system, turns }) {
  const earlier = turns.slice(0, -1);
  const question = turns[turns.length - 1].text;
  let text = system;
  if (earlier.length) {
    text += "\n\nEARLIER IN THIS CONVERSATION:\n" +
      earlier.map((t) => `${t.role === "assistant" ? "Assistant" : "Technician"}: ${t.text}`).join("\n");
  }
  return `${text}\n\nTECHNICIAN'S QUESTION:\n${question}\n\nReply with the JSON object only.`;
}

async function callOnce(env, model, prompt) {
  const headers = { "Content-Type": "application/json", [env.GATEWAY_KEY_HEADER]: env.GATEWAY_API_KEY };
  if (env.GATEWAY_CLIENT_HEADER && env.GATEWAY_CLIENT_ID) headers[env.GATEWAY_CLIENT_HEADER] = env.GATEWAY_CLIENT_ID;
  const body = {
    model,
    prompt,
    modelConfig: { temperature: 0.2, max_tokens: Number(env.GATEWAY_MAX_TOKENS || 1024) },
  };
  if (env.GATEWAY_USER_ID) body.userId = env.GATEWAY_USER_ID;

  let res;
  try {
    res = await fetch(env.GATEWAY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(env.GATEWAY_TIMEOUT_MS || 45000)),
    });
  } catch (e) {
    const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
    throw Object.assign(new Error(timedOut ? "The company AI gateway took too long to answer." : `Could not reach the company AI gateway: ${e.message}`), { status: 0, kind: "network" });
  }
  const data = await res.json().catch(() => ({}));
  // The gateway reports problems either with an HTTP error or with status: false.
  if (!res.ok || data.status === false) {
    throw Object.assign(new Error(String(data.msg || data.error || res.statusText || `HTTP ${res.status}`)), { status: res.ok ? 400 : res.status });
  }
  const text = typeof data.msg === "string" ? data.msg : "";
  if (!text.trim()) throw Object.assign(new Error("The company AI gateway sent an empty answer."), { status: 0, kind: "empty" });
  return text;
}

// "This model isn't available, try the next one in the list."
function modelProblem(e) {
  return e.status === 404 || (e.status === 400 && /model/i.test(e.message)) || e.kind === "empty";
}

export async function answer(prompt, env) {
  const text = promptText(prompt);
  let lastError = null;
  for (const model of models(env)) {
    try {
      return { text: await callOnce(env, model, text), model };
    } catch (e) {
      lastError = e;
      console.warn(`[proxy] gateway model ${model} failed:`, e.status, e.message);
      if (!modelProblem(e)) break;
    }
  }
  throw toProxyError(lastError || new Error("No model configured"));
}

function toProxyError(e) {
  if (e.status === 401 || e.status === 403) {
    return new ProxyError("not_configured", "The company AI gateway refused the server's key. It may have expired or reached its monthly limit.", 502);
  }
  if (e.status === 429 || /quota|monthly|usage limit|cost limit|budget/i.test(e.message)) return new ProxyError("quota", "The company AI usage limit is used up for now.", 503);
  if ([500, 502, 503, 504].includes(e.status) || e.kind === "network") return new ProxyError("busy", "The company AI gateway is unavailable right now.", 503);
  return new ProxyError("upstream", `The company AI gateway had a problem: ${e.message}`, 502);
}
