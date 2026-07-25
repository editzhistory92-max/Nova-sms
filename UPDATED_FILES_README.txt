MUFASA SMS — API Poller CPU Fix + System Performance Update
Date: 2026-07-25
Cache marker: /api.js?v=20260725-api-poller-cpu-fix

What your VPS diagnostics showed:
- Node process was stuck at 100% CPU on one core.
- Host CPU/RAM were not exhausted.
- PM2 logs were empty after flush.
- DB had 168,832 api_integration_logs rows and 75 MB DB size.

Conclusion:
This is code/background task behavior, not VPS hardware. The active suspect is API Integration Poller doing many sql.js writes without console logs.

Fixes in this update:
1) API Integration poller batching
   - Poller now uses background DB batching.
   - Uses db.runNoSave() where appropriate.
   - Saves once per poll instead of per DB write.

2) API poller record cap/yield
   - Processes up to records_limit per response (hard max 1000).
   - Yields every 25 records so Node can respond to other requests.

3) API logs/seen cleanup
   - api_integration_logs capped periodically.
   - Default cap: 20,000 rows.
   - api_integration_seen capped too.
   - This prevents 100k+ log growth from slowing DB export/save.

4) Slow poll warning
   - Logs a warning only if API poll takes >10 seconds.

5) Previous performance fixes retained
   - Request-level DB batching for non-GET API requests.
   - Background number jobs.
   - Smart-divide chunked updates.
   - No automatic VACUUM after every delete.
   - Normalized phone indexes.
   - Dashboard aggregate optimization.
   - Payment V2 fixes retained.

Important emergency mitigation if CPU is stuck before/after deploy:
cd ~/Mufasa-sms
pm2 stop mufasa-sms
mkdir -p ~/mufasa-sms-backups
cp -a backend/data.sqlite ~/mufasa-sms-backups/manual-before-disable-api-poller-$(date +%F-%H%M%S).sqlite
node - <<'NODE'
const db=require('./backend/db');
(async()=>{
  await db.init();
  console.log('Before:', db.all('SELECT id,name,enabled,poll_interval_sec,last_poll_at,last_error FROM api_integrations'));
  db.run('UPDATE api_integrations SET enabled=0');
  console.log('After:', db.all('SELECT id,name,enabled FROM api_integrations'));
})();
NODE
pm2 restart mufasa-sms --update-env
pm2 list

VPS deploy after GitHub push:
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
pm2 logs mufasa-sms --lines 80

Correct health check command (no brackets):
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "health %{time_total}s\n" http://127.0.0.1:4000/api/health; sleep 1; done

Verify:
grep -n "20260725-api-poller-cpu-fix" admin.html manager.html agent.html client.html management.html payment.html
grep -n "withBackgroundDbBatch\|lastApiIntegrationCleanupAt\|slow poll" backend/server.js
