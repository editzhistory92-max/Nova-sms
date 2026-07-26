MUFASA SMS — Final Performance + Panel Sharing Update
Date: 2026-07-26
Cache marker: /api.js?v=20260726-panel-sharing-final

Final performance work:
- Request-level DB batching remains active.
- Background number jobs remain active.
- API poller remains removed/disabled; HTTP incoming remains active.
- 100,000 number smart-divide HTTP stress test passed:
  Initial response: 125 ms
  Dashboard during job: 481 ms
  Job completed: 12,214 ms
  Allocated: 100,000
- Performance report updated: PERFORMANCE_INVESTIGATION.md

Multi-tab login:
- Login token is now shared via localStorage + sessionStorage.
- Opening another tab in the same browser should remain logged in.
- Logout clears both storages.

Open pages in new tab:
- Existing sidebar data-page link overlay remains.
- Ctrl+Click / Middle click / Right click -> Open in New Tab should work with shared login.

Panel Sharing system added:
Routes:
- /panel-sharing-login
- /panel-sharing
- /panel-sharing/:page

Panel Sharing Dashboard:
- Total Sharing Users
- Total Shared Numbers
- Total OTP Received

Panel Sharing SMS Numbers:
- Shows only currently unallocated Admin numbers.
- Allocated numbers disappear automatically from this list.

Sharing Users:
- Panel Name
- User Name
- Username
- Password
- Status
- Attribute URL

Allocation:
- Allocates numbers internally as Agent allocations.
- Admin SMS Numbers owner display uses Sharing User Panel Name (e.g. ABC Panel) instead of generic username.
- Allocation response includes allocated numbers and frontend auto-downloads CSV.
- CSV columns: Range Name, Number

Attribute URL forwarding:
- When OTP is received for a sharing user number, system forwards JSON to that sharing user's Attribute URL.
- This is an additional forwarding system.
- Existing HTTP incoming integration is not changed.

Existing features preserved:
- HTTP incoming /api/incoming-sms untouched.
- Payment V2 retained.
- Limit Management retained.
- Test Panel retained.
- Admin/Manager/Agent/Client functionality retained.

VPS deploy after GitHub push:
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
pm2 logs mufasa-sms --lines 80

Verify:
grep -n "20260726-panel-sharing-final" admin.html manager.html agent.html client.html management.html payment.html panel-sharing.html
grep -n "panel-sharing\|sharing_users\|forwardSharingOtpIfNeeded" backend/server.js backend/schema.js

Health check:
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "health %{time_total}s\n" http://127.0.0.1:4000/api/health; sleep 1; done
