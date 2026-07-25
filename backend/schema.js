/**
 * Database schema — Multi-Level SMS Panel
 * Tables: users, ranges, numbers, sms_records, payments, cli_limits, integrations
 * Hierarchy: admin > manager > agent > client (via users.parent_id)
 */
const db = require('./db');

function ensureColumn(table, column, definition) {
  const cols = db.all(`PRAGMA table_info(${table})`).map(c => c.name);
  if (!cols.includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function createTables() {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,            -- bcrypt hash
    role       TEXT NOT NULL,            -- admin | manager | agent | client
    name       TEXT DEFAULT '',
    email      TEXT DEFAULT '',
    whatsapp   TEXT DEFAULT '',
    contact    TEXT DEFAULT '',
    skype      TEXT DEFAULT '',
    parent_id  INTEGER,                  -- kis manager/agent ke neeche
    active     INTEGER DEFAULT 1,        -- 1 = active, 0 = disabled
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ranges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    prefix      TEXT DEFAULT '',
    test_number TEXT DEFAULT '',
    currency    TEXT DEFAULT 'USD',
    rate_1_1    TEXT DEFAULT 'NA',
    rate_7_1    TEXT DEFAULT 'NA',
    rate_7_7    TEXT DEFAULT 'NA',
    rate_30_45  TEXT DEFAULT 'NA',
    memo        TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
  )`);



  db.run(`CREATE TABLE IF NOT EXISTS range_test_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    range_id INTEGER NOT NULL,
    test_number TEXT NOT NULL,
    label TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (range_id) REFERENCES ranges(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    range_id   INTEGER NOT NULL,
    number     TEXT NOT NULL,
    prefix     TEXT DEFAULT '',
    rate       TEXT DEFAULT '',
    payterm    TEXT DEFAULT 'Weekly',
    payout     TEXT DEFAULT '0',
    -- ownership chain (kisi bhi level par assigned ho sakta hai)
    manager_id INTEGER,
    agent_id   INTEGER,
    client_id  INTEGER,
    sd_limit   INTEGER DEFAULT 0,
    sw_limit   INTEGER DEFAULT 0,
    import_batch_id TEXT DEFAULT '',
    import_source TEXT DEFAULT '',
    imported_by INTEGER,
    imported_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (range_id) REFERENCES ranges(id)
  )`);


  db.run(`CREATE TABLE IF NOT EXISTS number_import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT UNIQUE NOT NULL,
    range_id INTEGER,
    range_name TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    total INTEGER DEFAULT 0,
    inserted INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    status TEXT DEFAULT 'processing', -- processing | done | failed | deleted
    error TEXT DEFAULT '',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    deleted_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sms_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number_id  INTEGER,
    number     TEXT,
    range_id   INTEGER,
    cli        TEXT DEFAULT '',
    sender_type TEXT DEFAULT '',
    message    TEXT DEFAULT '',
    otp_code   TEXT DEFAULT '',
    is_otp     INTEGER DEFAULT 1,
    client_id  INTEGER,
    agent_id   INTEGER,
    manager_id INTEGER,
    is_test INTEGER DEFAULT 0,
    test_batch_id TEXT DEFAULT '',
    source TEXT DEFAULT 'carrier',
    payout_rate TEXT DEFAULT '',
    payout_amount TEXT DEFAULT '',
    received_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS cli_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cli        TEXT NOT NULL,
    type       TEXT DEFAULT 'overall',   -- overall | specific
    manager_id INTEGER,                   -- specific ke liye
    limit_val  INTEGER DEFAULT 0,
    used       INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);





  db.run(`CREATE TABLE IF NOT EXISTS payment_v2_settings (
    payment_type TEXT PRIMARY KEY,
    label TEXT DEFAULT '',
    min_withdrawal TEXT DEFAULT '0',
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  const payTypes = [
    ['daily','Daily','0',1,1],
    ['weekly','Weekly','0',1,2],
    ['monthly_30x45','Monthly (30x45)','0',1,3]
  ];
  payTypes.forEach(r => {
    const ex = db.get('SELECT payment_type FROM payment_v2_settings WHERE payment_type=?', [r[0]]);
    if (!ex) db.run('INSERT INTO payment_v2_settings (payment_type,label,min_withdrawal,active,sort_order) VALUES (?,?,?,?,?)', r);
  });

  db.run(`CREATE TABLE IF NOT EXISTS agent_wallets (
    agent_id INTEGER PRIMARY KEY,
    wallet_address TEXT DEFAULT '',
    network TEXT DEFAULT 'USDT_TRC20',
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sms_record_id INTEGER UNIQUE,
    agent_id INTEGER NOT NULL,
    manager_id INTEGER,
    range_id INTEGER,
    payment_type TEXT NOT NULL,
    amount TEXT DEFAULT '0',
    earned_at TEXT DEFAULT '',
    cycle_key TEXT DEFAULT '',
    eligible_at TEXT DEFAULT '',
    status TEXT DEFAULT 'open', -- open | requested | paid | rejected
    request_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_requests_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    manager_id INTEGER,
    payment_type TEXT NOT NULL,
    amount TEXT DEFAULT '0',
    wallet_address TEXT NOT NULL,
    status TEXT DEFAULT 'Pending', -- Pending | Paid | Rejected
    requested_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT,
    rejected_at TEXT,
    processed_by INTEGER,
    txid TEXT DEFAULT '',
    screenshot_url TEXT DEFAULT '',
    admin_notes TEXT DEFAULT '',
    reject_reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    actor_name TEXT DEFAULT '',
    actor_role TEXT DEFAULT '',
    action TEXT NOT NULL,
    request_id INTEGER,
    agent_id INTEGER,
    manager_id INTEGER,
    payment_type TEXT DEFAULT '',
    amount TEXT DEFAULT '',
    wallet_address TEXT DEFAULT '',
    status TEXT DEFAULT '',
    details TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_notifications_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    request_id INTEGER,
    event TEXT DEFAULT '',
    message TEXT DEFAULT '',
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT DEFAULT '',
    role TEXT DEFAULT '',
    action TEXT NOT NULL,
    module TEXT DEFAULT '',
    details TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS number_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number_id INTEGER,
    number TEXT DEFAULT '',
    action TEXT NOT NULL,
    from_owner TEXT DEFAULT '',
    to_owner TEXT DEFAULT '',
    details TEXT DEFAULT '',
    user_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS webhook_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT DEFAULT 'success',
    number TEXT DEFAULT '',
    matched_number TEXT DEFAULT '',
    cli TEXT DEFAULT '',
    message TEXT DEFAULT '',
    raw_payload TEXT DEFAULT '{}',
    error TEXT DEFAULT '',
    source_ip TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS failed_sms_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT DEFAULT '',
    cli TEXT DEFAULT '',
    message TEXT DEFAULT '',
    raw_payload TEXT DEFAULT '{}',
    error TEXT DEFAULT '',
    source_ip TEXT DEFAULT '',
    status TEXT DEFAULT 'Pending',       -- Pending | Retried | Ignored
    retry_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);




  db.run(`CREATE TABLE IF NOT EXISTS carrier_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    integration_status TEXT DEFAULT 'disabled', -- enabled | disabled
    carrier_ip TEXT DEFAULT '',
    http_callback_url TEXT DEFAULT '',
    api_key TEXT DEFAULT '',
    auth_token TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    retention_days INTEGER DEFAULT 30,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  ensureColumn('webhook_logs', 'source_ip', "TEXT DEFAULT ''");
  ensureColumn('carrier_settings', 'retention_days', 'INTEGER DEFAULT 30');
  ensureColumn('sms_records', 'is_test', 'INTEGER DEFAULT 0');
  ensureColumn('sms_records', 'test_batch_id', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'source', "TEXT DEFAULT 'carrier'");
  ensureColumn('sms_records', 'sender_type', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'otp_code', "TEXT DEFAULT ''");
  ensureColumn('users', 'payment_type', "TEXT DEFAULT 'weekly'");
  ensureColumn('sms_records', 'payment_type', "TEXT DEFAULT ''");
  ensureColumn('ranges', 'payment_type', "TEXT DEFAULT 'weekly'");
  ensureColumn('numbers', 'import_batch_id', "TEXT DEFAULT ''");
  ensureColumn('numbers', 'import_source', "TEXT DEFAULT ''");
  ensureColumn('numbers', 'imported_by', 'INTEGER');
  ensureColumn('numbers', 'imported_at', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'payout_rate', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'payout_amount', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'limit_reason', "TEXT DEFAULT ''");
  ensureColumn('ranges', 'deleted_at', "TEXT DEFAULT ''");

  const cs = db.get('SELECT COUNT(*) AS c FROM carrier_settings');
  if (!cs || cs.c === 0) {
    db.run(`INSERT INTO carrier_settings (integration_status,carrier_ip,http_callback_url,notes)
            VALUES ('disabled','','/api/incoming-sms','HTTP integration ready')`);
  }



  db.run(`CREATE TABLE IF NOT EXISTS daily_limit_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    limit_type TEXT NOT NULL, -- range | number | cli
    range_id INTEGER,
    cli TEXT DEFAULT '',
    number TEXT DEFAULT '',
    daily_limit INTEGER NOT NULL DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS api_integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    enabled INTEGER DEFAULT 0,
    method TEXT DEFAULT 'GET',
    auth_type TEXT DEFAULT 'query_token', -- query_token | bearer | header | none
    token TEXT DEFAULT '',
    token_param TEXT DEFAULT 'token',
    token_header TEXT DEFAULT 'Authorization',
    dt1_param TEXT DEFAULT 'dt1',
    dt2_param TEXT DEFAULT 'dt2',
    records_param TEXT DEFAULT 'records',
    records_limit INTEGER DEFAULT 100,
    poll_interval_sec INTEGER DEFAULT 5,
    response_format TEXT DEFAULT 'auto',
    last_poll_at TEXT,
    last_success_at TEXT,
    last_error TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS api_integration_seen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    integration_id INTEGER,
    duplicate_key TEXT UNIQUE NOT NULL,
    provider_message_id TEXT DEFAULT '',
    first_seen_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS api_integration_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    integration_id INTEGER,
    integration_name TEXT DEFAULT '',
    request_time TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT '', -- success | failed | duplicate | ignored
    reason TEXT DEFAULT '',
    number TEXT DEFAULT '',
    cli TEXT DEFAULT '',
    message TEXT DEFAULT '',
    provider_message_id TEXT DEFAULT '',
    duplicate_key TEXT DEFAULT '',
    raw_json TEXT DEFAULT '',
    sms_record_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);


  db.run(`CREATE TABLE IF NOT EXISTS system_security (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_security_code TEXT DEFAULT 'Dawood',
    carrier_lock_password TEXT DEFAULT 'Dawood',
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  ensureColumn('system_security', 'carrier_lock_password', "TEXT DEFAULT 'Dawood'");
  const sc = db.get('SELECT COUNT(*) AS c FROM system_security');
  if (!sc || sc.c === 0) {
    db.run(`INSERT INTO system_security (admin_security_code) VALUES ('Dawood')`);
  }


  // Performance indexes for analytics/search/reporting.
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_cli ON sms_records(cli)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_received_at ON sms_records(received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_cli_received ON sms_records(cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_manager_cli_date ON sms_records(manager_id, cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_agent_cli_date ON sms_records(agent_id, cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_client_cli_date ON sms_records(client_id, cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_range_cli_date ON sms_records(range_id, cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_number_cli_date ON sms_records(number, cli, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_test_date ON sms_records(is_test, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_manager_date ON sms_records(manager_id, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_agent_date ON sms_records(agent_id, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_client_date ON sms_records(client_id, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_range_date ON sms_records(range_id, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sms_number_date ON sms_records(number, received_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ranges_name_nocase ON ranges(name COLLATE NOCASE)`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_import_batch ON numbers(import_batch_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_import_source ON numbers(import_source)`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_number ON numbers(number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_range ON numbers(range_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_manager ON numbers(manager_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_agent ON numbers(agent_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_client ON numbers(client_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_manager_range_number ON numbers(manager_id, range_id, number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_agent_range_number ON numbers(agent_id, range_id, number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_client_range_number ON numbers(client_id, range_id, number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_limit_rules_type_active ON daily_limit_rules(limit_type, active)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_limit_rules_range ON daily_limit_rules(range_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_limit_rules_cli ON daily_limit_rules(cli)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_limit_rules_number ON daily_limit_rules(number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_integrations_enabled ON api_integrations(enabled)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_seen_key ON api_integration_seen(duplicate_key)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_logs_integration ON api_integration_logs(integration_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_logs_status ON api_integration_logs(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_ledger_agent_type_status ON payment_ledger(agent_id, payment_type, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_ledger_eligible ON payment_ledger(payment_type, eligible_at, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_requests_agent_type_status ON payment_requests_v2(agent_id, payment_type, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests_v2(status, requested_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_notifications_agent ON payment_notifications_v2(agent_id, read_at, created_at)`);

}

module.exports = { createTables };
