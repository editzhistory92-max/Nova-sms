MUFASA SMS — Dashboard + Range Allocation + Dropdown Fix
Date: 2026-07-28
Cache marker: /api.js?v=20260728-dashboard-allocation-fix

Issues fixed:

1) Agent/Client dashboard
- /api/dashboard now returns otp_today, successful_otp_today, failed_otp_today, total_sms.
- Manager/Agent/Client dashboard cards now show:
  Today OTP
  Successful OTP
  Failed OTP
  Total SMS
- Failed OTP count is scoped by user hierarchy using visible numbers.
- Added failed_sms_queue indexes for created_at and normalized number lookup.

2) Range Allocation role visibility
- /api/numbers/summary is role-aware:
  Admin: all ranges
  Manager: only ranges assigned to the manager
  Agent: only ranges assigned to the agent
- SMS Rate Card still uses /api/ranges and still shows all available ranges.
- Only Range Allocation uses scoped ranges.

3) Complete allocation flow
- Admin Range Allocation can allocate to Manager or direct Agent.
- Manager Range Allocation can allocate to Agent.
- Agent Range Allocation can allocate to Client.
- User dropdowns show correct target users.
- Payment cycle options:
  Daily (1/1)
  Weekly (7/1)
  Weekly (7/7)
  Monthly (30/45)
- Displayed allocation rate changes according to selected payment cycle.
- Backend smart-divide now supports Admin -> Manager and Admin -> Agent direct targets correctly.
- Backend rate selection supports Daily/Weekly 7-1/Weekly 7-7/Monthly 30-45.

4) Dropdown performance
- Allocation Range dropdowns now use /api/numbers/summary (small scoped dataset) instead of all-range data.
- Range Card continues to show all ranges; allocation dropdowns no longer show unavailable ranges.
- Dropdowns should open much faster and closer to reference panels.

5) Existing optimizations retained
- HTTP incoming unchanged.
- API poller removed/disabled (HTTP incoming only).
- Payment V2 retained.
- Panel Sharing retained.
- Test Panel lazy loading retained.
- Background number jobs retained.
- Request-level DB batching retained.

Important live note:
If live server still shows older marker, deploy this package and restart PM2 before testing.

VPS deploy:
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
pm2 logs mufasa-sms --lines 80

Verify:
grep -n "20260728-dashboard-allocation-fix" admin.html manager.html agent.html client.html management.html payment.html panel-sharing.html test.html
grep -n "failed_otp_today\|numbers/summary\|smart_divide_payment_type\|idx_failed_sms_number_clean" backend/server.js backend/schema.js
