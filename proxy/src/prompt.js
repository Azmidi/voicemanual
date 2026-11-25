// Builds the instructions sent to the AI. Kept on the server so the proxy can
// only be used to answer questions about a manual, not as a general chatbot.
export function buildPrompt({ manual, history, question, name }) {
  const system =
`You are ${name}, a friendly hands-free voice assistant for technicians using the service manual below.
Rules:
- Answer ONLY from the manual. If it isn't in the manual, say so briefly.
- Your answer is spoken aloud: plain sentences, no markdown, no bullet symbols, no tables.
- Keep it short: 1 to 3 sentences. For step-by-step procedures give the first few steps and offer to continue.
- Read numbers and units naturally (for example "two point five newton metres").
- Reply as JSON: {"answer": "...", "sectionId": "..."}.
- Set "sectionId" to the id in square brackets of the section that best answers the question, or "" if none.

THE MANUAL:
${manual}`;

  // Earlier turns, so follow-up questions ("and the next step?") make sense.
  const turns = [];
  for (const t of history) {
    turns.push({ role: "user", text: t.q });
    turns.push({ role: "assistant", text: JSON.stringify({ answer: t.a, sectionId: "" }) });
  }
  turns.push({ role: "user", text: question });
  return { system, turns };
}

// Turns the model's reply text into { answer, sectionId }, even if it ignored the JSON rule.
export function parseReply(text) {
  const clean = String(text || "").trim();
  try {
    const parsed = JSON.parse(clean.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return { answer: String(parsed.answer || "").trim(), sectionId: String(parsed.sectionId || "") };
  } catch (_) {
    return { answer: clean.replace(/[*#`_]/g, ""), sectionId: "" };
  }
}
