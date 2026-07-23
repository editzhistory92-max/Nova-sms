MUFASA SMS — Full Cleanup + Range/Test Number Bulk Import
Date: 2026-07-22
Cache marker: /api.js?v=20260722-full-cleanup-test-range-import

Removed completely from runtime/UI:
1) Notification system
   - No notification bell/polling on frontend
   - No Notification Rules page
   - No /api/notifications or /api/notification-rules backend routes
   - No incoming-SMS notification milestone checks/writes
   - Old DB tables are not dropped for data safety, but schema no longer creates them for fresh DBs.

2) News system
   - Removed News pages/menus from Manager, Agent, Client
   - Removed News for Users from Management
   - Removed backend /api/news routes
   - Old DB table is not dropped for safety.

3) PDF / Print export buttons
   - PDF and Print buttons removed/auto-hidden.
   - Copy / CSV / Excel remain.

4) Settings popup simplified
   - Notification sound/popup settings removed.
   - Dark mode remains optional.

5) Integration Layer placeholder removed
   - Management placeholder Integration Layer removed.
   - Real API Integration remains.
   - Carrier HTTP Integration remains.

6) SMPP removed from runtime/UI
   - Management SMPP page removed.
   - Backend SMPP routes removed.
   - Startup no longer starts SMPP listener on port 2775.
   - smpp package dependency removed from package.json.
   - backend/smppServer.js is a harmless disabled stub to overwrite older deployments safely.

7) Test SMS Generator removed
   - Management Test SMS Generator page removed.
   - Backend /api/test-generator routes removed.
   - Public/Admin Test Panel demo traffic remains separate and was not removed.

New bulk range + test number import:
- Management Panel -> Rate Management -> Bulk Range + Test Numbers Import
- Supports: TXT, CSV, XLS, XLSX
- File logic:
  Range name line
  test number lines under it
  next non-number line = next range
- Automatically creates ranges
- Automatically imports test numbers into Test Panel (range_test_numbers)
- Rate/currency fields stay default/NA unless edited later

Example file:
Nigeria MTN
08031234567
08039876543
08035556677
Pakistan Jazz
03001234567
03019876543
03025556677
UK EE
447700900001
447700900002
447700900003

Backend endpoint added:
POST /api/ranges/import-test-bulk
multipart field: file

Note on better-sqlite3 migration:
Not included in this cleanup zip because it is a bigger DB-layer migration and must be done separately with a full backup/rollback plan. This cleanup removes several unnecessary reads/writes first.

VPS commands after GitHub push:
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
pm2 logs mufasa-sms --lines 80
