MUFASA SMS — Live Comparison + Test Panel Performance Fix
Date: 2026-07-26
Cache marker: /api.js?v=20260726-test-panel-fast

Live comparison findings:
- Reference panels are server-rendered PHP pages, usually 18–34 KB, responding around 0.41–0.54s.
- MUFASA SMS CDR endpoints are now comparable (~0.45–0.49s).
- SMS Numbers API is also around reference range (~0.47s), though numbers/summary is larger because it returns all range summaries.
- Remaining serious bottleneck was SMS Test Panel records.

Root cause fixed:
- /api/test-panel/sms took ~55 seconds in production.
- Cause: old query used correlated subqueries and normalized phone matching against range_test_numbers for every SMS row.
- Fix: Test Panel SMS now reads direct sms_records where is_test=1 with simple joins and LIMIT.
- Test Panel dashboard also counts is_test=1 directly.

Existing features preserved:
- HTTP incoming untouched.
- Payment V2 retained.
- Limit Management retained.
- Panel Sharing retained.
- API poller remains removed/disabled per user confirmation; HTTP incoming remains active.

VPS deploy:
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
pm2 logs mufasa-sms --lines 80

Verify:
grep -n "20260726-test-panel-fast" admin.html manager.html agent.html client.html management.html payment.html panel-sharing.html test.html
grep -n "test-panel/sms\|is_test" backend/server.js | head -80

Health check:
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "health %{time_total}s\n" http://127.0.0.1:4000/api/health; sleep 1; done
