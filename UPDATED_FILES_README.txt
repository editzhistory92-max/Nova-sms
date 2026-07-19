LATEST UPDATED FILES - MUFASA SMS
=================================

This bundle includes the fix for Admin SMS Numbers auto-loading issue:
- ensureAdminManagers() is included in admin.html
- loadAdminPageData() calls loadNumbers() when SMS Numbers page opens
- api.js cache version should be /api.js?v=20260719-page-load-fix or current bundled version

Copy these files into your local Git repo, commit/push, then pull on VPS.

Do NOT push database/backups/node_modules:
- backend/data.sqlite
- backend/backups/
- node_modules/
