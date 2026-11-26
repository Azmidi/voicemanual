// Google Gemini. The API key stays here on the server (GEMINI_API_KEY).
//
// Like manuel.js, this never relies on one fixed model name: it asks Google which
// models the key can use, picks the newest stable "Flash" model, and picks again
// if Google says a model is gone. Set GEMINI_MODEL to pin one model instead.
import { ProxyError } from "../errors.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const FALLBACK_MODEL = "gemini-flash-latest"; // Google's "always current" alias
const LIST_CACHE_MS = 6 * 60 * 60 * 1000;      // ask Google for the model list every 6 hours
const BAD_MODEL_MS = 24 * 60 * 60 * 1000;      // skip a model that failed for a day

// Shared by all requests handled by this server instance.
const cache = { names: null, at: 0, current: "", bad: new Map() };

export function _resetForTests() {
  cache.names = null; cache.at = 0; cache.current = ""; cache.bad.clear();
}

export function isConfigured(env) {
  return !!env.GEMINI_API_KEY;
}

function versionOf(name) {
  const m = name.match(/gemini-(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// Pick the newest model, preferring stable "Flash" (fast and cheap).
export function pickBestModel(names) {
  const unwanted = /(image|tts|audio|live|embedding|vision|thinking|computer|robotics|learnlm|exp)/;
  const usable = names.filter((n) => !unwanted.test(n));
  const tiers = [
    (n) => /^gemini-[\d.]+-flash$/.test(n),
    (n) => /^gemini-[\d.]+-flash-\d{3}$/.test(n),
    (n) => /^gemini-[\d.]+-flash/.test(n) && !/lite/.test(n),
    (n) => /flash/.test(n),
    () => true,
  ];
  for (const tier of tiers) {
    const hits = usable.filter(tier).sort((a, b) => versionOf(b) - versionOf(a) || a.length - b.length);
    if (hits.length) return hits[0];
  }
  return null;
}

function isBad(model, now = Date.now()) {
  const at = cache.bad.get(model);
  if (at && now - at > BAD_MODEL_MS) cache.bad.delete(model);
  return cache.bad.has(model);
}

async function googleFetch(env, path, init = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY, ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data?.error?.message || res.statusText || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

async function listModels(env) {
  const data = await googleFetch(env, "/models?pageSize=1000");
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => n.startsWith("gemini-"));
}

// Models to try, best first.
async function modelsToTry(env, { fresh = false } = {}) {
  if (env.GEMINI_MODEL) return [env.GEMINI_MODEL];
  if (!fresh && cache.current && !isBad(cache.current)) return [cache.current];

  if (fresh || !cache.names || Date.now() - cache.at > LIST_CACHE_MS) {
    try {
      cache.names = await listModels(env);
      cache.at = Date.now();
    } catch (e) {
      if (keyProblem(e)) throw e;
      console.warn("[proxy] Could not list Gemini models, using fallback alias:", e.message);
    }
  }
  let pool = (cache.names || []).filter((n) => !isBad(n));
  const ranked = [];
  for (let i = 0; i < 4 && pool.length; i++) {
    const next = pickBestModel(pool);
    if (!next) break;
    ranked.push(next);
    pool = pool.filter((n) => n !== next);
  }
  if (!isBad(FALLBACK_MODEL)) ranked.push(FALLBACK_MODEL);
  return [...new Set(ranked)];
}

// Ask the model to think only briefly: quicker answers, and its thinking can't
// use up the whole answer allowance. Each model family takes a different setting.
function thinkingFor(model) {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-2\.5-pro/.test(model)) return { thinkingBudget: 128 };
  if (/^gemini-[3-9]/.test(model)) return { thinkingLevel: "low" };
  return null;
}

function requestBody({ system, turns }) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: { answer: { type: "STRING" }, sectionId: { type: "STRING" } },
        required: ["answer"],
      },
    },
  };
}

async function generate(env, model, baseBody) {
  const path = `/models/${encodeURIComponent(model)}:generateContent`;
  const thinking = thinkingFor(model);
  const body = thinking ? { ...baseBody, generationConfig: { ...baseBody.generationConfig, thinkingConfig: thinking } } : baseBody;
  let data;
  try {
    data = await googleFetch(env, path, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    // If this model doesn't accept the thinking or JSON settings, try once with plain settings.
    if (e.status !== 400 || /api key/i.test(e.message)) throw e;
    const { responseMimeType, responseSchema, ...plain } = baseBody.generationConfig;
    data = await googleFetch(env, path, { method: "POST", body: JSON.stringify({ ...baseBody, generationConfig: plain }) });
  }
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  if (!text) {
    const why = data?.promptFeedback?.blockReason || cand?.finishReason || "no text";
    throw Object.assign(new Error(`Gemini sent an empty answer (${why})`), { status: 0 });
  }
  return text;
}

// "This model won't work, try another one."
function modelProblem(e) {
  return e.status === 404 ||
    (e.status === 429 && /limit:\s*0\b/i.test(e.message || "")) ||
    /not found|not supported|no longer|deprecated|retired|not available|empty answer/i.test(e.message || "");
}
// "Too busy right now."
function busyProblem(e) {
  return [429, 500, 502, 503, 504].includes(e.status) || /overloaded|high demand|unavailable|try again/i.test(e.message || "");
}
function keyProblem(e) {
  return (e.status === 400 && /api key|api_key/i.test(e.message || "")) || e.status === 401 || e.status === 403;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The one function every provider has: prompt in, reply text out.
export async function answer(prompt, env, { retryDelayMs = 1500 } = {}) {
  const body = requestBody(prompt);
  let lastError = null;
  try {
    let models = await modelsToTry(env);
    const tried = new Set();
    let listed = false;
    while (models.length) {
      const model = models.shift();
      if (tried.has(model)) continue;
      tried.add(model);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const text = await generate(env, model, body);
          cache.current = model;
          return { text, model };
        } catch (e) {
          lastError = e;
          console.warn(`[proxy] ${model} failed:`, e.status, e.message);
          if (busyProblem(e) && !modelProblem(e) && attempt === 0 && tried.size === 1) { await wait(retryDelayMs); continue; }
          break;
        }
      }
      const e = lastError;
      if (keyProblem(e) || env.GEMINI_MODEL || tried.size >= 3) break;
      if (modelProblem(e)) { cache.bad.set(model, Date.now()); if (cache.current === model) cache.current = ""; }
      else if (!busyProblem(e)) break;
      if (!models.length && !listed) {
        listed = true;
        models = (await modelsToTry(env, { fresh: true })).filter((m) => !tried.has(m));
      }
    }
  } catch (e) {
    lastError = e;
  }
  throw toProxyError(lastError || new Error("No Gemini model available"));
}

function toProxyError(e) {
  // Never pass Google's raw text about keys to the browser: it's the server's problem, not the user's.
  if (keyProblem(e)) return new ProxyError("not_configured", "The server's Gemini key was refused. Ask whoever runs the server to check it.", 502);
  if (e.status === 429 && /quota|limit/i.test(e.message || "")) return new ProxyError("quota", "The Gemini usage limit is used up for now.", 503);
  if (busyProblem(e)) return new ProxyError("busy", "Gemini is very busy right now.", 503);
  return new ProxyError("upstream", `Gemini had a problem: ${e.message}`, 502);
}
