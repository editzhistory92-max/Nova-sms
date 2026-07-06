'use strict';

/**
 * Active SMPP client connector for Mufasa SMS.
 *
 * Reads SMPP settings from Carrier Settings and forwards deliver_sm messages
 * into the same SMS processing flow used by HTTP carrier integration.
 */
const smpp = require('smpp');

let session = null;
let reconnectTimer = null;
let getSettings = null;
let onIncomingSms = null;
let logger = console;

const status = {
  enabled: false,
  state: 'DISCONNECTED', // CONNECTING | CONNECTED | DISCONNECTED | DISABLED | ERROR | RECONNECTING
  connected: false,
  host: '',
  port: '',
  bind_type: 'transceiver',
  system_id_present: false,
  last_connected_at: '',
  last_disconnected_at: '',
  last_connect_attempt_at: '',
  last_error: '',
  last_bind_status: '',
  last_pdu_at: '',
  last_log_at: '',
  reconnect_attempts: 0,
};

function now() {
  return new Date().toISOString();
}

function log(...args) {
  status.last_log_at = now();
  try { (logger || console).log('[SMPP]', ...args); } catch (_) {}
}

function error(...args) {
  status.last_log_at = now();
  try { (logger || console).error('[SMPP]', ...args); } catch (_) {}
}

function cloneStatus() {
  return { ...status };
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function closeSession(reason = 'manual') {
  if (!session) return;
  log('Closing existing session:', reason);
  try { session.removeAllListeners(); } catch (_) {}
  try { session.unbind(); } catch (_) {}
  try { session.close(); } catch (_) {}
  session = null;
}

function setDisconnected(reason) {
  status.connected = false;
  status.state = reason === 'disabled' ? 'DISABLED' : 'DISCONNECTED';
  status.last_disconnected_at = now();
}

function commandStatusName(code) {
  const names = {
    0: 'ESME_ROK / OK',
    1: 'ESME_RINVMSGLEN',
    2: 'ESME_RINVCMDLEN',
    3: 'ESME_RINVCMDID',
    4: 'ESME_RINVBNDSTS',
    5: 'ESME_RALYBND',
    8: 'ESME_RSYSERR',
    10: 'ESME_RINVSRCADR',
    11: 'ESME_RINVDSTADR',
    13: 'ESME_RBINDFAIL',
    14: 'ESME_RINVPASWD',
    15: 'ESME_RINVSYSID',
    52: 'ESME_RINVEXPIRY',
    88: 'ESME_RTHROTTLED',
  };
  return names[code] || `UNKNOWN_STATUS_${code}`;
}

function decodeShortMessage(sm) {
  if (!sm) return '';
  if (typeof sm === 'string') return sm;
  if (Buffer.isBuffer(sm)) return sm.toString('utf8');
  if (sm.message !== undefined) {
    if (Buffer.isBuffer(sm.message)) return sm.message.toString('utf8');
    return String(sm.message || '');
  }
  try { return Buffer.from(sm).toString('utf8'); } catch (_) {}
  return String(sm || '');
}

function buildPayloadFromDeliverSm(pdu) {
  return {
    number: pdu.destination_addr || pdu.receipted_message_id || '',
    cli: pdu.source_addr || '',
    message: decodeShortMessage(pdu.short_message),
    smpp_command: pdu.command,
    smpp_sequence: pdu.sequence_number,
    smpp_service_type: pdu.service_type || '',
  };
}

function scheduleReconnect(delayMs = 10000) {
  clearReconnect();
  const cfg = getSettings ? (getSettings() || {}) : {};
  if ((cfg.integration_status || 'disabled') !== 'enabled' || !cfg.smpp_host || !cfg.smpp_system_id) {
    log('Reconnect not scheduled: SMPP disabled or missing credentials');
    return;
  }
  status.state = 'RECONNECTING';
  log(`Scheduling reconnect in ${Math.round(delayMs / 1000)}s`);
  reconnectTimer = setTimeout(() => connect().catch(() => {}), delayMs);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

function credentialsSummary(cfg) {
  return {
    integration_status: cfg.integration_status || 'disabled',
    host: cfg.smpp_host || '',
    port: cfg.smpp_port || '2775',
    system_id_present: !!cfg.smpp_system_id,
    password_present: !!cfg.smpp_password,
  };
}

async function connect() {
  if (!getSettings || !onIncomingSms) {
    status.state = 'ERROR';
    status.last_error = 'SMPP init missing getSettings/onIncomingSms handlers';
    error(status.last_error);
    return cloneStatus();
  }

  const cfg = getSettings() || {};
  const enabled = (cfg.integration_status || 'disabled') === 'enabled';
  const host = String(cfg.smpp_host || '').trim();
  const port = String(cfg.smpp_port || '').trim() || '2775';
  const systemId = String(cfg.smpp_system_id || '').trim();
  const password = String(cfg.smpp_password || '');

  status.enabled = enabled;
  status.host = host;
  status.port = port;
  status.bind_type = 'transceiver';
  status.system_id_present = !!systemId;

  log('connect() called with settings:', credentialsSummary(cfg));

  if (!enabled) {
    clearReconnect();
    closeSession('integration disabled');
    status.state = 'DISABLED';
    status.connected = false;
    status.last_error = '';
    log('SMPP disabled via Carrier Settings');
    return cloneStatus();
  }

  if (!host || !systemId) {
    clearReconnect();
    closeSession('missing credentials');
    status.state = 'DISCONNECTED';
    status.connected = false;
    status.last_error = !host ? 'SMPP host is missing' : 'SMPP system_id is missing';
    error(status.last_error);
    return cloneStatus();
  }

  clearReconnect();
  closeSession('new connect attempt');

  status.state = 'CONNECTING';
  status.connected = false;
  status.last_error = '';
  status.last_bind_status = '';
  status.last_connect_attempt_at = now();
  status.reconnect_attempts += 1;

  const url = `smpp://${host}:${port}`;
  const connectTimeoutMs = parseInt(process.env.SMPP_CONNECT_TIMEOUT_MS || '20000', 10);
  const enquireMs = parseInt(process.env.SMPP_ENQUIRE_LINK_MS || '30000', 10);

  log(`Connecting to ${url} (attempt ${status.reconnect_attempts})`);

  return await new Promise((resolve) => {
    let settled = false;
    let bindStarted = false;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(cloneStatus());
    }

    const timeout = setTimeout(() => {
      if (settled) return;
      status.state = 'ERROR';
      status.connected = false;
      status.last_error = bindStarted
        ? `SMPP bind timeout after ${connectTimeoutMs}ms`
        : `SMPP TCP connect timeout after ${connectTimeoutMs}ms`;
      error(status.last_error);
      scheduleReconnect(15000);
      finish();
    }, connectTimeoutMs);
    if (timeout.unref) timeout.unref();

    try {
      session = smpp.connect({
        url,
        auto_enquire_link_period: enquireMs,
      }, () => {
        log('TCP connected, sending bind_transceiver');
        if (!session) {
          status.state = 'ERROR';
          status.last_error = 'SMPP session missing after TCP connect';
          error(status.last_error);
          scheduleReconnect(15000);
          finish();
          return;
        }
        bindStarted = true;
        session.bind_transceiver({
          system_id: systemId,
          password,
        }, (pdu) => {
          const code = pdu && pdu.command_status !== undefined ? pdu.command_status : -1;
          const name = commandStatusName(code);
          status.last_bind_status = `${code} ${name}`;
          if (code === 0) {
            status.state = 'CONNECTED';
            status.connected = true;
            status.last_connected_at = now();
            status.last_error = '';
            log('bind_transceiver success:', status.last_bind_status);
            finish();
          } else {
            status.state = 'ERROR';
            status.connected = false;
            status.last_error = `bind_transceiver failed: ${status.last_bind_status}`;
            error(status.last_error);
            scheduleReconnect(15000);
            finish();
          }
        });
      });

      session.on('connect', () => log('Socket connect event'));

      session.on('deliver_sm', (pdu) => {
        status.last_pdu_at = now();
        try {
          const payload = buildPayloadFromDeliverSm(pdu);
          log('deliver_sm received:', { from: payload.cli, to: payload.number, sequence: payload.smpp_sequence });
          onIncomingSms(payload, `SMPP:${host}`);
          try { session.send(pdu.response()); } catch (_) {}
        } catch (e) {
          status.last_error = e.message;
          error('deliver_sm processing error:', e.message);
          try { session.send(pdu.response({ command_status: smpp.ESME_RSYSERR })); } catch (_) {}
        }
      });

      session.on('enquire_link', (pdu) => {
        try { session.send(pdu.response()); } catch (_) {}
      });

      session.on('close', () => {
        log('Session closed');
        setDisconnected('closed');
        scheduleReconnect(10000);
        finish();
      });

      session.on('error', (err) => {
        const msg = err && err.message ? err.message : String(err || 'SMPP error');
        status.state = 'ERROR';
        status.connected = false;
        status.last_error = msg;
        error('Session error:', msg);
        scheduleReconnect(15000);
        finish();
      });
    } catch (e) {
      status.state = 'ERROR';
      status.connected = false;
      status.last_error = e.message;
      error('Connect exception:', e.message);
      scheduleReconnect(15000);
      finish();
    }
  });
}

function init(options) {
  getSettings = options.getSettings;
  onIncomingSms = options.onIncomingSms;
  logger = options.logger || console;
  log('SMPP client initialized');
  return connect();
}

function restart() {
  log('Manual/setting-triggered SMPP restart requested');
  status.reconnect_attempts = 0;
  return connect();
}

function stop() {
  clearReconnect();
  closeSession('stop called');
  setDisconnected('disabled');
  log('SMPP stopped');
  return cloneStatus();
}

module.exports = {
  init,
  restart,
  stop,
  getStatus: cloneStatus,
};
