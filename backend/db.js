/**
 * Database layer — sql.js (pure-JS SQLite) with file persistence.
 * ------------------------------------------------------------------
 * Ye sandbox/local ke liye hai (koi native build nahi chahiye).
 * VPS/production par MySQL par switch karne ke liye niche notes hain
 * (README dekhein) — SQL portable rakhi gayi hai.
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_FILE = process.env.DB_FILE
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data.sqlite') : null)
  || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'data.sqlite') : null)
  || path.join(__dirname, 'data.sqlite');
let SQL, db;

// initialize (async once at startup)
async function init() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  console.log('• Database file:', DB_FILE);
  SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const buf = fs.readFileSync(DB_FILE);
    db = new SQL.Database(new Uint8Array(buf));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON;');
  return db;
}

// persist to disk
function save() {
  const data = db.export();
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

// run a statement (INSERT/UPDATE/DELETE/DDL) with params
function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  save();
  // return lastInsertRowid
  const r = db.exec('SELECT last_insert_rowid() AS id');
  return { lastInsertRowid: r[0] ? r[0].values[0][0] : null };
}

// get single row
function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

// get all rows
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

module.exports = { init, run, get, all, save };
