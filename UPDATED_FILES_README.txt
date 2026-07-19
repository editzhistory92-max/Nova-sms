LATEST UPDATED FILES - MUFASA SMS
=================================

This zip is refreshed after the latest changes.
Copy/replace these files into your local Git repo, then commit/push.

Current cache marker in HTML:
/api.js?v=20260719-cdr-paged-frontend

Latest included changes:
- Server-side SMS/CDR pagination: /api/sms/paged
- Stats summary endpoint: /api/stats-summary/:by
- Faster SMS Report / SMS Detail / SMS Stats loading
- SMPP Server module
- API Integration polling module
- Limit Management
- Optional SMS history deletion on number/range delete
- Direct Admin -> Agent allocation support
- Test Panel sync/masking fixes
- Purple theme/logo updates

Files included:
- admin.html
- manager.html
- agent.html
- client.html
- test.html
- test-login.html
- login.html
- api.js
- package.json
- package-lock.json
- backend/server.js
- backend/schema.js
- backend/seed.js
- backend/auth.js
- backend/db.js
- backend/backup.js
- backend/smppServer.js
- backend/package.json
- backend/package-lock.json
- assets/mufasa-logo.png
- assets/mufasa-logo-192.png
- assets/mufasa-favicon.png

DO NOT push these to GitHub:
- backend/data.sqlite
- backend/backups/
- node_modules/

Local Git commands after copying files:

git add -A
git commit -m "Latest Mufasa SMS update"
git push origin main

VPS commands after GitHub push:

cd ~/Mufasa-sms
git pull --ff-only origin main
npm install
pm2 flush mufasa-sms
pm2 restart mufasa-sms --update-env
pm2 list

Verify on VPS:

grep -n "api.js?v=20260719-cdr-paged-frontend" admin.html manager.html agent.html client.html test.html
grep -n "sms/paged\|stats-summary" backend/server.js
