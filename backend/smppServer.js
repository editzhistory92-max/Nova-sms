/*
 * MUFASA SMS — SMPP Server (incoming channel)
 * ------------------------------------------------------------
 * This is an SMPP SERVER, not the old outbound/client connector.
 * Carriers bind to us using system_id/password and submit SMS.
 * All accepted messages are passed into the same incoming flow used
 * by HTTP /api/incoming-sms.
 */
const smpp = require('smpp');
const bcrypt = require('bcryptjs');

const DEFAULT_PORT = parseInt(process.env.SMPP_SERVER_PORT || '2775', 10);
const DEFAULT_HOST = process.env.SMPP_SERVER_HOST || '0.0.0.0';
const DEFAULT_ENABLED = String(process.env.SMPP_SERVER_ENABLED || 'true').toLowerCase() !== 'false';

let servers = new Map(); // port -> server
let sessions = new Map(); // sessionId -> {session,user,ip,port,bindType,connectedAt}
let lastOptions = null;
let seq = 1;

function cleanIp(ip) { return String(ip || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1').trim(); }
function safeJson(v) { try { return JSON.stringify(v || {}); } catch (_) { return '{}'; } }
function nextSessionId() { return 'SMPP-' + Date.now().toString(36).toUpperCase() + '-' + (seq++).toString(36).toUpperCase(); }
function okConst(name, fallback) { return typeof smpp[name] === 'number' ? smpp[name] : fallback; }
const ESME_ROK = okConst('ESME_ROK', 0);
const ESME_RSYSERR = okConst('ESME_RSYSERR', 8);
const ESME_RBINDFAIL = okConst('ESME_RBINDFAIL', 13);
const ESME_RINVPASWD = okConst('ESME_RINVPASWD', 14);
const ESME_RINVSYSID = okConst('ESME_RINVSYSID', 15);
const ESME_RINVCMDID = okConst('ESME_RINVCMDID', 3);

function logDb(db, event) {
  try {
    db.run(`INSERT INTO smpp_logs (user_id,username,ip,port,event,command,status,number,cli,message,error,raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      event.user_id || null,
      event.username || '',
      event.ip || '',
      event.port || null,
      event.event || '',
      event.command || '',
      event.status || '',
      event.number || '',
      event.cli || '',
      event.message || '',
      event.error || '',
      safeJson(event.raw || {})
    ]);
  } catch (e) {
    try { console.warn('[SMPP_SERVER] log db failed:', e.message); } catch (_) {}
  }
}

function updateSessionDb(db, sid, patch) {
  try {
    const cur = db.get('SELECT id FROM smpp_sessions WHERE session_id=?', [sid]);
    if (!cur) return;
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === '__NOW__') sets.push(`${k}=datetime('now')`);
      else { sets.push(`${k}=?`); vals.push(v); }
    }
    if (!sets.length) return;
    vals.push(sid);
    db.run(`UPDATE smpp_sessions SET ${sets.join(', ')} WHERE session_id=?`, vals);
  } catch (e) {
    try { console.warn('[SMPP_SERVER] session update failed:', e.message); } catch (_) {}
  }
}

function userAllowedIp(user, ip) {
  const allowed = String(user.allowed_ip || '').split(/[\s,;]+/).map(cleanIp).filter(Boolean);
  if (!allowed.length) return true;
  return allowed.includes(cleanIp(ip));
}
function bindTypeFromCommand(cmd) { return String(cmd || '').replace(/^bind_/, '').toLowerCase(); }
function userAllowedBind(user, bindType) {
  const want = String(user.bind_type || 'any').toLowerCase();
  return want === 'any' || want === bindType;
}
function userPortAllowed(user, port) {
  const p = parseInt(user.port || DEFAULT_PORT, 10) || DEFAULT_PORT;
  return p === Number(port);
}

function decodeBuffer(buf, dataCoding) {
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  if (!buf.length) return '';
  // UCS2 / UTF-16BE is data_coding 8 in SMPP. Node supports UTF-16LE, so swap bytes.
  if (Number(dataCoding) === 8) {
    const swapped = Buffer.from(buf);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const a = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = a;
    }
    return swapped.toString('utf16le').replace(/\u0000+$/g, '').trim();
  }
  return buf.toString('utf8').replace(/\u0000+$/g, '').trim();
}
function decodeShortMessage(pdu) {
  let raw = pdu.short_message;
  if (raw && typeof raw === 'object' && raw.message !== undefined) raw = raw.message;
  if ((raw === undefined || raw === null || raw === '') && pdu.message_payload) raw = pdu.message_payload;
  if (Buffer.isBuffer(raw)) return decodeBuffer(raw, pdu.data_coding);
  if (Array.isArray(raw)) return decodeBuffer(Buffer.from(raw), pdu.data_coding);
  return String(raw || '').trim();
}
function isDeliveryReceipt(pdu, message) {
  if ((Number(pdu.esm_class || 0) & 0x04) === 0x04) return true;
  return /^id:[^\s]+\s+sub:/i.test(String(message || '')) && /\s+stat:/i.test(String(message || ''));
}
function pduPayload(pdu, user) {
  const msg = decodeShortMessage(pdu);
  let number = String(pdu.destination_addr || pdu.destination || '').trim();
  let cli = String(pdu.source_addr || pdu.source || '').trim();
  const mapping = String(user.mapping || 'destination_to_number').toLowerCase();
  if (mapping === 'source_to_number') {
    const tmp = number; number = cli; cli = tmp;
  }
  return {
    number,
    cli,
    message: msg,
    smpp_command: pdu.command,
    smpp_sequence: pdu.sequence_number,
    smpp_user: user.username,
    data_coding: pdu.data_coding,
    esm_class: pdu.esm_class
  };
}

function respond(session, pdu, status) {
  try { session.send(pdu.response({ command_status: status })); } catch (_) {}
}

function authenticateBind({ db, session, pdu, port, ip, bindType }) {
  const systemId = String(pdu.system_id || '').trim();
  const password = String(pdu.password || '');
  const user = db.get('SELECT * FROM smpp_users WHERE username=?', [systemId]);
  if (!user) return { ok: false, status: ESME_RINVSYSID, error: 'Invalid system_id' };
  if (!user.enabled) return { ok: false, status: ESME_RBINDFAIL, user, error: 'SMPP user disabled' };
  if (!userPortAllowed(user, port)) return { ok: false, status: ESME_RBINDFAIL, user, error: 'Port not allowed for user' };
  if (!userAllowedBind(user, bindType)) return { ok: false, status: ESME_RBINDFAIL, user, error: 'Bind type not allowed' };
  if (!userAllowedIp(user, ip)) return { ok: false, status: ESME_RBINDFAIL, user, error: 'IP not allowed' };
  let passOk = false;
  try { passOk = bcrypt.compareSync(password, user.password_hash || ''); } catch (_) { passOk = false; }
  if (!passOk) return { ok: false, status: ESME_RINVPASWD, user, error: 'Invalid password' };
  return { ok: true, user };
}

function handleBind(opts, session, pdu, port, ip, bindType) {
  const { db, logger } = opts;
  const auth = authenticateBind({ db, session, pdu, port, ip, bindType });
  const username = pdu.system_id || '';
  if (!auth.ok) {
    logDb(db, { user_id: auth.user?.id, username, ip, port, event: 'bind_rejected', command: pdu.command, status: 'failed', error: auth.error, raw: { bindType } });
    logger.warn && logger.warn('[SMPP_SERVER] bind rejected', { username, ip, port, bindType, error: auth.error });
    respond(session, pdu, auth.status);
    try { session.close(); } catch (_) {}
    return;
  }
  const sid = nextSessionId();
  session.__mufasaSessionId = sid;
  session.__mufasaUser = auth.user;
  session.__mufasaBindType = bindType;
  sessions.set(sid, { session, user: auth.user, ip, port, bindType, connectedAt: new Date().toISOString() });
  try {
    db.run(`INSERT INTO smpp_sessions (session_id,user_id,username,ip,port,bind_type,status,connected_at,last_seen)
      VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`, [sid, auth.user.id, auth.user.username, ip, port, bindType, 'connected']);
  } catch (e) { logger.warn && logger.warn('[SMPP_SERVER] session db insert failed:', e.message); }
  logDb(db, { user_id: auth.user.id, username: auth.user.username, ip, port, event: 'bind_success', command: pdu.command, status: 'connected', raw: { bindType } });
  logger.log && logger.log('[SMPP_SERVER] bind success', { username: auth.user.username, ip, port, bindType });
  respond(session, pdu, ESME_ROK);
}

function handleIncomingPdu(opts, session, pdu, port, ip) {
  const { db, processIncomingSmsPayload, logger } = opts;
  const user = session.__mufasaUser;
  if (!user) { respond(session, pdu, ESME_RBINDFAIL); return; }
  const payload = pduPayload(pdu, user);
  updateSessionDb(db, session.__mufasaSessionId, { last_seen: '__NOW__' });
  if (isDeliveryReceipt(pdu, payload.message)) {
    logDb(db, { user_id: user.id, username: user.username, ip, port, event: 'delivery_receipt_ignored', command: pdu.command, status: 'ignored', number: payload.number, cli: payload.cli, message: payload.message, raw: payload });
    respond(session, pdu, ESME_ROK);
    return;
  }
  let result;
  try {
    result = processIncomingSmsPayload({ ip, smpp_user: user.username }, payload, ip, { source: 'smpp' });
    logDb(db, { user_id: user.id, username: user.username, ip, port, event: 'incoming_sms', command: pdu.command, status: result.status === 200 ? 'saved' : 'failed', number: payload.number, cli: payload.cli, message: payload.message, error: result.body?.error || '', raw: payload });
  } catch (e) {
    logger.error && logger.error('[SMPP_SERVER] incoming pdu failed', e);
    logDb(db, { user_id: user.id, username: user.username, ip, port, event: 'incoming_sms_error', command: pdu.command, status: 'error', number: payload.number, cli: payload.cli, message: payload.message, error: e.message, raw: payload });
    respond(session, pdu, ESME_RSYSERR);
    return;
  }
  // Always ACK application-level rejects (number not found etc.) to prevent retry storms.
  respond(session, pdu, ESME_ROK);
}

function setupSession(opts, session, port) {
  const { db, logger } = opts;
  const ip = cleanIp(session.socket && session.socket.remoteAddress);
  session.on('bind_transceiver', pdu => handleBind(opts, session, pdu, port, ip, 'transceiver'));
  session.on('bind_transmitter', pdu => handleBind(opts, session, pdu, port, ip, 'transmitter'));
  session.on('bind_receiver', pdu => handleBind(opts, session, pdu, port, ip, 'receiver'));
  session.on('submit_sm', pdu => handleIncomingPdu(opts, session, pdu, port, ip));
  session.on('deliver_sm', pdu => handleIncomingPdu(opts, session, pdu, port, ip));
  session.on('data_sm', pdu => handleIncomingPdu(opts, session, pdu, port, ip));
  session.on('enquire_link', pdu => { updateSessionDb(db, session.__mufasaSessionId, { last_seen: '__NOW__' }); respond(session, pdu, ESME_ROK); });
  session.on('unbind', pdu => { respond(session, pdu, ESME_ROK); try { session.close(); } catch (_) {} });
  session.on('close', () => {
    const sid = session.__mufasaSessionId;
    const user = session.__mufasaUser;
    if (sid) updateSessionDb(db, sid, { status: 'disconnected', disconnected_at: '__NOW__' });
    if (sid) sessions.delete(sid);
    if (user) logDb(db, { user_id: user.id, username: user.username, ip, port, event: 'session_closed', status: 'disconnected' });
  });
  session.on('error', err => {
    const user = session.__mufasaUser;
    logger.warn && logger.warn('[SMPP_SERVER] session error', { ip, port, error: err.message });
    logDb(db, { user_id: user?.id, username: user?.username || '', ip, port, event: 'session_error', status: 'error', error: err.message });
  });
  session.on('pdu', pdu => {
    const known = ['bind_transceiver','bind_transmitter','bind_receiver','submit_sm','deliver_sm','data_sm','enquire_link','unbind'];
    if (!known.includes(pdu.command)) {
      logger.warn && logger.warn('[SMPP_SERVER] unsupported pdu', { command: pdu.command, ip, port });
      try { session.send(pdu.response({ command_status: ESME_RINVCMDID })); } catch (_) {}
    }
  });
}

function desiredPorts(db) {
  const ports = new Set([DEFAULT_PORT]);
  try {
    db.all('SELECT DISTINCT port FROM smpp_users WHERE enabled=1').forEach(r => {
      const p = parseInt(r.port || DEFAULT_PORT, 10);
      if (p > 0) ports.add(p);
    });
  } catch (_) {}
  return [...ports].sort((a, b) => a - b);
}

function start(options) {
  lastOptions = options;
  const { db, logger = console } = options;
  if (!DEFAULT_ENABLED) {
    logger.log && logger.log('[SMPP_SERVER] disabled by SMPP_SERVER_ENABLED=false');
    return { ok: true, disabled: true };
  }
  const ports = desiredPorts(db);
  for (const port of ports) {
    if (servers.has(port)) continue;
    const server = smpp.createServer(session => setupSession({ ...options, logger }, session, port));
    server.on('error', err => {
      logger.error && logger.error('[SMPP_SERVER] server error', { port, error: err.message });
      logDb(db, { port, event: 'server_error', status: 'error', error: err.message });
    });
    server.listen(port, DEFAULT_HOST, () => {
      logger.log && logger.log(`[SMPP_SERVER] listening on ${DEFAULT_HOST}:${port}`);
      logDb(db, { port, event: 'server_listen', status: 'listening', raw: { host: DEFAULT_HOST, port } });
    });
    servers.set(port, server);
  }
  return { ok: true, ports, sessions: sessions.size };
}

function stop() {
  for (const [sid, entry] of sessions.entries()) {
    try { entry.session.close(); } catch (_) {}
    sessions.delete(sid);
  }
  for (const [port, server] of servers.entries()) {
    try { server.close(); } catch (_) {}
    servers.delete(port);
  }
  return { ok: true };
}

function restart(options = null) {
  stop();
  return start(options || lastOptions);
}

function status() {
  return {
    enabled: DEFAULT_ENABLED,
    host: DEFAULT_HOST,
    ports: [...servers.keys()],
    sessions: [...sessions.entries()].map(([session_id, s]) => ({ session_id, username: s.user?.username || '', ip: s.ip, port: s.port, bind_type: s.bindType, connected_at: s.connectedAt }))
  };
}

module.exports = { start, stop, restart, status };
