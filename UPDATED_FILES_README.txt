NOVA SMS — Rebrand & Aurora Dark theme
Date: 2026-07-28

Rebranding release. Business logic, APIs, database schema, authentication,
SMS processing, number allocation, reports and permissions are UNCHANGED.

1) Brand
- Mufasa SMS -> Nova SMS across titles, sidebars, login screens and footers.
- New assets: assets/nova-logo.png, nova-logo-192.png, nova-favicon.png.
- Old assets/mufasa-*.png removed.

2) Theme — "Aurora Dark"
- New stylesheets: assets/nova-theme.css, assets/nova-login.css.
- Legacy purple theme block removed from all panels.
- Palette: midnight navy surfaces with aqua (#00E5C0) / sky (#2FB6FF) accents.

3) Main login URL
- /login  ->  /panel-login   (Admin, Manager, Agent, Client)
- /login and /login.html now 301-redirect to /panel-login.
- /api/login (auth API) unchanged.
- Module logins unchanged: /management-login, /payment-login,
  /panel-sharing-login, /test-login.

4) Code cleanup
- window.MUFASA_PANEL_MODE -> window.NOVA_PANEL_MODE
- CSS vars --mufasa-* -> --nova-*, .mufasa-logo-img -> .nova-logo-img
- Backups renamed to nova-sms-backup-<timestamp>.sqlite (existing files migrated).

--------------------------------------------------------------------------
PREVIOUS RELEASE NOTES
--------------------------------------------------------------------------

NOVA SMS — Agent/Manager Dashboard + Range Allocation Final Fix
Date: 2026-07-28
Cache marker: /api.js?v=20260728-agent-manager-allocation-final

Fixes implemented:

1) Agent/Manager/Client dashboard stats
- Dashboard cards now display:
  Today OTP
  Successful OTP
  Failed OTP
  Total SMS
- Backend /api/dashboard returns otp_today, successful_otp_today, failed_otp_today, total_sms.
- Failed counts are scoped by visible numbers for Manager/Agent/Client.

2) Agent Panel SMS Test Panel removed
- Agent sidebar no longer shows SMS Test Panel.
- Agent page section and test-panel frontend functions removed.

3) Manager Panel Range Allocation fixed
- Range Allocation no longer uses the full Rate Card range list.
- It loads role-scoped ranges from /api/numbers/summary.
- Manager sees only ranges allocated to that Manager.
- Manager can allocate to Agent correctly.
- Payment Cycle selection available:
  Daily (1/1)
  Weekly (7/1)
  Weekly (7/7)
  Monthly (30/45)
- Displayed allocation rate changes with selected payment cycle.

4) Agent Panel Range Allocation fixed
- Agent sees only ranges allocated to that Agent.
- Agent can allocate to Client correctly.
- Payment Cycle selection available.
- Displayed allocation rate changes with selected payment cycle.

5) Backend allocation/rate logic
- /api/numbers/summary is role-scoped for allocation modules.
- SMS Rate Card remains all-ranges as requested.
- smart-divide supports Admin->Manager, Admin->Agent, Manager->Agent, Agent->Client.
- Rate selection supports Daily, Weekly 7/1, Weekly 7/7, Monthly 30/45.
- Historical earnings remain unchanged.

6) Dropdown performance
- Allocation dropdowns use small scoped data.
- Rate Card still uses all ranges.
- Removed hidden full-range/test data from Agent allocation workflows.

VPS deploy:
cd ~/Nova-sms
git pull --ff-only origin main
npm install && pm2 flush nova-sms && pm2 restart nova-sms --update-env && pm2 list
pm2 logs nova-sms --lines 80

Verify:
grep -n "20260728-agent-manager-allocation-final" admin.html manager.html agent.html client.html management.html payment.html panel-sharing.html test.html
grep -n "failed_otp_today\|numbers/summary\|smart_divide_payment_type\|idx_failed_sms_number_clean" backend/server.js backend/schema.js
