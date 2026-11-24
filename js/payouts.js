// Payout engine: AUD (or any currency) vault reserve -> bank account, modelled on a double-entry ledger.
//
//   Agent / owner  ->  request (idempotency key)  ->  INITIATED (validated, waits for owner approval)
//   approve        ->  PENDING_RAIL  (Dr in_flight / Cr reserve, then POST to the payment rail)
//   signed event   ->  SETTLED | FAILED | RETURNED  (journal entries, never edits; reversals only)
//
// Real money only moves when YOU connect a payment provider and approve a transfer. Only confirmed rail
// events credit the reserve. "Simulator" mode is a built-in fake rail for demos and training (no real money).
window.Payouts = (() => {
  "use strict";
  const K = { rail: "pay.rail", transfers: "pay.transfers", journal: "pay.journal", events: "pay.events", alloc: "pay.alloc", payees: "pay.payees", cursor: "pay.cursor" };
  const STATES = ["INITIATED", "PENDING_RAIL", "SETTLED", "FAILED", "RETURNED"];
  const RANK = { INITIATED: 0, PENDING_RAIL: 1, SETTLED: 2, FAILED: 2, RETURNED: 3 };
  const DEFAULT_RAIL = {
    mode: "simulator", currency: "AUD", reserveAccountId: "", apiId: "",
    payoutPath: "/payouts", statusPath: "/payouts/{railId}", lookupPath: "/payouts?idempotency_key={idem}", idemHeader: "Idempotency-Key",
    bodyTemplate: '{"amount":"{{amount}}","currency":"{{currency}}","destination":{"bsb":"{{bsb}}","account_number":"{{account}}","payid":"{{payid}}","name":"{{name}}"},"reference":"{{reference}}","client_ref":"{{id}}"}',
    railIdPath: "id", statusJsonPath: "status", settledValues: "settled,completed", failedValues: "failed,rejected,cancelled", returnedValues: "returned,dishonoured,reversed",
    webhookSecret: "", sigScheme: "ts.raw", toleranceSec: 300, relayUrl: "", relayToken: "",
    autoApproveCents: 0, simDelaySec: 6, simFail: false, onArrivalAgent: "", onArrivalPrompt: "A payout just settled. Write a two-line confirmation for the owner and say what should happen next."
  };

  const rail = () => ({ ...DEFAULT_RAIL, ...Store.get(K.rail, {}) });
  const saveRail = r => { Store.set(K.rail, { ...rail(), ...r }); Core.emit("payouts"); };
  const transfers = () => Store.get(K.transfers, []);
  const saveTransfers = l => Store.set(K.transfers, l);
  const journal = () => Store.get(K.journal, []);
  const events = () => Store.get(K.events, []);
  const payees = () => Store.get(K.payees, []);
  const allocs = () => Store.get(K.alloc, {});
  const emit = () => Core.emit("payouts");
  const log = (t, d) => Core.Audit.log(t, d);
  const cur = c => String(c || rail().currency || "AUD").toUpperCase();
  const lc = c => cur(c).toLowerCase();
  const fmt = (cents, c) => U.money(cents / 100, cur(c));
  const getPath = (o, path) => String(path || "").split(".").filter(Boolean).reduce((x, k) => (x == null ? x : x[k]), o);
  const err = (msg, code, http) => Object.assign(new Error(msg), { code, http });

  // ---------- crypto helpers ----------
  const te = new TextEncoder();
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", te.encode(s)));
  async function hmac(secret, msg) {
    const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return hex(await crypto.subtle.sign("HMAC", key, te.encode(msg)));
  }
  function safeEq(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
  const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));

  // ---------- double-entry journal (integer cents; entries are never edited) ----------
  const ACC = {
    reserve: c => `vault:reserve:${lc(c)}`, inflight: c => `transfer:in_flight:${lc(c)}`, returned: c => `transfer:returned_clearing:${lc(c)}`,
    funding: c => `external:rail_funding:${lc(c)}`, opening: c => `equity:opening:${lc(c)}`,
    dest: t => t.destType === "payid" ? `external:payid:${t.payid}:${lc(t.currency)}` : `external:bsb:${t.bsb}_${t.account}:${lc(t.currency)}`
  };
  function jpost(list, dr, cr, cents, c, memo, ref) {
    list.unshift({ id: U.uid(), ts: Date.now(), dr, cr, cents, currency: cur(c), memo: memo || "", ref: ref || "" });
  }
  const bal = (code, list = journal()) => list.reduce((s, j) => s + (j.dr === code ? j.cents : 0) - (j.cr === code ? j.cents : 0), 0);
  const reserve = c => bal(ACC.reserve(c)), inflight = c => bal(ACC.inflight(c)), returnedClr = c => bal(ACC.returned(c));
  const accountCodes = () => [...new Set(journal().flatMap(j => [j.dr, j.cr]))].sort();

  // ---------- validation ----------
  const toCents = v => { const s = String(v).trim(); if (!/^\d+(\.\d{1,2})?$/.test(s)) throw err("Amount must be a positive number with at most 2 decimals.", "BAD_AMOUNT", 422); const c = Math.round(parseFloat(s) * 100); if (c <= 0) throw err("Amount must be greater than zero.", "BAD_AMOUNT", 422); return c; };
  function validateDest(d) {
    const bsb = String(d.bsb || "").replace(/[\s-]/g, ""), account = String(d.account_number || d.account || "").replace(/\s/g, ""), payid = String(d.payid || "").trim();
    if (payid) { if (!/^[^\s]{3,80}$/.test(payid)) throw err("PayID looks invalid (phone, email, ABN or alias).", "BAD_DEST", 422); return { destType: "payid", bsb: "", account: "", payid }; }
    if (!/^\d{6}$/.test(bsb)) throw err("BSB must be 6 digits.", "BAD_DEST", 422);
    if (!/^\d{4,10}$/.test(account)) throw err("Account number must be 4 to 10 digits.", "BAD_DEST", 422);
    return { destType: "bsb", bsb, account, payid: "" };
  }
  const maskAcct = t => t.destType === "payid" ? t.payid.replace(/^(.{2}).*(.{2})$/, "$1…$2") : `${t.bsb.slice(0, 3)}-${t.bsb.slice(3)} ····${t.account.slice(-3)}`;

  // agent allowance (computed, never mints money): cap minus sum of that agent's transfers that are in flight or settled
  const spentBy = (agentId, c) => transfers().filter(t => t.agentId === agentId && t.currency === cur(c) && ["INITIATED", "PENDING_RAIL", "SETTLED"].includes(t.state)).reduce((s, t) => s + t.amountCents, 0);
  const allowanceLeft = (agentId, c) => { const cap = (allocs()[agentId] || {})[cur(c)] || 0; return cap - spentBy(agentId, c); };

  // ---------- step 1: request (idempotent) ----------
  async function requestTransfer(req, ctx = {}) {
    const key = String(ctx.idemKey || req.idemKey || "").trim();
    if (!key || key.length < 8) throw err("An idempotency key (min 8 characters) is required.", "NO_IDEM_KEY", 400);
    const c = cur(req.currency), cents = toCents(req.amount), dest = validateDest(req);
    const name = String(req.name || "").trim(); if (!name) throw err("Enter the account holder name.", "NO_NAME", 422);
    const fp = { amount_cents: cents, currency: c, destination_type: dest.destType, bsb: dest.bsb, account_number: dest.account, payid: dest.payid };
    const requestHash = await sha256(JSON.stringify(fp, Object.keys(fp).sort()));
    // everything below is synchronous, so it is atomic with respect to the rest of the app
    const existing = transfers().find(t => t.idemKey === key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw err("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "IDEM_CONFLICT", 422);
      return { transfer: existing, replayed: true, inProgress: !["SETTLED", "FAILED", "RETURNED"].includes(existing.state) };
    }
    if (ctx.agentId) {
      const left = allowanceLeft(ctx.agentId, c);
      if (left < cents) throw err(`Agent allowance too low (${fmt(Math.max(0, left), c)} left). The owner sets allowances in Vault → Payouts.`, "ALLOWANCE", 403);
    }
    if (reserve(c) - committed(c) < cents) throw err(`Not enough confirmed ${c} in the vault reserve (${fmt(reserve(c) - committed(c), c)} available). Only confirmed rail deposits fund the reserve.`, "INSUFFICIENT", 402);
    const t = { id: "T" + Date.now().toString(36).toUpperCase() + randomHex(2).toUpperCase(), idemKey: key, requestHash, agentId: ctx.agentId || "", source: ctx.source || "owner", currency: c, amountCents: cents, ...dest, name, reference: String(req.reference || "").slice(0, 60), state: "INITIATED", railId: "", ledgerId: null, created: Date.now(), history: [{ state: "INITIATED", ts: Date.now(), note: `Requested by ${ctx.source || "owner"}${ctx.agentId ? " (" + ctx.agentId + ")" : ""}` }] };
    saveTransfers([t, ...transfers()]);
    log("payout", `INITIATED ${t.id} ${fmt(cents, c)} to ${maskAcct(t)} by ${t.source}`); emit();
    const ar = rail().autoApproveCents;
    if (ar > 0 && cents <= ar && !ctx.agentId) { approve(t.id).catch(e => log("payout", `Auto-approve ${t.id} failed: ${e.message}`)); }
    return { transfer: t, replayed: false };
  }
  // funds already locked or waiting for approval
  const committed = c => transfers().filter(t => t.currency === cur(c) && t.state === "INITIATED").reduce((s, t) => s + t.amountCents, 0);

  function setState(t, state, note, extra = {}) {
    const next = { ...t, ...extra, state, history: [...t.history, { state, ts: Date.now(), note: note || "", eventId: extra.eventId }] };
    delete next.eventId;
    saveTransfers(transfers().map(x => x.id === t.id ? next : x)); return next;
  }

  // ---------- step 2/3: approve, lock funds, call the rail ----------
  async function approve(id) {
    const t = transfers().find(x => x.id === id); if (!t) throw err("Transfer not found.", "NOT_FOUND", 404);
    if (t.state !== "INITIATED") throw err(`Transfer is already ${t.state}.`, "BAD_STATE", 409);
    if (reserve(t.currency) < t.amountCents) throw err(`Reserve too low (${fmt(reserve(t.currency), t.currency)}).`, "INSUFFICIENT", 402);
    const j = journal(); jpost(j, ACC.inflight(t.currency), ACC.reserve(t.currency), t.amountCents, t.currency, `Lock ${t.id}`, t.id);
    Store.set(K.journal, j);
    const r = rail(), sim = r.mode === "simulator" ? { settleAt: Date.now() + Math.max(1, r.simDelaySec) * 1000, willFail: !!r.simFail } : null;
    const t2 = setState(t, "PENDING_RAIL", "Funds locked in transfer:in_flight; sending to the rail", { sim });
    log("payout", `PENDING_RAIL ${t.id} ${fmt(t.amountCents, t.currency)} (${r.mode})`); emit();
    await dispatch(t2);
    return transfers().find(x => x.id === id);
  }
  const canceled = id => { const t = transfers().find(x => x.id === id); if (!t || t.state !== "INITIATED") throw err("Only requests waiting for approval can be cancelled.", "BAD_STATE", 409); setState(t, "FAILED", "Cancelled by owner before sending"); log("payout", `Cancelled ${id}`); emit(); };

  function fillBody(tpl, t) {
    const vals = { amount: (t.amountCents / 100).toFixed(2), amount_cents: String(t.amountCents), currency: t.currency, bsb: t.bsb, account: t.account, payid: t.payid, name: t.name, reference: t.reference, id: t.id, idempotency_key: "rail-" + t.id };
    return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => k in vals ? JSON.stringify(String(vals[k])).slice(1, -1) : m);
  }
  async function dispatch(t) {
    const r = rail();
    if (r.mode === "simulator") return; // tick() delivers the signed event
    const conn = Finance.apis().find(a => a.id === r.apiId);
    if (!conn) { failTransfer(t.id, "No API connection selected for the rail (Vault → Rail & webhooks)."); return; }
    const body = fillBody(r.bodyTemplate, t);
    const res = await Finance.apiRequest(conn, { method: "POST", path: r.payoutPath, body, headers: { [r.idemHeader || "Idempotency-Key"]: "rail-" + t.id } });
    let json = null; try { json = JSON.parse(res.text); } catch { /* not JSON */ }
    const cur0 = transfers().find(x => x.id === t.id);
    if (res.ok) {
      const railId = String(getPath(json, r.railIdPath) || "");
      setState(cur0, "PENDING_RAIL", `Rail accepted (HTTP ${res.status})${railId ? ", id " + railId : ""}`, { railId: railId || cur0.railId });
      log("payout", `Rail accepted ${t.id} ${railId}`);
    } else if (res.status >= 400 && res.status < 500 && ![408, 409, 429].includes(res.status)) {
      failTransfer(t.id, `Rail rejected the payout (HTTP ${res.status}): ${String(res.text).slice(0, 200)}`);
    } else {
      // outcome unknown (timeout, network, 5xx): never send again, look it up with the idempotency key instead
      setState(cur0, "PENDING_RAIL", `Outcome unknown (HTTP ${res.status || "network error"}). Not re-sent; use “Check status”.`);
      log("payout", `Unknown outcome for ${t.id}; waiting for status check or webhook`);
    }
    emit();
  }
  function failTransfer(id, note, eventId) {
    const t = transfers().find(x => x.id === id); if (!t || t.state === "FAILED") return;
    if (t.state === "PENDING_RAIL") { const j = journal(); jpost(j, ACC.reserve(t.currency), ACC.inflight(t.currency), t.amountCents, t.currency, `Release ${t.id}: ${note}`, t.id); Store.set(K.journal, j); }
    setState(t, "FAILED", note, { eventId }); log("payout", `FAILED ${id}: ${note}`);
    Core.Bus.post({ from: { id: "vault", name: "Vault Service" }, to: { id: "conductor", name: "Conductor", group: "conductor" }, type: "alert", subject: "vault.transfer.failed", body: JSON.stringify({ transfer_id: id, amount: t.amountCents / 100, currency: t.currency, reason: note }) });
    emit();
  }

  // ---------- status lookup (when an outcome is unknown or no webhook arrives) ----------
  async function checkStatus(id) {
    const t = transfers().find(x => x.id === id); if (!t) throw err("Transfer not found.", "NOT_FOUND", 404);
    const r = rail();
    if (r.mode === "simulator") { await tick(true); return transfers().find(x => x.id === id); }
    const conn = Finance.apis().find(a => a.id === r.apiId); if (!conn) throw err("No API connection selected for the rail.", "NO_RAIL", 400);
    const path = t.railId ? r.statusPath.replace("{railId}", encodeURIComponent(t.railId)) : r.lookupPath.replace("{idem}", encodeURIComponent("rail-" + t.id));
    const res = await Finance.apiRequest(conn, { method: "GET", path });
    if (!res.ok) throw err(`Status lookup failed (HTTP ${res.status || "network"}).`, "LOOKUP", 502);
    let json = null; try { json = JSON.parse(res.text); } catch { throw err("The rail answered with something that is not JSON.", "LOOKUP", 502); }
    if (Array.isArray(json)) json = json[0] || null; else if (json && Array.isArray(json.data)) json = json.data[0] || null;
    if (!json) { setState(t, t.state, "Status lookup: the rail has no record of this payout"); emit(); return transfers().find(x => x.id === id); }
    const st = String(getPath(json, r.statusJsonPath) || "").toLowerCase(), has = list => String(list).split(",").map(s => s.trim().toLowerCase()).filter(Boolean).includes(st);
    const railId = String(getPath(json, r.railIdPath) || t.railId || "");
    const type = has(r.settledValues) ? "payout.settled" : has(r.failedValues) ? "payout.failed" : has(r.returnedValues) ? "payout.returned" : "";
    if (railId && railId !== t.railId) setState(transfers().find(x => x.id === id), t.state, `Status lookup found rail id ${railId}`, { railId });
    if (type) applyEvent({ eventId: `poll:${t.id}:${type}`, type, ref: t.id, amountCents: t.amountCents, currency: t.currency, settlementId: railId, source: "status-lookup" });
    else { setState(transfers().find(x => x.id === id), t.state, `Status lookup: rail says “${st || "unknown"}”`); emit(); }
    return transfers().find(x => x.id === id);
  }

  // ---------- events: signature check, dedupe, monotonic state ----------
  function normalize(j) {
    const g = (...ks) => { for (const k of ks) { const v = getPath(j, k); if (v != null && v !== "") return v; } return ""; };
    const t = String(g("type", "event", "event_type")).toLowerCase();
    const type = /deposit|received|credit/.test(t) ? "deposit.received" : /return|dishonou|revers/.test(t) ? "payout.returned" : /fail|reject|cancel/.test(t) ? "payout.failed" : /settle|complete|paid|success/.test(t) ? "payout.settled" : "";
    const amt = g("amount_cents", "data.amount_cents"), dec = g("amount", "data.amount");
    return { eventId: String(g("event_id", "id", "data.event_id")), type, ref: String(g("transfer_ref", "client_ref", "data.client_ref", "reference", "data.transfer_ref", "rail_id", "payout_id", "data.id")), railId: String(g("rail_id", "payout_id", "data.payout_id")),
      amountCents: amt !== "" ? Math.round(Number(amt)) : dec !== "" ? Math.round(parseFloat(dec) * 100) : null, currency: String(g("currency", "data.currency") || "").toUpperCase(), settlementId: String(g("settlement_id", "data.settlement_id") || ""), ts: g("ts", "timestamp", "created_at") };
  }
  const findTransfer = e => transfers().find(t => t.id === e.ref || (t.railId && (t.railId === e.ref || t.railId === e.railId)) || t.idemKey === e.ref || "rail-" + t.id === e.ref);

  async function ingestRaw({ raw, signature, timestamp, source = "webhook" }) {
    const r = rail();
    const secret = source === "simulator" ? r.webhookSecret || "" : r.webhookSecret;
    if (!secret) return { ok: false, status: 400, message: "Set a webhook secret first (Vault → Rail & webhooks)." };
    const ts = String(timestamp || "");
    if (r.sigScheme === "ts.raw") {
      const n = Number(ts); if (!n) return { ok: false, status: 401, message: "Missing timestamp." };
      const ms = n < 1e12 ? n * 1000 : n;
      if (Math.abs(Date.now() - ms) > (r.toleranceSec || 300) * 1000) return { ok: false, status: 401, message: "Timestamp outside the allowed window (possible replay)." };
    }
    const expect = await hmac(secret, r.sigScheme === "ts.raw" ? `${ts}.${raw}` : raw);
    const given = String(signature || "").trim().toLowerCase().replace(/^sha256=/, "");
    if (!safeEq(expect, given)) { log("security", `Rejected ${source} webhook: bad signature`); return { ok: false, status: 401, message: "Bad signature: event rejected." }; }
    let j; try { j = JSON.parse(raw); } catch { return { ok: false, status: 400, message: "Body is not valid JSON." }; }
    const ev = normalize(j); ev.source = source;
    if (!ev.eventId) return { ok: false, status: 422, message: "Event has no id." };
    if (!ev.type) return { ok: false, status: 422, message: "Unknown event type." };
    return { ok: true, ...applyEvent(ev) };
  }

  function mirror(fn) { try { const r = rail(); const a = r.reserveAccountId && Finance.account(r.reserveAccountId); if (a) return fn(a); } catch (e) { log("payout", "Ledger mirror skipped: " + e.message); } return null; }

  function applyEvent(ev) {
    const evs = events();
    if (evs.some(e => e.eventId === ev.eventId)) return { status: 200, duplicate: true, message: "Duplicate event ignored." };
    const rec = { eventId: ev.eventId, type: ev.type, ref: ev.ref, ts: Date.now(), source: ev.source || "", result: "" };
    const done = (result, extra = {}) => { rec.result = result; Store.set(K.events, [rec, ...events()].slice(0, 1000)); emit(); return { status: 200, result, ...extra }; };
    const c = cur(ev.currency);
    if (ev.type === "deposit.received") {
      if (!(ev.amountCents > 0)) return done("ignored: no amount");
      if (ev.settlementId && events().some(e => e.settlementId === ev.settlementId)) return done("ignored: settlement id already credited");
      rec.settlementId = ev.settlementId;
      const j = journal(); jpost(j, ACC.reserve(c), ACC.funding(c), ev.amountCents, c, `Confirmed deposit ${ev.settlementId || ev.eventId}`, ev.settlementId || ev.eventId); Store.set(K.journal, j);
      mirror(a => a.currency === c ? Finance.post({ type: "deposit", accountId: a.id, amount: ev.amountCents / 100, memo: "Confirmed rail deposit", ref: ev.settlementId }) : null);
      log("payout", `Reserve credited ${fmt(ev.amountCents, c)} (confirmed deposit)`);
      return done("reserve credited");
    }
    const t = findTransfer(ev);
    if (!t) { log("payout", `Event ${ev.eventId} did not match any transfer`); return done("unmatched transfer"); }
    if (ev.amountCents != null && ev.amountCents !== t.amountCents && ev.type !== "payout.failed") {
      setState(t, t.state, `Event ${ev.eventId} amount ${fmt(ev.amountCents, t.currency)} does not match ${fmt(t.amountCents, t.currency)}: held for review`);
      Core.Bus.post({ from: { id: "vault", name: "Vault Service" }, to: { id: "security-chief", name: "Security Chief", group: "security" }, type: "alert", subject: "vault.amount_mismatch", body: `Transfer ${t.id}: event ${ev.eventId} reports a different amount.` });
      return done("amount mismatch: held for review");
    }
    const want = ev.type === "payout.settled" ? "SETTLED" : ev.type === "payout.failed" ? "FAILED" : "RETURNED";
    const legal = { SETTLED: ["PENDING_RAIL"], FAILED: ["PENDING_RAIL"], RETURNED: ["SETTLED"] }[want];
    if (!legal.includes(t.state)) {
      const note = RANK[t.state] >= RANK[want] ? `stale ${ev.type} ignored (already ${t.state})` : `${ev.type} arrived while ${t.state}: ignored`;
      if (t.state === "FAILED" && want === "SETTLED") Core.Bus.post({ from: { id: "vault", name: "Vault Service" }, to: { id: "security-chief", name: "Security Chief", group: "security" }, type: "alert", subject: "vault.settled_after_failed", body: `Transfer ${t.id} was marked FAILED but the rail now reports it settled. Check the bank before retrying.` });
      return done(note);
    }
    if (want === "FAILED") { failTransfer(t.id, `Rail reported failure (${ev.eventId})`, ev.eventId); return done("transfer failed, funds released"); }
    const j = journal();
    if (want === "SETTLED") {
      jpost(j, ACC.dest(t), ACC.inflight(t.currency), t.amountCents, t.currency, `Settled ${t.id}`, ev.settlementId || t.id);
      Store.set(K.journal, j);
      const le = mirror(a => a.currency === t.currency ? Finance.post({ type: "payment", accountId: a.id, amount: t.amountCents / 100, memo: `Payout to ${t.name} ${maskAcct(t)}`, ref: ev.settlementId || t.railId || t.id }) : null);
      const t2 = setState(t, "SETTLED", `Settled by rail (${ev.source || "event"})${ev.settlementId ? ", settlement " + ev.settlementId : ""}`, { settlementId: ev.settlementId, ledgerId: le ? le.id : null, settledAt: Date.now(), eventId: ev.eventId });
      log("payout", `SETTLED ${t.id} ${fmt(t.amountCents, t.currency)}`);
      done("settled");
      onSettled(t2);
      return { status: 200, result: "settled" };
    }
    jpost(j, ACC.returned(t.currency), ACC.dest(t), t.amountCents, t.currency, `Returned ${t.id}`, ev.settlementId || t.id); Store.set(K.journal, j);
    mirror(a => a.currency === t.currency ? Finance.post({ type: "deposit", accountId: a.id, amount: t.amountCents / 100, memo: `Returned payout ${t.id}`, ref: ev.settlementId }) : null);
    setState(t, "RETURNED", "Returned or dishonoured after settlement. Funds are in returned clearing until reconciled.", { eventId: ev.eventId });
    log("payout", `RETURNED ${t.id}`);
    Core.Bus.post({ from: { id: "vault", name: "Vault Service" }, to: { id: "conductor", name: "Conductor", group: "conductor" }, type: "alert", subject: "vault.transfer.returned", body: JSON.stringify({ transfer_id: t.id, amount: t.amountCents / 100, currency: t.currency }) });
    return done("returned: reconcile it");
  }
  // returned money moves back into the reserve only on an explicit owner action
  function reconcileReturn(id) {
    const t = transfers().find(x => x.id === id); if (!t || t.state !== "RETURNED") throw err("Only returned transfers can be reconciled.", "BAD_STATE", 409);
    if (t.returnedToReserve) throw err("Already moved back to the reserve.", "BAD_STATE", 409);
    const j = journal(); jpost(j, ACC.reserve(t.currency), ACC.returned(t.currency), t.amountCents, t.currency, `Reconciled return ${t.id}`, t.id); Store.set(K.journal, j);
    saveTransfers(transfers().map(x => x.id === id ? { ...x, returnedToReserve: true } : x)); log("payout", `Return reconciled ${id}`); emit();
  }

  // runs after the SETTLED commit is durable
  function onSettled(t) {
    const body = { transfer_id: t.id, idempotency_key: t.idemKey, amount: t.amountCents / 100, currency: t.currency, destination: maskAcct(t), settlement_id: t.settlementId || "", settled_at: new Date(t.settledAt).toISOString() };
    Core.Bus.post({ from: { id: "vault", name: "Vault Service" }, to: { id: "conductor", name: "Conductor", group: "conductor" }, type: "event", subject: "vault.transfer.settled", body: JSON.stringify(body) });
    U.toast(`✅ ${fmt(t.amountCents, t.currency)} settled to ${maskAcct(t)}`, 6000);
    const r = rail(), ag = r.onArrivalAgent && Core.agent(r.onArrivalAgent);
    if (ag && Core.canCall().ok) Engine.runAgent(ag, `${r.onArrivalPrompt}\n\nSettlement:\n${JSON.stringify(body)}`).done.catch(() => {});
  }

  // ---------- reconciliation ----------
  function reconcile(c = cur()) {
    const r = rail(), acct = r.reserveAccountId && Finance.account(r.reserveAccountId);
    const rows = [["Reserve (confirmed)", reserve(c)], ["In flight", inflight(c)], ["Returned clearing", returnedClr(c)]];
    const j = journal(), debits = j.reduce((s, x) => s + x.cents, 0);
    const out = { currency: c, reserve: reserve(c), inflight: inflight(c), returned: returnedClr(c), rows, balanced: true, journalEntries: j.length, debits, finance: null, drift: null, account: acct ? acct.name : "" };
    // journal is balanced by construction (every line has one debit and one credit of the same amount); check the sum of all accounts is zero
    const sum = accountCodes().reduce((s, code) => s + bal(code, j.filter(x => x.currency === c)), 0); out.balanced = sum === 0;
    if (acct && acct.currency === c) { out.finance = Math.round(Finance.balance(acct.id) * 100); out.drift = out.finance - (out.reserve + out.inflight + out.returned); }
    return out;
  }
  function adoptOpening() {
    const c = cur(), r = reconcile(c); if (r.drift == null) throw err("Choose the reserve account first (Rail & webhooks).", "NO_ACCOUNT", 400);
    if (r.drift === 0) return 0;
    const j = journal();
    if (r.drift > 0) jpost(j, ACC.reserve(c), ACC.opening(c), r.drift, c, "Adopted opening balance from the cash ledger", "opening"); else jpost(j, ACC.opening(c), ACC.reserve(c), -r.drift, c, "Adjustment to match the cash ledger", "opening");
    Store.set(K.journal, j); log("payout", `Reserve adjusted by ${fmt(r.drift, c)} to match ${r.account}`); emit(); return r.drift;
  }

  // ---------- payees, allowances, rail config helpers ----------
  const savePayees = l => { Store.set(K.payees, l); emit(); };
  function setAllowance(agentId, c, cents) { const a = allocs(); a[agentId] = { ...(a[agentId] || {}), [cur(c)]: Math.max(0, Math.round(cents)) }; Store.set(K.alloc, a); log("payout", `Allowance for ${agentId}: ${fmt(a[agentId][cur(c)], c)}`); emit(); }
  const newSecret = () => "whsec_" + randomHex(24);

  // ---------- simulator + relay polling ----------
  let ticking = false;
  async function simEvent(t, type) {
    const r = rail(); if (!r.webhookSecret) { saveRail({ webhookSecret: newSecret() }); }
    const raw = JSON.stringify({ event_id: "sim_" + randomHex(6), type, transfer_ref: t.id, rail_id: "SIM-" + t.id, amount: (t.amountCents / 100).toFixed(2), currency: t.currency, settlement_id: "SIMSTL-" + randomHex(4).toUpperCase() });
    const ts = String(Math.floor(Date.now() / 1000)), sig = await hmac(rail().webhookSecret, rail().sigScheme === "ts.raw" ? `${ts}.${raw}` : raw);
    return ingestRaw({ raw, signature: sig, timestamp: ts, source: "simulator" });
  }
  async function tick(force) {
    if (ticking) return; ticking = true;
    try {
      const r = rail();
      for (const t of transfers().filter(x => x.state === "PENDING_RAIL" && x.sim && (force || x.sim.settleAt <= Date.now()))) await simEvent(t, t.sim.willFail ? "payout.failed" : "payout.settled");
      if (r.mode !== "simulator" && r.relayUrl && Core.online()) await pollRelay().catch(() => {});
    } finally { ticking = false; }
  }
  async function pollRelay() {
    const r = rail(); if (!r.relayUrl) throw err("Set the relay URL first.", "NO_RELAY", 400);
    const cursor = Store.get(K.cursor, 0);
    const res = await fetch(r.relayUrl.replace(/\/+$/, "") + "/events?after=" + cursor, { headers: r.relayToken ? { Authorization: "Bearer " + r.relayToken } : {} });
    if (!res.ok) throw err(`Relay answered HTTP ${res.status}.`, "RELAY", 502);
    const data = await res.json(); let n = 0, bad = 0;
    for (const e of data.events || []) { const out = await ingestRaw({ raw: e.raw, signature: e.signature, timestamp: e.timestamp, source: "relay" }); out.ok ? n++ : bad++; }
    if (typeof data.last === "number") Store.set(K.cursor, data.last);
    return { received: (data.events || []).length, applied: n, rejected: bad };
  }
  function start() { setInterval(() => { if (!document.hidden) tick().catch(() => {}); }, 4000); setTimeout(() => tick().catch(() => {}), 1500); }

  // ---------- agents: a structured request, never a direct send ----------
  const FENCE = /```(?:action|json)?\s*(\{[\s\S]*?\})\s*```/g;
  async function fromAgentText(agent, text) {
    if (!text || !/payout\.request/.test(text) || !Engine.FIN_GROUPS.has(agent.group)) return "";
    const notes = [];
    for (const m of String(text).matchAll(FENCE)) {
      let j; try { j = JSON.parse(m[1]); } catch { continue; }
      if (j.action !== "payout.request") continue;
      try {
        const p = payees().find(x => x.id === j.payee || x.name.toLowerCase() === String(j.payee || "").toLowerCase());
        if (!p) throw err(`Unknown payee “${j.payee}”. Agents can only pay saved payees (Vault → Payouts → Payees).`, "NO_PAYEE", 403);
        const key = "agent_" + agent.id + "_" + (await sha256(JSON.stringify([agent.id, j.amount, j.currency, p.id, j.reference || "", new Date().toDateString()]))).slice(0, 16);
        const out = await requestTransfer({ amount: j.amount, currency: j.currency || rail().currency, bsb: p.bsb, account_number: p.account, payid: p.payid, name: p.name, reference: j.reference }, { idemKey: key, agentId: agent.id, source: "agent" });
        notes.push(`Vault: payout ${out.replayed ? "already requested" : "requested"} ${out.transfer.id} (${fmt(out.transfer.amountCents, out.transfer.currency)} to ${p.name}). It will not be sent until the owner approves it.`);
        Core.Bus.post({ from: Core.ref(agent), to: { id: "vault", name: "Vault Service" }, type: "request", subject: "vault.transfer.request", body: `${out.transfer.id}: ${fmt(out.transfer.amountCents, out.transfer.currency)} to ${p.name}. Awaiting owner approval.` });
      } catch (e) { notes.push(`Vault: payout request refused. ${e.message}`); log("payout", `Agent ${agent.id} request refused: ${e.message}`); }
    }
    return notes.length ? "\n\n> " + notes.join("\n> ") : "";
  }

  // ---------- summary for agents & dashboards ----------
  function stats(c = cur()) {
    const all = transfers().filter(t => t.currency === c), day = 864e5, now = Date.now();
    const sum = f => all.filter(f).reduce((s, t) => s + t.amountCents, 0);
    return { currency: c, reserve: reserve(c), available: reserve(c) - committed(c), inflight: inflight(c), awaiting: sum(t => t.state === "INITIATED"), awaitingN: all.filter(t => t.state === "INITIATED").length,
      settled: sum(t => t.state === "SETTLED"), settled30: sum(t => t.state === "SETTLED" && now - (t.settledAt || 0) < 30 * day), settledToday: sum(t => t.state === "SETTLED" && now - (t.settledAt || 0) < day), returned: sum(t => t.state === "RETURNED" && !t.returnedToReserve), failedN: all.filter(t => t.state === "FAILED").length, count: all.length };
  }
  function snapshotText() {
    const s = stats(), r = rail();
    if (!s.count && !s.reserve) return "";
    return `Payout rail (${r.mode}${r.mode === "simulator" ? ", no real money" : ""}): reserve ${fmt(s.reserve, s.currency)}, in flight ${fmt(s.inflight, s.currency)}, awaiting owner approval ${s.awaitingN} (${fmt(s.awaiting, s.currency)}), settled last 30 days ${fmt(s.settled30, s.currency)}, returned not reconciled ${fmt(s.returned, s.currency)}. To ask for a payout, include a fenced block {"action":"payout.request","payee":"<saved payee name>","amount":"250.00","currency":"AUD","reference":"…"}; it is only a request and the owner must approve it.`;
  }

  // ---------- terminal ----------
  const find = p => transfers().find(t => t.id.toLowerCase() === String(p).toLowerCase()) || transfers().find(t => t.id.toLowerCase().startsWith(String(p).toLowerCase()));
  async function terminal(cmd, parts) {
    const c = cur();
    try {
      switch (cmd) {
        case "reserve": { const s = stats(c); return `Reserve ${fmt(s.reserve, c)} · available ${fmt(s.available, c)} · in flight ${fmt(s.inflight, c)} · awaiting approval ${fmt(s.awaiting, c)}`; }
        case "transfers": { const n = Math.min(40, parseInt(parts[1], 10) || 10); return transfers().slice(0, n).map(t => `${t.id.padEnd(12)} ${t.state.padEnd(13)} ${fmt(t.amountCents, t.currency).padStart(14)}  ${maskAcct(t)}  ${t.name}`).join("\n") || "No transfers yet."; }
        case "payout": {
          if (parts.length < 4) return "Usage: payout <amount> <currency> <payee name | bsb-account | payid> [reference]\n  e.g. payout 250 AUD 062000-12345678 Owner Savings\nA request waits for approve <id>.";
          const rest = parts.slice(3).join(" "), dest = parts[3];
          const p = payees().filter(x => (rest.toLowerCase() + " ").startsWith(x.name.toLowerCase() + " ")).sort((a, b) => b.name.length - a.name.length)[0];
          let d = {}, name = "";
          if (p) { d = { bsb: p.bsb, account_number: p.account, payid: p.payid }; name = p.name; }
          else if (/^\d{6}-\d{4,10}$/.test(dest)) { const [b, a] = dest.split("-"); d = { bsb: b, account_number: a }; name = parts.slice(4).join(" ") || "Account holder"; }
          else if (/@|^\+?\d{8,}$/.test(dest)) { d = { payid: dest }; name = parts.slice(4).join(" ") || dest; }
          else return `No saved payee “${dest}”. Use a saved payee name, bsb-account (062000-12345678) or a PayID.`;
          const out = await requestTransfer({ amount: parts[1], currency: parts[2], ...d, name, reference: p ? rest.slice(p.name.length).trim() : "" }, { idemKey: "term_" + randomHex(8), source: "terminal" });
          return `${out.transfer.id} created (${fmt(out.transfer.amountCents, out.transfer.currency)} to ${out.transfer.name}). Awaiting your approval: approve ${out.transfer.id}`;
        }
        case "approve": { const t = find(parts[1]); if (!t) return "Usage: approve <transfer id>"; const r = await approve(t.id); return `${r.id} is ${r.state}.${rail().mode === "simulator" ? " (simulated rail, no real money)" : ""}`; }
        case "check": { const t = find(parts[1]); if (!t) return "Usage: check <transfer id>"; const r = await checkStatus(t.id); return `${r.id} is ${r.state}. ${(r.history[r.history.length - 1] || {}).note || ""}`; }
        case "reconcile": { const r = reconcile(c); return `Reconcile ${c}\n  reserve ${fmt(r.reserve, c)}\n  in flight ${fmt(r.inflight, c)}\n  returned clearing ${fmt(r.returned, c)}\n  journal ${r.balanced ? "balanced" : "NOT BALANCED"} (${r.journalEntries} entries)\n` + (r.drift == null ? "  cash ledger: choose a reserve account in Rail & webhooks" : `  cash ledger (${r.account}) ${fmt(r.finance, c)} · drift ${fmt(r.drift, c)}`); }
        case "rail": { const r = rail(); return `Rail mode: ${r.mode}${r.mode === "simulator" ? " (simulated, no real money)" : ""}\nCurrency: ${r.currency}\nWebhook secret: ${r.webhookSecret ? "set" : "NOT set"}\nRelay: ${r.relayUrl || "none"}\nAuto-approve up to: ${fmt(r.autoApproveCents, c)}`; }
      }
    } catch (e) { return "Error: " + e.message; }
    return null;
  }
  const HELP = ["  reserve | transfers [n] | rail | reconcile", "  payout <amount> <cur> <payee|bsb-acct|payid> [ref]   (waits for approval)", "  approve <id> | check <id>"].join("\n");

  return {
    STATES, K, DEFAULT_RAIL, rail, saveRail, transfers, journal, events, payees, savePayees, allocs, setAllowance, allowanceLeft, spentBy,
    requestTransfer, approve, cancel: canceled, checkStatus, ingestRaw, applyEvent, reconcile, adoptOpening, reconcileReturn, pollRelay, tick, start,
    fromAgentText, stats, snapshotText, terminal, HELP, accountCodes, bal, fmt, maskAcct, newSecret, hmac, sha256, randomHex, cur, ACC
  };
})();
