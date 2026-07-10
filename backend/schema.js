/**
 * Database schema — Multi-Level SMS Panel
 * Tables: users, ranges, numbers, sms_records, payments, cli_limits, news
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

  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,     -- kis user ka payment
    period     TEXT DEFAULT '',
    weekly     REAL DEFAULT 0,
    monthly    REAL DEFAULT 0,
    status     TEXT DEFAULT 'Pending',  -- Paid | Pending
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
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

  db.run(`CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT NOT NULL,
    body      TEXT NOT NULL,
    audience  TEXT DEFAULT 'all',   -- all | manager | agent | client
    created_by TEXT DEFAULT 'Admin',
    active    INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_type TEXT DEFAULT 'weekly',      -- weekly | biweekly | monthly | custom
    start_day INTEGER DEFAULT 1,           -- 0=Sunday, 1=Monday...
    end_day INTEGER DEFAULT 0,
    release_day INTEGER DEFAULT 1,
    custom_start TEXT DEFAULT '',
    custom_end TEXT DEFAULT '',
    custom_release TEXT DEFAULT '',
    timezone TEXT DEFAULT 'UTC',
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_role TEXT DEFAULT '',
    manager_id INTEGER,
    amount REAL NOT NULL,
    wallet_address TEXT NOT NULL,
    payment_method TEXT DEFAULT 'Binance',
    status TEXT DEFAULT 'Pending',          -- Pending | Forwarded | Approved | Rejected | Done
    manager_note TEXT DEFAULT '',
    admin_note TEXT DEFAULT '',
    screenshot_url TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    forwarded_at TEXT,
    approved_at TEXT,
    rejected_at TEXT,
    done_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (manager_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS integration_connectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    connector_type TEXT NOT NULL,           -- HTTP | API | WEBHOOK | SMPP | FILE | PANEL_SYNC | MANUAL
    direction TEXT DEFAULT 'both',          -- number_provision | sms_receiving | both
    status TEXT DEFAULT 'disabled',         -- disabled | testing | active
    endpoint_url TEXT DEFAULT '',
    config_json TEXT DEFAULT '{}',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  const pc = db.get('SELECT COUNT(*) AS c FROM payment_config');
  if (!pc || pc.c === 0) {
    db.run(`INSERT INTO payment_config (cycle_type,start_day,end_day,release_day,timezone)
            VALUES ('weekly',1,0,1,'UTC')`);
  }


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

  db.run(`CREATE TABLE IF NOT EXISTS notification_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    scope TEXT DEFAULT 'global',          -- global | manager | agent | client | range | cli
    period TEXT DEFAULT 'daily',          -- daily | payment_cycle | monthly | lifetime
    thresholds TEXT DEFAULT '100,500,1000,5000,10000',
    notify_roles TEXT DEFAULT 'admin',    -- comma list: admin,manager,agent,client
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS notification_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER,
    scope TEXT DEFAULT '',
    scope_key TEXT DEFAULT '',
    scope_name TEXT DEFAULT '',
    period TEXT DEFAULT '',
    period_start TEXT DEFAULT '',
    period_end TEXT DEFAULT '',
    threshold INTEGER DEFAULT 0,
    count INTEGER DEFAULT 0,
    message TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY,
    notification_sound INTEGER DEFAULT 1,
    notification_popup INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  const nr = db.get('SELECT COUNT(*) AS c FROM notification_rules');
  if (!nr || nr.c === 0) {
    const defaults = [
      ['Global Daily Milestones','global','daily','100,500,1000,5000,10000','admin'],
      ['Manager Daily Milestones','manager','daily','100,500,1000,5000,10000','admin,manager'],
      ['Agent Daily Milestones','agent','daily','100,500,1000,5000,10000','admin,manager,agent'],
      ['Client Daily Milestones','client','daily','100,500,1000,5000,10000','admin,manager,agent,client'],
      ['Range Monthly Milestones','range','monthly','1000,5000,10000,50000,100000','admin,manager'],
      ['CLI Daily Milestones','cli','daily','100,500,1000,5000,10000','admin,manager']
    ];
    defaults.forEach(r => db.run('INSERT INTO notification_rules (name,scope,period,thresholds,notify_roles,active) VALUES (?,?,?,?,?,1)', r));
  }


  db.run(`CREATE TABLE IF NOT EXISTS carrier_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    integration_status TEXT DEFAULT 'disabled', -- enabled | disabled
    carrier_ip TEXT DEFAULT '',
    http_callback_url TEXT DEFAULT '',
    api_key TEXT DEFAULT '',
    auth_token TEXT DEFAULT '',
    smpp_host TEXT DEFAULT '',
    smpp_port TEXT DEFAULT '',
    smpp_system_id TEXT DEFAULT '',
    smpp_password TEXT DEFAULT '',
    smpp_bind_type TEXT DEFAULT 'transceiver',
    smpp_enabled INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    retention_days INTEGER DEFAULT 30,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  ensureColumn('webhook_logs', 'source_ip', "TEXT DEFAULT ''");
  ensureColumn('carrier_settings', 'retention_days', 'INTEGER DEFAULT 30');
  ensureColumn('carrier_settings', 'smpp_bind_type', "TEXT DEFAULT 'transceiver'");
  ensureColumn('carrier_settings', 'smpp_enabled', 'INTEGER DEFAULT 0');
  ensureColumn('sms_records', 'is_test', 'INTEGER DEFAULT 0');
  ensureColumn('sms_records', 'test_batch_id', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'source', "TEXT DEFAULT 'carrier'");
  ensureColumn('sms_records', 'sender_type', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'otp_code', "TEXT DEFAULT ''");
  ensureColumn('numbers', 'import_batch_id', "TEXT DEFAULT ''");
  ensureColumn('numbers', 'import_source', "TEXT DEFAULT ''");
  ensureColumn('numbers', 'imported_by', 'INTEGER');
  ensureColumn('numbers', 'imported_at', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'payout_rate', "TEXT DEFAULT ''");
  ensureColumn('sms_records', 'payout_amount', "TEXT DEFAULT ''");

  const cs = db.get('SELECT COUNT(*) AS c FROM carrier_settings');
  if (!cs || cs.c === 0) {
    db.run(`INSERT INTO carrier_settings (integration_status,carrier_ip,http_callback_url,notes,smpp_host,smpp_port,smpp_system_id,smpp_password,smpp_bind_type,smpp_enabled)
            VALUES ('disabled','','/api/incoming-sms','HTTP integration ready. SMPP disabled.','','','','','disabled',0)`);
  }


  db.run(`CREATE TABLE IF NOT EXISTS qa_test_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    enabled INTEGER DEFAULT 0,
    max_batch_size INTEGER DEFAULT 100,
    default_cli TEXT DEFAULT 'TestCLI',
    default_message TEXT DEFAULT 'Your test verification code is {code}',
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  const qa = db.get('SELECT COUNT(*) AS c FROM qa_test_settings');
  if (!qa || qa.c === 0) {
    db.run(`INSERT INTO qa_test_settings (enabled,max_batch_size,default_cli,default_message)
            VALUES (0,100,'TestCLI','Your test verification code is {code}')`);
  }


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

  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_import_batch ON numbers(import_batch_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_import_source ON numbers(import_source)`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_number ON numbers(number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_range ON numbers(range_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_manager ON numbers(manager_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_agent ON numbers(agent_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_client ON numbers(client_id)`);

}

module.exports = { createTables };
