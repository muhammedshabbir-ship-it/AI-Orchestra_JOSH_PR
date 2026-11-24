// Vault UI for payouts: dashboard, transfers, rail & webhooks, journal. Used by the Vault Terminal view.
window.PayoutsUI = (() => {
  "use strict";
  const { esc } = U;
  const P = () => window.Payouts, fmt = (c, cur) => P().fmt(c, cur || P().cur());
  const STATE_CLS = { INITIATED: "warn", PENDING_RAIL: "warn", SETTLED: "ok", FAILED: "bad", RETURNED: "bad" };
  const tag = s => `<span class="tag st ${STATE_CLS[s] || ""}">${s.replace("_", " ")}</span>`;
  const tile = (l, v, s, cls) => `<div class="tile ${cls || ""}"><div class="l">${esc(l)}</div><div class="v">${v}</div>${s ? `<div class="s muted small">${s}</div>` : ""}</div>`;
  const modeChip = r => r.mode === "simulator" ? `<span class="chip-mode sim">SIMULATOR · no real money</span>` : `<span class="chip-mode live">${esc(r.mode.toUpperCase())} rail</span>`;

  // ---------- dashboard (top of the Overview tab) ----------
  function bars14() {
    const day = 864e5, now = new Date(); now.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 14 }, (_, i) => { const d = now.getTime() - (13 - i) * day; return { d, v: 0 }; });
    for (const t of P().transfers()) if (t.state === "SETTLED" && t.currency === P().cur() && t.settledAt) { const k = days.find(x => t.settledAt >= x.d && t.settledAt < x.d + day); if (k) k.v += t.amountCents; }
    const max = Math.max(1, ...days.map(x => x.v)), W = 280, H = 70, bw = W / 14;
    return `<svg viewBox="0 0 ${W} ${H + 14}" class="spark" role="img" aria-label="Settled volume, last 14 days">${days.map((x, i) => { const h = Math.round((x.v / max) * H); return `<rect x="${i * bw + 2}" y="${H - h}" width="${bw - 4}" height="${Math.max(h, x.v ? 2 : 1)}" rx="2" class="${x.v ? "sb" : "sb0"}"><title>${new Date(x.d).toLocaleDateString()}: ${fmt(x.v)}</title></rect>`; }).join("")}
      <text x="0" y="${H + 11}" class="axis">${new Date(days[0].d).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</text><text x="${W}" y="${H + 11}" text-anchor="end" class="axis">today</text></svg>`;
  }

  // The vault dial: a combination-lock ring showing where the payout money is right now.
  let dialDrawn = false;
  function dial(s) {
    const c = s.currency, R = 74, C = 2 * Math.PI * R;
    const segs = [["Available reserve", s.available, "var(--accent)"], ["In flight", s.inflight, "var(--silver)"], ["Awaiting approval", s.awaiting, "#6f8a7d"], ["Returned", s.returned, "var(--danger)"]];
    const total = segs.reduce((n, x) => n + Math.max(0, x[1]), 0);
    let off = 0, arcs = "";
    if (total > 0) for (const [, v, col] of segs) { if (v <= 0) continue; const len = Math.max(2, (v / total) * C - 3); arcs += `<circle class="darc" cx="110" cy="110" r="${R}" stroke="${col}" stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" stroke-dashoffset="${(-off).toFixed(1)}" ${dialDrawn ? "" : `style="--len:${len.toFixed(1)}"`}/>`; off += (v / total) * C; }
    const ticks = Array.from({ length: 72 }, (_, i) => { const a = i * 5 * Math.PI / 180, major = i % 6 === 0, r1 = major ? 88 : 92, r2 = 100; return `<line x1="${(110 + r1 * Math.sin(a)).toFixed(1)}" y1="${(110 - r1 * Math.cos(a)).toFixed(1)}" x2="${(110 + r2 * Math.sin(a)).toFixed(1)}" y2="${(110 - r2 * Math.cos(a)).toFixed(1)}" class="${major ? "tk maj" : "tk"}"/>`; }).join("");
    const html = `<figure class="dial ${dialDrawn ? "" : "draw"}"><svg viewBox="0 0 220 220" role="img" aria-label="Where the payout money is: reserve ${esc(fmt(s.available, c))}, in flight ${esc(fmt(s.inflight, c))}"><g>${ticks}</g><circle cx="110" cy="110" r="${R}" class="dtrack"/><g transform="rotate(-90 110 110)">${arcs}</g><text x="110" y="104" text-anchor="middle" class="dl">Reserve</text><text x="110" y="128" text-anchor="middle" class="dv">${esc(fmt(s.available, c))}</text></svg>
      <figcaption>${segs.map(([n, v, col]) => `<span><i style="background:${col}"></i>${esc(n)} <b>${esc(fmt(Math.max(0, v), c))}</b></span>`).join("")}</figcaption></figure>`;
    dialDrawn = true; return html;
  }
  function dashboard() {
    const r = P().rail(), s = P().stats(), rc = P().reconcile(), nw = Finance.netWorth(), tr = P().transfers(), evs = P().events();
    const awaiting = tr.filter(t => t.state === "INITIATED");
    const alerts = [];
    if (r.mode === "simulator") alerts.push(`<div class="alert warn">The payout rail is in <b>simulator</b> mode: transfers settle in a few seconds but no real money moves. To go live: Rail & webhooks → connect your payment provider.</div>`);
    if (!r.webhookSecret) alerts.push(`<div class="alert warn">No webhook secret yet. Create one in Rail & webhooks so settlement events can be verified.</div>`);
    if (rc.drift) alerts.push(`<div class="alert fail">Cash ledger and payout journal differ by ${fmt(rc.drift)}. Open the Journal tab to reconcile.</div>`);
    if (s.returned > 0) alerts.push(`<div class="alert fail">${fmt(s.returned)} was returned by the bank and still needs reconciling (Payouts tab).</div>`);
    const stages = ["INITIATED", "PENDING_RAIL", "SETTLED", "RETURNED", "FAILED"], counts = Object.fromEntries(stages.map(x => [x, tr.filter(t => t.state === x).length])), tot = Math.max(1, tr.length);
    return `<div class="hero"><div class="hero-main"><div class="hero-top">${modeChip(r)}<span class="muted small">Webhook secret ${r.webhookSecret ? "set" : "<b>missing</b>"} · ${evs.length} events · last ${evs[0] ? U.ago(evs[0].ts) : "never"}</span></div>
        <div class="muted small">Available to send</div><div class="fig big">${fmt(s.available)}</div><div class="muted small">All holdings: ${U.money(nw.total, nw.base)}${nw.missing.length ? ` (leaves out ${esc(nw.missing.join(", "))} until an exchange rate is set in Cash vault → Rates &amp; prices)` : ""}</div>
        <div class="row"><button class="btn primary" data-p="new">New transfer</button><button class="btn" data-p="deposit-sim" ${r.mode === "simulator" ? "" : "hidden"}>Simulate incoming deposit</button><button class="btn" data-p="poll" ${r.relayUrl ? "" : "hidden"}>Check relay now</button></div></div>${dial(s)}</div>
      ${alerts.join("")}
      ${awaiting.length ? `<div class="card attn"><h3>Waiting for your approval (${awaiting.length})</h3>${awaiting.map(t => `<div class="li"><div class="row between"><div><b>${fmt(t.amountCents, t.currency)}</b> → ${esc(t.name)} <span class="muted small">${esc(P().maskAcct(t))}${t.reference ? " · " + esc(t.reference) : ""}</span><div class="muted small">by ${esc(t.source)}${t.agentId ? " (" + esc(t.agentId) + ")" : ""} · ${U.ago(t.created)}</div></div>
        <div class="row nowrap"><button class="btn small primary" data-p="approve" data-id="${t.id}">Approve &amp; send</button><button class="btn small" data-p="cancel" data-id="${t.id}">Decline</button></div></div></div>`).join("")}</div>` : ""}
      <div class="ledger"><div><span>Available reserve</span><b>${fmt(s.available)}</b><em>confirmed ${fmt(s.reserve)}</em></div><div><span>In flight</span><b>${fmt(s.inflight)}</b><em>locked, waiting for the rail</em></div><div><span>Settled in 30 days</span><b>${fmt(s.settled30)}</b><em>today ${fmt(s.settledToday)}</em></div><div><span>Needs attention</span><b class="${s.returned ? "bad" : ""}">${fmt(s.returned + s.awaiting)}</b><em>${s.awaitingN} to approve${s.returned ? ", returned money" : ""}</em></div></div>
      <div class="grid2"><div class="card"><h3>Settled volume · 14 days</h3>${bars14()}</div>
        <div class="card"><h3>Transfer pipeline</h3>${stages.map(x => `<div class="pipe"><span class="pl">${tag(x)}</span><span class="pbar"><i style="width:${Math.round(100 * counts[x] / tot)}%"></i></span><span class="pn">${counts[x]}</span></div>`).join("")}
        <div class="muted small">${rc.balanced ? "✅ Journal balanced" : "⚠ Journal NOT balanced"} · ${rc.journalEntries} entries${rc.drift == null ? " · choose a reserve account to compare with the cash ledger" : rc.drift === 0 ? " · cash ledger matches" : ""}</div></div></div>
      <div class="card"><div class="row between"><h3>Recent transfers</h3><button class="btn small" data-tab="payouts">All transfers</button></div>${tr.slice(0, 5).map(t => `<div class="li"><div class="row between"><span>${tag(t.state)} <b>${fmt(t.amountCents, t.currency)}</b> → ${esc(t.name)} <span class="muted small">${esc(P().maskAcct(t))}</span></span><span class="muted small">${U.ago(t.created)}</span></div></div>`).join("") || `<p class="muted">No transfers yet. Fund the reserve with a confirmed deposit, then create a transfer.</p>`}</div>`;
  }
  const events = () => P().events();

  // ---------- transfers ----------
  function transfersTab() {
    const tr = P().transfers(), pays = P().payees(), agents = Core.agents().filter(a => Engine.FIN_GROUPS.has(a.group)), al = P().allocs(), c = P().cur();
    return `<div class="row"><button class="btn primary" data-p="new">New transfer</button><button class="btn" data-p="payee-add">Saved payee</button><button class="btn" data-p="csv">Export CSV</button></div>
      <p class="muted small">Every transfer follows INITIATED → PENDING RAIL → SETTLED, with FAILED and RETURNED handled by explicit entries. Nothing is sent until you approve it.</p>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>ID</th><th>Created</th><th>State</th><th class="num">Amount</th><th>To</th><th>By</th><th></th></tr></thead><tbody>${tr.map(t => `<tr><td><code>${t.id}</code></td><td>${U.ago(t.created)}</td><td>${tag(t.state)}</td><td class="num">${fmt(t.amountCents, t.currency)}</td><td>${esc(t.name)}<div class="muted small">${esc(P().maskAcct(t))}</div></td><td>${esc(t.source)}${t.agentId ? `<div class="muted small">${esc(t.agentId)}</div>` : ""}</td>
        <td>${t.state === "INITIATED" ? `<button class="btn small primary" data-p="approve" data-id="${t.id}">Approve &amp; send</button><button class="btn small" data-p="cancel" data-id="${t.id}">Decline</button>` : ""}${t.state === "PENDING_RAIL" ? `<button class="btn small" data-p="check" data-id="${t.id}">Check status</button>` : ""}${t.state === "RETURNED" && !t.returnedToReserve ? `<button class="btn small primary" data-p="reconcile-return" data-id="${t.id}">Move back to reserve</button>` : ""}
        <details><summary class="muted small">History</summary>${t.history.map(h => `<div class="muted small">${new Date(h.ts).toLocaleTimeString()} · <b>${h.state}</b> ${esc(h.note || "")}</div>`).join("")}<div class="muted small">key: <code>${esc(t.idemKey)}</code></div></details></td></tr>`).join("") || `<tr><td colspan="7" class="muted">No transfers yet.</td></tr>`}</tbody></table></div>
      <div class="grid2"><div class="card"><h3>Saved payees</h3><p class="muted small">Agents can only pay payees saved here. Owner transfers can go to any valid account.</p>${pays.map(p => `<div class="li"><div class="row between"><span><b>${esc(p.name)}</b> <span class="muted small">${p.payid ? "PayID " + esc(p.payid) : esc(p.bsb) + " " + esc(p.account)}</span></span><span class="row nowrap"><button class="btn small" data-p="payee-edit" data-id="${p.id}">Edit</button><button class="btn small danger" data-p="payee-del" data-id="${p.id}">✕</button></span></div></div>`).join("") || `<p class="muted">None yet.</p>`}</div>
        <div class="card"><h3>Agent allowances (${esc(c)})</h3><p class="muted small">How much each agent may request in total. Default is zero. A request still needs your approval.</p>${agents.map(a => `<div class="li"><div class="row between"><span>${esc(a.name)} <span class="muted small">left ${fmt(Math.max(0, P().allowanceLeft(a.id, c)), c)}</span></span><button class="btn small" data-p="allow" data-id="${a.id}">Set</button></div></div>`).join("") || `<p class="muted">No finance agents.</p>`}</div></div>`;
  }

  // ---------- rail & webhooks ----------
  function railTab() {
    const r = P().rail(), evs = P().events(), api = Finance.apis().find(a => a.id === r.apiId), acct = Finance.account(r.reserveAccountId);
    return `<div class="card"><div class="row between"><h3>Payout rail</h3>${modeChip(r)}</div>
      <div class="kv"><span>Mode</span><b>${esc(r.mode)}</b><span>Currency</span><b>${esc(r.currency)}</b><span>Reserve account (cash ledger)</span><b>${acct ? esc(acct.name) : "not chosen"}</b><span>Payment API connection</span><b>${api ? esc(api.name) : r.mode === "simulator" ? "not needed in simulator" : "not chosen"}</b>
      <span>Webhook secret</span><b>${r.webhookSecret ? "set (" + r.webhookSecret.slice(0, 6) + "…)" : "not set"}</b><span>Signature</span><b>${esc(r.sigScheme === "ts.raw" ? "HMAC-SHA256 of timestamp.body" : "HMAC-SHA256 of body")}</b><span>Relay</span><b>${esc(r.relayUrl || "none")}</b><span>Auto-approve up to</span><b>${r.autoApproveCents ? fmt(r.autoApproveCents) : "never (every transfer needs approval)"}</b></div>
      <div class="row"><button class="btn primary" data-p="rail-edit">Edit rail settings</button><button class="btn" data-p="secret">Generate webhook secret</button><button class="btn" data-p="poll" ${r.relayUrl ? "" : "hidden"}>Check relay now</button><button class="btn" data-p="paste">Paste a webhook</button><button class="btn" data-p="deposit-sim" ${r.mode === "simulator" ? "" : "hidden"}>Simulate incoming deposit</button></div>
      <p class="muted small">Going live: choose “live” or “sandbox”, connect the provider in API hub, set the payout path and body template, then point the provider's webhooks at your relay (server/relay.js). Test in the provider's sandbox before using real money.</p></div>
      <div class="card"><h3>Event log</h3><div class="tblwrap"><table class="tbl"><thead><tr><th>When</th><th>Event</th><th>Type</th><th>Transfer</th><th>Source</th><th>Result</th></tr></thead><tbody>${evs.slice(0, 40).map(e => `<tr><td>${U.ago(e.ts)}</td><td><code>${esc(e.eventId)}</code></td><td>${esc(e.type)}</td><td>${esc(e.ref || "")}</td><td>${esc(e.source)}</td><td>${esc(e.result)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No events yet.</td></tr>`}</tbody></table></div></div>`;
  }

  // ---------- journal & reconciliation ----------
  function journalTab() {
    const c = P().cur(), rc = P().reconcile(c), codes = P().accountCodes(), j = P().journal();
    return `<div class="tiles">${tile("Reserve", fmt(rc.reserve), "vault:reserve")}${tile("In flight", fmt(rc.inflight), "transfer:in_flight")}${tile("Returned clearing", fmt(rc.returned), "transfer:returned_clearing")}${tile("Journal", rc.balanced ? "Balanced ✅" : "NOT balanced", `${rc.journalEntries} entries`, rc.balanced ? "" : "bad")}</div>
      <div class="card"><h3>Reconciliation with the cash ledger</h3>${rc.drift == null ? `<p class="muted">Choose a reserve account (Rail & webhooks) to compare.</p>` : `<div class="kv"><span>Cash ledger: ${esc(rc.account)}</span><b>${fmt(rc.finance)}</b><span>Reserve + in flight + returned</span><b>${fmt(rc.reserve + rc.inflight + rc.returned)}</b><span>Difference</span><b class="${rc.drift ? "bad" : ""}">${fmt(rc.drift)}</b></div>
        ${rc.drift ? `<p class="muted small">A difference appears when the cash ledger was changed by hand or before the payout rail was used. Adopting the cash ledger balance records the difference in the journal as an opening or adjustment entry.</p><button class="btn" data-p="adopt">Adopt cash ledger balance as reserve</button>` : `<p class="muted small">Zero drift: every dollar in the cash ledger is accounted for in the journal.</p>`}`}</div>
      <div class="card"><h3>Chart of accounts</h3><div class="tblwrap"><table class="tbl"><tbody>${codes.map(k => `<tr><td><code>${esc(k)}</code></td><td class="num">${fmt(P().bal(k, j.filter(x => x.currency === c)))}</td></tr>`).join("") || `<tr><td class="muted">No entries yet.</td></tr>`}</tbody></table></div></div>
      <div class="card"><div class="row between"><h3>Journal</h3><button class="btn small" data-p="csv-journal">Export CSV</button></div><p class="muted small">Entries are never edited. Mistakes are fixed with a reversing entry.</p><div class="tblwrap"><table class="tbl"><thead><tr><th>When</th><th>Debit</th><th>Credit</th><th class="num">Amount</th><th>Memo</th></tr></thead><tbody>${j.slice(0, 60).map(x => `<tr><td>${new Date(x.ts).toLocaleString()}</td><td><code>${esc(x.dr)}</code></td><td><code>${esc(x.cr)}</code></td><td class="num">${fmt(x.cents, x.currency)}</td><td>${esc(x.memo)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Empty.</td></tr>`}</tbody></table></div></div>`;
  }

  // ---------- actions ----------
  const accOpts = () => [{ value: "", label: "None" }, ...Finance.accounts().filter(a => !a.archived).map(a => ({ value: a.id, label: `${a.name} (${a.currency})` }))];
  async function newTransfer() {
    const pays = P().payees();
    const v = await U.form("New transfer", [
      ...(pays.length ? [{ key: "payee", label: "Saved payee (optional)", type: "select", options: [{ value: "", label: "Enter details below" }, ...pays.map(p => ({ value: p.id, label: p.name }))] }] : []),
      { key: "name", label: "Account holder name" }, { key: "bsb", label: "BSB (6 digits)", placeholder: "062-000" }, { key: "account_number", label: "Account number" }, { key: "payid", label: "or PayID (phone, email, ABN)" },
      { key: "amount", label: "Amount", required: true, placeholder: "250.00" }, { key: "currency", label: "Currency", value: P().cur() }, { key: "reference", label: "Reference (shown to the receiver)" }
    ], { currency: P().cur() }, { submit: "Create request", intro: "Creates a request. It is only sent when you approve it." });
    if (!v) return;
    const p = v.payee && pays.find(x => x.id === v.payee);
    const req = p ? { ...v, name: p.name, bsb: p.bsb, account_number: p.account, payid: p.payid } : v;
    const out = await P().requestTransfer(req, { idemKey: "own_" + P().randomHex(8), source: "owner" });
    U.toast(`Request ${out.transfer.id} created. Approve it to send.`);
  }
  async function payeeForm(id) {
    const p = id ? P().payees().find(x => x.id === id) : null;
    const v = await U.form(p ? "Edit payee" : "Saved payee", [{ key: "name", label: "Name", required: true }, { key: "bsb", label: "BSB" }, { key: "account", label: "Account number" }, { key: "payid", label: "or PayID" }], p || {});
    if (!v) return;
    if (!v.payid && !(v.bsb && v.account)) throw new Error("Enter a BSB and account number, or a PayID.");
    P().savePayees(p ? P().payees().map(x => x.id === id ? { ...x, ...v } : x) : [...P().payees(), { id: "p" + U.uid(), ...v }]);
  }
  async function railForm() {
    const r = P().rail(), apis = Finance.apis();
    const v = await U.form("Payout rail settings", [
      { key: "mode", label: "Mode", type: "select", options: [{ value: "simulator", label: "Simulator (demo, no real money)" }, { value: "sandbox", label: "Sandbox (provider test mode)" }, { value: "live", label: "Live (real money)" }] },
      { key: "currency", label: "Currency" }, { key: "reserveAccountId", label: "Reserve account in the cash ledger", type: "select", options: accOpts() },
      { key: "apiId", label: "Payment API connection (API hub)", type: "select", options: [{ value: "", label: "None" }, ...apis.map(a => ({ value: a.id, label: a.name }))] },
      { key: "payoutPath", label: "Payout path (POST)" }, { key: "bodyTemplate", label: "Payout body (JSON template)", type: "textarea", rows: 5, hint: "{{amount}} {{amount_cents}} {{currency}} {{bsb}} {{account}} {{payid}} {{name}} {{reference}} {{id}}" },
      { key: "idemHeader", label: "Idempotency header name" }, { key: "railIdPath", label: "Rail payout id in the response (JSON path)" }, { key: "statusPath", label: "Status path (GET, {railId})" }, { key: "lookupPath", label: "Lookup by idempotency key ({idem})" }, { key: "statusJsonPath", label: "Status field in the status response" },
      { key: "settledValues", label: "Status values meaning settled" }, { key: "failedValues", label: "Status values meaning failed" }, { key: "returnedValues", label: "Status values meaning returned" },
      { key: "webhookSecret", label: "Webhook signing secret", type: "password" }, { key: "sigScheme", label: "Signature scheme", type: "select", options: [{ value: "ts.raw", label: "HMAC-SHA256 of timestamp.body" }, { value: "raw", label: "HMAC-SHA256 of body" }] },
      { key: "relayUrl", label: "Webhook relay URL" }, { key: "relayToken", label: "Relay token", type: "password" },
      { key: "autoApprove", label: "Auto-approve owner transfers up to (0 = never)", type: "number", step: "any" },
      { key: "simDelaySec", label: "Simulator: seconds until settlement", type: "number" }, { key: "simFail", label: "Simulator: make transfers fail", type: "checkbox" },
      { key: "onArrivalAgent", label: "After settlement, ask this agent for a note", type: "select", options: [{ value: "", label: "Nobody" }, ...Core.agents().map(a => ({ value: a.id, label: a.name }))] }
    ], { ...r, autoApprove: r.autoApproveCents / 100 }, { submit: "Save" });
    if (!v) return;
    if (v.mode === "live" && r.mode !== "live" && !confirm("Live mode sends real money through your provider when you approve transfers. Continue?")) return;
    const { autoApprove, ...rest } = v;
    P().saveRail({ ...rest, currency: String(rest.currency || "AUD").toUpperCase(), autoApproveCents: Math.round((autoApprove || 0) * 100), simDelaySec: rest.simDelaySec || 6 });
    Core.Audit.log("payout", `Rail settings saved (mode ${rest.mode})`);
  }
  async function pasteWebhook() {
    const v = await U.form("Paste a webhook", [{ key: "raw", label: "Raw body (exactly as received)", type: "textarea", rows: 6, required: true }, { key: "signature", label: "Signature header value", required: true }, { key: "timestamp", label: "Timestamp header value" }], {}, { submit: "Verify and apply" });
    if (!v) return;
    const out = await P().ingestRaw({ raw: v.raw.trim(), signature: v.signature, timestamp: v.timestamp, source: "pasted" });
    U.toast(out.ok ? (out.duplicate ? "Duplicate: already applied." : "Applied: " + out.result) : "Rejected: " + out.message, 6000);
  }
  async function simDeposit() {
    const v = await U.form("Simulate an incoming deposit", [{ key: "amount", label: "Amount", required: true, value: "1000.00" }], { amount: "1000.00" }, { submit: "Simulate" });
    if (!v) return;
    const r = P().rail(); if (!r.webhookSecret) P().saveRail({ webhookSecret: P().newSecret() });
    const sec = P().rail().webhookSecret, raw = JSON.stringify({ event_id: "simdep_" + P().randomHex(6), type: "deposit.received", amount: Number(v.amount).toFixed(2), currency: P().cur(), settlement_id: "SIMDEP-" + P().randomHex(4).toUpperCase() });
    const ts = String(Math.floor(Date.now() / 1000)), sig = await P().hmac(sec, P().rail().sigScheme === "ts.raw" ? `${ts}.${raw}` : raw);
    const out = await P().ingestRaw({ raw, signature: sig, timestamp: ts, source: "simulator" });
    U.toast(out.ok ? "Simulated deposit credited to the reserve." : out.message);
  }
  async function act(a, id) {
    try {
      switch (a) {
        case "new": await newTransfer(); break;
        case "approve": { const t = P().transfers().find(x => x.id === id), r = P().rail(); if (!confirm(`Send ${fmt(t.amountCents, t.currency)} to ${t.name} (${P().maskAcct(t)})?${r.mode === "simulator" ? "\n\nSimulator mode: no real money moves." : "\n\nThis moves real money through your provider."}`)) return; const o = await P().approve(id); U.toast(`${o.id} is ${o.state}.`); break; }
        case "cancel": P().cancel(id); break;
        case "check": { const o = await P().checkStatus(id); U.toast(`${o.id}: ${o.state}`); break; }
        case "reconcile-return": if (confirm("Move this returned amount back into the vault reserve?")) P().reconcileReturn(id); break;
        case "payee-add": await payeeForm(); break;
        case "payee-edit": await payeeForm(id); break;
        case "payee-del": if (confirm("Remove this payee?")) P().savePayees(P().payees().filter(x => x.id !== id)); break;
        case "allow": { const a2 = Core.agent(id), v = await U.form(`Allowance: ${a2.name}`, [{ key: "amount", label: `Total this agent may request (${P().cur()})`, type: "number", step: "any" }], { amount: ((P().allocs()[id] || {})[P().cur()] || 0) / 100 }); if (v) P().setAllowance(id, P().cur(), (v.amount || 0) * 100); break; }
        case "rail-edit": await railForm(); break;
        case "secret": if (!P().rail().webhookSecret || confirm("Replace the current webhook secret? The provider and relay must be updated too.")) { const s = P().newSecret(); P().saveRail({ webhookSecret: s }); U.copy(s); U.toast("New secret created and copied. Give the same value to your provider and relay.", 6000); } break;
        case "poll": { U.toast("Checking the relay…"); const o = await P().pollRelay(); U.toast(`Relay: ${o.received} new, ${o.applied} applied, ${o.rejected} rejected.`); break; }
        case "paste": await pasteWebhook(); break;
        case "deposit-sim": await simDeposit(); break;
        case "adopt": { const d = P().adoptOpening(); U.toast(`Reserve adjusted by ${fmt(d)}.`); break; }
        case "csv": U.download("transfers.csv", U.csv([["id", "created", "state", "amount", "currency", "name", "destination", "source", "idempotency_key", "settlement_id"], ...P().transfers().map(t => [t.id, new Date(t.created).toISOString(), t.state, t.amountCents / 100, t.currency, t.name, P().maskAcct(t), t.source, t.idemKey, t.settlementId || ""])]), "text/csv"); break;
        case "csv-journal": U.download("journal.csv", U.csv([["date", "debit", "credit", "amount", "currency", "memo", "ref"], ...P().journal().map(x => [new Date(x.ts).toISOString(), x.dr, x.cr, x.cents / 100, x.currency, x.memo, x.ref])]), "text/csv"); break;
      }
    } catch (e) { U.toast("⚠ " + e.message, 7000); }
  }

  return { dashboard, transfersTab, railTab, journalTab, act };
})();
