# MUFASA SMS Performance Investigation — 2026-07-25

## Executive Summary

The slowdown was system-wide, not only bulk allocation.

Two real bottlenecks were found:

1. **Every `db.run()` saved/exported the entire sql.js SQLite DB file synchronously.**
   - Many small actions do multiple writes: update + number history logs + audit logs.
   - Example: allocating 25 numbers triggered 1 allocation update + 25 history inserts + 1 audit insert = 27 DB saves.
   - Each save exports the full DB and writes it synchronously, blocking Node's event loop.

2. **Some duplicate checks used `REPLACE(...)` expressions without indexes.**
   - Move to Test Panel and Import Test Numbers scanned large `numbers` tables repeatedly.
   - On 70k numbers, moving only 25 numbers to test took ~2.4 seconds before adding expression indexes.

These are application/database implementation bottlenecks, not VPS hardware limits.

---

## Stress Test Evidence

### Old smart-divide style direct test

Old loop = one `db.run()` per number = one full DB save per number.

| Workload | Duration | Event Loop Block |
|---:|---:|---:|
| 1,000 numbers | 2,010 ms | 2,010 ms |
| 5,000 numbers | 17,775 ms | 17,776 ms |

This proves why the panel appeared frozen: Node could not respond to other requests while the synchronous save loop was running.

---

## Fixes Implemented

### 1. Request-level DB write batching

Added batching in `backend/db.js`:

- `beginBatch()`
- `endBatch()`
- `db.run()` inside a batch marks DB as dirty but does not save immediately.
- At the end of the API request, only one DB export/write happens.

Added `/api` middleware in `backend/server.js`:

- Every non-GET API request starts a DB batch.
- Batch is saved once when the response finishes.

This improves all small write operations:

- allocate selected numbers
- unallocate selected numbers
- range update/delete
- test number import
- move to test panel
- audit/history writes

### 2. Smart Divide background jobs

Added background job system:

- `POST /api/numbers/smart-divide`
- `GET /api/number-jobs/:jobId`

Large allocations now return immediately and run in background.

Implementation:

- chunked `UPDATE ... WHERE id IN (...)`
- `runNoSave()` during chunks
- one final `db.save()`
- `setImmediate()` yield between chunks so the event loop remains responsive

### 3. Removed per-delete VACUUM

`deleteNumbersFromRows()` previously ran `VACUUM` after each delete operation.

That rewrites/compacts the whole DB and makes small delete/range actions feel frozen.

Now delete operations do not VACUUM automatically. Database remains safe; compaction can be done during maintenance if needed.

### 4. Added expression indexes for normalized phone lookups

Added indexes:

- `idx_numbers_clean_phone`
- `idx_range_test_numbers_range_clean_phone`
- `idx_range_test_numbers_number`

This fixed slow duplicate checks in:

- Move to Test Panel
- Import Test Numbers
- find number by normalized phone

### 5. Dashboard query optimized

Dashboard was loading full SMS rows for payout/recent activity.

Now it uses:

- SQL `COUNT(*)`
- SQL `SUM(...)`
- recent rows with `LIMIT 5`

---

## Results After Fixes

### Bulk allocation through real HTTP/background job

Generated realistic DB and tested via actual HTTP API.

| Workload | Initial API Response | Job Complete | Dashboard During Job | Allocated |
|---:|---:|---:|---:|---:|
| 5,000 | 20 ms | 242 ms | 93 ms | 5,000 |
| 10,000 | 28 ms | 403 ms | 109 ms | 10,000 |
| 20,000 | 30 ms | 920 ms | 155 ms | 20,000 |
| 50,000 | 44 ms | 3,950 ms | 235 ms | 50,000 |
| 70,000 | 61 ms | 7,266 ms | 312 ms | 70,000 |

Panel stays responsive because the initial response is immediate and the frontend polls job progress.

### Small daily operations on 70,000-number DB

| Operation | Before / issue | After fix |
|---|---:|---:|
| Allocate selected 25 | many synchronous saves | 14 ms |
| Unallocate selected 25 | many synchronous saves | 28 ms |
| Move to Test Panel 25 | ~2,440 ms due normalized scans | 23 ms |
| Import Test Numbers 25 | ~1,224 ms due normalized scans | 70 ms |
| Range create | normal | 54 ms |
| Delete range with ~35k numbers | heavy but non-vacuum | 883 ms |
| SMS Numbers page load | server-side paged | 95 ms |

### Endpoint stress test on 70,000 numbers + 20,000 SMS

| Endpoint / Operation | Time |
|---|---:|
| Dashboard | 437 ms |
| SMS Numbers page 25 | 343 ms |
| Numbers search | 375 ms |
| Numbers range filter | 311 ms |
| SMS CDR paged report | 362 ms |
| SMS search | 362 ms |
| Stats summary by range | 320 ms |
| Stats summary by number | 457 ms |

---

## Why requests were completing together

When a write action ran multiple `db.run()` calls, each call synchronously exported and wrote the full DB file.

While that happened:

- Node's event loop was blocked.
- Other API requests waited in queue.
- Browser UI appeared frozen.
- After the blocking operation finished, queued requests completed together.

This explains why deleting multiple ranges or doing small allocations sometimes looked like “nothing happened” and then all completed later.

---

## Remaining recommendation

The long-term best improvement is still migrating from `sql.js` to native SQLite (`better-sqlite3`) because `sql.js` still needs full DB export on save.

However, the current update removes the worst causes:

- no per-row saves inside each request
- no vacuum after every delete
- no repeated normalized phone table scans
- background jobs for large allocations

A `better-sqlite3` migration should be handled separately with full backup/rollback.

## Additional 100,000 Number Test

After the final background-job and batching changes, a real HTTP smart-divide test with 100,000 numbers was run:

| Workload | Initial API Response | Dashboard During Job | Job Complete | Allocated |
|---:|---:|---:|---:|---:|
| 100,000 numbers | 125 ms | 481 ms | 12,214 ms | 100,000 |

This confirms large operations now start immediately and run in background while the panel remains responsive.
