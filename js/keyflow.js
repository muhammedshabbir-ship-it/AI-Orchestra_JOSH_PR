// Keyflow: API keys for YOUR OWN apps and services (create, verify, expire, rotate, rate limit, log),
// plus an encrypted vault for keys other providers gave you.
//
// Design (same ideas as the open-source KeyFlow project, MIT):
//  - a key is shown once; only its SHA-256 hash, prefix and last 4 characters are kept
//  - every key belongs to one app, has the smallest set of scopes it needs, an expiry and a rate limit
//  - every verification is logged
// The static app has no server, so verification is used by (a) the Verify screen and (b) your own server,
// through the exported verifier file and server/verify-keys.js.
window.Keyflow = (() => {
  "use strict";
  const K = { apps: "kf.apps", keys: "kf.keys", logs: "kf.logs", vault: "kf.vault" };
  const SCOPES = [
    { id: "vault:read", label: "Read vault balances and reports" },
    { id: "payouts:read", label: "Read transfers and their status" },
    { id: "payouts:request", label: "Ask for a payout (still needs owner approval)" },
    { id: "agents:run", label: "Run agents and teams" },
    { id: "memory:read", label: "Read shared memory" },
    { id: "memory:write", label: "Write shared memory" },
    { id: "history:read", label: "Read run history" }
  ];
  const te = new TextEncoder(), td = new TextDecoder();
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", te.encode(s)));
  const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  function randomString(len) { const lim = 256 - (256 % 62), out = []; while (out.length < len) for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) if (b < lim && out.length < len) out.push(B62[b % 62]); return out.join(""); }
  const emit = () => Core.emit("keyflow");
  const err = m => new Error(m);
  const DAY = 864e5;

  const apps = () => Store.get(K.apps, []);
  const keys = () => Store.get(K.keys, []);
  const logs = () => Store.get(K.logs, []);
  const saveKeys = l => Store.set(K.keys, l);

  function addApp(name, desc) {
    name = String(name || "").trim(); if (!name) throw err("Give the app a name.");
    if (apps().some(a => a.name.toLowerCase() === name.toLowerCase())) throw err("An app with this name already exists.");
    const a = { id: "app_" + U.uid(), name, desc: desc || "", created: Date.now() };
    Store.set(K.apps, [...apps(), a]); Core.Audit.log("keys", `App “${name}” added`); emit(); return a;
  }
  function removeApp(id) {
    if (keys().some(k => k.appId === id && !k.revoked)) throw err("Revoke or delete this app's active keys first.");
    Store.set(K.apps, apps().filter(a => a.id !== id)); saveKeys(keys().filter(k => k.appId !== id)); emit();
  }

  // ---------- create / rotate / revoke ----------
  async function create({ appId, name, prefix, scopes, days, limit }) {
    const app = apps().find(a => a.id === appId); if (!app) throw err("Choose an app. Each app gets its own keys.");
    name = String(name || "").trim(); if (!name) throw err("Name the key (for example “Production server”).");
    prefix = String(prefix || "ak").toLowerCase(); if (!/^[a-z0-9]{2,8}$/.test(prefix)) throw err("Prefix: 2 to 8 letters or digits.");
    scopes = [...new Set(scopes || [])]; if (!scopes.length) throw err("Pick at least one permission. A key should only be able to do what it needs.");
    if (scopes.some(s => s !== "*" && !SCOPES.some(x => x.id === s))) throw err("Unknown permission.");
    days = Number(days || 0); if (!(days >= 0 && days <= 3650)) throw err("Expiry must be between 0 and 3650 days (0 means never).");
    limit = Math.round(Number(limit || 0)); if (!(limit >= 0 && limit <= 100000)) throw err("Rate limit must be between 0 and 100000 requests a minute (0 means none).");
    const secret = `${prefix}_${randomString(32)}`;
    const rec = { id: "key_" + U.uid(), appId, name, prefix, last4: secret.slice(-4), hash: await sha256(secret), scopes, created: Date.now(), expires: days ? Date.now() + days * DAY : 0, limit, revoked: 0, uses: 0, lastUsed: 0, rotatedFrom: "" };
    saveKeys([rec, ...keys()]); Core.Audit.log("keys", `Key “${name}” created for ${app.name} (${scopes.join(", ")})`); emit();
    return { key: rec, secret };
  }
  async function rotate(id, graceDays = 7) {
    const old = keys().find(k => k.id === id); if (!old) throw err("Key not found.");
    if (old.revoked) throw err("This key is already revoked.");
    const days = old.expires ? Math.max(1, Math.round((old.expires - old.created) / DAY)) : 0;
    const out = await create({ appId: old.appId, name: old.name + " (rotated)", prefix: old.prefix, scopes: old.scopes, days, limit: old.limit });
    const grace = Date.now() + Math.max(0, graceDays) * DAY;
    saveKeys(keys().map(k => k.id === id ? { ...k, expires: k.expires ? Math.min(k.expires, grace) : grace } : k.id === out.key.id ? { ...k, rotatedFrom: id } : k));
    Core.Audit.log("keys", `Key “${old.name}” rotated; the old key works for ${graceDays} more days`); emit(); return out;
  }
  function revoke(id) { const k = keys().find(x => x.id === id); if (!k) return; saveKeys(keys().map(x => x.id === id ? { ...x, revoked: Date.now() } : x)); Core.Audit.log("keys", `Key “${k.name}” revoked`); emit(); }
  function remove(id) { saveKeys(keys().filter(k => k.id !== id)); emit(); }

  // ---------- verify (with scope, expiry, revocation, rate limit, log) ----------
  const windows = new Map();
  function addLog(e) { Store.set(K.logs, [{ id: U.uid(), ts: Date.now(), ...e }, ...logs()].slice(0, 500)); emit(); }
  async function verify(raw, { scope = "", source = "app" } = {}) {
    raw = String(raw || "").trim().replace(/^Bearer\s+/i, "");
    const deny = (reason, k) => { addLog({ ok: false, reason, keyId: k ? k.id : "", appId: k ? k.appId : "", name: k ? k.name : "", scope, source }); return { valid: false, reason, key: k ? safe(k) : null }; };
    if (!raw) return deny("missing");
    const h = await sha256(raw), k = keys().find(x => x.hash === h);
    if (!k) return deny("invalid");
    if (k.revoked) return deny("revoked", k);
    if (k.expires && k.expires < Date.now()) return deny("expired", k);
    if (scope && !k.scopes.includes("*") && !k.scopes.includes(scope)) return deny("scope", k);
    if (k.limit) {
      const now = Date.now(), w = (windows.get(k.id) || []).filter(t => now - t < 60000);
      if (w.length >= k.limit) { windows.set(k.id, w); return deny("rate_limited", k); }
      w.push(now); windows.set(k.id, w);
    }
    saveKeys(keys().map(x => x.id === k.id ? { ...x, uses: x.uses + 1, lastUsed: Date.now() } : x));
    addLog({ ok: true, reason: "ok", keyId: k.id, appId: k.appId, name: k.name, scope, source });
    return { valid: true, reason: "ok", key: safe(k) };
  }
  const safe = k => ({ id: k.id, appId: k.appId, name: k.name, scopes: k.scopes, expires: k.expires });
  const REASONS = { ok: "Valid", missing: "No key given", invalid: "Not a key from this app", revoked: "Revoked", expired: "Expired", scope: "Valid key, but it lacks this permission", rate_limited: "Too many requests: rate limit reached" };
  const status = k => k.revoked ? "revoked" : k.expires && k.expires < Date.now() ? "expired" : k.expires && k.expires - Date.now() < 7 * DAY ? "expiring" : "active";

  // ---------- health: the three practices from the brief ----------
  function health() {
    const ks = keys().filter(k => !k.revoked), out = [], now = Date.now();
    for (const k of ks) {
      const app = (apps().find(a => a.id === k.appId) || {}).name || "unknown app";
      if (k.scopes.includes("*")) out.push({ level: "bad", keyId: k.id, text: `“${k.name}” (${app}) can do everything. Give it only the permissions it needs.`, fix: "perms" });
      if (!k.expires) out.push({ level: "warn", keyId: k.id, text: `“${k.name}” (${app}) never expires. Set an expiry so a leaked key stops working.`, fix: "expiry" });
      else if (k.expires < now) out.push({ level: "bad", keyId: k.id, text: `“${k.name}” (${app}) expired but is not revoked.`, fix: "revoke" });
      else if (k.expires - now < 7 * DAY) out.push({ level: "warn", keyId: k.id, text: `“${k.name}” (${app}) expires within 7 days. Rotate it.`, fix: "rotate" });
      if (now - k.created > 180 * DAY && !k.expires) out.push({ level: "warn", keyId: k.id, text: `“${k.name}” (${app}) is over 180 days old.`, fix: "rotate" });
    }
    const s = Core.settings(), plain = Object.entries(s.providers || {}).filter(([, v]) => v && v.apiKey).map(([k]) => k);
    if (plain.length) out.push({ level: "warn", text: `${plain.length} provider key${plain.length > 1 ? "s" : ""} (${plain.join(", ")}) sit in Settings without encryption. Keep the master copy in the secrets vault.`, fix: "vault" });
    return out;
  }
  function practices() {
    const ks = keys().filter(k => status(k) !== "revoked" && status(k) !== "expired"), as = apps();
    const wild = ks.filter(k => k.scopes.includes("*")).length, plain = Object.values(Core.settings().providers || {}).filter(v => v && v.apiKey).length;
    const v = Store.get(K.vault, null);
    return [
      { name: "Separate keys for each app", ok: as.length > 0 && as.every(a => ks.some(k => k.appId === a.id)) && !ks.some(k => !apps().some(a => a.id === k.appId)), detail: as.length ? `${as.length} app${as.length > 1 ? "s" : ""}, ${ks.length} active key${ks.length === 1 ? "" : "s"}` : "No apps yet. Add one app per service that needs access." },
      { name: "Minimum permissions", ok: ks.length > 0 && wild === 0, detail: ks.length ? (wild ? `${wild} key${wild > 1 ? "s" : ""} with full access` : "Every key is limited to the permissions it needs") : "No keys yet" },
      { name: "Secure storage", ok: !!v && plain === 0, detail: !v ? "The secrets vault is not set up yet" : plain ? `${plain} provider key${plain > 1 ? "s" : ""} still unencrypted in Settings` : "Provider keys are in the encrypted vault; created keys are stored as hashes" }
    ];
  }

  // ---------- verifier file for your own server ----------
  function exportVerifier() {
    return { version: 1, generated: new Date().toISOString(), note: "Hashes only. Raw keys are never stored.", keys: keys().map(k => ({ id: k.id, app: (apps().find(a => a.id === k.appId) || {}).name || "", name: k.name, hash: k.hash, scopes: k.scopes, expires: k.expires, limitPerMin: k.limit, revoked: k.revoked })) };
  }

  // ---------- encrypted vault for keys other providers issued ----------
  let vkey = null, timer = null;
  const IDLE = 5 * 60 * 1000;
  const b64 = u8 => btoa(String.fromCharCode(...u8)), unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function derive(pass, salt) {
    const base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function enc(text) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, vkey, te.encode(text)); return { iv: b64(iv), ct: b64(new Uint8Array(ct)) }; }
  async function dec(o) { try { return td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, vkey, unb64(o.ct))); } catch { throw err("Could not decrypt. Wrong passphrase or damaged data."); } }
  const touch = () => { clearTimeout(timer); if (vkey) timer = setTimeout(lock, IDLE); };
  function lock() { vkey = null; clearTimeout(timer); Core.emit("keyflow"); }
  const vault = () => Store.get(K.vault, null);
  async function setup(pass) {
    if (vault()) throw err("The vault already exists.");
    if (String(pass || "").length < 8) throw err("Use a passphrase of at least 8 characters. If you forget it, the vault cannot be recovered.");
    const salt = crypto.getRandomValues(new Uint8Array(16)); vkey = await derive(pass, salt);
    Store.set(K.vault, { v: 1, salt: b64(salt), check: await enc("keyflow-ok"), items: [] }); touch(); Core.Audit.log("security", "Secrets vault created"); emit();
  }
  async function unlock(pass) {
    const v = vault(); if (!v) throw err("Set up the vault first.");
    const k = await derive(pass, unb64(v.salt)), prev = vkey; vkey = k;
    try { if ((await dec(v.check)) !== "keyflow-ok") throw 0; } catch { vkey = prev; Core.Audit.log("security", "Secrets vault: wrong passphrase"); throw err("Wrong passphrase."); }
    touch(); Core.Audit.log("security", "Secrets vault unlocked"); emit();
  }
  const items = () => (vault() || { items: [] }).items;
  async function addSecret({ label, provider, appId, scopes, expires, value }) {
    if (!vkey) throw err("Unlock the vault first."); label = String(label || "").trim(); if (!label || !String(value || "").trim()) throw err("Enter a label and the secret.");
    const v = vault(), it = { id: "sec_" + U.uid(), label, provider: provider || "", appId: appId || "", scopes: String(scopes || ""), expires: expires ? new Date(expires).getTime() || 0 : 0, created: Date.now(), ...await enc(String(value)) };
    Store.set(K.vault, { ...v, items: [it, ...v.items] }); touch(); Core.Audit.log("security", `Secret “${label}” stored in the vault`); emit(); return it;
  }
  async function reveal(id) { if (!vkey) throw err("Unlock the vault first."); const it = items().find(x => x.id === id); if (!it) throw err("Not found."); touch(); Core.Audit.log("security", `Secret “${it.label}” revealed`); return dec(it); }
  function removeSecret(id) { const v = vault(); Store.set(K.vault, { ...v, items: v.items.filter(x => x.id !== id) }); emit(); }

  return { SCOPES, REASONS, apps, keys, logs, addApp, removeApp, create, rotate, revoke, remove, verify, status, health, practices, exportVerifier, vaultExists: () => !!vault(), isUnlocked: () => !!vkey, setup, unlock, lock, items, addSecret, reveal, removeSecret, randomString };
})();
