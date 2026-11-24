# Agent Studio

A standalone, open-source multi-agent platform built with plain **HTML, CSS and JavaScript**. No Streamlit, no framework, no server.
**57 agents · 3 linked systems · 20 team dashboards · works offline and online.** Runs in a browser, installs as a PWA, and builds into an Android APK.

## What is inside

| Area | What it does |
|---|---|
| **Dashboard** | Platform KPIs, alerts, per-system health, recent runs and agent messages |
| **Orchestra (GOD AI)** | The Conductor routes a goal to the teams it needs; teams run (members in parallel); the Conductor merges. Or chain teams in a manual order |
| **Teams** | One dashboard per team: agent status, run stats, enable/disable, run box (file attach), team panel, optional "consult linked teams first" |
| **Chat** | Talk to any single agent (long-term memory injected automatically) |
| **Tasks** | Manual board (to do / doing / blocked / done), assign to a team or agent, run it, or draft tasks with the Task Builder |
| **Memory** | Long-term memory (global, per team or per agent), pinned items, extraction from text |
| **Comms** | Structured agent-to-agent message bus with envelope validation |
| **Runtime** | Live agent state, runs, errors, latency, estimated tokens; stop-all; scheduled jobs |
| **Vault Terminal** | Platform balance, cash vault + ledger, gold & silver vault, live wallet, payments, API hub, command terminal |
| **Agents** | Add, edit, delete, import/export the roster, export system specs |
| **Security** | App lock, security checks, audit log, encrypted backup/restore |
| **History** | Every chat and run is saved on the device; search, reopen, export |

The 57 agents: System 1 Command & Orchestra (27), System 2 Knowledge & World Intelligence (20), System 3 Finance & Vault (10). See `docs/SPECS.md` (generated) for the system-specific specifications.

## Run it

Open `index.html` through any static server (`npm run serve`, or `python3 -m http.server`). Opening the file directly works for most things, but encryption (app lock, backups) and offline caching need `http://localhost` or `https`.

1. Go to **Settings**, choose a provider (OpenRouter, Ollama, OpenAI, Anthropic, Gemini, Groq, DeepSeek, Mistral or any OpenAI-compatible URL), paste the key, press **Test connection**.
2. Try the **Orchestra** with a goal such as "Plan the launch of our wallet product".

## Publish on GitHub and get a web link

```bash
git init && git add . && git commit -m "Agent Studio"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then **Settings → Pages → Source: GitHub Actions**. The `Deploy web app to GitHub Pages` workflow publishes on every push to `https://<you>.github.io/<repo>/`.

## Android APK

* **No Android Studio needed:** the `Build Android APK` workflow runs on every push. Open the repo's **Actions** tab, open the latest run and download the `agent-studio-apk` artifact (a debug APK; allow "install unknown apps" on the phone).
* **Locally** (Node 20, JDK 17, Android SDK): `npm install && npm run build && npx cap add android && npx cap sync android && cd android && ./gradlew assembleDebug`.

The APK contains the whole app, so it also opens with no internet.

## Offline and online

* All data is stored on the device (IndexedDB). Dashboards, vault, ledger, tasks, memory, history and the terminal work with no connection.
* Agents need a reachable AI provider. **To run agents fully offline**, use Ollama on the same network (or the same device) and choose Ollama in Settings. The app detects local addresses and still allows them when the internet is down.
* The status chip and banner show the connection state. Price refreshes are skipped offline and the last saved prices are used.

## Using Ollama

* PC/browser: start Ollama with `OLLAMA_ORIGINS=*`.
* Phone (APK): `localhost` is the phone itself. Run Ollama on a computer with `OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=*` and set the Base URL to `http://<computer-ip>:11434`.
* A page served from `https://` (GitHub Pages) can only reach Ollama on localhost; use the APK or the local copy for a LAN address.

## Finance platform: what it does and does not do

* **Does:** record and reconcile. Multi-account ledger (entries are never deleted; mistakes are reversed), cash vault and bank accounts, gold and silver vault (bars/coins with weight, purity, serial, location, movement log, fine-ounce valuation), live wallet prices (CoinGecko), Bitcoin address balance sync (mempool.space), exchange rates (Frankfurter), metals spot (configurable URL, manual override), payment register, CSV exports, command terminal.
* **Payments:** a payment is prepared, approved, optionally submitted through an API connection you define (JSON template with `{{amount}}`, `{{currency}}`, `{{payee}}`, `{{reference}}`), then marked completed, which posts the ledger entry. The app only moves real money if you connect a provider API and confirm the prompt. Many bank/payment APIs block direct browser calls (CORS); those need your own small server in between.
* **Does not:** hold private keys, execute trades, or provide licensed financial advice. Agent outputs are suggestions.
* Verify the live price sources before relying on them: they are third-party services that can change. Edit the metals URL in *Vault → Overview → Rates & prices*.

## Security notes

* A Content-Security-Policy blocks injected and third-party scripts.
* API keys are stored unencrypted in the device's app storage and are sent only to the provider they belong to. Use restricted, revocable keys.
* The PIN lock hides the app on a shared device; it is not disk encryption. **Encrypted backups** (AES-GCM, PBKDF2) protect exported data; the passphrase cannot be recovered.
* For a public multi-user product, route AI and finance calls through your own backend instead of keeping keys in the client.

## Load the client's own roles

*Agents → Import JSON* replaces the roster. Format:

```json
{ "systems": [ { "id": "sys1", "name": "System 1", "description": "",
  "agents": [ { "id": "lead-1", "name": "Lead", "layer": "lead", "group": "news",
                "role": "Coordinator", "prompt": "Instructions…" } ] } ] }
```

`layer` is `conductor`, `orchestrator`, `lead` or `worker`; `group` is the team id. The first agent by layer in each team leads it. `GROUP_META` in `js/defaults.js` gives teams their names, icons and links.

## Development

```
npm run build   # copy the app to ./www
npm run spec    # regenerate docs/SPECS.md from the roster
npm run serve   # static server
```

Plain scripts, no bundler: `js/defaults.js` (roster) → `core.js` (state, bus, memory, runtime) → `engine.js` (team/orchestra runs, scheduler) → `finance.js` → views.

## Licence

MIT. See `LICENSE`.

## Free & small models (start at no cost)

Open **Settings → Free & small models**:

- **Use free cloud**: OpenRouter's free router (`openrouter/free`). Needs only a free key from openrouter.ai/keys. Free limits are about 20 requests/minute and 50/day (1,000/day after a one-time $10 credit; checked Nov 2026, verify current terms). One orchestra run can use 15-40 calls, so the app paces requests and stops at your daily cap.
- **Use small local models**: Ollama on your computer, no key, no limits, works offline. Run `ollama pull llama3.2:3b` and `ollama pull llama3.2:1b`.
- **Worker model**: the Conductor, team leads and chat use the main model; worker agents use a smaller one. Any single agent can override both (Agents → Edit → Model override).
- **Find live free models** lists the free models OpenRouter currently offers, since free model names change often.

## Vault payouts (vault reserve to bank account)

Vault Terminal → **Dashboard / Payouts / Rail & webhooks / Journal**.

Flow, as in the client brief:

1. An agent, the terminal or you **request** a transfer with an idempotency key. The same key with the same details returns the same transfer; the same key with different details is rejected (422).
2. The request waits as **INITIATED** until you approve it. Nothing is sent without approval (unless you set an auto-approve limit for your own transfers).
3. Approval locks the money (Dr `transfer:in_flight` / Cr `vault:reserve`), then sends it to the payment rail with an `Idempotency-Key` header. If the rail times out, the app never re-sends; it looks the payout up by its key.
4. A **signed event** (webhook) settles it: Dr destination / Cr in-flight, **SETTLED**. Failed releases the money back to the reserve; a bank return goes to a clearing account until you reconcile it. Journal entries are never edited.
5. After settlement the app posts `vault.transfer.settled` on the message bus, shows a notice and can ask an agent to write a note.

Safety defaults: only confirmed deposit events credit the reserve; events are signature-checked, de-duplicated, timestamp-checked and cannot move a transfer backwards; amount mismatches are held for review; agents can only request payouts to **saved payees**, within an **allowance** you set, and still need your approval.

Modes: **Simulator** (built-in fake rail, no real money, for demos and training), **Sandbox** and **Live** (your provider's API, connected in API hub). Real transfers need a business account with a licensed provider (for example an NPP/PayID/BSB provider) and sometimes fees; test in the provider's sandbox first.

The app cannot receive webhooks by itself, so `server/relay.js` (no dependencies) receives them, verifies the signature and keeps them for the app to collect. See `server/README.md`.

## API Keys (Keyflow-style key manager)

**API Keys** has six tabs:

- **Overview**: apps, active keys, 24-hour checks, the three safety rules (separate keys per app, minimum permissions, secure storage) with live pass/fail, and a list of what needs fixing.
- **Apps & keys**: one app per service; each key has its own permissions (scopes), prefix, expiry and rate limit. Shown once, stored only as a SHA-256 hash. Rotate (old key keeps working 7 days) and revoke. **Export verifier file** + `server/verify-keys.js` lets your own server check keys.
- **Verify & logs**: check a key and see why it is accepted or refused (invalid, revoked, expired, wrong permission, rate limited). Every check is logged.
- **Secrets vault**: keys other companies gave you, encrypted on the device with AES-256-GCM (PBKDF2, 250,000 rounds). Locks after 5 idle minutes. A forgotten passphrase cannot be recovered.
- **Integrations**: step-by-step guides with the smallest permission set for Roblox Open Cloud, Nango, KeyFlow, OpenRouter, Groq, Gemini, Monoova and Azupay, plus the **API Key Agent**.
- **Key Forge**: random secrets for things your own app defines (webhook secrets, relay tokens).

Credits: the ideas follow the MIT-licensed KeyFlow project (github.com/evansso/keyflow). No code was copied. Nango is under the Elastic License 2.0 and is only referred to, not bundled.

## Look and feel

Patina green, brass and silver, to match a gold and silver vault. Money figures use a ledger serif. The vault dashboard has a combination-lock dial that shows where the payout money sits (reserve, in flight, awaiting approval, returned).
