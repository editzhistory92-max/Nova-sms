MUFASA SMS — Performance + Bulk Range Creation Update
Date: 2026-07-22
Cache marker: /api.js?v=20260722-perf-bulk-ranges

What changed:
1) Admin Panel performance
   - Admin DOM is lighter: Management-only page sections were removed from admin.html.
   - Admin no longer contains System Master/Rate/Import/Allocation page DOM.
   - Admin still keeps daily operations only.

2) Faster SMS Numbers
   - Manager, Agent, Client numbers pages now use server-side pagination.
   - Admin already used server-side pagination; backend query is further optimized.
   - /api/numbers count is now a direct COUNT query, not SELECT * subquery.
   - /api/numbers supports short backend cache for duplicate rapid clicks.
   - Client numbers page can fetch last_sms_at per visible page only.

3) Faster SMS CDR / SMS Detail / SMS Stats
   - /api/sms/paged uses UK date converted to UTC range comparisons, so indexes can be used.
   - /api/sms/paged and /api/stats-summary have short backend caching.
   - Manager/Agent startup no longer loads full /api/sms dataset.
   - Manager/Agent/Admin stats pages use /api/stats-summary on demand.
   - Pagination controls added for server-side report pages.

4) Backend/database optimization
   - Added indexes for SMS date/scope queries:
     idx_sms_test_date, idx_sms_manager_date, idx_sms_agent_date,
     idx_sms_client_date, idx_sms_range_date, idx_sms_number_date.
   - Added ranges alphabetical index: idx_ranges_name_nocase.
   - Added number scope/range composite indexes.
   - Added short in-memory API read cache cleared automatically on non-GET API requests.

5) Bulk Range Creation
   - New Management Panel card: Rate Management -> Bulk Range Creation.
   - Enter multiple range names, one per line.
   - New backend endpoint: POST /api/ranges/bulk-create.
   - Existing ranges are skipped; soft-deleted ranges are restored.

6) Alphabetical Sorting
   - /api/ranges now returns ranges alphabetically: ORDER BY name COLLATE NOCASE.
   - /api/numbers/summary ranges are alphabetical.
   - Range dropdowns/lists are now fed from alphabetical backend results.

Files changed:
- admin.html
- management.html
- manager.html
- agent.html
- client.html
- api.js
- backend/server.js
- backend/schema.js
- .gitignore

Deployment:
Windows local repo:
  cd /d F:\ms-sms-service
  git add -A
  git commit -m "Optimize panels and add bulk range creation"
  git push origin main

VPS:
  cd ~/Mufasa-sms
  git fetch origin main
  git pull --ff-only origin main
  npm install
  pm2 flush mufasa-sms
  pm2 restart mufasa-sms --update-env
  pm2 list

Important DB tracking note:
If backend/data.sqlite or backend/backups are still tracked in Git, untrack them from Windows local repo before future deploys:
  git rm --cached backend/data.sqlite
  git rm --cached -r backend/backups
  git add .gitignore
  git commit -m "Stop tracking database and backups"
  git push origin main
