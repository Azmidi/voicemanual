// The AI provider is chosen with the AI_PROVIDER setting. To add another one,
// write a file with an `answer(prompt, env)` function and list it here.
import * as gemini from "./gemini.js";
import * as azureOpenAI from "./azure-openai.js";

const PROVIDERS = { gemini, "azure-openai": azureOpenAI };

export function getProvider(env) {
  const name = String(env.AI_PROVIDER || "gemini").trim().toLowerCase();
  const provider = PROVIDERS[name];
  return provider ? { name, ...provider } : null;
}
