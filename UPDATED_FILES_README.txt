MUFASA SMS — Payment V2 + Cleanup + Bulk Range/Test Import
Date: 2026-07-23
Cache marker: /api.js?v=20260723-payment-v2-clean

Major cleanup kept:
- Notification milestone system removed from runtime/UI.
- News system removed from runtime/UI.
- PDF and Print export buttons removed/auto-hidden. Copy/CSV/Excel remain.
- Settings popup simplified: dark mode only.
- Integration Layer placeholder removed. Real API Integration + Carrier HTTP Integration remain.
- SMPP removed from runtime/UI/routes/startup. smpp dependency removed. backend/smppServer.js is a disabled stub.
- Test SMS Generator removed. Normal Test Panel/demo test traffic remains.

New Payment V2 system:
- Old Credit Notes / Payment Config / Withdrawal routes removed from backend UI flow.
- Old fresh-DB schema tables removed: payments, payment_config, withdrawal_requests.
- Existing old DB tables are not dropped for data safety; they are unused.
- New separate Admin-only Payment Panel:
  /payment-login
  /payment
  /payment/:page
- Uses Admin credentials only.

Payment V2 features:
- Range has payment_type: daily, weekly, monthly_30x45.
- Management -> Rate Management can set Payment Type per range.
- Incoming OTPs create payment ledger entries by agent + payment type.
- Earnings stay separated: Daily / Weekly / Monthly.
- UK timezone cycles:
  Daily eligible next UK day after 00:00.
  Weekly cycle Tuesday -> Monday, eligible next Tuesday UK time.
  Monthly 30x45 uses 30-day work cycles with 45-day waiting; eligible after 75 days from cycle start.
- Agents only can request payments.
- Managers only view agent balances/status.
- Admin Payment Panel processes Pending/Paid/Rejected.
- Admin can upload payment screenshot, enter TXID and notes.
- USDT TRC20 wallet management in Agent panel with validation and guide.
- Duplicate pending payment request prevention per agent + payment type.
- Permanent payment history and separate payment audit logs.
- Lightweight payment-specific agent notices are stored in payment_notifications_v2; old global notification system is removed.

New Payment V2 backend endpoints:
- GET/PUT /api/payment-v2/settings
- GET /api/payment-v2/agent/summary
- GET/PUT /api/payment-v2/agent/wallet
- POST /api/payment-v2/agent/request
- GET /api/payment-v2/agent/requests
- GET /api/payment-v2/agent/notifications
- GET /api/payment-v2/manager/agents
- GET /api/payment-v2/admin/summary
- GET /api/payment-v2/admin/requests
- POST /api/payment-v2/admin/requests/:id/pay
- POST /api/payment-v2/admin/requests/:id/reject
- GET /api/payment-v2/admin/audit-logs

Bulk Range + Test Number Import:
- Management -> Rate Management -> Bulk Range + Test Numbers Import.
- Supports TXT, CSV, XLS, XLSX.
- Format:
  Range Name line
  Test number lines under it
  Next non-number line = next range
- Creates ranges and imports test numbers into Test Panel automatically.
- New endpoint: POST /api/ranges/import-test-bulk

Dependency changes:
- Removed smpp.
- Added xlsx for XLS/XLSX import parsing.

Important deployment note:
Because xlsx dependency was added and smpp removed, npm install is required after pull.

Windows local repo:
  cd /d F:\ms-sms-service
  git add -A
  git commit -m "Add Payment V2 panel and cleanup unused modules"
  git push origin main

VPS commands:
  cd ~/Mufasa-sms
  git pull --ff-only origin main
  npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
  pm2 logs mufasa-sms --lines 80

Verify:
  grep -n "payment-login\|payment/:page" backend/server.js
  grep -n "20260723-payment-v2-clean" admin.html management.html manager.html agent.html client.html payment.html
  grep -n "payment-v2" backend/server.js

Note on better-sqlite3:
Not included in this zip. It should be handled as a separate DB-engine migration with a full backup/rollback plan.
