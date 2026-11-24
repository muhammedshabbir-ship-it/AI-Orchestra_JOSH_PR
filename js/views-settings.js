// Settings: AI provider, free & small models, run preferences, storage, install.
(() => {
  "use strict";
  const { $, esc } = U;
  let installEvt = null;
  const live = {};   // live free-model lists found this session, per provider

  function provCfg() { const s = Core.settings(); s.providers = s.providers || {}; return (s.providers[s.provider] = s.providers[s.provider] || {}); }

  function fields(el) {
    const id = Core.settings().provider, p = PROVIDERS[id], c = Core.cfg(id);
    $("#setKey", el).value = c.apiKey || ""; $("#setKey", el).placeholder = p.needsKey ? "Paste your API key" : "API key (optional)";
    $("#setModel", el).value = c.model || ""; $("#setModel", el).placeholder = p.model || "model name";
    $("#setWorker", el).value = c.workerModel || "";
    $("#setBase", el).value = c.baseUrl || ""; $("#setBase", el).placeholder = p.baseUrl || "https://…/v1";
    $("#provHint", el).textContent = p.hint; $("#testOut", el).textContent = ""; $("#modelList", el).innerHTML = "";
    renderFree(el);
    App.renderBadge();
  }
  function saveProv(el) {
    const s = Core.settings(), id = s.provider;
    s.providers = s.providers || {};
    const old = s.providers[id] || {};
    s.providers[id] = { apiKey: $("#setKey", el).value.trim(), model: $("#setModel", el).value.trim(), workerModel: $("#setWorker", el).value.trim(), baseUrl: $("#setBase", el).value.trim() };
    if (old.apiKey !== s.providers[id].apiKey) Core.Audit.log("security", `API key for ${id} ${s.providers[id].apiKey ? "set" : "removed"}`);
    Core.saveSettings();
  }

  function renderFree(el) {
    const id = Core.settings().provider, c = Core.cfg(id), p = PROVIDERS[id];
    const base = (window.FREE_PRESETS[id] || []);
    const extra = (live[id] || []).filter(m => !base.some(b => b.model === m.model));
    const row = m => `<div class="li"><div class="row between"><div><b>${esc(m.model)}</b>${c.model === m.model ? ` <span class="tag orch">main</span>` : ""}${c.workerModel === m.model ? ` <span class="tag">workers</span>` : ""}<div class="muted small">${esc(m.note)}</div></div>
      <div class="row nowrap"><button class="btn small" data-fm="main" data-m="${esc(m.model)}">Use for all bots</button><button class="btn small" data-fm="worker" data-m="${esc(m.model)}">Workers only</button></div></div></div>`;
    $("#fmFor", el).textContent = p.label;
    $("#fmList", el).innerHTML = (base.length || extra.length) ? base.map(row).join("") + (extra.length ? `<div class="label">Live free models found on ${esc(p.label)}</div>` + extra.map(row).join("") : "") : `<p class="muted small">No presets for ${esc(p.label)}. Use “Load models” above to see what it offers.</p>`;
    $("#fmFind", el).hidden = id !== "openrouter";
    $("#fmPull", el).hidden = id !== "ollama";
    const u = Core.Usage.today(), cap = parseInt(Core.settings().dailyCap, 10) || 0;
    $("#usageToday", el).textContent = `Requests today: ${u.calls}${cap && !LLM.isLocal(id, c) ? ` of ${cap}` : ""}${LLM.isLocal(id, c) ? " (local model: no limits applied)" : ""}`;
  }

  function applySafe(rpm, cap, conc, tconc) {
    const s = Core.settings(); s.rpm = rpm; s.dailyCap = cap; s.conc = conc; s.teamConc = tconc; Core.saveSettings();
  }
  function syncPrefs(el) {
    const s = Core.settings();
    $("#setConc", el).value = s.conc || 3; $("#setTConc", el).value = s.teamConc || 2; $("#setRpm", el).value = s.rpm || 0; $("#setCap", el).value = s.dailyCap || 0;
  }

  App.register({
    id: "settings", title: "Settings", icon: "⚙️",
    mount(el) {
      el.innerHTML = `
        <div class="card"><h2>AI provider</h2>
          <label class="field">Provider<select id="setProvider">${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join("")}</select></label>
          <p id="provHint" class="muted small"></p>
          <label class="field">API key<div class="row nowrap"><input id="setKey" type="password" autocomplete="off"><button id="keyToggle" class="btn" type="button">Show</button></div></label>
          <label class="field">Model (Conductor, team leads, chat)<input id="setModel" list="modelList" autocomplete="off"><datalist id="modelList"></datalist></label>
          <label class="field">Model for worker agents (optional, a smaller one saves requests and cost)<input id="setWorker" list="modelList" autocomplete="off" placeholder="same as main model"></label>
          <label class="field">Base URL<input id="setBase" autocomplete="off"></label>
          <label class="field">Temperature <span id="tempVal" class="muted"></span><input id="setTemp" type="range" min="0" max="1.5" step="0.1"></label>
          <div class="row"><button id="loadModels" class="btn">Load models</button><button id="testConn" class="btn primary">Test connection</button></div><pre id="testOut" class="muted small"></pre></div>

        <div class="card"><h2>Free & small models</h2>
          <p class="muted small">Start at no cost. <b>Free cloud</b> needs only a free OpenRouter key but is rate limited. <b>Free local</b> runs small models with Ollama on your computer: no key, no limits, works offline.</p>
          <div class="row"><button class="btn primary" data-fm="quick-cloud">Use free cloud (OpenRouter free router)</button><button class="btn primary" data-fm="quick-local">Use small local models (Ollama)</button></div>
          <div class="label">Presets for <b id="fmFor"></b>: use one model for every bot, or only for the workers (the Conductor and team leads keep the main model)</div>
          <div id="fmList"></div>
          <div class="row"><button id="fmFind" class="btn">Find live free models (OpenRouter)</button><button id="fmPull" class="btn">Copy Ollama pull commands</button><button class="btn" data-fm="clear-worker">Clear worker model</button></div>
          <h3>Free-tier guard</h3>
          <p class="muted small">Free cloud models allow about 20 requests a minute and 50 a day without credits (1,000 a day after a one-time $10 purchase; as of Nov 2026). One orchestra run can use 20–40 calls, so keep the guard on. Local models are never limited.</p>
          <div class="row"><label class="inline">Max requests / min<input id="setRpm" type="number" min="0" max="600"></label><label class="inline">Max requests / day<input id="setCap" type="number" min="0" max="100000"></label><button class="btn" data-fm="safe">Apply free-tier safe settings</button></div>
          <div id="usageToday" class="muted small"></div></div>

        <div class="card"><h2>Run preferences</h2>
          <div class="row"><label class="inline">Members in parallel<input id="setConc" type="number" min="1" max="10"></label><label class="inline">Teams in parallel<input id="setTConc" type="number" min="1" max="6"></label></div>
          <label class="check"><input type="checkbox" id="setMem"> Use long-term memory in agent prompts</label>
          <p class="muted small">Lower parallelism if your provider rate-limits you.</p></div>
        <div class="card"><h2>App</h2><p class="muted small">Everything is stored on this device (<span id="storKind"></span>). Keys go only to the provider you choose. Works offline for everything except cloud AI calls; use Ollama on your network to run agents offline.</p>
          <div class="row"><button id="installBtn" class="btn" hidden>Install app</button><button id="wipeAll" class="btn danger">Erase all app data</button></div>
          <p class="muted small">Open source (MIT licence). Source and build instructions are in the repository README.</p></div>`;
      const s = Core.settings();
      $("#setProvider", el).value = s.provider; $("#setTemp", el).value = s.temperature; $("#tempVal", el).textContent = s.temperature;
      $("#setMem", el).checked = s.memoryOn !== false;
      $("#storKind", el).textContent = Store.persistent() ? "IndexedDB" : "browser storage";
      syncPrefs(el); fields(el);

      $("#setProvider", el).addEventListener("change", e => { Core.settings().provider = e.target.value; Core.saveSettings(); fields(el); });
      ["#setKey", "#setModel", "#setWorker", "#setBase"].forEach(i => $(i, el).addEventListener("input", () => { saveProv(el); renderFree(el); App.renderBadge(); }));
      $("#setTemp", el).addEventListener("input", e => { Core.settings().temperature = +e.target.value; $("#tempVal", el).textContent = e.target.value; Core.saveSettings(); });
      const num = (id, key, min, max, def) => $(id, el).addEventListener("change", e => { Core.settings()[key] = Math.max(min, Math.min(max, parseInt(e.target.value, 10) || def)); e.target.value = Core.settings()[key]; Core.saveSettings(); renderFree(el); });
      num("#setConc", "conc", 1, 10, 3); num("#setTConc", "teamConc", 1, 6, 2); num("#setRpm", "rpm", 0, 600, 0); num("#setCap", "dailyCap", 0, 100000, 0);
      $("#setMem", el).addEventListener("change", e => { Core.settings().memoryOn = e.target.checked; Core.saveSettings(); });
      $("#keyToggle", el).addEventListener("click", () => { const k = $("#setKey", el), show = k.type === "password"; k.type = show ? "text" : "password"; $("#keyToggle", el).textContent = show ? "Hide" : "Show"; });
      $("#loadModels", el).addEventListener("click", async () => {
        $("#testOut", el).textContent = "Loading models…";
        try { const list = await LLM.listModels({ provider: Core.settings().provider, cfg: Core.cfg() }); $("#modelList", el).innerHTML = list.map(m => `<option value="${esc(m)}">`).join(""); $("#testOut", el).textContent = `${list.length} models loaded – tap the Model field to pick one.`; }
        catch (e) { $("#testOut", el).textContent = "⚠ " + e.message; }
      });
      $("#testConn", el).addEventListener("click", async () => {
        const out = $("#testOut", el); out.textContent = "Testing…";
        const pre = Core.canCall(); if (!pre.ok) { out.textContent = "⚠ " + pre.reason; return; }
        try { const r = await LLM.chat({ provider: Core.settings().provider, cfg: Core.cfg(), messages: [{ role: "user", content: "Reply with the single word: OK" }], temperature: 0 }); out.textContent = "✅ Connected. Model replied: " + r.trim().slice(0, 80); }
        catch (e) { out.textContent = "⚠ " + e.message; }
      });

      // ---- free & small models ----
      el.addEventListener("click", async e => {
        const b = e.target.closest("[data-fm]"); if (!b) return;
        const s = Core.settings(), a = b.dataset.fm;
        if (a === "main" || a === "worker") {
          const c = provCfg(); if (a === "main") c.model = b.dataset.m; else c.workerModel = b.dataset.m;
          Core.saveSettings(); fields(el); U.toast(a === "main" ? `All bots now use ${b.dataset.m}.` : `Worker agents now use ${b.dataset.m}.`);
        } else if (a === "clear-worker") { provCfg().workerModel = ""; Core.saveSettings(); fields(el); }
        else if (a === "quick-cloud") {
          s.provider = "openrouter"; provCfg(); s.providers.openrouter.model = "openrouter/free"; s.providers.openrouter.workerModel = "";
          applySafe(20, 50, 1, 1); $("#setProvider", el).value = "openrouter"; fields(el); syncPrefs(el);
          U.toast("Free cloud selected. Paste a free OpenRouter key (openrouter.ai/keys), then Test connection.", 7000);
          $("#setKey", el).focus();
        } else if (a === "quick-local") {
          s.provider = "ollama"; provCfg(); Object.assign(s.providers.ollama, { model: "llama3.2:3b", workerModel: "llama3.2:1b" });
          applySafe(0, 0, 2, 1); $("#setProvider", el).value = "ollama"; fields(el); syncPrefs(el);
          U.toast("Local models selected. In a terminal run: ollama pull llama3.2:3b && ollama pull llama3.2:1b", 9000);
        } else if (a === "safe") { applySafe(20, 50, 1, 1); syncPrefs(el); renderFree(el); U.toast("Free-tier safe settings applied: 20 requests/min, 50/day, one at a time."); }
      });
      $("#fmFind", el).addEventListener("click", async () => {
        U.toast("Looking up free models…");
        try {
          const list = await LLM.listFreeModels({ provider: "openrouter", cfg: Core.cfg("openrouter") });
          live.openrouter = list.map(m => ({ model: m.id, note: `${m.name}${m.ctx ? " · " + Math.round(m.ctx / 1000) + "K context" : ""}` }));
          renderFree(el); U.toast(`${list.length} free models found.`);
        } catch (err) { U.toast("Could not load the list: " + err.message, 6000); }
      });
      $("#fmPull", el).addEventListener("click", () => U.copy(["llama3.2:1b", "llama3.2:3b", "qwen2.5:1.5b", "gemma2:2b"].map(m => "ollama pull " + m).join("\n")));
      Core.on(t => { if (t === "usage" && App.current() === "settings") renderFree(el); });

      $("#wipeAll", el).addEventListener("click", () => { if (confirm("Erase ALL app data (keys, agents, history, memory, vault)? This cannot be undone.")) { Store.wipe(); location.reload(); } });
      window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#installBtn", el).hidden = false; });
      $("#installBtn", el).addEventListener("click", async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("#installBtn", el).hidden = true; });
    },
    show(el) { $("#setProvider", el).value = Core.settings().provider; syncPrefs(el); fields(el); }
  });
})();
