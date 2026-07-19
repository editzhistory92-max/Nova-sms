Latest Mufasa update bundle

Copy these files into your LOCAL Git repo (F:\ms-sms-service), then run:

git add -A
git commit -m "Latest panel performance integrations and fixes"
git push origin main

Then on VPS:
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install
pm2 flush mufasa-sms
pm2 restart mufasa-sms --update-env
pm2 list

Verify:
grep -n "api.js?v=20260718-latest-bundle" admin.html manager.html agent.html client.html test.html
grep -n "API INTEGRATION POLLING\|smppServer\|daily_limit_rules" backend/server.js backend/schema.js
