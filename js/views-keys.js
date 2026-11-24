// API Keys: keys for your own apps (Keyflow), encrypted vault for provider keys, integrations guide,
// the API Key Agent and Key Forge.
(() => {
  "use strict";
  const { $, esc } = U;
  const KF = () => window.Keyflow;
  const FORGE = "keys.forge";
  let tab = "overview", rv = null, fresh = null, reveal = new Map(), vErr = "", lastVerify = null;

  // Keys for these services can only be issued by the service itself.
  const INTEGRATIONS = [
    { id: "roblox", name: "Roblox Open Cloud", auth: "API key", url: "https://create.roblox.com", min: "Only the API systems and operations you call (for example one experience, one datastore)",
      steps: ["Open the Creator Hub and go to the API keys (credentials) page.", "Choose Create API key and give it a name that says what it is for.", "Under permissions, add only the API systems you need and the exact experiences or resources.", "Set an expiry date and, if you can, the IP addresses allowed to use it.", "Copy the key once and put it in the secrets vault, never in source code."], tip: "Use a dedicated account for group resources so the key cannot reach anything else." },
    { id: "nango", name: "Nango (self-hosted integrations)", auth: "Secret key + OAuth", url: "https://nango.dev", min: "One connection per customer or app, only the scopes that API needs",
      steps: ["Self-host Nango or use their cloud, and add the API you want to connect.", "Create the integration and give it only the scopes you need.", "Keep the Nango secret key in the secrets vault and call Nango from your own server.", "Check the Elastic License 2.0 terms before you offer it to other people as a service."], tip: "Nango handles OAuth sign-in for 1,000+ APIs, which a browser-only app cannot do safely by itself." },
    { id: "keyflow", name: "KeyFlow (keys for your own API)", auth: "Your own keys", url: "https://github.com/evansso/keyflow", min: "Per-app keys with prefix, expiry and rate limit",
      steps: ["The Apps & keys tab does the same job inside this app: create, verify, expire, rate limit and log keys.", "Export the verifier file and use server/verify-keys.js in your own server.", "Use the KeyFlow project itself if you want a hosted API with Cloudflare Workers."], tip: "KeyFlow is MIT licensed. Agent Studio re-implements the ideas and does not copy its code." },
    { id: "openrouter", name: "OpenRouter", auth: "API key", url: "https://openrouter.ai/keys", min: "A key with a spending limit", steps: ["Create a key on the keys page.", "Set a credit limit on it if the page offers one.", "Paste it in Settings, or store it in the vault."], tip: "Free models work without credits but with low daily limits." },
    { id: "groq", name: "Groq", auth: "API key", url: "https://console.groq.com/keys", min: "Standard key", steps: ["Create a key in the console.", "Paste it in Settings."], tip: "Free tier with rate limits." },
    { id: "gemini", name: "Google Gemini", auth: "API key", url: "https://aistudio.google.com/apikey", min: "Standard key", steps: ["Create a key in AI Studio.", "Paste it in Settings."], tip: "Free tier for flash-lite models." },
    { id: "monoova", name: "Monoova", auth: "Business API credentials", url: "https://www.monoova.com", min: "Payout permission for one account only", steps: ["Apply for a business account and ask for sandbox access first.", "Create credentials limited to the payout account you use.", "Connect it in the API hub, then set the rail in Vault → Rail & webhooks."], tip: "Onboarding and fees apply." },
    { id: "azupay", name: "Azupay", auth: "Business API credentials", url: "https://azupay.com.au", min: "Payout permission for one account only", steps: ["Apply for a business account and ask for sandbox access first.", "Create credentials limited to the payout account you use.", "Connect it in the API hub, then set the rail in Vault → Rail & webhooks."], tip: "Onboarding and fees apply." }
  ];
  const TABS = [["overview", "Overview"], ["apps", "Apps & keys"], ["verify", "Verify & logs"], ["secrets", "Secrets vault"], ["integrations", "Integrations"], ["forge", "Key Forge"]];

  // ---- Key Forge (secrets your own app defines) ----
  const forgeKeys = () => Store.get(FORGE, []);
  const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
  const b64url = n => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const KINDS = {
    webhook: { label: "Webhook signing secret", make: () => "whsec_" + hex(24), where: "Give the same value to your payment provider and your relay, and paste it in Vault → Rail & webhooks." },
    relay: { label: "Relay access token", make: () => b64url(32), where: "Set it as RELAY_TOKEN on your relay server and in Vault → Rail & webhooks." },
    idem: { label: "Idempotency key", make: () => "idem_" + (crypto.randomUUID ? crypto.randomUUID() : hex(16)), where: "One per payout request. The app makes these for you automatically." },
    token: { label: "Generic secret (hex)", make: () => hex(32), where: "Any secret your own software needs." }
  };
  const mask = v => v.length <= 10 ? "•".repeat(v.length) : v.slice(0, 6) + "•".repeat(10) + v.slice(-3);

  const pill = (s, txt) => `<span class="kpill ${s}">${esc(txt || s)}</span>`;
  const when = ts => ts ? new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "never";

  // ---------- tabs ----------
  function overview() {
    const ks = KF().keys(), act = ks.filter(k => KF().status(k) === "active" || KF().status(k) === "expiring"), logs = KF().logs(), day = logs.filter(l => Date.now() - l.ts < 864e5);
    const hl = KF().health(), pr = KF().practices();
    const hours = Array.from({ length: 24 }, (_, i) => ({ t: Date.now() - (23 - i) * 36e5, ok: 0, bad: 0 }));
    for (const l of day) { const h = hours.find((x, i) => l.ts >= x.t && (i === 23 || l.ts < hours[i + 1].t)); if (h) l.ok ? h.ok++ : h.bad++; }
    const max = Math.max(1, ...hours.map(h => h.ok + h.bad)), W = 288, H = 56, bw = W / 24;
    const spark = `<svg viewBox="0 0 ${W} ${H}" class="spark" role="img" aria-label="Key checks in the last 24 hours">${hours.map((h, i) => { const a = Math.round(h.ok / max * H), b = Math.round(h.bad / max * H); return `<rect x="${i * bw + 1.5}" y="${H - a}" width="${bw - 3}" height="${a || 0}" class="sb"/><rect x="${i * bw + 1.5}" y="${H - a - b}" width="${bw - 3}" height="${b}" class="sbd"/>`; }).join("")}</svg>`;
    return `<div class="ledger"><div><span>Apps</span><b>${KF().apps().length}</b></div><div><span>Active keys</span><b>${act.length}</b></div><div><span>Checks, 24 hours</span><b>${day.length}</b></div><div><span>Refused</span><b class="${day.some(l => !l.ok) ? "bad" : ""}">${day.filter(l => !l.ok).length}</b></div></div>
      <div class="grid2"><div class="card"><h3>Three rules for safe keys</h3>${pr.map(p => `<div class="rule ${p.ok ? "pass" : "todo"}"><span class="rd" aria-hidden="true">${p.ok ? "✓" : "!"}</span><div><b>${esc(p.name)}</b><div class="muted small">${esc(p.detail)}</div></div></div>`).join("")}</div>
        <div class="card"><h3>Key checks, last 24 hours</h3>${spark}<div class="muted small">Brass: accepted. Red: refused.</div></div></div>
      <div class="card"><h3>${hl.length ? `Needs attention (${hl.length})` : "Nothing needs attention"}</h3>${hl.map(h => `<div class="li"><div class="row between"><span>${pill(h.level === "bad" ? "bad" : "warn", h.level === "bad" ? "Fix now" : "Soon")} ${esc(h.text)}</span>${h.keyId && h.fix === "rotate" ? `<button class="btn small" data-k="rotate" data-id="${h.keyId}">Rotate</button>` : h.keyId && h.fix === "revoke" ? `<button class="btn small" data-k="revoke" data-id="${h.keyId}">Revoke</button>` : h.fix === "vault" ? `<button class="btn small" data-k="tab" data-id="secrets">Open vault</button>` : h.keyId ? `<button class="btn small" data-k="tab" data-id="apps">Open keys</button>` : ""}</div></div>`).join("") || `<p class="muted">Every key has an expiry, only the permissions it needs, and provider keys are encrypted.</p>`}</div>`;
  }

  function appsTab() {
    const apps = KF().apps(), ks = KF().keys();
    const secret = fresh ? `<div class="card fresh"><h3>Copy your new key now</h3><p class="muted small">This is the only time it is shown. Only its hash is kept, so it cannot be recovered. “${esc(fresh.name)}”</p><code class="secretline">${esc(fresh.secret)}</code><div class="row"><button class="btn primary" data-k="copy-fresh">Copy key</button><button class="btn" data-k="done-fresh">I saved it</button></div></div>` : "";
    return secret + `<div class="row"><button class="btn primary" data-k="app-add">+ App</button><button class="btn" data-k="key-add" ${apps.length ? "" : "disabled"}>+ Key</button><button class="btn" data-k="export" ${ks.length ? "" : "disabled"}>Export verifier file</button></div>
      <p class="muted small">Give every app its own keys, so one leak or one revoke never touches the others. Your own server checks keys with the verifier file and <code>server/verify-keys.js</code>.</p>
      ${apps.map(a => { const list = ks.filter(k => k.appId === a.id); return `<div class="card"><div class="row between"><div><h3>${esc(a.name)}</h3><div class="muted small">${esc(a.desc || "No description")}</div></div><div class="row nowrap"><button class="btn small" data-k="key-add" data-id="${a.id}">+ Key</button><button class="btn small danger" data-k="app-del" data-id="${a.id}">Delete app</button></div></div>
        ${list.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Key</th><th>Permissions</th><th>Expires</th><th class="num">Limit/min</th><th class="num">Uses</th><th>Status</th><th></th></tr></thead><tbody>${list.map(k => { const st = KF().status(k); return `<tr><td><b>${esc(k.name)}</b><div class="muted small"><code>${esc(k.prefix)}_••••${esc(k.last4)}</code></div></td><td>${k.scopes.map(s => `<span class="tag ${s === "*" ? "bad" : ""}">${esc(s === "*" ? "everything" : s)}</span>`).join(" ")}</td><td>${esc(when(k.expires))}</td><td class="num">${k.limit || "none"}</td><td class="num">${k.uses}</td><td>${pill(st === "active" ? "ok" : st === "expiring" ? "warn" : "bad", st)}</td>
          <td><div class="row nowrap">${st !== "revoked" ? `<button class="btn small" data-k="rotate" data-id="${k.id}">Rotate</button><button class="btn small" data-k="revoke" data-id="${k.id}">Revoke</button>` : ""}<button class="btn small danger" data-k="key-del" data-id="${k.id}">✕</button></div></td></tr>`; }).join("")}</tbody></table></div>` : `<p class="muted">No keys yet. Create the first one with only the permissions this app needs.</p>`}</div>`; }).join("") || `<div class="card"><p class="muted">Start by adding the first app, for example “Mobile app” or “Reporting server”.</p></div>`}`;
  }

  function verifyTab() {
    const logs = KF().logs().slice(0, 60), r = lastVerify;
    return `<div class="card"><h3>Check a key</h3><p class="muted small">Paste a key to see what the server would answer. Each check is logged below.</p>
      <div class="row"><input id="vKey" type="password" autocomplete="off" placeholder="Key to check"><select id="vScope"><option value="">Any permission</option>${KF().SCOPES.map(s => `<option value="${s.id}">${esc(s.id)}</option>`).join("")}</select><button class="btn primary" data-k="verify">Check key</button></div>
      ${r ? `<div class="alert ${r.valid ? "okbox" : "fail"}"><b>${r.valid ? "Valid." : "Refused."}</b> ${esc(KF().REASONS[r.reason] || r.reason)}${r.key ? ` · ${esc(r.key.name)}` : ""}</div>` : ""}</div>
      <div class="card"><div class="row between"><h3>Live log</h3><span class="muted small">Updates as keys are checked</span></div><div class="tblwrap"><table class="tbl"><thead><tr><th>When</th><th>Result</th><th>Key</th><th>Permission</th><th>From</th></tr></thead><tbody>${logs.map(l => `<tr><td>${U.ago(l.ts)}</td><td>${pill(l.ok ? "ok" : "bad", l.ok ? "accepted" : KF().REASONS[l.reason] ? l.reason.replace("_", " ") : l.reason)}</td><td>${esc(l.name || "unknown")}</td><td>${esc(l.scope || "any")}</td><td>${esc(l.source)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No checks yet.</td></tr>`}</tbody></table></div></div>`;
  }

  function secretsTab() {
    if (!KF().vaultExists()) return `<div class="card"><h3>Set up the secrets vault</h3><p class="muted small">Keeps keys that other companies gave you (OpenRouter, a payment provider, Roblox) encrypted with AES-256 on this device. The passphrase never leaves it. If you forget it, the secrets cannot be recovered.</p>
      <label class="field">Passphrase (8 or more characters)<input id="pp1" type="password" autocomplete="new-password"></label><label class="field">Repeat passphrase<input id="pp2" type="password" autocomplete="new-password"></label><div class="row"><button class="btn primary" data-k="v-setup">Create vault</button></div>${vErr ? `<div class="err">${esc(vErr)}</div>` : ""}</div>`;
    if (!KF().isUnlocked()) return `<div class="card"><h3>Vault is locked</h3><label class="field">Passphrase<input id="pp1" type="password" autocomplete="current-password"></label><div class="row"><button class="btn primary" data-k="v-unlock">Unlock</button></div>${vErr ? `<div class="err">${esc(vErr)}</div>` : ""}<p class="muted small">${KF().items().length} secret${KF().items().length === 1 ? "" : "s"} stored.</p></div>`;
    return `<div class="row"><button class="btn primary" data-k="s-add">+ Secret</button><button class="btn" data-k="v-lock">Lock now</button><span class="muted small">Locks itself after 5 idle minutes.</span></div>
      ${KF().items().map(it => `<div class="card"><div class="row between"><div><b>${esc(it.label)}</b> ${it.provider ? `<span class="tag">${esc(it.provider)}</span>` : ""}<div class="muted small">${esc((KF().apps().find(a => a.id === it.appId) || {}).name || "no app")} · permissions: ${esc(it.scopes || "not noted")} · expires ${esc(when(it.expires))}</div>${reveal.has(it.id) ? `<code class="secretline">${esc(reveal.get(it.id))}</code>` : `<code class="secretline dim">••••••••••••••••</code>`}</div>
        <div class="row nowrap"><button class="btn small" data-k="s-show" data-id="${it.id}">${reveal.has(it.id) ? "Hide" : "Show 10 s"}</button><button class="btn small" data-k="s-copy" data-id="${it.id}">Copy</button><button class="btn small danger" data-k="s-del" data-id="${it.id}">✕</button></div></div></div>`).join("") || `<div class="card"><p class="muted">Empty. Add the keys you got from providers so they are not left in plain text.</p></div>`}`;
  }

  function integrationsTab() {
    const agent = Core.agent("api-key-agent");
    return `<div class="card"><h3>API Key Agent</h3><p class="muted small">Describe a goal. The agent lists the APIs and keys it needs, most blocking first, with the official place to get each one.</p>
      <textarea id="kGoal" rows="3" placeholder="e.g. Send my savings to my AUD bank account automatically and tell me when it arrives"></textarea>
      <div class="row"><button class="btn primary" data-k="plan" ${agent ? "" : "disabled"}>Plan the APIs I need</button><button class="btn" data-k="chat" ${agent ? "" : "hidden"}>Chat with the agent</button></div>${agent ? "" : `<p class="muted small">The API Key Agent is not in your roster. Agents → Reset restores it.</p>`}<div id="kOut"></div></div>
      <div class="alert info">A key for a service (an AI provider, a bank, Roblox) can only be issued by that service. Websites that make random keys give strings no provider will accept, so use the steps below and keep each key in the secrets vault.</div>
      <div class="grid2">${INTEGRATIONS.map(p => `<div class="card integ"><div class="row between"><h3>${esc(p.name)}</h3><span class="tag">${esc(p.auth)}</span></div>
        <div class="muted small"><b>Smallest permission set:</b> ${esc(p.min)}</div><ol class="steps">${p.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol><div class="muted small">${esc(p.tip)}</div>
        <div class="row"><a class="btn small" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Open ${esc(new URL(p.url).hostname)}</a><button class="btn small" data-k="s-add" data-id="${p.id}">Store its key in the vault</button></div></div>`).join("")}</div>`;
  }

  function forgeTab() {
    const list = forgeKeys();
    return `<div class="card"><h3>Key Forge</h3><p class="muted small">Creates strong random secrets on this device for things your own app defines. Nothing leaves the device.</p>
      <div class="row"><select id="kKind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select><input id="kLabel" placeholder="Label (optional)"><button class="btn primary" data-k="make">Create</button></div><div id="kWhere" class="muted small">${esc(KINDS.webhook.where)}</div>
      ${list.map(k => `<div class="li"><div class="row between"><div><b>${esc(k.label)}</b> <span class="tag">${esc((KINDS[k.kind] || {}).label || k.kind)}</span><div class="muted small">${U.ago(k.created)}</div><code class="secretline">${reveal.has(k.id) ? esc(k.value) : esc(mask(k.value))}</code></div>
        <div class="row nowrap"><button class="btn small" data-k="f-show" data-id="${k.id}">${reveal.has(k.id) ? "Hide" : "Show"}</button><button class="btn small" data-k="f-copy" data-id="${k.id}">Copy</button>${k.kind === "webhook" ? `<button class="btn small" data-k="use-webhook" data-id="${k.id}">Use as webhook secret</button>` : ""}${k.kind === "relay" ? `<button class="btn small" data-k="use-relay" data-id="${k.id}">Use as relay token</button>` : ""}<button class="btn small danger" data-k="f-del" data-id="${k.id}">✕</button></div></div></div>`).join("") || `<p class="muted">No saved secrets yet.</p>`}</div>`;
  }

  function render(el) {
    const body = { overview, apps: appsTab, verify: verifyTab, secrets: secretsTab, integrations: integrationsTab, forge: forgeTab }[tab]();
    const hl = KF().health().length;
    $("#kTabs", el).innerHTML = TABS.map(([id, t]) => `<button class="tab ${tab === id ? "active" : ""}" data-k="tab" data-id="${id}">${t}${id === "overview" && hl ? ` <span class="count">${hl}</span>` : ""}</button>`).join("");
    const keep = { goal: ($("#kGoal", el) || {}).value };
    $("#kBody", el).innerHTML = body;
    if (keep.goal && $("#kGoal", el)) $("#kGoal", el).value = keep.goal;
  }

  async function keyForm(appId) {
    const apps = KF().apps();
    const init = { appId: appId || apps[0].id, prefix: "ak", days: 90, limit: 60, "s:vault:read": true };
    const v = await U.form("New key", [
      { key: "appId", label: "App (each app gets its own keys)", type: "select", options: apps.map(a => ({ value: a.id, label: a.name })) },
      { key: "name", label: "Name", required: true, placeholder: "Production server" }, { key: "prefix", label: "Prefix (2 to 8 letters or digits)" },
      ...KF().SCOPES.map(s => ({ key: "s:" + s.id, label: `${s.id}: ${s.label}`, type: "checkbox" })),
      { key: "days", label: "Expires after (days, 0 = never)", type: "number" }, { key: "limit", label: "Rate limit (requests a minute, 0 = none)", type: "number" }
    ], init, { submit: "Create key", intro: "Choose only the permissions this key needs." });
    if (!v) return;
    const out = await KF().create({ appId: v.appId, name: v.name, prefix: v.prefix, scopes: KF().SCOPES.filter(s => v["s:" + s.id]).map(s => s.id), days: v.days, limit: v.limit });
    fresh = { secret: out.secret, name: out.key.name };
  }

  App.register({
    id: "keys", title: "API Keys", icon: "🔑",
    mount(el) {
      el.innerHTML = `<div><h2>API Keys</h2><div class="muted small">Keys for your own apps, an encrypted vault for provider keys, and guides to get each key safely</div></div><div id="kTabs" class="tabs"></div><div id="kBody" class="stack"></div>`;
      el.addEventListener("change", e => { if (e.target.id === "kKind") $("#kWhere", el).textContent = KINDS[e.target.value].where; });
      el.addEventListener("click", async e => {
        const b = e.target.closest("[data-k]"); if (!b) return;
        const id = b.dataset.id, k = KF().keys().find(x => x.id === id);
        try {
          switch (b.dataset.k) {
            case "tab": tab = id; fresh = tab === "apps" ? fresh : null; break;
            case "app-add": { const v = await U.form("New app", [{ key: "name", label: "Name", required: true, placeholder: "Reporting server" }, { key: "desc", label: "What is it for?" }]); if (v) KF().addApp(v.name, v.desc); break; }
            case "app-del": if (confirm("Delete this app and its keys?")) KF().removeApp(id); break;
            case "key-add": await keyForm(id); break;
            case "copy-fresh": U.copy(fresh.secret); U.toast("Copied. Store it in the secrets vault or your server's secret store."); return;
            case "done-fresh": fresh = null; break;
            case "rotate": { if (!confirm("Create a replacement key? The old one keeps working for 7 days so you can switch over.")) return; const o = await KF().rotate(id, 7); fresh = { secret: o.secret, name: o.key.name }; tab = "apps"; break; }
            case "revoke": if (confirm(`Revoke “${k.name}”? It stops working at once.`)) KF().revoke(id); break;
            case "key-del": if (confirm("Delete this key record?")) KF().remove(id); break;
            case "export": U.download("keys.json", JSON.stringify(KF().exportVerifier(), null, 2), "application/json"); U.toast("Exported hashes only. Use it with server/verify-keys.js."); return;
            case "verify": lastVerify = await KF().verify($("#vKey", el).value, { scope: $("#vScope", el).value, source: "verify screen" }); $("#vKey", el).value = ""; break;
            case "v-setup": { if ($("#pp1", el).value !== $("#pp2", el).value) { vErr = "The passphrases do not match."; break; } vErr = ""; try { await KF().setup($("#pp1", el).value); } catch (er) { vErr = er.message; } break; }
            case "v-unlock": vErr = ""; try { await KF().unlock($("#pp1", el).value); } catch (er) { vErr = er.message; } break;
            case "v-lock": KF().lock(); reveal.clear(); break;
            case "s-add": {
              const p = INTEGRATIONS.find(x => x.id === id);
              if (!KF().isUnlocked()) { tab = "secrets"; U.toast("Unlock the secrets vault first."); break; }
              const v = await U.form("Store a secret", [{ key: "label", label: "Label", required: true }, { key: "provider", label: "Provider" }, { key: "appId", label: "Used by app", type: "select", options: [{ value: "", label: "No app" }, ...KF().apps().map(a => ({ value: a.id, label: a.name }))] }, { key: "scopes", label: "Permissions it was created with" }, { key: "expires", label: "Expiry date (YYYY-MM-DD, optional)" }, { key: "value", label: "Secret", type: "password", required: true }], { label: p ? p.name + " key" : "", provider: p ? p.name : "", scopes: p ? p.min : "" }, { submit: "Encrypt and store" });
              if (v) { await KF().addSecret(v); tab = "secrets"; }
              break;
            }
            case "s-show": if (reveal.has(id)) reveal.delete(id); else { reveal.set(id, await KF().reveal(id)); setTimeout(() => { reveal.delete(id); if (App.current() === "keys") render(el); }, 10000); } break;
            case "s-copy": U.copy(await KF().reveal(id)); U.toast("Copied. Clear your clipboard after pasting."); return;
            case "s-del": if (confirm("Delete this secret?")) KF().removeSecret(id); break;
            case "make": { const kind = $("#kKind", el).value, label = $("#kLabel", el).value.trim() || KINDS[kind].label; Store.set(FORGE, [{ id: U.uid(), kind, label, value: KINDS[kind].make(), created: Date.now() }, ...forgeKeys()]); Core.Audit.log("security", `Created secret “${label}” (${kind})`); break; }
            case "f-show": reveal.has(id) ? reveal.delete(id) : reveal.set(id, 1); break;
            case "f-copy": U.copy(forgeKeys().find(x => x.id === id).value); U.toast("Copied."); return;
            case "f-del": if (confirm("Delete this secret? Anything using it will stop working.")) Store.set(FORGE, forgeKeys().filter(x => x.id !== id)); break;
            case "use-webhook": Payouts.saveRail({ webhookSecret: forgeKeys().find(x => x.id === id).value }); Core.Audit.log("security", "Webhook secret set from Key Forge"); U.toast("Set as the webhook secret. Give the same value to your provider and relay."); return;
            case "use-relay": Payouts.saveRail({ relayToken: forgeKeys().find(x => x.id === id).value }); Core.Audit.log("security", "Relay token set from Key Forge"); U.toast("Set as the relay token. Set the same RELAY_TOKEN on the relay server."); return;
            case "chat": App.go("chat", { agentId: "api-key-agent" }); return;
            case "plan": {
              const goal = $("#kGoal", el).value.trim(); if (!goal) return U.toast("Describe the goal first.");
              const pre = Engine.preflight(); if (!pre.ok) { U.toast(pre.reason); if (pre.goto) App.go(pre.goto); return; }
              const h = Engine.runAgent(Core.agent("api-key-agent"), `Goal: ${goal}\n\nList the APIs, keys and secrets needed to reach this goal, most blocking first. For each: provider (official), purpose, the smallest set of permissions or scopes, free or sandbox option, how to get the key from the provider's own site, and where it goes in Agent Studio (Settings, API hub, Vault → Rail & webhooks, the secrets vault, or Key Forge). Separate "keys only a provider can issue" from "secrets Key Forge can create". Say plainly what costs money or needs approval.`);
              h.run.title = "API plan: " + goal.slice(0, 50);
              if (rv) rv.detach(); rv = RunView.attach($("#kOut", el), h.run); return;
            }
          }
        } catch (er) { U.toast("⚠ " + er.message, 6000); }
        render(el);
      });
      Core.on(t => { if (["keyflow", "keys", "settings"].includes(t) && App.current() === "keys" && !(document.activeElement && document.activeElement.matches("input,textarea,select"))) render(el); });
    },
    show(el) { render(el); }
  });
})();
