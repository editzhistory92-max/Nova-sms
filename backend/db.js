/**
 * Database layer — sql.js (pure-JS SQLite) with file persistence.
 * ------------------------------------------------------------------
 * VPS deployment uses a persisted SQLite file.
 * DB_FILE can override the default backend/data.sqlite path.
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_FILE = process.env.DB_FILE
  || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'data.sqlite') : null)
  || path.join(__dirname, 'data.sqlite');
let SQL, db;
let batchDepth = 0;
let batchDirty = false;

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
  batchDirty = false;
}
function autoSave() {
  if (batchDepth > 0) { batchDirty = true; return; }
  save();
}
function beginBatch() { batchDepth++; }
function endBatch() {
  if (batchDepth > 0) batchDepth--;
  if (batchDepth === 0 && batchDirty) save();
}
/**
 * Close a batch WITHOUT flushing to disk.
 *
 * sql.js exports the whole database on every save(), so a recurring background
 * task that only touches bookkeeping rows would otherwise rewrite the entire
 * file (18 MB+) on every tick and block the event loop. Such a task can close
 * its batch with this and let the next real write persist the data.
 * The pending-write flag is preserved, so nothing is silently lost.
 */
function endBatchNoSave() {
  if (batchDepth > 0) batchDepth--;
}

// run a statement (INSERT/UPDATE/DELETE/DDL) with params
function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  autoSave();
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


function exportBuffer() {
  const data = db.export();
  return Buffer.from(data);
}
function getDbFile() {
  return DB_FILE;
}
function replaceWithFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const next = new SQL.Database(new Uint8Array(buf));
  next.run('PRAGMA foreign_keys = ON;');
  if (db && db.close) {
    try { db.close(); } catch (_) {}
  }
  db = next;
  save();
  return db;
}


function exec(sql) {
  db.exec(sql);
  autoSave();
}
function execNoSave(sql) {
  db.exec(sql);
}
function runNoSave(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  const r = db.exec('SELECT last_insert_rowid() AS id');
  return { lastInsertRowid: r[0] ? r[0].values[0][0] : null };
}
function vacuum() {
  try { db.exec('VACUUM'); save(); return true; }
  catch (e) { console.warn('VACUUM failed:', e.message); return false; }
}

module.exports = { init, run, runNoSave, exec, execNoSave, get, all, save, beginBatch, endBatch, endBatchNoSave, vacuum, exportBuffer, getDbFile, replaceWithFile };
