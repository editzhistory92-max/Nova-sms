MUFASA SMS — HTTP Only / API Poller Removed
Date: 2026-07-25
Cache marker: /api.js?v=20260725-http-only-no-api-poller

Reason:
VPS diagnostics confirmed CPU dropped to 0% when API Integration was disabled.
User confirmed API Integration is not needed; only HTTP incoming should remain.

Changes:
1) API Integration poller no longer starts at backend startup.
   Startup log now shows:
   • API Integration poller disabled (HTTP incoming only)

2) API Integration UI removed from Management Panel.

3) API Integration API endpoints are shadowed with 410 responses:
   "API Integration module removed. HTTP incoming integration remains active."

4) Payment ledger startup backfill disabled by default.
   New OTPs are still written to payment ledger normally.
   If old ledger backfill is needed later, it can be enabled manually with:
   PAYMENT_LEDGER_BACKFILL_ON_STARTUP=true

5) Previous performance fixes retained:
   - request-level DB batching
   - background number jobs
   - smart-divide chunk updates
   - normalized phone indexes
   - no VACUUM after every delete
   - dashboard aggregate query

Important:
HTTP Incoming endpoint remains unchanged:
POST /api/incoming-sms

VPS deploy after GitHub push:
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
pm2 logs mufasa-sms --lines 80

Correct health check:
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "health %{time_total}s\n" http://127.0.0.1:4000/api/health; sleep 1; done

Verify:
grep -n "20260725-http-only-no-api-poller" admin.html manager.html agent.html client.html management.html payment.html
grep -n "API Integration poller disabled\|PAYMENT_LEDGER_BACKFILL_ON_STARTUP" backend/server.js
