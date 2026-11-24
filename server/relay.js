#!/usr/bin/env node
// Agent Studio webhook relay (reference implementation, no dependencies).
// Your payment provider POSTs signed webhooks here. The relay verifies the signature, drops duplicates and
// stores the raw events. The app (which cannot receive inbound calls) collects them with GET /events.
//
//   WEBHOOK_SECRET=whsec_...  RELAY_TOKEN=long-random-token  node relay.js
//
// Env: PORT (8787) · WEBHOOK_SECRET (required) · RELAY_TOKEN (required, used by the app) · ALLOWED_ORIGIN (* by default, set to your app URL)
//      SIG_HEADER (x-signature) · TS_HEADER (x-timestamp) · SIG_SCHEME (ts.raw | raw) · TOLERANCE_SEC (300) · DATA_FILE (events.json)
// Always run it behind HTTPS (Caddy, nginx, Cloudflare Tunnel, or your host's TLS).
"use strict";
const http = require("http"), crypto = require("crypto"), fs = require("fs"), path = require("path");
const env = process.env, PORT = +env.PORT || 8787, SECRET = env.WEBHOOK_SECRET, TOKEN = env.RELAY_TOKEN;
const SIG = (env.SIG_HEADER || "x-signature").toLowerCase(), TSH = (env.TS_HEADER || "x-timestamp").toLowerCase();
const SCHEME = env.SIG_SCHEME || "ts.raw", TOL = (+env.TOLERANCE_SEC || 300) * 1000, ORIGIN = env.ALLOWED_ORIGIN || "*";
const FILE = path.resolve(env.DATA_FILE || "events.json"), MAX = 256 * 1024;
if (require.main === module && (!SECRET || !TOKEN)) { console.error("Set WEBHOOK_SECRET and RELAY_TOKEN."); process.exit(1); }

let db = { last: 0, events: [] };
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* first run */ }
const save = () => { const tmp = FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); };
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const hmac = (secret, msg) => crypto.createHmac("sha256", secret).update(msg).digest("hex");
const cors = { "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", ...cors }); res.end(JSON.stringify(obj)); };

function verify(raw, h) {
  const given = String(h[SIG] || "").toLowerCase().replace(/^sha256=/, "");
  let msg = raw;
  if (SCHEME === "ts.raw") {
    const ts = Number(h[TSH]); if (!ts) return "missing timestamp";
    const ms = ts < 1e12 ? ts * 1000 : ts; if (Math.abs(Date.now() - ms) > TOL) return "timestamp outside window";
    msg = `${h[TSH]}.${raw}`;
  }
  return eq(hmac(SECRET, msg), given) ? "" : "bad signature";
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, events: db.events.length, last: db.last });
  if (req.method === "GET" && url.pathname === "/events") {
    if (!eq((req.headers.authorization || "").replace(/^Bearer\s+/i, ""), TOKEN)) return send(res, 401, { error: "unauthorized" });
    const after = +url.searchParams.get("after") || 0;
    return send(res, 200, { last: db.last, events: db.events.filter(e => e.seq > after).slice(0, 200) });
  }
  if (req.method === "POST" && url.pathname === "/webhooks/rail") {
    const chunks = []; let size = 0, dead = false;
    req.on("data", c => { size += c.length; if (size > MAX) { dead = true; send(res, 413, { error: "too large" }); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (dead) return;
      const raw = Buffer.concat(chunks).toString("utf8"), bad = verify(raw, req.headers);
      if (bad) { console.warn("rejected webhook:", bad); return send(res, 401, { error: bad }); }
      let j; try { j = JSON.parse(raw); } catch { return send(res, 400, { error: "invalid json" }); }
      const id = String(j.event_id || j.id || ""); if (!id) return send(res, 422, { error: "no event id" });
      if (db.events.some(e => e.eventId === id)) return send(res, 200, { ok: true, duplicate: true });
      db.events.push({ seq: ++db.last, eventId: id, raw, signature: String(req.headers[SIG] || ""), timestamp: String(req.headers[TSH] || ""), received: Date.now() });
      if (db.events.length > 5000) db.events.splice(0, db.events.length - 5000);
      save(); send(res, 200, { ok: true });
    });
    return;
  }
  send(res, 404, { error: "not found" });
});
if (require.main === module) server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
module.exports = { server };
