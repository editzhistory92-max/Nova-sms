# Mufasa SMS — Multi-Level SMS Panel

Real backend + frontend panels for Admin → Manager → Agent → Client hierarchy.

## Current status
- Fake/demo seed data removed.
- Database starts empty except one Admin account.
- Dashboard unified clean white theme hai: Admin, Manager, Agent, Client sab mein same color scheme. Cards exact screenshot jaisi copy nahi, lekin clean rounded gradient style mein hain. Today SMS, Yesterday SMS, Last 7 Days, Money This Month live API se aate hain.
- Admin credentials:
  - Username: `vibepk`
  - Password: `vibepk123`

## Files structure

```
ms-sms-service/
├── login.html
├── admin.html
├── manager.html
├── agent.html
├── client.html
├── api.js
└── backend/
    ├── server.js
    ├── schema.js
    ├── seed.js
    ├── auth.js
    ├── db.js
    ├── package.json
    └── package-lock.json
```

## Run locally

```bash
cd F:\ms-sms-service\backend
npm install
node server.js
```

Open in browser:

```
http://localhost:4000/login.html
```

Important: HTML files ko double-click se open na karein. Server ke through localhost par open karein.

## Reset database

Agar purana dummy data abhi bhi dikh raha ho to server band karke ye file delete karein:

```
F:\ms-sms-service\backend\data.sqlite
```

Phir dobara run karein:

```bash
node server.js
```

Console par aana chahiye:

```
✓ Admin created — username: vibepk
✅ Mufasa SMS backend running: http://localhost:4000
```

## Real data flow
1. Admin login karein: `vibepk / vibepk123`
2. Rate Management mein ranges add karein.
3. User Management mein managers add karein.
4. Import Numbers se CSV/TXT numbers import karein.
5. Admin numbers Manager ko allocate kare.
6. Manager agents banaye aur numbers agents ko allocate kare.
7. Agent clients banaye aur numbers clients ko allocate kare.
8. SMS webhook se real SMS records database mein save honge.


## SMS webhook tester

Testing ke liye browser mein open karein:

```
http://localhost:4000/sms-webhook-test.html
```

Receiving number wohi use karein jo Admin panel se import/allocate kiya gaya ho. Ye page `/api/webhook/sms` par POST request bhej kar real `sms_records` table mein record save karta hai.

## Incoming SMS webhook

Endpoint:

```
POST /api/webhook/sms
```

Body:

```json
{
  "number": "923001234567",
  "cli": "TikTok",
  "message": "Your code is 123456"
}
```

## Added Technical Modules

### Integration Layer
Admin panel mein Integration Layer module add hai. Ye future provider methods ke liye connector registry hai:
- HTTP
- API
- WEBHOOK
- SMPP
- FILE
- PANEL_SYNC
- MANUAL

Backend endpoints:
- `GET /api/integration-connectors`
- `POST /api/integration-connectors` (Admin)
- `PUT /api/integration-connectors/:id` (Admin)
- `DELETE /api/integration-connectors/:id` (Admin)

### Payment Cycle + Withdrawal Workflow
Admin panel mein Payment Configuration add hai. Supported cycle types:
- weekly
- biweekly
- monthly
- custom

Backend endpoints:
- `GET /api/payment-config`
- `PUT /api/payment-config` (Admin)
- `GET /api/earnings-summary`
- `GET /api/withdrawals`
- `POST /api/withdrawals` (Manager/Agent)
- `POST /api/withdrawals/:id/forward` (Manager)
- `POST /api/withdrawals/:id/status` (Admin)

Workflow:
Agent request → Manager forward → Admin approve/reject → Admin mark done.

## Logs + Notification Phase

### Backend-heavy operational safety
Added backend tables/modules:
- `audit_logs` — login/user/range/number/payment/integration activity
- `number_history` — number import/allocate/unallocate lifecycle history
- `webhook_logs` — every provider webhook success/failure log
- `failed_sms_queue` — failed SMS saved for retry/ignore

Admin view:
- System Master → System Logs
  - Activity Logs
  - Number History
  - Webhook Logs
  - Failed SMS Queue

### Milestone Notifications
Notifications are milestone-based, not every new SMS.
Number-wise notifications are intentionally disabled.
Supported scopes:
- Global
- Manager
- Agent
- Client
- Range
- CLI

Supported periods:
- Daily
- Payment Cycle
- Monthly
- Lifetime

Admin view:
- System Master → Notification Rules

All panels:
- Notification bell
- Unread count
- Sound alert toggle

Backend endpoints:
- `GET/POST/PUT/DELETE /api/notification-rules`
- `GET /api/notifications`
- `GET /api/notifications/unread-count`
- `POST /api/notifications/:id/read`
- `POST /api/notifications/read-all`
- `GET/PUT /api/preferences`

## Separate Test Panel Numbers

Test Panel numbers are now stored separately from real SMS Numbers.

Admin can add 2-3 test numbers per range in:

`Rate Management → Set Rate → Test Numbers`

Use comma, space, or new line separated numbers. These numbers are for the Test Panel only and should not be imported in the SMS Numbers file.

Backend:
- `range_test_numbers` table
- `GET /api/test-numbers`

If a test number also exists in the real `numbers` table, it is automatically hidden from the Test Panel to avoid mixing live panel numbers with test numbers.

## Carrier HTTP Integration

Admin panel:

`System Master → Carrier Integration`

Configurable settings:
- Integration Status: Enabled/Disabled
- Carrier IP Address
- HTTP Callback URL
- Future API Key / Auth Token
- Future SMPP Host / Port / System ID / Password
- Notes

Carrier HTTP endpoint:

`POST /api/incoming-sms`

This endpoint accepts flexible payloads such as:

```json
{ "number": "923001234567", "cli": "TikTok", "message": "Your code is 123456" }
```

Also supported field aliases:
- number/to/To/recipient/destination/msisdn/receiver/called
- cli/from/From/sender/originator/source/shortcode/service
- message/text/Text/body/Body/sms/content/msg

Security:
- `/api/incoming-sms` accepts requests only when Carrier Integration is enabled.
- Source IP must match the configured Carrier IP address.
- For proxy/tunnel deployments, the backend checks `CF-Connecting-IP`, `X-Real-IP`, and `X-Forwarded-For` headers.

Local testing:

```bash
cloudflared tunnel --url http://localhost:4000
# or
ngrok http 4000
```

Then send the carrier this URL:

`https://your-public-url/api/incoming-sms`

The internal test endpoint remains available for local testing:

`POST /api/webhook/sms`

## Additional Carrier Monitoring Features

Carrier Integration now includes production monitoring and diagnostics:

Admin Panel:

`System Master → Carrier Integration`

New items:
- Allowed Carrier IP List (comma/space/new-line separated)
- Last SMS Received time
- Last Carrier IP
- Last Carrier Request Status
- Test Connection button
- Webhook Log Retention setting: 7 / 30 / 90 / 180 days
- Carrier Webhook Logs viewer
- Export carrier webhook logs to CSV/Excel-compatible file

Backend additions:
- `carrier_settings.retention_days`
- `webhook_logs.source_ip`
- `GET /api/carrier-webhook-logs`
- `POST /api/carrier-test`

Request source IP is detected from:
- `CF-Connecting-IP`
- `X-Real-IP`
- `X-Forwarded-For`
- request socket IP

## Temporary Test SMS Generator

Admin panel:

`System Master → Test SMS Generator`

Purpose:
- Development/QA only, before real carrier integration.
- Feature-flag controlled: Enabled/Disabled from Admin Panel.
- Uses the same SMS processing logic as incoming carrier SMS.
- Generated SMS records are marked as test records (`is_test=1`, `source='test_generator'`) and can be cleared later.
- It does not use or modify the carrier HTTP/API/SMPP integration endpoints.

Backend additions:
- `qa_test_settings` table
- `sms_records.is_test`
- `sms_records.test_batch_id`
- `sms_records.source`

Endpoints:
- `GET /api/test-generator/settings`
- `PUT /api/test-generator/settings`
- `POST /api/test-generator/generate`
- `POST /api/test-generator/clear`

Usage:
1. Enable the module from Admin Panel.
2. Select an allocated client number, or leave blank to auto-use allocated client numbers.
3. Enter CLI, message, quantity.
4. Generate test SMS.
5. Verify dashboards, reports, notifications, payouts and permissions.
6. Use Clear Generated Test SMS when QA is complete.

## Admin Panel Fixes — Exact Payout + Reports + Test Panel Separation

Implemented fixes:
- Dashboard payout now sums exact per-SMS payout rates from the assigned number/range instead of using a fixed/rounded rate.
- No `.toFixed(2)` rounding for SMS payout calculations in the main dashboard/reports.
- `/api/sms` now returns `payout_rate` and `payout_amount` per SMS.
- `/api/stats/:by` returns exact decimal totals.
- SMS Report and SMS Detailed Report now include:
  - Number
  - Payout Rate
  - Visible records total payout
- Range Allocation row actions now call the real backend allocation API.
- Admin SMS Numbers UI label changed from Client to Manager.
- Manager/Agent/Client tags have stronger high-contrast colors.
- Records-per-page options are standardized through the shared UI helper:
  10, 25, 50, 100, 500, 1000, 10000, All
- SMS Test Panel recent records now show only SMS for numbers configured as Test Panel numbers.
- Test Panel data remains separate from normal SMS support/report data.


## Latest Bug Fixes — Unallocation + Ownership Snapshot

Fixed:
- Admin unallocate now clears Manager, Agent and Client ownership from selected numbers.
- Manager unallocate now clears Agent and Client ownership, while keeping Manager ownership.
- Agent unallocate now clears Client ownership, while keeping Agent/Manager ownership.
- Allocation now resets downstream ownership correctly when assigning to a higher level.
- Old SMS payout ownership is never recalculated or transferred after future allocation changes.
- Incoming SMS keeps a snapshot of owner chain at receive time: manager_id, agent_id, client_id.
- Dashboard and stats payouts use exact decimal string calculations from per-SMS payout rate.
- Admin SMS report and detailed report show Number, Payout Rate and visible total payout.
- SMS Test Panel recent data is restricted to configured Test Panel numbers only.

## Latest Feature Request Fixes — Date Filters + Advanced SMS Details

Implemented in Admin reporting:
- SMS Report now defaults to today and includes From/To date filters.
- SMS Detailed Report defaults to today and includes From/To date filters.
- SMS Detailed Report includes advanced filter toggles for Range, Number and Manager.
- Advanced filters use lists from SMS records only.
- Filter summary shows total OTPs and exact payout by selected category.
- Client/Agent/Manager/Range/Number stats default to today's data and include date filters.
- Duplicate SMS Numbers allocate/unallocate controls have been removed/hidden via cleaned controls where applicable.
- Payout totals continue to use exact decimal string calculations.

## UI + Detailed Report Filter Corrections

Implemented:
- Replaced black badges with light professional badges and sharp dark text.
- Applied consistent font/readability improvements across all panels.
- Rebuilt SMS Detailed Report filters:
  - Date toggle + single date input, default today.
  - Range toggle + dropdown with All Ranges and received ranges only.
  - Number-wise toggle groups the existing report table by number automatically.
  - User toggle changes by panel: Admin=Manager, Manager=Agent, Agent=Client.
- Detailed report table updates in place; no separate page/section.
- Summary rows show: Name/Number/Range, Total OTPs, Total Payout.
- SMS payout rate is now stored on each SMS record at receive time (`payout_rate`, `payout_amount`) to preserve historical payout ownership and rate snapshot.

## Latest UI + SMS Detailed Report Filter Update

Implemented:
- Uniform badge style across the app:
  - Background `#E2E8F0`
  - Text `#1E293B`
  - Border `#CBD5E1`
  - Border radius `8px`
  - Font weight `600`
- Improved table readability:
  - Inter/Segoe UI/Roboto stack
  - Header weight 600
  - Data weight 500
  - Alternating rows and hover state
- Payout rate uses stronger dark-green / dark-blue emphasis.
- SMS Detailed Report filters are now combinable with AND logic.
- Filters supported together: Date + Range + Number + Manager/Agent/Client.
- When filters are enabled, the same report table summarizes by selected dimensions and shows Total OTPs + Total Payout.

## Branding Update — Mufasa SMS

Project branding updated from the previous SMS service name to **Mufasa SMS** across:
- Browser titles
- Login page
- Sidebar/header logos
- Footer text
- Backend console message
- README references
- Testing pages
- Inline SVG favicon

Logo concept:
- Minimal SaaS-style speech bubble with a modern M mark
- Blue gradient palette (#2563EB → #06B6D4)
- No lion/cartoon styling

Login page updated with:
- Mufasa SMS
- Secure OTP Management Platform
- Modern feature list
- Clean light theme and blue gradient CTA

## Uploaded Logo Applied

The user-provided Mufasa SMS logo image is now used in:
- Login page branding
- Admin/Manager/Agent/Client panel logos
- Browser tab favicon
- Webhook tester page favicon

Logo assets:
- `assets/mufasa-logo.png`
- `assets/mufasa-favicon.png`

No major theme change was required. Only the logo container was adjusted with a subtle black/gold-compatible style so the uploaded logo displays cleanly inside the existing light SaaS theme.

## Railway Temporary Deployment

This project is Railway-compatible as a single Node.js web service.

Root deployment is recommended. Railway should run:

```bash
npm install
npm start
```

Required Railway variables:

```env
NODE_ENV=production
JWT_SECRET=your-long-random-secret
DB_FILE=/data/data.sqlite
```

Attach a Railway Volume mounted at `/data` so the SQLite database is persistent.

Public Railway URL example:

```txt
https://your-service.up.railway.app/login.html
https://your-service.up.railway.app/api/incoming-sms
```

Full details are in:

```txt
RAILWAY_DEPLOYMENT.md
```

## Profile, Activity and Clean URL Security Update

Implemented:
- Clean routes:
  - `/` → login
  - `/login` → login
  - `/admin` → Admin panel
  - `/manager` → Manager panel
  - `/agent` → Agent panel
  - `/client` → Client panel
- Old `.html` routes redirect to clean URLs.
- Protected pages hide all content until `/api/me` verifies the JWT token and expected role.
- Profile dropdown added on top-right profile icon for Admin/Manager/Agent.
- Client panel has no profile editing or activity management.
- Profile permissions:
  - Admin/Manager/Agent can update username.
  - Password change requires current password, new password and confirm password.
- Activity logs:
  - Admin: My Activity + Manager Activity
  - Manager: My Activity + Agent Activity
  - Agent: My Activity + Client Activity
- Logout is now logged through backend `/api/logout`.

Updated backend endpoints:
- `GET /api/profile`
- `PUT /api/profile`
- `POST /api/logout`
- `GET /api/activity-log`

## Dark Mode + Admin Security Code + Mobile Login Fix

Implemented:
- Dark mode now covers cards, tables, modals, notification panels, profile panels, inputs and text colors.
- Admin password changes now require the Admin Security Code.
- Default Admin Security Code: `Dawood`.
- Admin Security Code can be changed from Profile modal, but old security code is required.
- Client still has no profile/activity access.
- Page refresh now restores the last opened panel page instead of forcing Dashboard.
- Mobile login no longer shows the large logo first; the form is shown immediately.

## Persistent Database + Automatic Backups

Implemented for Railway and VPS:

- Database can be stored at `/data/data.sqlite` using `DB_FILE`.
- Automatic backups can be stored at `/data/backups` using `BACKUP_DIR`.
- Automatic backups run every `BACKUP_INTERVAL_HOURS` hours.
- Retention is controlled by `BACKUP_RETENTION_DAYS`.
- Admin Panel section: `System Master → Backups`.

Recommended Railway variables:

```env
DB_FILE=/data/data.sqlite
BACKUP_DIR=/data/backups
BACKUP_ENABLED=true
BACKUP_INTERVAL_HOURS=3
BACKUP_RETENTION_DAYS=30
```

## CLI Search & Pagination Update

Implemented:
- Admin Panel → Reports → CLI Search
- Manager Panel → CLI Search
- Agents and Clients do not have CLI Search.

CLI Search behavior:
- Prefix-only smart suggestions (e.g. `T` → TikTok, Telegram).
- Admin searches across the whole platform.
- Manager searches only within their own hierarchy/scope.
- Summary cards show Today, Yesterday, Last 7 Days and This Month when no custom date range is selected.
- If From/To dates are selected, results recalculate for the selected period.
- Range analytics show Today/Yesterday counts without custom dates, and selected-period counts with custom dates.

Backend:
- `GET /api/cli-search/suggestions?q=PREFIX`
- `GET /api/cli-search?cli=CLI&from=YYYY-MM-DD&to=YYYY-MM-DD`
- SMS analytics indexes added for CLI/date/range/owner lookups.

Pagination:
- Shared pagination helper added in `api.js`.
- Page number, previous and next buttons now work for updated paginated tables.
- Active page is highlighted.
- Pagination works after filters/search/page-size changes.

## Client Simplicity Update

Implemented client-friendly improvements only:
- Client dashboard remains simple.
- Client SMS Stats now includes OTP Code column.
- Copy OTP button added for detected OTP codes.
- Client SMS Numbers now includes Last SMS Time.
- New client welcome guide added and shown once per browser.
- Advanced filters are hidden by default behind an Advanced Filters button.

No admin/manager/agent complexity was added to Client Panel.

## HTTP Carrier Integration Verification

The carrier HTTP endpoint is:

```txt
POST /api/incoming-sms
```

Production Railway callback URL:

```txt
https://mufasa-sms-production.up.railway.app/api/incoming-sms
```

Supported content types:

```txt
application/json
application/x-www-form-urlencoded
multipart/form-data
```

Also supports GET diagnostics at `/api/incoming-sms`, and GET query callback for carriers that test URLs via browser/query string.

Accepted field aliases:

Number:
`number`, `to`, `To`, `recipient`, `destination`, `msisdn`, `receiver`, `called`

CLI/Sender:
`cli`, `from`, `From`, `sender`, `originator`, `source`, `shortcode`, `service`

Message:
`message`, `text`, `Text`, `body`, `Body`, `sms`, `content`, `msg`

Security:
- Carrier Integration must be enabled from Admin Panel.
- Carrier IP must be added to Allowed Carrier IP List.
- Multiple IPs are supported.
- Rejected attempts are saved in Carrier Webhook Logs.

Example JSON request:

```bash
curl -X POST "https://mufasa-sms-production.up.railway.app/api/incoming-sms" \
  -H "Content-Type: application/json" \
  -d '{"number":"923001234567","cli":"TikTok","message":"Your verification code is 123456"}'
```

Example form request:

```bash
curl -X POST "https://mufasa-sms-production.up.railway.app/api/incoming-sms" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "to=923001234567" \
  --data-urlencode "from=TikTok" \
  --data-urlencode "text=Your verification code is 123456"
```

## SMPP Integration Enabled

SMPP is now active (not reserved for future use).

Admin Panel:

`System Master → Carrier Integration`

Configure:
- Integration Status: Enabled
- SMPP Host (example: `51.77.64.61`)
- SMPP Port (example: `2775`)
- SMPP System ID
- SMPP Password

Backend behavior:
- Reads SMPP credentials from Carrier Settings.
- Automatically connects/binds using `bind_transceiver`.
- Automatically reconnects if connection drops.
- Shows SMPP status in Carrier Integration page.
- Receives `deliver_sm` messages from SMPP.
- Saves incoming SMPP messages through the same normal SMS processing pipeline as HTTP carrier SMS.
- SMPP messages appear in inbox/reports/dashboard/CLI Search/logs according to number ownership.

Admin endpoints:
- `GET /api/smpp/status`
- `POST /api/smpp/reconnect`

Notes:
- HTTP endpoint `/api/incoming-sms` remains available.
- SMPP and HTTP both feed the same processing flow.
- The carrier must provide SMPP Host, Port, System ID and Password.

## SMPP Debug / Reconnect Update

Implemented SMPP debug improvements:
- SMPP startup now logs to PM2/console when initialized.
- Logs include loaded settings summary: integration status, host, port, system_id presence, password presence.
- Logs TCP connect attempts.
- Logs bind_transceiver success/failure with command_status code.
- Adds connect/bind timeout handling instead of staying stuck forever.
- Adds automatic reconnect scheduling logs.
- Carrier settings save now triggers SMPP restart and logs errors.
- Admin Carrier Integration page polls SMPP status every 10 seconds.

Useful PM2 commands:

```bash
pm2 logs mufasa-sms
pm2 restart mufasa-sms
```

If SMPP stays CONNECTING/RECONNECTING, check:
- SMPP Host
- SMPP Port
- System ID
- Password
- Carrier firewall/IP whitelist
- VPS outbound network/firewall
- PM2 logs for bind error code (e.g. invalid password/system_id/bind failed/connection timeout)

## SMPP Bind Type Setting

SMPP bind type is now configurable from Admin Panel:

`System Master → Carrier Integration → Bind Type`

Options:
- Transceiver (`bind_transceiver`) — default
- Receiver (`bind_receiver`) — common for inbound SMS only
- Transmitter (`bind_transmitter`) — outbound only

Backend uses the selected bind function and logs the exact bind type:

```txt
[SMPP] TCP connected, sending bind_receiver
[SMPP] bind_receiver success: 0 ESME_ROK / OK
```

If carrier returns `ESME_RBINDFAIL`, try changing Bind Type to `Receiver`, save settings, then click `Reconnect SMPP`.

## SMPP Test All Bind Modes

Added admin tool to test all SMPP bind modes:

`System Master → Carrier Integration → Test Bind Modes`

It tests sequentially:
- `bind_transceiver`
- `bind_transmitter`
- `bind_receiver`

The result shows each bind type success/failure, command status and error. If one succeeds, the panel offers to apply the recommended bind type automatically.

Backend endpoints:
- `POST /api/smpp/test-bind-modes`
- `POST /api/smpp/apply-bind-type`

This helps diagnose `ESME_RBINDFAIL (13)` by confirming which bind type the carrier account supports.

## SMPP Temporary Disable + Import Optimization

Implemented:
- SMPP has a separate enable/disable toggle in Carrier Integration.
- Default SMPP connection is disabled (`smpp_enabled=0`).
- When SMPP is disabled, the backend does not attempt to connect or reconnect and does not spam SMPP logs.
- HTTP integration remains available through `POST /api/incoming-sms`.
- If SMPP is enabled later, it supports bind type selection and automatic fallback testing.

Bulk import improvements:
- Number imports now run as background jobs.
- Large uploads are processed in batches (default 1000 records per batch, configurable via `IMPORT_BATCH_SIZE`).
- Admin Panel → Import Numbers now shows import jobs and batches.
- Admin can delete a selected import batch.
- Admin can delete all imported numbers.
- Database VACUUM/optimization runs after bulk delete.

Pagination:
- Shared pagination helper is used by updated paginated tables to show only actual page numbers.

## SMPP Fully Disabled / HTTP-Only Mode

SMPP active usage has been removed from the backend runtime.

Current behavior:
- No `smppClient` is imported by `backend/server.js`.
- No SMPP auto-connect attempts.
- No SMPP reconnect loop.
- No SMPP bind attempts.
- No SMPP PM2 log spam.
- HTTP carrier integration remains active through `POST /api/incoming-sms`.

Carrier Integration page now shows HTTP-only status.

Useful VPS commands after deploying this update:

```bash
cd ~/Mufasa-sms
npm install
pm2 restart mufasa-sms
pm2 flush mufasa-sms
pm2 logs mufasa-sms --lines 100
```

`pm2 flush` clears old SMPP error spam from previous versions.

Incoming SMS / import logs:
- Successful incoming SMS logs: `[INCOMING_SMS] saved ...`
- Failed incoming SMS logs: `[INCOMING_SMS] failed ...`
- Rejected carrier IP logs: `[INCOMING_SMS] rejected ...`
- Number import logs: `[IMPORT] started`, `[IMPORT] completed`, `[IMPORT] failed`
