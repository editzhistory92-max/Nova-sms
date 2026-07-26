MUFASA SMS — Panel Sharing Final + Smoke Fix
Date: 2026-07-26
Cache marker: /api.js?v=20260726-panel-sharing-final

Includes:
- Final performance optimizations and background jobs.
- Multi-tab login via localStorage + sessionStorage.
- Sidebar routes support browser new-tab behavior.
- New Admin-only Panel Sharing panel:
  /panel-sharing-login
  /panel-sharing
  /panel-sharing/:page
- Sharing Users with Panel Name, User Name, Username, Password, Status, Attribute URL.
- Panel Sharing allocation uses internal Agent allocation behavior.
- Admin SMS Numbers owner display shows Sharing User Panel Name.
- Allocated sharing numbers disappear from Panel Sharing unallocated list.
- Allocation auto-downloads CSV with Range Name, Number.
- OTP forwarding to Attribute URL added as an additional forwarding system.
- HTTP incoming /api/incoming-sms untouched.
- Payment V2 retained.
- Limit Management and Test Panel retained.

Important:
- API poller remains removed/disabled as previously confirmed; HTTP incoming remains active.
- A server-side join issue in SMS/CDR queries was fixed so sharing panel names do not break /api/sms/paged.

Stress test update:
- 100,000 number smart-divide HTTP test passed:
  Initial response 125 ms, dashboard during job 481 ms, complete 12,214 ms.

VPS deploy:
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
pm2 logs mufasa-sms --lines 80

Verify:
grep -n "20260726-panel-sharing-final" admin.html manager.html agent.html client.html management.html payment.html panel-sharing.html
grep -n "panel-sharing\|sharing_users\|forwardSharingOtpIfNeeded" backend/server.js backend/schema.js
curl -s -o /dev/null -w "health %{time_total}s\n" http://127.0.0.1:4000/api/health
