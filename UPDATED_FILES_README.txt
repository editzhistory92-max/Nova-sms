MUFASA SMS — Management/Admin Split Update
Date: 2026-07-22
Cache marker: /api.js?v=20260722-management-split

What changed:
1) Admin Panel is now daily-operations only.
   Visible Admin sidebar now contains:
   - Dashboard
   - SMS Numbers
   - SMS Test Panel
   - User Management
   - SMS CDR Stats / Reports
   - Credit / Payouts
   - Payment Configuration

2) Removed from Admin sidebar:
   - SMS Number Management parent menu
   - Range Allocation
   - Import Numbers / Import Ranges
   - Import Test Numbers
   - Rate Management
   - System Master and all System Master submenus

3) New Management Panel now contains maintenance/config only:
   - Range Allocation
   - Import Numbers / Import Ranges
   - Import Test Numbers
   - Rate Management
   - System Master:
     News for Users, SMS CLI Limit, Limit Management, Carrier Integration,
     SMPP Server, API Integration, Test SMS Generator, Integration Layer,
     Notification Rules, System Logs, Backups

4) Performance/loading split:
   - Admin no longer preloads import/rate/system-master modules.
   - Admin no longer builds all CDR pages at startup.
   - Admin SMS Report / SMS Detail use server-side /api/sms/paged on demand.
   - Management has separate route-storage key: ms_last_page_management.
   - Management default page is Rate Management.

Files changed in this update:
- admin.html
- management.html
- management-login.html
- api.js
- All panel HTML files have refreshed /api.js cache marker.

Deployment reminder:
1) Extract this zip into Windows local repo: F:\ms-sms-service
2) From Windows local repo:
   git add -A
   git commit -m "Split Admin and Management panels"
   git push origin main
3) On VPS:
   cd ~/Mufasa-sms
   git pull --ff-only origin main
   npm install
   pm2 flush mufasa-sms
   pm2 restart mufasa-sms --update-env
   pm2 list
