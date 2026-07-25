MUFASA SMS — System-wide Performance Investigation + Full Optimization
Date: 2026-07-25
Cache marker: /api.js?v=20260725-perf-bg-jobs

Root cause found:
1) System-wide write delay was caused by sql.js db.run() saving/exporting the full DB after every write.
   Small actions often do many writes (allocation update + number history rows + audit logs), so even 20-25 numbers could feel slow.
2) Move to Test Panel / Import Test Numbers were slow on large DBs because normalized phone checks used REPLACE(...) scans without indexes.
3) Delete actions were running VACUUM after deletes, which rewrites the DB and caused visible delays.
4) Dashboard loaded full SMS rows for payout/recent activity; now it uses aggregate SQL.

Fixes included:
- Request-level DB write batching: one DB save per non-GET API request instead of one save per db.run().
- Large smart-divide allocations run as background jobs.
- New endpoint: GET /api/number-jobs/:jobId
- Frontend API helper automatically waits/polls background number jobs and shows progress toasts.
- Smart divide uses chunked UPDATE ... WHERE id IN (...), runNoSave(), one final save, and setImmediate yielding.
- Removed automatic VACUUM after every delete.
- Added expression indexes for normalized phone lookups:
  idx_numbers_clean_phone
  idx_range_test_numbers_range_clean_phone
  idx_range_test_numbers_number
- Dashboard uses COUNT/SUM SQL and LIMIT 5 recent rows.
- Payment ledger backfill batches saves.

Stress test evidence:
Old smart divide loop:
- 1,000 numbers: 2,010 ms blocked
- 5,000 numbers: 17,775 ms blocked

New HTTP/background smart-divide:
- 5,000: initial 20 ms, complete 242 ms, dashboard during job 93 ms
- 10,000: initial 28 ms, complete 403 ms, dashboard during job 109 ms
- 20,000: initial 30 ms, complete 920 ms, dashboard during job 155 ms
- 50,000: initial 44 ms, complete 3,950 ms, dashboard during job 235 ms
- 70,000: initial 61 ms, complete 7,266 ms, dashboard during job 312 ms

Small operation test on 70k numbers:
- Allocate selected 25: 14 ms
- Unallocate selected 25: 28 ms
- Move to Test Panel 25: 23 ms
- Import Test Numbers 25: 70 ms
- Range create: 54 ms
- Delete range with ~35k numbers: 883 ms
- SMS Numbers page: 95 ms

Full report:
- PERFORMANCE_INVESTIGATION.md

Other retained changes:
- Payment V2 fixes retained.
- Manager payment view hides empty categories.
- Agent assigned payment type controls future OTP payout rate.
- Historical earnings stay in original category.
- Cleanup modules remain removed (notifications/news/SMPP/test generator/integration placeholder/PDF/Print).

VPS deployment after GitHub push:
cd ~/Mufasa-sms
git pull --ff-only origin main
npm install && pm2 flush mufasa-sms && pm2 restart mufasa-sms --update-env && pm2 list
pm2 logs mufasa-sms --lines 80

Verify:
grep -n "20260725-perf-bg-jobs" admin.html manager.html agent.html client.html management.html payment.html
grep -n "number-jobs\|performSmartDivideJob\|beginBatch\|idx_numbers_clean_phone" backend/server.js backend/db.js backend/schema.js
