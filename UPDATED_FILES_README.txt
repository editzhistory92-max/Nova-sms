MUFASA SMS — Corrected Admin/Management Split
Date: 2026-07-22
Cache marker: /api.js?v=20260722-admin-sms-ops-split

Correction made per requirement:
The Management Panel should NOT take the complete SMS Number Management module.
Only these modules remain in Management:
- System Master (all options)
- Rate Management
- Import Numbers / Import Ranges
- Import Test Numbers

Admin Panel now keeps daily SMS number operations:
- SMS Number Management menu restored
- Range Allocation restored in Admin
- SMS Numbers restored with full operational actions:
  Allocate Selected, Unallocate Selected, Delete Selected,
  Move to Test Panel, Delete Filtered, Delete ALL Numbers,
  Smart Divide, filters, owner/unallocated management
- Delete Selected Range Numbers added inside Admin SMS Numbers page
- Admin direct Manager/Agent allocation UI remains available in Allocate Selected

Management Panel cleanup:
- Range Allocation removed from Management navigation
- Hidden SMS Numbers/Range Allocation pages removed from Management DOM
- Destructive number delete cards removed from Management Import page
- Bulk Range Creation remains in Management -> Rate Management

Performance features from previous update kept:
- Server-side /api/numbers pagination for Admin/Manager/Agent/Client
- Optimized /api/sms/paged date filtering and short backend cache
- /api/stats-summary on stats pages
- Alphabetical range sorting
- Bulk Range Creation endpoint: POST /api/ranges/bulk-create

Files changed in this package:
- admin.html
- management.html
- manager.html
- agent.html
- client.html
- api.js
- backend/server.js
- backend/schema.js
- .gitignore

Deploy:
1) Extract this zip into Windows local repo: F:\ms-sms-service
2) Commit/push from Windows local repo only:
   cd /d F:\ms-sms-service
   git add -A
   git commit -m "Correct admin management split for SMS operations"
   git push origin main
3) VPS pull/restart:
   cd ~/Mufasa-sms
   git fetch origin main
   git pull --ff-only origin main
   npm install
   pm2 flush mufasa-sms
   pm2 restart mufasa-sms --update-env
   pm2 list

Important:
If backend/data.sqlite or backend/backups are still tracked in Git, untrack from Windows local repo before future deploys:
  git rm --cached backend/data.sqlite
  git rm --cached -r backend/backups
  git add .gitignore
  git commit -m "Stop tracking database and backups"
  git push origin main
