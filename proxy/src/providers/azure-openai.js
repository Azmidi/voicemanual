// Azure OpenAI (or another OpenAI-style service), ready for if the company
// approves that instead of Gemini. Settings:
//   AZURE_OPENAI_ENDPOINT     e.g. https://my-resource.openai.azure.com
//   AZURE_OPENAI_API_KEY
//   AZURE_OPENAI_DEPLOYMENT   the deployment name you created in Azure
//   AZURE_OPENAI_API_VERSION  optional, default below
// Not yet tried against a live Azure resource: test it before switching over.
import { ProxyError } from "../errors.js";

const DEFAULT_API_VERSION = "2024-10-21";

export function isConfigured(env) {
  return !!(env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_DEPLOYMENT);
}

export async function answer({ system, turns }, env) {
  const base = String(env.AZURE_OPENAI_ENDPOINT).replace(/\/+$/, "");
  const version = env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION;
  const url = `${base}/openai/deployments/${encodeURIComponent(env.AZURE_OPENAI_DEPLOYMENT)}/chat/completions?api-version=${encodeURIComponent(version)}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": env.AZURE_OPENAI_API_KEY },
      body: JSON.stringify({
        messages: [{ role: "system", content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))],
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: "json_object" },
      }),
    });
  } catch (e) {
    throw new ProxyError("upstream", `Could not reach Azure OpenAI: ${e.message}`, 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    if (res.status === 401 || res.status === 403) throw new ProxyError("not_configured", "The server's Azure OpenAI key was refused.", 502);
    if (res.status === 429) throw new ProxyError("busy", "Azure OpenAI is busy or the limit is used up.", 503);
    throw new ProxyError("upstream", `Azure OpenAI had a problem: ${msg}`, 502);
  }
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new ProxyError("upstream", "Azure OpenAI sent an empty answer.", 502);
  return { text, model: data.model || env.AZURE_OPENAI_DEPLOYMENT };
}
