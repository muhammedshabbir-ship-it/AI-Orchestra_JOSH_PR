// Provider definitions + a single chat() that talks to all of them from the browser.
window.PROVIDERS = {
  openrouter: { label: "OpenRouter", type: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free", needsKey: true,
    hint: "Default is the free router (it picks an available free model). A free account key from openrouter.ai/keys is enough. Free models are limited (about 20 requests/min, 50/day; 1,000/day after a one-time $10 credit purchase, as of Nov 2026). Paid examples: openai/gpt-4o-mini, anthropic/claude-3.5-haiku." },
  ollama: { label: "Ollama (local / free)", type: "ollama", baseUrl: "http://localhost:11434", model: "llama3.2:3b", needsKey: false,
    hint: "No key needed. Ollama must be running. For web use start it with OLLAMA_ORIGINS=* . On an Android phone, use your computer's network address (e.g. http://192.168.1.20:11434) instead of localhost, and run Ollama with OLLAMA_HOST=0.0.0.0." },
  openai: { label: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", needsKey: true,
    hint: "Key from platform.openai.com/api-keys." },
  anthropic: { label: "Anthropic (Claude)", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5", needsKey: true,
    hint: "Key from console.anthropic.com. Replace the model with any current Claude model name." },
  gemini: { label: "Google Gemini", type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.0-flash", needsKey: true,
    hint: "Key from aistudio.google.com/apikey." },
  groq: { label: "Groq", type: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", needsKey: true,
    hint: "Fast inference. Key from console.groq.com." },
  deepseek: { label: "DeepSeek", type: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", needsKey: true,
    hint: "Key from platform.deepseek.com." },
  mistral: { label: "Mistral", type: "openai", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest", needsKey: true,
    hint: "Key from console.mistral.ai." },
  custom: { label: "Custom (OpenAI-compatible)", type: "openai", baseUrl: "", model: "", needsKey: false,
    hint: "Any OpenAI-compatible API (LM Studio, vLLM, Together, Fireworks, a proxy…). Enter its Base URL (ending in /v1), model name and key if needed." }
};

// Free and small model suggestions. Model names change often: use "Find live free models" / "Load models" to confirm.
window.FREE_PRESETS = {
  openrouter: [
    { model: "openrouter/free", note: "Router: picks an available free model for you (best default)" },
    { model: "liquid/lfm-3-1.7b:free", note: "Tiny 1.7B, fast; good for simple worker tasks" },
    { model: "google/gemma-4-26b-a4b-it:free", note: "Gemma 4 26B, 262K context; good for leads" },
    { model: "nvidia/nemotron-3.5-lightning:free", note: "Light and fast, 1M context" },
    { model: "inclusionai/ling-3.2-flash:free", note: "Flash model, 1M context" }
  ],
  ollama: [
    { model: "llama3.2:1b", note: "1B, ~1.3 GB, runs on almost any laptop; for workers" },
    { model: "llama3.2:3b", note: "3B, ~2 GB; best balance for leads and chat" },
    { model: "qwen2.5:1.5b", note: "1.5B, ~1 GB, multilingual" },
    { model: "qwen2.5:3b", note: "3B, ~1.9 GB, multilingual" },
    { model: "gemma2:2b", note: "2B, ~1.6 GB" },
    { model: "gemma3:1b", note: "1B, ~0.8 GB, very small" },
    { model: "qwen3:1.7b", note: "1.7B, ~1.4 GB" },
    { model: "phi3:mini", note: "3.8B, ~2.2 GB, strong reasoning for its size" }
  ],
  groq: [{ model: "llama-3.1-8b-instant", note: "8B, fast; has a free tier (rate limited)" }],
  gemini: [{ model: "gemini-flash-lite-latest", note: "Lite model; Google AI Studio has a free tier (verify the name with Load models)" }]
};

window.LLM = (() => {
  async function errText(res) {
    let t = "";
    try { t = await res.text(); } catch {}
    try { const j = JSON.parse(t); t = j.error?.message || j.error || j.message || t; } catch {}
    if (typeof t !== "string") t = JSON.stringify(t);
    return `HTTP ${res.status}: ${t}`.slice(0, 600);
  }

  async function doFetch(url, opts, provider) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      let msg = `Network error calling ${url.split("?")[0]}. Check your internet, the Base URL, and the API key.`;
      if (provider === "ollama") msg += " For Ollama: make sure it is running and started with OLLAMA_ORIGINS=* (and OLLAMA_HOST=0.0.0.0 for phones).";
      throw new Error(msg);
    }
  }

  async function readLines(res, onLine) {
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    }
    if (buf.trim()) onLine(buf.trim());
  }

  function resolve(provider, cfg) {
    const p = PROVIDERS[provider];
    const base = (cfg.baseUrl || p.baseUrl || "").replace(/\/+$/, "");
    const model = cfg.model || p.model;
    return { p, base, model, key: (cfg.apiKey || "").trim() };
  }

  async function chat({ provider, cfg = {}, system, messages, temperature = 0.7, onToken, signal }) {
    const { p, base, model, key } = resolve(provider, cfg);
    if (!base) throw new Error("Set a Base URL in Settings.");
    if (!model) throw new Error("Set a model name in Settings.");
    if (p.needsKey && !key) throw new Error(`Add your ${p.label} API key in Settings.`);
    const msgs = messages.map(m => ({ role: m.role, content: m.content }));
    const emit = t => { if (onToken && t) onToken(t); };
    let full = "";

    if (p.type === "openai") {
      const headers = { "Content-Type": "application/json" };
      if (key) headers.Authorization = `Bearer ${key}`;
      if (provider === "openrouter") { headers["HTTP-Referer"] = location.origin || "https://agent-studio.app"; headers["X-Title"] = "Agent Studio"; }
      const body = { model, temperature, stream: true, messages: [...(system ? [{ role: "system", content: system }] : []), ...msgs] };
      const res = await doFetch(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal }, provider);
      if (!res.ok) throw new Error(await errText(res));
      await readLines(res, line => {
        if (!line.startsWith("data:")) return;
        const d = line.slice(5).trim();
        if (d === "[DONE]") return;
        try {
          const j = JSON.parse(d);
          if (j.error) throw new Error(j.error.message || "Provider error");
          const t = j.choices?.[0]?.delta?.content || "";
          full += t; emit(t);
        } catch (e) { if (e.message && !(e instanceof SyntaxError)) throw e; }
      });
      return full;
    }

    if (p.type === "ollama") {
      const headers = { "Content-Type": "application/json" };
      if (key) headers.Authorization = `Bearer ${key}`;
      const body = { model, stream: true, options: { temperature }, messages: [...(system ? [{ role: "system", content: system }] : []), ...msgs] };
      const res = await doFetch(`${base}/api/chat`, { method: "POST", headers, body: JSON.stringify(body), signal }, provider);
      if (!res.ok) throw new Error(await errText(res));
      await readLines(res, line => {
        try {
          const j = JSON.parse(line);
          if (j.error) throw new Error(j.error);
          const t = j.message?.content || "";
          full += t; emit(t);
        } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
      });
      return full;
    }

    if (p.type === "anthropic") {
      const headers = { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
      const body = { model, max_tokens: 4096, temperature: Math.min(temperature, 1), messages: msgs };
      if (system) body.system = system;
      const res = await doFetch(`${base}/messages`, { method: "POST", headers, body: JSON.stringify(body), signal }, provider);
      if (!res.ok) throw new Error(await errText(res));
      const j = await res.json();
      full = (j.content || []).map(c => c.text || "").join("");
      emit(full);
      return full;
    }

    if (p.type === "gemini") {
      const body = {
        contents: msgs.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { temperature }
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const res = await doFetch(`${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal }, provider);
      if (!res.ok) throw new Error(await errText(res));
      const j = await res.json();
      full = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("");
      if (!full) throw new Error("The model returned no text (it may have been blocked by a safety filter).");
      emit(full);
      return full;
    }
    throw new Error("Unknown provider type.");
  }

  async function listModels({ provider, cfg = {} }) {
    const { p, base, key } = resolve(provider, cfg);
    if (!base) throw new Error("Set a Base URL first.");
    if (p.type === "ollama") {
      const res = await doFetch(`${base}/api/tags`, {}, provider);
      if (!res.ok) throw new Error(await errText(res));
      return ((await res.json()).models || []).map(m => m.name);
    }
    if (p.type === "openai") {
      const headers = key ? { Authorization: `Bearer ${key}` } : {};
      const res = await doFetch(`${base}/models`, { headers }, provider);
      if (!res.ok) throw new Error(await errText(res));
      return ((await res.json()).data || []).map(m => m.id).sort();
    }
    if (p.type === "gemini") {
      const res = await doFetch(`${base}/models?key=${encodeURIComponent(key)}`, {}, provider);
      if (!res.ok) throw new Error(await errText(res));
      return ((await res.json()).models || []).map(m => m.name.replace(/^models\//, ""));
    }
    throw new Error("This provider does not offer a model list. Type the model name manually.");
  }

  async function listFreeModels({ provider = "openrouter", cfg = {} } = {}) {
    const { base } = resolve(provider, cfg);
    const res = await doFetch(`${base}/models`, {}, provider);
    if (!res.ok) throw new Error(await errText(res));
    const j = await res.json();
    return (j.data || [])
      .filter(m => String(m.id).endsWith(":free") || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0))
      .map(m => ({ id: m.id, name: m.name || m.id, ctx: m.context_length || 0 }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function isLocal(provider, cfg = {}) {
    const p = PROVIDERS[provider];
    if (!p) return false;
    const base = cfg.baseUrl || p.baseUrl || "";
    let host = "";
    try { host = new URL(base).hostname; } catch { return false; }
    return host === "localhost" || /^127\./.test(host) || host === "::1" || host === "[::1]" || /^10\./.test(host) ||
      /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local");
  }

  return { chat, listModels, listFreeModels, isLocal };
})();
