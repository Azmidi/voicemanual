/**
 * Manuel: a hands-free voice assistant for an HTML service manual.
 *
 * HOW TO ADD IT TO A MANUAL PAGE
 *   Put this line just before </body>:
 *     <script src="manuel/manuel.js"></script>
 *
 * WHAT IT DOES
 *   - Click the mic once and just talk. No button pressing while you work.
 *   - Ask any question. Manuel reads the WHOLE manual (not only the open page),
 *     answers out loud in a sentence or two, and can jump to the right section.
 *   - Simple commands: "go to troubleshooting", "scroll down", "read this page",
 *     "stop", "mute".
 *   - After 15 minutes of silence it dozes off. Say "Hey Manuel" to wake it.
 *   - A typing box works too (for noisy rooms or browsers without voice).
 *
 * WHY IT WON'T BREAK WHEN GOOGLE RETIRES A MODEL
 *   It never relies on a fixed Gemini model name. It asks Google which models
 *   your key can use, picks the newest stable "Flash" model, remembers it for a
 *   week, and automatically picks again if Google says the model is gone.
 *
 * Without an API key it still works: it searches the manual itself and reads
 * out the most relevant sentences.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Settings you might want to change
  // ---------------------------------------------------------------------------
  const CONFIG = {
    name: "Manuel",
    subtitle: "Voice assistant for this manual",
    lang: "en-US",
    speechRate: 0.95,
    idleAfterMs: 15 * 60 * 1000,          // doze off after 15 min of silence
    wakeWords: ["hey manuel", "hi manuel", "okay manuel", "ok manuel", "hey manual", "hey emanuel"],
    historyTurns: 3,                      // remember the last few questions for follow-ups
    modelCacheMs: 7 * 24 * 60 * 60 * 1000,
    fallbackModel: "gemini-flash-latest", // Google's own "always current" alias, used only if listing fails
    apiBase: "https://generativelanguage.googleapis.com/v1beta",
    storageKey: "manuel_v2",
  };

  // ---------------------------------------------------------------------------
  // Saved settings (stay in this browser only)
  // ---------------------------------------------------------------------------
  const store = {
    load() {
      try { return JSON.parse(localStorage.getItem(CONFIG.storageKey)) || {}; } catch (_) { return {}; }
    },
    save(patch) {
      const next = Object.assign(this.load(), patch);
      try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(next)); } catch (_) {}
      return next;
    },
  };

  // Carry over the API key from the old assistant, if there was one.
  (function migrateOldKey() {
    const s = store.load();
    if (s.apiKey) return;
    try {
      const old = JSON.parse(localStorage.getItem("manuel_settings") || "{}");
      if (old.apiKey && old.apiKey.startsWith("AIza")) store.save({ apiKey: old.apiKey });
    } catch (_) {}
  })();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    mode: "off",           // off | listening | thinking | speaking | idle
    rec: null,
    restartTimer: null,
    idleTimer: null,
    sections: [],          // [{ id, title, text }]
    history: [],           // [{ q, a }]
  };

  const $ = (id) => document.getElementById(id);
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ---------------------------------------------------------------------------
  // Read the manual into sections
  // ---------------------------------------------------------------------------
  function readManual() {
    const links = [...document.querySelectorAll("#contents a[href^='#']")];
    const seen = new Set();
    const targets = [];
    links.forEach((a) => {
      const id = a.getAttribute("href").slice(1);
      const el = id && document.getElementById(id);
      if (!el || seen.has(id) || el.closest("#manuel-root")) return;
      seen.add(id);
      targets.push({ id, title: a.textContent.replace(/\s+/g, " ").trim(), el });
    });

    // Fallback for manuals without a table of contents: use headings.
    if (!targets.length) {
      document.querySelectorAll("main[id], section[id]").forEach((el) => {
        const h = el.querySelector("h1, h2, h3");
        targets.push({ id: el.id, title: (h ? h.textContent : el.id).trim(), el });
      });
    }

    const targetEls = new Set(targets.map((t) => t.el));
    return targets.map(({ id, title, el }) => {
      // Take this section's own text, without its sub-sections (they are listed separately).
      const copy = el.cloneNode(true);
      copy.querySelectorAll("[id]").forEach((child) => {
        const real = document.getElementById(child.id);
        if (real && real !== el && targetEls.has(real)) child.remove();
      });
      copy.querySelectorAll("script, style").forEach((n) => n.remove());
      const text = (copy.textContent || "").replace(/\s+/g, " ").trim();
      return { id, title, text };
    }).filter((s) => s.text.length > 0);
  }

  function manualAsText() {
    return state.sections.map((s) => `### [${s.id}] ${s.title}\n${s.text}`).join("\n\n");
  }

  // ---------------------------------------------------------------------------
  // Offline search (used with no API key, or if Gemini is unavailable)
  // ---------------------------------------------------------------------------
  const STOP = new Set("a an the and or of to in on for is are was be how what when where which who why do does did can could should would i me my you your it this that these those with from into about please tell show give find need".split(" "));

  function words(t) {
    return t.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
  }

  // Very light word stemming so "removing", "removal" and "remove" match.
  function stem(w) {
    return w.replace(/(ing|ings|ed|es|s|al|ly|ment|ation|er|ers)$/, "").slice(0, 7);
  }

  let searchIndex = null;
  function buildIndex() {
    const docs = state.sections.map((s) => {
      const tf = new Map();
      words(s.text).map(stem).forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
      return { s, tf, titleWords: new Set(words(s.title).map(stem)), len: Math.max(50, s.text.length / 6) };
    });
    const df = new Map();
    docs.forEach((d) => d.tf.forEach((_, w) => df.set(w, (df.get(w) || 0) + 1)));
    searchIndex = { docs, df, n: docs.length };
  }

  function bodyOf(section) {
    // Drop the heading from the start of the text so it isn't read twice.
    return section.text.startsWith(section.title) ? section.text.slice(section.title.length).trim() : section.text;
  }

  function localAnswer(question) {
    const q = [...new Set(words(question).map(stem))];
    if (!q.length) return { answer: "Sorry, I didn't catch a question there. Could you try again?" };
    if (!searchIndex) buildIndex();
    const { docs, df, n } = searchIndex;

    let best = null;
    docs.forEach((d) => {
      let score = 0;
      q.forEach((w) => {
        const idf = Math.log(1 + n / (1 + (df.get(w) || 0)));
        const tf = d.tf.get(w) || 0;
        score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * d.len / 300)));
        if (d.titleWords.has(w)) score += 2 * idf;
      });
      if (!best || score > best.score) best = { s: d.s, score };
    });
    if (!best || best.score < 1) {
      return { answer: "I couldn't find that in the manual. Try asking in a different way." };
    }

    const sentences = bodyOf(best.s).split(/(?<=[.!?])\s+/).filter((x) => x.length > 15 && x.length < 400);
    const ranked = sentences
      .map((x, i) => {
        const xs = new Set(words(x).map(stem));
        return { x, i, score: q.reduce((n, w) => n + (xs.has(w) ? 1 : 0), 0) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, 2)
      .sort((a, b) => a.i - b.i)
      .map((r) => r.x);
    const body = ranked.length ? ranked.join(" ") : sentences.slice(0, 2).join(" ");
    return { answer: `From "${best.s.title}": ${body || "this section looks relevant."}`, sectionId: best.s.id };
  }

  // ---------------------------------------------------------------------------
  // Gemini: choose a model automatically (no hard-coded model names)
  // ---------------------------------------------------------------------------
  function versionOf(name) {
    const m = name.match(/gemini-(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }

  async function listModels(apiKey) {
    const res = await fetch(`${CONFIG.apiBase}/models?pageSize=1000`, { headers: { "x-goog-api-key": apiKey } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const e = new Error(err?.error?.message || res.statusText);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => n.startsWith("gemini-"));
  }

  // Pick the newest model, preferring stable "Flash" (fast and cheap, often free).
  function pickBestModel(names) {
    const unwanted = /(image|tts|audio|live|embedding|vision|thinking|computer|robotics|learnlm|exp)/;
    const usable = names.filter((n) => !unwanted.test(n));
    const tiers = [
      (n) => /^gemini-[\d.]+-flash$/.test(n),                  // e.g. gemini-2.5-flash (stable)
      (n) => /^gemini-[\d.]+-flash-\d{3}$/.test(n),            // e.g. gemini-2.0-flash-001 (stable, pinned)
      (n) => /^gemini-[\d.]+-flash/.test(n) && !/lite/.test(n), // previews of newer Flash models
      (n) => /flash/.test(n),                                   // any Flash
      () => true,                                               // anything that can answer
    ];
    for (const tier of tiers) {
      const hits = usable.filter(tier).sort((a, b) => versionOf(b) - versionOf(a) || a.length - b.length);
      if (hits.length) return hits[0];
    }
    return null;
  }

  // Models that failed for this key (retired, not on the free plan, ...), skipped for a day.
  function badModels() {
    const s = store.load();
    const bad = s.badModels || {};
    const now = Date.now();
    Object.keys(bad).forEach((k) => { if (now - bad[k] > 24 * 60 * 60 * 1000) delete bad[k]; });
    return bad;
  }
  function markBad(model) {
    const bad = badModels();
    bad[model] = Date.now();
    store.save({ badModels: bad, model: "", modelAt: 0 });
  }

  // Returns models to try, best first.
  async function getModels(apiKey) {
    const s = store.load();
    if (s.modelOverride) return [s.modelOverride];
    const bad = badModels();
    const cached = s.model && s.modelKey === apiKey.slice(-6) && Date.now() - (s.modelAt || 0) < CONFIG.modelCacheMs && !bad[s.model];
    if (cached) return [s.model]; // no need to ask Google again this week
    let names = [];
    try {
      names = (await listModels(apiKey)).filter((n) => !bad[n]);
    } catch (e) {
      if (e.status === 400 || e.status === 401 || e.status === 403) throw e; // bad key: let the caller say so
      console.warn("[Manuel] Could not list models, using fallback alias.", e);
    }
    const ranked = [];
    let pool = names.slice();
    for (let i = 0; i < 4 && pool.length; i++) {
      const next = pickBestModel(pool);
      if (!next) break;
      ranked.push(next);
      pool = pool.filter((n) => n !== next);
    }
    if (!bad[CONFIG.fallbackModel]) ranked.push(CONFIG.fallbackModel);
    return [...new Set(ranked)];
  }

  function rememberModel(apiKey, model) {
    const s = store.load();
    if (s.model !== model) {
      store.save({ model, modelAt: Date.now(), modelKey: apiKey.slice(-6) });
      updateModelLabel();
    }
  }

  // ---------------------------------------------------------------------------
  // Gemini: ask a question
  // ---------------------------------------------------------------------------
  function buildRequest(question) {
    const system =
`You are ${CONFIG.name}, a friendly hands-free voice assistant for technicians using the service manual below.
Rules:
- Answer ONLY from the manual. If it isn't in the manual, say so briefly.
- Your answer is spoken aloud: plain sentences, no markdown, no bullet symbols, no tables.
- Keep it short: 1 to 3 sentences. For step-by-step procedures give the first few steps and offer to continue.
- Read numbers and units naturally (for example "two point five newton metres").
- Set "sectionId" to the id in square brackets of the section that best answers the question, or "" if none.

THE MANUAL:
${manualAsText()}`;

    const contents = [];
    state.history.slice(-CONFIG.historyTurns).forEach((t) => {
      contents.push({ role: "user", parts: [{ text: t.q }] });
      contents.push({ role: "model", parts: [{ text: JSON.stringify({ answer: t.a, sectionId: "" }) }] });
    });
    contents.push({ role: "user", parts: [{ text: question }] });

    return {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192, // roomy, because newer models "think" before answering
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: { answer: { type: "STRING" }, sectionId: { type: "STRING" } },
          required: ["answer"],
        },
      },
    };
  }

  // Ask the model to think only briefly: quicker answers, and its thinking can't
  // use up the whole answer allowance. Each model family takes a different setting.
  function thinkingFor(model) {
    if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
    if (/^gemini-2\.5-pro/.test(model)) return { thinkingBudget: 128 };
    if (/^gemini-[3-9]/.test(model)) return { thinkingLevel: "low" };
    return null;
  }

  async function postGenerate(apiKey, model, body) {
    const res = await fetch(`${CONFIG.apiBase}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data?.error?.message || res.statusText || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return data;
  }

  async function callGemini(apiKey, model, baseBody) {
    const thinking = thinkingFor(model);
    let body = baseBody;
    if (thinking) body = { ...baseBody, generationConfig: { ...baseBody.generationConfig, thinkingConfig: thinking } };
    let data;
    try {
      data = await postGenerate(apiKey, model, body);
    } catch (e) {
      // If this model doesn't accept the thinking or JSON settings, try once with plain settings.
      if (e.status !== 400 || /api key/i.test(e.message)) throw e;
      console.warn(`[Manuel] ${model} refused the request settings, retrying plainly:`, e.message);
      const { thinkingConfig, responseMimeType, responseSchema, ...plain } = baseBody.generationConfig;
      data = await postGenerate(apiKey, model, { ...baseBody, generationConfig: plain });
    }

    const cand = data?.candidates?.[0];
    const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
    if (!text) {
      const why = data?.promptFeedback?.blockReason || cand?.finishReason || "no text";
      throw Object.assign(new Error(`Gemini sent an empty answer (${why})`), { status: 0 });
    }
    try {
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      return { answer: String(parsed.answer || "").trim(), sectionId: parsed.sectionId || "" };
    } catch (_) {
      return { answer: text.replace(/[*#`_]/g, ""), sectionId: "" };
    }
  }

  // Errors that mean "this model won't work for you, try another one".
  function modelProblem(e) {
    return e.status === 404 ||
      (e.status === 429 && /limit:\s*0\b|free.?tier|not available/i.test(e.message || "")) ||
      /not found|not supported|no longer|deprecated|retired|not available|empty answer/i.test(e.message || "");
  }

  function keyProblem(e) {
    return (e.status === 400 && /api key|api_key/i.test(e.message || "")) || e.status === 401 || e.status === 403;
  }

  async function ask(question) {
    const apiKey = store.load().apiKey;
    if (!apiKey) return localAnswer(question);

    const body = buildRequest(question);
    let lastError = null;
    try {
      let models = await getModels(apiKey);
      const tried = new Set();
      while (models.length) {
        const model = models.shift();
        if (tried.has(model)) continue;
        tried.add(model);
        try {
          const result = await callGemini(apiKey, model, body);
          rememberModel(apiKey, model);
          return result;
        } catch (e) {
          lastError = e;
          console.warn(`[Manuel] ${model} failed:`, e.status, e.message);
          if (keyProblem(e) || !modelProblem(e) || store.load().modelOverride) break;
          markBad(model);
          // The remembered model stopped working: ask Google for the current list.
          if (!models.length && tried.size === 1) models = await getModels(apiKey);
        }
      }
    } catch (e) {
      lastError = e;
    }

    const e = lastError || new Error("No model available");
    console.error("[Manuel] Gemini error:", e);
    const local = localAnswer(question);
    let lead;
    if (keyProblem(e)) lead = "Your Gemini key doesn't seem to work. Please check it in settings.";
    else if (e.status === 429) lead = "Gemini says the free limit is used up for now, so here's what I found myself.";
    else if (e instanceof TypeError) lead = "I couldn't connect to Gemini. Please check your internet connection. Here's what I found myself.";
    else lead = "Gemini had a problem, so here's what I found myself.";
    return {
      answer: lead + " " + local.answer,
      sectionId: local.sectionId,
      detail: `Gemini said: ${e.status ? e.status + " " : ""}${e.message}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Speaking
  // ---------------------------------------------------------------------------
  function speak(text, then) {
    if (!window.speechSynthesis || !text) { then && then(); return; }
    speechSynthesis.cancel();
    setTimeout(() => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = CONFIG.lang;
      u.rate = Number(store.load().rate) || CONFIG.speechRate;
      let done = false;
      const finish = () => { if (!done) { done = true; then && then(); } };
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
    }, 100);
  }

  function stopSpeaking() {
    try { speechSynthesis.cancel(); } catch (_) {}
  }

  function chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
      g.gain.setValueAtTime(0.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      o.start(); o.stop(ctx.currentTime + 0.25);
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Commands that don't need the AI
  // ---------------------------------------------------------------------------
  function findSection(phrase) {
    const q = words(phrase);
    if (!q.length) return null;
    let best = null;
    state.sections.forEach((s) => {
      const t = words(s.title);
      const hits = q.filter((w) => t.some((tw) => tw === w || tw.startsWith(w) || w.startsWith(tw))).length;
      const score = hits / Math.max(q.length, 1) + hits / (t.length * 4 || 1);
      if (hits && (!best || score > best.score)) best = { s, score };
    });
    return best && best.score >= 0.5 ? best.s : null;
  }

  function matchCommand(text) {
    const t = text.toLowerCase().replace(/[.!?,]/g, "").trim();
    if (/^(stop|quiet|be quiet|silence|cancel|enough|shut up)$/.test(t)) return { type: "stop" };
    if (/^(mute|stop listening|go to sleep|turn off)$/.test(t)) return { type: "mute" };
    if (/(scroll|go|page) down/.test(t)) return { type: "scroll", dir: 1 };
    if (/(scroll|go|page) up/.test(t)) return { type: "scroll", dir: -1 };
    if (/(go to|back to) (the )?top|top of (the )?page/.test(t)) return { type: "top" };
    if (/^(read|read (this|the) (page|section)|read it|read aloud|read that)$/.test(t)) return { type: "read" };
    if (/^(repeat|say (that|it) again|what did you say)$/.test(t)) return { type: "repeat" };
    const nav = t.match(/^(?:please )?(?:go to|open|show( me)?|take me to|jump to|navigate to|turn to)\s+(?:the )?(.+?)(?: section| page| chapter)?$/);
    if (nav) {
      const s = findSection(nav[2]);
      if (s) return { type: "nav", section: s };
    }
    return null;
  }

  function goToSection(id) {
    const link = document.querySelector(`#contents a[href="#${CSS.escape(id)}"]`);
    if (link) link.click();
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
  }

  function visibleTopicText() {
    const el = document.querySelector("#content-frame main.activeTopic") || document.querySelector("main.activeTopic") || document.querySelector("main");
    return el ? el.innerText.replace(/\s+/g, " ").trim() : "";
  }

  function scrollPage(dir) {
    const amount = window.innerHeight * 0.65 * dir;
    window.scrollBy({ top: amount, behavior: "smooth" });
    document.querySelectorAll(".content-container, #content-frame").forEach((el) => el.scrollBy({ top: amount, behavior: "smooth" }));
  }

  // ---------------------------------------------------------------------------
  // Handle one thing the user said or typed
  // ---------------------------------------------------------------------------
  let lastAnswer = "";

  async function handle(text, { spoken = true } = {}) {
    text = (text || "").trim();
    if (!text) return afterTurn();
    showHeard(text);
    resetIdleTimer();

    const cmd = matchCommand(text);
    if (cmd) {
      switch (cmd.type) {
        case "stop": stopSpeaking(); showAnswer(""); return afterTurn();
        case "mute": return turnOff();
        case "scroll": scrollPage(cmd.dir); return afterTurn();
        case "top": window.scrollTo({ top: 0, behavior: "smooth" }); document.querySelectorAll(".content-container, #content-frame").forEach((el) => el.scrollTo({ top: 0, behavior: "smooth" })); return afterTurn();
        case "repeat": return say(lastAnswer || "I haven't said anything yet.");
        case "nav": goToSection(cmd.section.id); return say(`Opening ${cmd.section.title}.`);
        case "read": {
          const txt = visibleTopicText().slice(0, 3000);
          return say(txt || "There's nothing to read on this page.");
        }
      }
    }

    // Ignore very short background noise picked up by the mic.
    if (spoken && text.split(/\s+/).length < 2) return afterTurn();

    stopListening();
    showDetail("");
    setMode("thinking");
    showAnswer("Thinking…");
    const { answer, sectionId, detail } = await ask(text);
    state.history.push({ q: text, a: answer });
    state.history = state.history.slice(-CONFIG.historyTurns);
    const section = state.sections.find((s) => s.id === sectionId);
    say(answer, section);
    showDetail(detail);
  }

  function say(text, section) {
    lastAnswer = text;
    showAnswer(text, section);
    if (store.load().autoJump && section) goToSection(section.id);
    if (state.mode === "off") { speak(text); return; }
    setMode("speaking");
    stopListening();
    speak(text, afterTurn);
  }

  function afterTurn() {
    if (state.mode === "off" || state.mode === "idle") return;
    setMode("listening");
    listenSoon(150);
  }

  // ---------------------------------------------------------------------------
  // Listening loop (one sentence at a time, restarted after each)
  // ---------------------------------------------------------------------------
  function stopListening() {
    clearTimeout(state.restartTimer);
    const r = state.rec;
    state.rec = null;
    if (r) {
      r.onresult = r.onerror = r.onend = null;
      try { r.abort(); } catch (_) {}
    }
  }

  function listenSoon(ms) {
    clearTimeout(state.restartTimer);
    if (state.mode !== "listening" && state.mode !== "idle") return;
    state.restartTimer = setTimeout(listenOnce, ms);
  }

  function listenOnce() {
    if (state.mode !== "listening" && state.mode !== "idle") return;
    stopListening();
    const r = new SpeechRec();
    r.lang = CONFIG.lang;
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 1;
    state.rec = r;
    let handled = false;

    r.onresult = (e) => {
      const said = (e.results?.[0]?.[0]?.transcript || "").trim();
      if (!said || handled) return;
      handled = true;
      state.rec = null;

      if (state.mode === "idle") {
        const lower = said.toLowerCase();
        const wake = CONFIG.wakeWords.find((w) => lower.includes(w));
        if (!wake) return listenSoon(100);
        chime();
        setMode("listening");
        resetIdleTimer();
        const rest = lower.slice(lower.indexOf(wake) + wake.length).replace(/^[\s,.]+/, "");
        if (rest.length > 2) return handle(rest);
        return say("I'm here. Go ahead.");
      }
      handle(said);
    };
    r.onerror = (e) => {
      if (e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        turnOff();
        showAnswer("I can't use the microphone. Please allow microphone access for this page in your browser, then click the mic again.");
        return;
      }
      if (e.error === "network") {
        showAnswer("Voice recognition needs an internet connection. You can still type your question below.");
      }
      listenSoon(e.error === "no-speech" ? 50 : 800);
    };
    r.onend = () => {
      if (state.rec === r) state.rec = null;
      if (!handled) listenSoon(50);
    };
    try { r.start(); } catch (_) { listenSoon(500); }
  }

  // ---------------------------------------------------------------------------
  // On / off / idle
  // ---------------------------------------------------------------------------
  function turnOn() {
    if (!SpeechRec) {
      showAnswer("This browser can't listen. Please use Chrome or Edge, or type your question below.");
      return;
    }
    setMode("listening");
    resetIdleTimer();
    chime();
    listenSoon(100);
  }

  function turnOff() {
    clearTimeout(state.idleTimer);
    stopListening();
    stopSpeaking();
    setMode("off");
  }

  function resetIdleTimer() {
    clearTimeout(state.idleTimer);
    if (state.mode === "off") return;
    state.idleTimer = setTimeout(goIdle, CONFIG.idleAfterMs);
  }

  function goIdle() {
    if (state.mode === "off") return;
    stopListening();
    setMode("idle");
    showAnswer(`Resting. Say "Hey ${CONFIG.name}" to wake me.`);
    speak(`I'll rest now. Say hey ${CONFIG.name} when you need me.`, () => listenSoon(200));
  }

  // ---------------------------------------------------------------------------
  // Look and feel
  // ---------------------------------------------------------------------------
  const MODES = {
    off:       { label: "Off. Click the mic to start.", icon: "mic" },
    listening: { label: "Listening. Just speak.",       icon: "mic" },
    thinking:  { label: "Looking it up…",               icon: "dots" },
    speaking:  { label: "Speaking. Click to interrupt.", icon: "wave" },
    idle:      { label: `Resting. Say "Hey ${CONFIG.name}".`, icon: "moon" },
  };

  const ICONS = {
    mic:  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8"/></svg>',
    dots: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    wave: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  const CSS_TEXT = `
#manuel-root{--m-bg:#fff;--m-fg:#1b1f2a;--m-mute:#5b6475;--m-line:#dde3ee;--m-soft:#f3f6fb;--m-brand:#0b4fb3;--m-brand-fg:#fff;--m-ok:#1f8f4e;--m-warn:#c77700;--m-rest:#7a6cc8;
  position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:12px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--m-fg)}
@media (prefers-color-scheme:dark){#manuel-root{--m-bg:#1b1f27;--m-fg:#e8ecf3;--m-mute:#a2abbb;--m-line:#323947;--m-soft:#242a35;--m-brand:#4d8ff0;--m-brand-fg:#0b1220}}
#manuel-root *{box-sizing:border-box}
#manuel-panel{width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 110px);overflow:auto;background:var(--m-bg);border:1px solid var(--m-line);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);overflow:hidden}
#manuel-panel[hidden]{display:none}
.m-top{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--m-brand);color:var(--m-brand-fg)}
.m-title{font-weight:700;font-size:15px}.m-sub{font-size:12px;opacity:.85}
.m-top button{background:transparent;border:0;color:inherit;cursor:pointer;padding:6px;border-radius:8px;display:flex}
.m-top button:hover{background:rgba(255,255,255,.18)}
.m-body{padding:14px;display:flex;flex-direction:column;gap:12px}
.m-status{display:flex;align-items:center;gap:12px}
#manuel-mic{flex:none;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;background:#8a93a3;transition:transform .15s,background .2s}
#manuel-mic:hover{transform:scale(1.05)}
#manuel-mic:focus-visible,#manuel-fab:focus-visible{outline:3px solid var(--m-brand);outline-offset:3px}
#manuel-root[data-mode=listening] #manuel-mic{background:var(--m-ok);animation:m-pulse 2.4s ease-in-out infinite}
#manuel-root[data-mode=thinking] #manuel-mic{background:var(--m-warn)}
#manuel-root[data-mode=speaking] #manuel-mic{background:var(--m-brand)}
#manuel-root[data-mode=idle] #manuel-mic{background:var(--m-rest)}
@keyframes m-pulse{0%,100%{box-shadow:0 0 0 0 rgba(31,143,78,.45)}50%{box-shadow:0 0 0 10px rgba(31,143,78,0)}}
#manuel-label{font-weight:600}
.m-hint{font-size:12px;color:var(--m-mute)}
#manuel-heard{font-size:13px;color:var(--m-mute);font-style:italic}
#manuel-answer{background:var(--m-soft);border-radius:12px;padding:10px 12px;max-height:220px;overflow:auto;white-space:pre-wrap}
#manuel-heard:empty,#manuel-answer:empty,#manuel-detail:empty{display:none}
#manuel-goto{align-self:flex-start;background:transparent;border:1px solid var(--m-brand);color:var(--m-brand);border-radius:999px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}
#manuel-goto[hidden]{display:none}
#manuel-form{display:flex;gap:8px}
#manuel-input{flex:1;min-width:0;padding:9px 12px;border:1px solid var(--m-line);border-radius:10px;background:var(--m-bg);color:var(--m-fg);font:inherit}
#manuel-form button,.m-save{border:0;border-radius:10px;padding:9px 14px;background:var(--m-brand);color:var(--m-brand-fg);font:inherit;font-weight:600;cursor:pointer}
.m-chips{display:flex;flex-wrap:wrap;gap:6px}
.m-chips button{border:1px solid var(--m-line);background:var(--m-bg);color:var(--m-fg);border-radius:999px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
.m-chips button:hover{border-color:var(--m-brand);color:var(--m-brand)}
#manuel-settings{border-top:1px solid var(--m-line);padding:14px;display:flex;flex-direction:column;gap:8px}
#manuel-settings[hidden]{display:none}
#manuel-settings label{font-size:12px;font-weight:600;color:var(--m-mute)}
#manuel-settings input[type=password],#manuel-settings input[type=text],#manuel-settings select{width:100%;padding:8px 10px;border:1px solid var(--m-line);border-radius:8px;background:var(--m-bg);color:var(--m-fg);font:inherit}
.m-check{display:flex;gap:8px;align-items:center;font-size:13px}
.m-note{font-size:12px;color:var(--m-mute)}
.m-note a{color:var(--m-brand)}
#manuel-fab{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;color:#fff;background:#8a93a3;box-shadow:0 6px 18px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}
#manuel-root[data-mode=listening] #manuel-fab{background:var(--m-ok)}
#manuel-root[data-mode=thinking] #manuel-fab{background:var(--m-warn)}
#manuel-root[data-mode=speaking] #manuel-fab{background:var(--m-brand)}
#manuel-root[data-mode=idle] #manuel-fab{background:var(--m-rest)}
@media print{#manuel-root{display:none}}
`;

  function buildUI() {
    document.getElementById("manuel-root")?.remove();
    document.getElementById("msi-va-root")?.remove(); // old assistant, if both are loaded

    const style = document.createElement("style");
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = "manuel-root";
    root.dataset.mode = "off";
    root.innerHTML = `
<section id="manuel-panel" hidden aria-label="${CONFIG.name} voice assistant">
  <div class="m-top">
    <div><div class="m-title">${CONFIG.name}</div><div class="m-sub">${CONFIG.subtitle}</div></div>
    <div style="display:flex;gap:2px">
      <button id="manuel-gear" title="Settings" aria-label="Settings">${ICONS.gear}</button>
      <button id="manuel-close" title="Close" aria-label="Close">${ICONS.close}</button>
    </div>
  </div>
  <div class="m-body">
    <div class="m-status">
      <button id="manuel-mic" aria-label="Turn listening on or off">${ICONS.mic}</button>
      <div><div id="manuel-label" aria-live="polite">${MODES.off.label}</div><div class="m-hint">Alt+M turns the mic on or off</div></div>
    </div>
    <div id="manuel-heard"></div>
    <div id="manuel-answer" aria-live="polite"></div>
    <button id="manuel-goto" hidden></button>
    <div id="manuel-detail" class="m-note"></div>
    <form id="manuel-form" autocomplete="off">
      <input id="manuel-input" placeholder="Or type a question…" aria-label="Type a question"/>
      <button type="submit">Ask</button>
    </form>
    <div class="m-chips">
      <button data-say="go to troubleshooting">Troubleshooting</button>
      <button data-say="go to disassembly">Disassembly</button>
      <button data-say="what test equipment do I need?">Test equipment</button>
      <button data-say="read this page">Read page</button>
      <button data-say="stop">Stop</button>
    </div>
  </div>
  <div id="manuel-settings" hidden>
    <label for="manuel-key">Google Gemini API key (optional)</label>
    <input id="manuel-key" type="password" placeholder="AIza…"/>
    <div class="m-note">Without a key, ${CONFIG.name} still finds answers by searching the manual. With a key, answers are smarter. Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. The key is saved in this browser only.</div>
    <label for="manuel-model">AI model</label>
    <select id="manuel-model"><option value="">Automatic (recommended)</option></select>
    <div class="m-note" id="manuel-model-note"></div>
    <label for="manuel-rate">Speaking speed</label>
    <select id="manuel-rate"><option value="0.8">Slow</option><option value="0.95">Normal</option><option value="1.15">Fast</option></select>
    <label class="m-check"><input type="checkbox" id="manuel-autojump"/> Jump to the matching section after each answer</label>
    <button class="m-save" id="manuel-save">Save</button>
  </div>
</section>
<button id="manuel-fab" aria-label="Open ${CONFIG.name}" title="${CONFIG.name} (Alt+M)">${ICONS.mic}</button>`;
    document.body.appendChild(root);
  }

  function setMode(mode) {
    state.mode = mode;
    const root = $("manuel-root");
    if (!root) return;
    root.dataset.mode = mode;
    const m = MODES[mode];
    $("manuel-label").textContent = m.label;
    $("manuel-mic").innerHTML = ICONS[m.icon];
    $("manuel-fab").innerHTML = ICONS[m.icon];
  }

  function showDetail(text) { $("manuel-detail").textContent = text || ""; }

  function showHeard(text) { $("manuel-heard").textContent = text ? `“${text}”` : ""; }

  function showAnswer(text, section) {
    $("manuel-answer").textContent = text || "";
    const go = $("manuel-goto");
    if (section) {
      go.hidden = false;
      go.textContent = `Open "${section.title}"`;
      go.onclick = () => goToSection(section.id);
    } else {
      go.hidden = true;
    }
  }

  function updateModelLabel() {
    const s = store.load();
    const note = $("manuel-model-note");
    if (!note) return;
    if (!s.apiKey) note.textContent = "Add a key to use AI answers.";
    else if (s.modelOverride) note.textContent = `Always using ${s.modelOverride}.`;
    else if (s.model) note.textContent = `Currently using ${s.model}, chosen automatically.`;
    else note.textContent = "A model will be chosen automatically on your first question.";
  }

  async function fillModelList() {
    const s = store.load();
    const select = $("manuel-model");
    select.length = 1;
    if (!s.apiKey) return;
    try {
      const names = (await listModels(s.apiKey)).sort((a, b) => versionOf(b) - versionOf(a) || a.localeCompare(b));
      names.forEach((n) => select.add(new Option(n, n)));
    } catch (_) {}
    if (s.modelOverride) {
      if (![...select.options].some((o) => o.value === s.modelOverride)) select.add(new Option(s.modelOverride, s.modelOverride));
      select.value = s.modelOverride;
    }
  }

  function wireUI() {
    const panel = $("manuel-panel");
    $("manuel-fab").onclick = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && state.mode === "off") turnOn();
    };
    $("manuel-close").onclick = () => { panel.hidden = true; };
    $("manuel-mic").onclick = () => {
      if (state.mode === "speaking") { stopSpeaking(); afterTurn(); return; }
      state.mode === "off" ? turnOn() : turnOff();
    };
    $("manuel-gear").onclick = () => {
      const box = $("manuel-settings");
      box.hidden = !box.hidden;
      if (!box.hidden) {
        const s = store.load();
        $("manuel-key").value = s.apiKey || "";
        $("manuel-rate").value = String(s.rate || CONFIG.speechRate);
        $("manuel-autojump").checked = !!s.autoJump;
        updateModelLabel();
        fillModelList();
      }
    };
    $("manuel-save").onclick = () => {
      const key = $("manuel-key").value.trim();
      const old = store.load();
      store.save({
        apiKey: key,
        modelOverride: $("manuel-model").value,
        rate: Number($("manuel-rate").value),
        autoJump: $("manuel-autojump").checked,
        ...(key !== old.apiKey ? { model: "", modelAt: 0 } : {}),
      });
      $("manuel-settings").hidden = true;
      showAnswer("Settings saved.");
      updateModelLabel();
    };
    $("manuel-form").onsubmit = (e) => {
      e.preventDefault();
      const v = $("manuel-input").value;
      $("manuel-input").value = "";
      handle(v, { spoken: false });
    };
    document.querySelectorAll("#manuel-root .m-chips button").forEach((b) => {
      b.onclick = () => handle(b.dataset.say, { spoken: false });
    });
    document.addEventListener("keydown", (e) => {
      if (e.altKey && (e.key === "m" || e.key === "M" || e.code === "KeyM")) {
        e.preventDefault();
        state.mode === "off" ? turnOn() : turnOff();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  function init() {
    buildUI();
    wireUI();
    state.sections = readManual();
    setMode("off");
    updateModelLabel();
    console.log(`[Manuel] Ready. Read ${state.sections.length} sections of the manual.`);

    // Small hook for testing from the browser console.
    window.Manuel = { ask: (q) => handle(q, { spoken: false }), sections: () => state.sections, pickBestModel };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
