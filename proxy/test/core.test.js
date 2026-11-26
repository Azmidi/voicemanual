import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/core.js";
import { _resetForTests, pickBestModel } from "../src/providers/gemini.js";

const ENV = { GEMINI_API_KEY: "test-key", ALLOWED_ORIGINS: "https://manual.example.com" };
const ORIGIN = "https://manual.example.com";

let calls;
function stubGoogle(handlers) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [pattern, fn] of handlers) if (pattern.test(String(url))) return fn(url, init);
    return new Response("{}", { status: 404 });
  };
}
const ok = (obj) => new Response(JSON.stringify(obj), { status: 200 });
const fail = (status, message) => new Response(JSON.stringify({ error: { message } }), { status });
const reply = (answer, sectionId = "") => ok({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answer, sectionId }) }] } }] });
const models = (...names) => ok({ models: names.map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ["generateContent"] })) });

function ask(body, { origin = ORIGIN, env = ENV, ip = "1.2.3.4", handle = createHandler() } = {}) {
  const req = new Request("https://proxy.example.com/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
  return handle(req, env, { clientIp: ip });
}
const Q = { question: "What does error 01/81 mean?", manual: "### [errors] Error codes\n01/81 means flash checksum failure." };

beforeEach(() => _resetForTests());

test("answers through Gemini, picks a model automatically, keeps the key server-side", async () => {
  stubGoogle([
    [/\/models\?/, () => models("gemini-1.5-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-image")],
    [/gemini-2\.5-flash:generateContent/, () => reply("It is a flash checksum failure.", "errors")],
  ]);
  const res = await ask(Q);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { answer: "It is a flash checksum failure.", sectionId: "errors", model: "gemini-2.5-flash" });
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  const gen = calls.find((c) => /generateContent/.test(c.url));
  assert.equal(gen.init.headers["x-goog-api-key"], "test-key");
  const sent = JSON.parse(gen.init.body);
  assert.match(sent.systemInstruction.parts[0].text, /flash checksum failure/);
  assert.equal(sent.contents.at(-1).parts[0].text, Q.question);
});

test("moves on to the next model when one is retired", async () => {
  stubGoogle([
    [/\/models\?/, () => models("gemini-2.5-flash", "gemini-2.0-flash")],
    [/gemini-2\.5-flash:generateContent/, () => fail(404, "models/gemini-2.5-flash is not found")],
    [/gemini-2\.0-flash:generateContent/, () => reply("Works.")],
  ]);
  const res = await ask(Q);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).model, "gemini-2.0-flash");
});

test("rejects websites that are not allowed", async () => {
  stubGoogle([]);
  const res = await ask(Q, { origin: "https://evil.example.net" });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "forbidden");
  assert.equal(calls.length, 0);
});

test("allows a page served from the same server when no list is set", async () => {
  stubGoogle([[/\/models\?/, () => models("gemini-2.5-flash")], [/generateContent/, () => reply("Yes.")]]);
  const res = await ask(Q, { origin: "https://proxy.example.com", env: { GEMINI_API_KEY: "k" } });
  assert.equal(res.status, 200);
});

test("limits questions per network address", async () => {
  stubGoogle([[/\/models\?/, () => models("gemini-2.5-flash")], [/generateContent/, () => reply("Yes.")]]);
  const handle = createHandler();
  const env = { ...ENV, RATE_LIMIT_PER_MINUTE: "2" };
  assert.equal((await ask(Q, { env, handle })).status, 200);
  assert.equal((await ask(Q, { env, handle })).status, 200);
  const third = await ask(Q, { env, handle });
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get("retry-after")) > 0);
  assert.equal((await ask(Q, { env, handle, ip: "5.6.7.8" })).status, 200);
});

test("says clearly when the server has no key", async () => {
  stubGoogle([]);
  const res = await ask(Q, { env: { ALLOWED_ORIGINS: "*" } });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, "not_configured");
});

test("does not pass Google's key error text to the browser", async () => {
  stubGoogle([[/\/models\?/, () => fail(400, "API key not valid. Please pass a valid API key.")]]);
  const body = await (await ask(Q)).json();
  assert.equal(body.error.code, "not_configured");
  assert.doesNotMatch(body.error.message, /test-key/);
});

test("rejects bad or oversized requests", async () => {
  stubGoogle([]);
  assert.equal((await ask({ manual: "x" })).status, 400);
  assert.equal((await ask({ question: "x".repeat(2000), manual: "m" })).status, 400);
  assert.equal((await ask({ ...Q, manual: "x".repeat(3000) }, { env: { ...ENV, MAX_BODY_BYTES: "1000" } })).status, 413);
});

test("answers CORS preflight only for allowed websites", async () => {
  const handle = createHandler();
  const pre = (origin) => handle(new Request("https://proxy.example.com/api/ask", { method: "OPTIONS", headers: { Origin: origin } }), ENV);
  assert.equal((await pre(ORIGIN)).status, 204);
  assert.equal((await pre("https://evil.example.net")).status, 403);
});

test("health check shows setup without secrets", async () => {
  const res = await createHandler()(new Request("https://proxy.example.com/api/health"), ENV);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, provider: "gemini", configured: true });
});

test("can switch to Azure OpenAI with settings only", async () => {
  stubGoogle([[/openai\.azure\.com/, () => ok({ model: "gpt-4o-mini", choices: [{ message: { content: '{"answer":"From Azure.","sectionId":"errors"}' } }] })]]);
  const env = { AI_PROVIDER: "azure-openai", AZURE_OPENAI_ENDPOINT: "https://r.openai.azure.com/", AZURE_OPENAI_API_KEY: "az", AZURE_OPENAI_DEPLOYMENT: "chat", ALLOWED_ORIGINS: ORIGIN };
  const res = await ask(Q, { env });
  assert.deepEqual(await res.json(), { answer: "From Azure.", sectionId: "errors", model: "gpt-4o-mini" });
  assert.match(calls[0].url, /^https:\/\/r\.openai\.azure\.com\/openai\/deployments\/chat\/chat\/completions\?api-version=/);
  assert.equal(calls[0].init.headers["api-key"], "az");
});

test("model picker prefers newest stable Flash", () => {
  assert.equal(pickBestModel(["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-flash-tts", "gemini-3-pro-preview"]), "gemini-2.5-flash");
});

test("Cloudflare Worker entry uses the same code", async () => {
  stubGoogle([[/\/models\?/, () => models("gemini-2.5-flash")], [/generateContent/, () => reply("From the worker.")]]);
  const worker = (await import("../src/worker.js")).default;
  const req = new Request("https://proxy.example.com/api/ask", {
    method: "POST", headers: { Origin: ORIGIN, "cf-connecting-ip": "9.9.9.9" }, body: JSON.stringify(Q),
  });
  const res = await worker.fetch(req, ENV);
  assert.equal((await res.json()).answer, "From the worker.");
});

// Company gateway: placeholder address and header names only.
const GW = {
  AI_PROVIDER: "company-gateway", ALLOWED_ORIGINS: ORIGIN,
  GATEWAY_URL: "https://gateway.example.internal/chat", GATEWAY_API_KEY: "gw-key", GATEWAY_KEY_HEADER: "x-example-key",
  GATEWAY_MODEL: "Model-A, Model-B", GATEWAY_CLIENT_HEADER: "x-example-client", GATEWAY_CLIENT_ID: "manuel",
};

test("company gateway: sends key, model and manual; reads the answer", async () => {
  stubGoogle([[/gateway\.example\.internal/, () => ok({ status: true, msg: '{"answer":"Via gateway.","sectionId":"errors"}' })]]);
  const res = await ask({ ...Q, history: [{ q: "Earlier?", a: "Earlier answer." }] }, { env: GW });
  assert.deepEqual(await res.json(), { answer: "Via gateway.", sectionId: "errors", model: "Model-A" });
  const { init } = calls[0];
  assert.equal(init.headers["x-example-key"], "gw-key");
  assert.equal(init.headers["x-example-client"], "manuel");
  const sent = JSON.parse(init.body);
  assert.equal(sent.model, "Model-A");
  assert.match(sent.prompt, /flash checksum failure/);
  assert.match(sent.prompt, /Technician: Earlier\?/);
  assert.match(sent.prompt, /What does error 01\/81 mean\?/);
  assert.equal(sent.userId, undefined);
});

test("company gateway: tries the next model when one isn't available", async () => {
  stubGoogle([[/gateway\.example\.internal/, (u, init) => JSON.parse(init.body).model === "Model-A"
    ? new Response(JSON.stringify({ status: false, msg: "model not found. Correlation ID: 1" }), { status: 400 })
    : ok({ status: true, msg: "Plain text answer." })]]);
  const body = await (await ask(Q, { env: GW })).json();
  assert.deepEqual(body, { answer: "Plain text answer.", sectionId: "", model: "Model-B" });
});

test("company gateway: a refused or expired key is reported, not passed through", async () => {
  stubGoogle([[/gateway\.example\.internal/, () => new Response(JSON.stringify({ status: false, msg: "Unauthorized" }), { status: 401 })]]);
  const res = await ask(Q, { env: GW });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "not_configured");
  assert.equal(calls.length, 1);
});

test("company gateway: status false with HTTP 200 is treated as an error", async () => {
  stubGoogle([[/gateway\.example\.internal/, () => ok({ status: false, msg: "Internal error while processing the chat request." })]]);
  const body = await (await ask(Q, { env: { ...GW, GATEWAY_MODEL: "Model-A" } })).json();
  assert.equal(body.error.code, "upstream");
});

test("company gateway is chosen automatically when its address is set", async () => {
  const { AI_PROVIDER, ...env } = GW;
  const body = await (await createHandler()(new Request("https://proxy.example.com/api/health"), env)).json();
  assert.deepEqual(body, { ok: true, provider: "company-gateway", configured: true });
});
