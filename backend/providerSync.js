/**
 * Nova SMS — Background Provider Sync Service
 * ---------------------------------------------------------------------------
 * Architecture
 *
 *   Provider API  ->  Background Sync Service  ->  Local Database
 *                                                        |
 *                                          Nova Backend (/api/*)
 *                                                        |
 *                            Admin / Manager / Agent / Client panels
 *
 * The panels NEVER call a provider API. They only read the local database
 * through the existing endpoints. Only this service talks to providers.
 *
 * Key properties
 *  - Incremental: each provider keeps its own `last_sync_at` cursor and asks
 *    only for records newer than that.
 *  - Safety window: the cursor is rewound by `overlap_seconds` on each poll so
 *    that records written a moment before the previous cursor are not missed.
 *  - Deduplication: the provider's unique reference id is stored with a UNIQUE
 *    index, so the overlap can never create duplicates.
 *  - Non-blocking: runs on its own timer in the Node process, writes in a
 *    single batched transaction, and never touches the request path.
 *  - Multi-provider: connectors are registered in `CONNECTORS`; adding a
 *    provider does not require any panel or API change.
 */

const db = require('./db');

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function nowUtcSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function toUtcSql(value) {
  if (!value && value !== 0) return nowUtcSql();
  // epoch seconds / milliseconds
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    const ms = String(value).length <= 10 ? n * 1000 : n;
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  }
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 19).replace('T', ' ');
  return nowUtcSql();
}

function shiftSql(sqlTs, seconds) {
  const d = new Date(String(sqlTs).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return nowUtcSql();
  return new Date(d.getTime() + seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]) !== '') return obj[k];
  }
  return '';
}

/** Read a value from a dotted path, e.g. "data.messages" */
function dig(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), obj);
}

/* ------------------------------------------------------------------ *
 * Provider connectors
 *
 * A connector turns "provider config + since timestamp" into a normalised
 * array of records. To add a provider, add one entry here — nothing else
 * in the panel or the API needs to change.
 * ------------------------------------------------------------------ */

const CONNECTORS = {
  /**
   * Generic URL/JSON connector. Covers most HTTP providers.
   *
   * config JSON (stored per provider row):
   * {
   *   "url":            "https://provider.tld/api/messages",   // required
   *   "method":         "GET",                                  // GET | POST
   *   "auth":           "bearer" | "header" | "query" | "none",
   *   "token":          "<api key / token>",
   *   "auth_header":    "X-API-Key",        // when auth = header
   *   "auth_query":     "api_key",          // when auth = query
   *   "since_param":    "start_date",       // query param carrying the cursor
   *   "since_format":   "sql" | "iso" | "epoch" | "epoch_ms",
   *   "limit_param":    "limit",
   *   "limit":          500,
   *   "extra_params":   { "status": "delivered" },
   *   "records_path":   "data.messages",    // where the array lives
   *   "map": {                              // provider field -> nova field
   *     "ref":     "message_id",
   *     "number":  "to",
   *     "cli":     "from",
   *     "message": "text",
   *     "date":    "created_at"
   *   }
   * }
   */
  generic_json: async function (cfg, sinceSql, log) {
    const url = String(cfg.url || '').trim();
    if (!url) throw new Error('provider config missing "url"');

    const method = String(cfg.method || 'GET').toUpperCase();
    const headers = { 'Accept': 'application/json' };
    const params = new URLSearchParams();

    // ---- authentication ----
    const auth = String(cfg.auth || (cfg.token ? 'bearer' : 'none')).toLowerCase();
    if (auth === 'bearer' && cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;
    else if (auth === 'header' && cfg.token) headers[cfg.auth_header || 'X-API-Key'] = cfg.token;
    else if (auth === 'query' && cfg.token) params.set(cfg.auth_query || 'api_key', cfg.token);

    // ---- incremental cursor ----
    // Providers differ: some take one "since" param, many take a dt1/dt2 window
    // plus a "records" count. Both styles are supported via config.
    const fmtVal = (sql, fmt) => {
      const f = String(fmt || 'sql').toLowerCase();
      if (f === 'iso')      return String(sql).replace(' ', 'T') + 'Z';
      if (f === 'epoch')    return Math.floor(new Date(String(sql).replace(' ', 'T') + 'Z').getTime() / 1000);
      if (f === 'epoch_ms') return new Date(String(sql).replace(' ', 'T') + 'Z').getTime();
      if (f === 'date')     return String(sql).slice(0, 10);
      if (f === 'compact')  return String(sql).replace(/[-: ]/g, '');
      return sql;                                   // "sql" -> YYYY-MM-DD HH:MM:SS
    };
    const fmt = cfg.since_format || 'sql';
    if (cfg.since_param) params.set(cfg.since_param, String(fmtVal(sinceSql, fmt)));
    // dt1 / dt2 window style (dt2 defaults to "now" a little in the future so
    // that clock skew on the provider side cannot hide the newest rows)
    if (cfg.from_param) params.set(cfg.from_param, String(fmtVal(sinceSql, fmt)));
    if (cfg.to_param) {
      const future = new Date(Date.now() + 60000).toISOString().slice(0, 19).replace('T', ' ');
      params.set(cfg.to_param, String(fmtVal(future, fmt)));
    }
    // record count: default 50 as required
    const recParam = cfg.records_param || cfg.limit_param;
    if (recParam) params.set(recParam, String(cfg.records || cfg.limit || 50));
    for (const [k, v] of Object.entries(cfg.extra_params || {})) params.set(k, String(v));

    // ---- request ----
    const qs = params.toString();
    const full = method === 'GET' && qs ? url + (url.includes('?') ? '&' : '?') + qs : url;
    const init = { method, headers, signal: AbortSignal.timeout(Number(cfg.timeout_ms || 20000)) };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(Object.fromEntries(params));
    }

    const res = await fetch(full, init);
    if (!res.ok) throw new Error(`provider HTTP ${res.status}`);
    const json = await res.json().catch(() => null);
    if (json === null) throw new Error('provider returned non-JSON');

    let rows = dig(json, cfg.records_path || '');
    if (!Array.isArray(rows)) {
      // tolerate common shapes without explicit records_path
      rows = Array.isArray(json) ? json
           : Array.isArray(json.data) ? json.data
           : Array.isArray(json.results) ? json.results
           : Array.isArray(json.messages) ? json.messages
           : [];
    }

    const m = cfg.map || {};
    return rows.map(r => {
      // Payout is OPTIONAL and is only used as an indicator (see below).
      const payoutKeys = [m.payout || 'payout', 'payout', 'price', 'rate', 'amount', 'revenue'];
      let payoutRaw = null;
      for (const k of payoutKeys) {
        if (r && r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') { payoutRaw = r[k]; break; }
      }
      return {
        ref:     String(pick(r, [m.ref     || 'id', 'id', 'message_id', 'sms_id', 'uuid', 'reference', 'msgid'])),
        number:  String(pick(r, [m.number  || 'to', 'to', 'number', 'msisdn', 'recipient', 'destination', 'did'])),
        cli:     String(pick(r, [m.cli     || 'from', 'from', 'cli', 'sender', 'originator', 'service'])),
        message: String(pick(r, [m.message || 'text', 'text', 'message', 'body', 'content', 'sms'])),
        date:    pick(r, [m.date || 'created_at', 'created_at', 'date', 'timestamp', 'received_at', 'time', 'datetime']),
        payoutRaw,
        raw: r,
      };
    });
  },
};

/* ------------------------------------------------------------------ *
 * Provider registry (database-backed)
 * ------------------------------------------------------------------ */

function listProviders(activeOnly = false) {
  const where = activeOnly ? 'WHERE active=1' : '';
  return db.all(`SELECT * FROM sync_providers ${where} ORDER BY id ASC`);
}

function getProvider(id) {
  return db.get('SELECT * FROM sync_providers WHERE id=?', [id]);
}

function parseConfig(row) {
  try { return JSON.parse(row.config_json || '{}'); } catch (_) { return {}; }
}

function markProvider(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.run(
    `UPDATE sync_providers SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`,
    [...keys.map(k => fields[k]), id]
  );
}

function logSync(providerId, status, fetched, inserted, duplicates, failed, ms, error) {
  try {
    db.run(
      `INSERT INTO sync_logs (provider_id,status,fetched,inserted,duplicates,failed,duration_ms,error)
       VALUES (?,?,?,?,?,?,?,?)`,
      [providerId, status, fetched | 0, inserted | 0, duplicates | 0, failed | 0, ms | 0, String(error || '').slice(0, 500)]
    );
    // keep the log table small
    db.runNoSave(`DELETE FROM sync_logs WHERE id NOT IN (SELECT id FROM sync_logs ORDER BY id DESC LIMIT 2000)`);
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * One sync cycle for one provider
 * ------------------------------------------------------------------ */

async function syncProvider(provider, deps, opts = {}) {
  const started = Date.now();
  const cfg = parseConfig(provider);
  const connector = CONNECTORS[provider.connector] || CONNECTORS.generic_json;

  // Cursor with safety overlap. A manual resync ignores the cursor entirely.
  const overlap = Math.max(0, parseInt(provider.overlap_seconds || 30, 10));
  const fullResync = !!opts.full;
  const cursor = provider.last_sync_at || '1970-01-01 00:00:00';
  const since = fullResync ? '1970-01-01 00:00:00' : shiftSql(cursor, -overlap);

  let fetched = 0, inserted = 0, duplicates = 0, failed = 0;
  let newest = provider.last_sync_at || '';

  try {
    const records = await connector(cfg, since, deps.log);
    fetched = records.length;

    if (fetched) {
      // Single transaction for the whole batch: one fsync instead of N.
      try { db.beginBatch && db.beginBatch(); } catch (_) {}
      try {
        for (const rec of records) {
          if (!rec.ref) { failed++; continue; }

          // Deduplicate on (provider_id, provider_ref).
          const seen = db.get(
            'SELECT id FROM sync_seen WHERE provider_id=? AND provider_ref=?',
            [provider.id, rec.ref]
          );
          if (seen) { duplicates++; continue; }

          const receivedAt = toUtcSql(rec.date);

          // Reuse the exact ingestion path used by the live carrier webhook,
          // so allocation, payout, OTP extraction and limits behave identically.
          let ok = false;
          try {
            // Provider payout is an INDICATOR only. Nova always calculates the
            // displayed payout from its own rate cards - EXCEPT when the
            // provider explicitly reports 0, which marks the SMS non-payable.
            const providerPayout = rec.payoutRaw;
            const hasPayout = providerPayout !== null && providerPayout !== undefined && String(providerPayout).trim() !== '';
            const payoutNum = hasPayout ? parseFloat(String(providerPayout).replace(/[^0-9.\-]/g, '')) : NaN;
            const forceZeroPayout = hasPayout && isFinite(payoutNum) && payoutNum === 0;

            const result = deps.processIncomingSmsPayload(
              { headers: {}, query: {}, body: {} },                 // no HTTP request
              { number: rec.number, cli: rec.cli, message: rec.message },
              `provider:${provider.name}`,
              { source: 'api_sync', received_at: receivedAt, forceZeroPayout }
            );
            ok = result && result.status === 200;
            if (!ok) failed++;
          } catch (e) {
            failed++;
            deps.log.warn(`[SYNC] record failed (${provider.name}/${rec.ref}):`, e.message);
          }

          if (ok) {
            inserted++;
            db.run(
              'INSERT OR IGNORE INTO sync_seen (provider_id,provider_ref,received_at) VALUES (?,?,?)',
              [provider.id, rec.ref, receivedAt]
            );
          }
          if (receivedAt > newest) newest = receivedAt;
        }
      } finally {
        try { db.endBatch && db.endBatch(); } catch (e) { deps.log.warn('[SYNC] batch save failed:', e.message); }
      }
    }

    // Advance the cursor only on a successful cycle.
    markProvider(provider.id, {
      last_sync_at: newest || nowUtcSql(),
      last_status: 'ok',
      last_error: '',
      consecutive_failures: 0,
    });
    logSync(provider.id, 'ok', fetched, inserted, duplicates, failed, Date.now() - started, '');

    if (fetched) {
      deps.log.log(`[SYNC] ${provider.name}: fetched=${fetched} new=${inserted} dup=${duplicates} failed=${failed} (${Date.now() - started}ms)`);
      // New rows are visible to every panel immediately: clear the read cache.
      try { deps.clearApiReadCache && deps.clearApiReadCache(); } catch (_) {}
    }
    return { ok: true, fetched, inserted, duplicates, failed };

  } catch (e) {
    // Cursor is deliberately NOT advanced, so nothing is skipped.
    const fails = (provider.consecutive_failures || 0) + 1;
    markProvider(provider.id, {
      last_status: 'error',
      last_error: String(e.message || e).slice(0, 500),
      consecutive_failures: fails,
    });
    logSync(provider.id, 'error', fetched, inserted, duplicates, failed, Date.now() - started, e.message);
    deps.log.warn(`[SYNC] ${provider.name} failed (attempt ${fails}): ${e.message}`);
    return { ok: false, error: String(e.message || e) };
  }
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

let timer = null;
const inFlight = new Set();   // guards against overlapping cycles per provider

function defaultIntervalMs() {
  const s = parseInt(process.env.SYNC_INTERVAL_SECONDS || '12', 10);
  return Math.max(5, isNaN(s) ? 12 : s) * 1000;
}

async function runDueProviders(deps) {
  let providers = [];
  try { providers = listProviders(true); } catch (_) { return; }
  const now = Date.now();

  for (const p of providers) {
    if (inFlight.has(p.id)) continue;

    // Per-provider interval.
    const every = Math.max(5, parseInt(p.interval_seconds || 12, 10)) * 1000;
    const lastRun = p.__lastRunAt || 0;

    // Exponential backoff after repeated failures (capped at 5 minutes),
    // so a broken provider cannot hammer the API or the event loop.
    const fails = p.consecutive_failures || 0;
    const backoff = fails ? Math.min(300000, every * Math.pow(2, Math.min(fails, 5))) : 0;
    const wait = Math.max(every, backoff);

    const last = lastRunMap.get(p.id) || 0;
    if (now - last < wait) continue;

    lastRunMap.set(p.id, now);
    inFlight.add(p.id);
    // Fire and forget: a slow provider must not delay the others.
    syncProvider(p, deps).finally(() => inFlight.delete(p.id));
  }
}

const lastRunMap = new Map();

function start(deps) {
  const enabled = String(process.env.SYNC_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) { deps.log.log('• Provider sync disabled (SYNC_ENABLED=false)'); return null; }
  if (timer) return timer;

  const tick = defaultIntervalMs();
  timer = setInterval(() => { runDueProviders(deps).catch(() => {}); }, tick);
  if (timer.unref) timer.unref();   // never keeps the process alive on shutdown

  const count = (() => { try { return listProviders(true).length; } catch (_) { return 0; } })();
  deps.log.log(`• Provider sync active: scheduler every ${tick / 1000}s, ${count} active provider(s)`);
  return timer;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  start,
  stop,
  syncProvider,
  listProviders,
  getProvider,
  parseConfig,
  CONNECTORS,
  _internal: { toUtcSql, shiftSql, dig, pick },
};
