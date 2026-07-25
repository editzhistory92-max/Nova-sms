# API Poller CPU Finding — 2026-07-25

## Symptom on VPS

PM2 showed:

- `mufasa-sms` CPU: 100%
- Host CPU: ~18–25%
- RAM normal
- PM2 logs empty after flush
- Process stayed at 100% for more than 60 seconds

This means one Node.js event-loop thread/core was busy. It is not a VPS capacity problem.

## Strong evidence

DB counts showed:

- `api_integration_logs`: 168,832 rows
- DB size: 75 MB

The API Integration poller runs in the background and previously used normal `db.run()` calls outside Express request batching. In sql.js, every `db.run()` exports/saves the whole database file. If the carrier API returns many rows or many invalid/duplicate rows, the poller can create many DB writes without console logs.

That explains:

- CPU stuck at 100%
- no fresh PM2 logs after flush
- UI/API delayed
- low VPS RAM/overall CPU

## Fix implemented

1. API poller now processes records inside a background DB batch.
2. API poller uses `db.runNoSave()` and saves once per poll.
3. API poller limits records per response to `records_limit` (max 1000).
4. API poller yields every 25 records.
5. API integration logs/seen rows are capped periodically:
   - default logs cap: 20,000
   - seen cap: max(40,000 / 50,000)
6. Slow poll warning logs only if a poll takes more than 10 seconds.

## Emergency mitigation if CPU is stuck before deploying the fix

Stop app, backup DB, disable API integrations, restart:

```bash
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
```

If CPU drops after this, the API poller was the active CPU source.
