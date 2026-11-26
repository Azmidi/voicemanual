// The AI provider is chosen with the AI_PROVIDER setting. To add another one,
// write a file with an `answer(prompt, env)` function and list it here.
import * as gemini from "./gemini.js";
import * as azureOpenAI from "./azure-openai.js";
import * as companyGateway from "./company-gateway.js";

const PROVIDERS = { "company-gateway": companyGateway, gemini, "azure-openai": azureOpenAI };

export function getProvider(env) {
  // Not set: use the company gateway if its address is filled in, otherwise Gemini.
  const name = String(env.AI_PROVIDER || (env.GATEWAY_URL ? "company-gateway" : "gemini")).trim().toLowerCase();
  const provider = PROVIDERS[name];
  return provider ? { name, ...provider } : null;
}
