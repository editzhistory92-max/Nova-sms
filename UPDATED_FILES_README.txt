MUFASA SMS — Clean VPS Package + Final Payload Optimization
Date: 2026-07-27
Cache marker: /api.js?v=20260727-final-payload-optimization

This archive is cleaned for VPS deployment only.

Removed from package:
- Railway deployment files and Railway variables/config references
- Stress-test scripts and temporary benchmark files
- Old cleanup scripts
- Old investigation-only markdown artifacts
- SMPP runtime module from packaged backend (server no longer requires it)
- Temporary/cache folders and uploads

Runtime files included:
- Panel HTML files (Admin, Manager, Agent, Client, Management, Payment, Panel Sharing, Test)
- api.js
- backend core files
- package.json/package-lock.json
- backend package files
- logo/favicon assets
- .env.example for VPS
- README.md with VPS-only instructions

Final performance optimization included:
- /api/ranges is lightweight by default; test numbers are only included with ?include_tests=1
- /api/test-numbers supports pagination and defaults to smaller page sizes
- Test Panel data is lazy-loaded only when the Test Panel page is opened
- /api/test-panel/sms is optimized to use sms_records.is_test=1 with simple joins and LIMIT
- Background number jobs and DB batching retained
- API poller remains removed/disabled; HTTP incoming remains active

Deploy on VPS after GitHub push:
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
pm2 logs mufasa-sms --lines 80

Verify:
grep -n "20260727-final-payload-optimization" admin.html manager.html agent.html client.html management.html payment.html panel-sharing.html test.html
grep -n "include_tests\|test-panel/sms\|test-numbers" backend/server.js | head -100
