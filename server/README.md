# Webhook relay

The app runs in a browser or APK, so it cannot receive calls from your payment provider. This small server can.

1. Run it somewhere with HTTPS: `WEBHOOK_SECRET=... RELAY_TOKEN=... ALLOWED_ORIGIN=https://your-app-url node server/relay.js`
2. In your provider's dashboard, set the webhook URL to `https://your-relay/webhooks/rail` and use the same signing secret.
3. In the app: Vault → Rail & webhooks. Enter the same secret, the relay URL and the relay token. The app polls `/events`, re-verifies every signature itself, and updates the ledger.

Providers sign webhooks differently. The relay and the app support HMAC-SHA256 over the raw body (`SIG_SCHEME=raw`) or over `timestamp.body` (`ts.raw`, default). If your provider uses another scheme, change the `verify` function in `relay.js` and `ingestRaw` in `js/payouts.js`.
