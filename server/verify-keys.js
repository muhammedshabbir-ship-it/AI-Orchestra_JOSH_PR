// Verify Agent Studio / Keyflow keys in your own Node server. No dependencies.
//   const { loadVerifier } = require("./verify-keys");
//   const keys = loadVerifier("keys.json");              // file exported from the app: API Keys → Apps & keys → Export verifier file
//   const r = keys.verify(req.headers.authorization, "payouts:read");
//   if (!r.valid) { res.writeHead(r.reason === "rate_limited" ? 429 : 401); return res.end(r.reason); }
// Only hashes are in the file, so a leaked file does not leak working keys.
"use strict";
const crypto = require("crypto"), fs = require("fs");
function loadVerifier(file) {
  let data = JSON.parse(fs.readFileSync(file, "utf8")); const windows = new Map();
  const api = {
    reload() { data = JSON.parse(fs.readFileSync(file, "utf8")); },
    verify(header, scope) {
      const raw = String(header || "").trim().replace(/^Bearer\s+/i, ""); if (!raw) return { valid: false, reason: "missing" };
      const h = crypto.createHash("sha256").update(raw).digest("hex"), k = data.keys.find(x => { const a = Buffer.from(x.hash), b = Buffer.from(h); return a.length === b.length && crypto.timingSafeEqual(a, b); });
      if (!k) return { valid: false, reason: "invalid" };
      if (k.revoked) return { valid: false, reason: "revoked" };
      if (k.expires && k.expires < Date.now()) return { valid: false, reason: "expired" };
      if (scope && !k.scopes.includes("*") && !k.scopes.includes(scope)) return { valid: false, reason: "scope" };
      if (k.limitPerMin) { const now = Date.now(), w = (windows.get(k.id) || []).filter(t => now - t < 60000); if (w.length >= k.limitPerMin) return { valid: false, reason: "rate_limited" }; w.push(now); windows.set(k.id, w); }
      return { valid: true, reason: "ok", key: { id: k.id, app: k.app, name: k.name, scopes: k.scopes } };
    }
  };
  return api;
}
module.exports = { loadVerifier };
