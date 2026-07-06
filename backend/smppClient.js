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
let runtimeBindTypeOverride = '';
let fallbackInProgress = false;

const status = {
  enabled: false,
  state: 'DISCONNECTED', // CONNECTING | CONNECTED | DISCONNECTED | DISABLED | ERROR | RECONNECTING
  connected: false,
  host: '',
  port: '',
  bind_type: 'transceiver',
  configured_bind_type: 'transceiver',
  system_id_present: false,
  last_connected_at: '',
  last_disconnected_at: '',
  last_connect_attempt_at: '',
  last_error: '',
  last_bind_status: '',
  last_pdu_at: '',
  last_log_at: '',
  reconnect_attempts: 0,
  last_bind_mode_results: [],
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

function closeSession(reason = 'manual', silent = false) {
  if (!session) return;
  if (!silent) log('Closing existing session:', reason);
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

function normalizeBindType(value) {
  const v = String(value || 'transceiver').toLowerCase().trim();
  if (['receiver', 'transmitter', 'transceiver'].includes(v)) return v;
  return 'transceiver';
}

function bindSession(sess, bindType, params, cb) {
  if (bindType === 'receiver') return sess.bind_receiver(params, cb);
  if (bindType === 'transmitter') return sess.bind_transmitter(params, cb);
  return sess.bind_transceiver(params, cb);
}

function uniqueModes(first) {
  return [first, 'receiver', 'transmitter', 'transceiver'].filter((v, i, a) => v && a.indexOf(v) === i);
}

async function attemptAutoBindFallback(cfg, failedType, failedStatus) {
  const enabled = String(process.env.SMPP_AUTO_BIND_FALLBACK || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    scheduleReconnect(15000);
    return;
  }
  if (fallbackInProgress) {
    log('Auto bind fallback already in progress; skipping duplicate request');
    return;
  }
  fallbackInProgress = true;
  status.state = 'RECONNECTING';
  log(`Auto bind fallback started after bind_${failedType} failed (${failedStatus || 'unknown'}). Testing all bind modes...`);
  const modes = uniqueModes(failedType);
  const results = [];
  try {
    for (const mode of modes) {
      // eslint-disable-next-line no-await-in-loop
      const r = await testSingleBind(mode, cfg, parseInt(process.env.SMPP_BIND_TEST_TIMEOUT_MS || '12000', 10));
      results.push(r);
      log(`Auto fallback result bind_${mode}:`, r);
      if (r.success) {
        runtimeBindTypeOverride = r.bind_type;
        status.bind_type = r.bind_type;
        status.last_bind_status = `${r.command_status} ${r.status_name}`;
        status.last_error = '';
        status.last_bind_mode_results = results;
        fallbackInProgress = false;
        log(`Auto fallback selected bind_${r.bind_type}. Reconnecting normal SMPP session now.`);
        setTimeout(() => connect().catch(() => {}), 500);
        return;
      }
    }
    status.last_bind_mode_results = results;
    status.last_error = 'No SMPP bind mode succeeded: ' + results.map(r => `bind_${r.bind_type}=${r.command_status !== null ? r.command_status + ' ' + r.status_name : r.error}`).join(' | ');
    error(status.last_error);
    fallbackInProgress = false;
    scheduleReconnect(15000);
  } catch (e) {
    fallbackInProgress = false;
    status.last_error = 'Auto bind fallback error: ' + e.message;
    error(status.last_error);
    scheduleReconnect(15000);
  }
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
  const smppEnabled = cfg.smpp_enabled === 1 || cfg.smpp_enabled === '1' || cfg.smpp_enabled === true;
  if ((cfg.integration_status || 'disabled') !== 'enabled' || !smppEnabled || !cfg.smpp_host || !cfg.smpp_system_id) {
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
    configured_bind_type: normalizeBindType(cfg.smpp_bind_type || cfg.bind_type || 'transceiver'),
    runtime_bind_override: runtimeBindTypeOverride || '',
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
  const smppEnabled = cfg.smpp_enabled === 1 || cfg.smpp_enabled === '1' || cfg.smpp_enabled === true;
  const enabled = (cfg.integration_status || 'disabled') === 'enabled' && smppEnabled;
  const host = String(cfg.smpp_host || '').trim();
  const port = String(cfg.smpp_port || '').trim() || '2775';
  const systemId = String(cfg.smpp_system_id || '').trim();
  const password = String(cfg.smpp_password || '');
  const configuredBindType = normalizeBindType(cfg.smpp_bind_type || cfg.bind_type || 'transceiver');
  const bindType = runtimeBindTypeOverride || configuredBindType;

  status.enabled = enabled;
  status.host = host;
  status.port = port;
  status.configured_bind_type = configuredBindType;
  status.bind_type = bindType;
  status.system_id_present = !!systemId;

  if (!enabled) {
    clearReconnect();
    closeSession('integration disabled', true);
    status.state = 'DISABLED';
    status.connected = false;
    status.last_error = '';
    return cloneStatus();
  }

  log('connect() called with settings:', credentialsSummary(cfg));

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
        log(`TCP connected, sending bind_${bindType}`);
        if (!session) {
          status.state = 'ERROR';
          status.last_error = 'SMPP session missing after TCP connect';
          error(status.last_error);
          scheduleReconnect(15000);
          finish();
          return;
        }
        bindStarted = true;
        bindSession(session, bindType, {
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
            log(`bind_${bindType} success:`, status.last_bind_status);
            finish();
          } else {
            status.state = 'ERROR';
            status.connected = false;
            status.last_error = `bind_${bindType} failed: ${status.last_bind_status}`;
            error(status.last_error);
            const currentCfg = cfg;
            closeSession(`bind_${bindType} failed`);
            attemptAutoBindFallback(currentCfg, bindType, status.last_bind_status).catch(() => {});
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


function testSingleBind(bindType, cfg, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const started = Date.now();
    bindType = normalizeBindType(bindType);
    const host = String(cfg.smpp_host || '').trim();
    const port = String(cfg.smpp_port || '').trim() || '2775';
    const systemId = String(cfg.smpp_system_id || '').trim();
    const password = String(cfg.smpp_password || '');
    const result = {
      bind_type: bindType,
      success: false,
      command_status: null,
      status_name: '',
      error: '',
      duration_ms: 0,
    };
    if (!host || !systemId) {
      result.error = !host ? 'SMPP host is missing' : 'SMPP system_id is missing';
      return resolve(result);
    }
    let temp = null;
    let finished = false;
    function done(extra = {}) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      Object.assign(result, extra);
      result.duration_ms = Date.now() - started;
      try { if (temp) temp.removeAllListeners(); } catch (_) {}
      try { if (temp) temp.unbind(); } catch (_) {}
      try { if (temp) temp.close(); } catch (_) {}
      resolve(result);
    }
    const timer = setTimeout(() => done({ error: `Timeout after ${timeoutMs}ms` }), timeoutMs);
    if (timer.unref) timer.unref();
    const url = `smpp://${host}:${port}`;
    log(`Testing bind_${bindType} on ${url}`);
    try {
      temp = smpp.connect({ url, auto_enquire_link_period: parseInt(process.env.SMPP_ENQUIRE_LINK_MS || '30000', 10) }, () => {
        try {
          bindSession(temp, bindType, { system_id: systemId, password }, (pdu) => {
            const code = pdu && pdu.command_status !== undefined ? pdu.command_status : -1;
            done({
              success: code === 0,
              command_status: code,
              status_name: commandStatusName(code),
              error: code === 0 ? '' : `bind_${bindType} failed: ${code} ${commandStatusName(code)}`,
            });
          });
        } catch (e) {
          done({ error: e.message });
        }
      });
      temp.on('error', (err) => done({ error: err && err.message ? err.message : String(err || 'SMPP error') }));
      temp.on('close', () => {
        if (!finished) done({ error: 'Session closed before successful bind' });
      });
    } catch (e) {
      done({ error: e.message });
    }
  });
}

async function testBindModes() {
  const cfg = getSettings ? (getSettings() || {}) : {};
  clearReconnect();
  closeSession('testing all bind modes');
  const modes = ['transceiver', 'transmitter', 'receiver'];
  const results = [];
  for (const mode of modes) {
    // eslint-disable-next-line no-await-in-loop
    const r = await testSingleBind(mode, cfg, parseInt(process.env.SMPP_BIND_TEST_TIMEOUT_MS || '12000', 10));
    results.push(r);
    log(`Bind mode test result: bind_${mode}`, r);
  }
  status.last_bind_mode_results = results;
  const recommended = (results.find(r => r.success) || {}).bind_type || '';
  if (recommended) log('Recommended SMPP bind type:', recommended);
  else error('No SMPP bind mode succeeded');
  // Reconnect the normal configured session after a short delay.
  scheduleReconnect(3000);
  return { results, recommended, tested_at: now() };
}

function init(options) {
  getSettings = options.getSettings;
  onIncomingSms = options.onIncomingSms;
  logger = options.logger || console;
  const cfg = getSettings ? (getSettings() || {}) : {};
  const smppEnabled = cfg.smpp_enabled === 1 || cfg.smpp_enabled === '1' || cfg.smpp_enabled === true;
  if ((cfg.integration_status || 'disabled') === 'enabled' && smppEnabled) log('SMPP client initialized');
  return connect();
}

function restart() {
  log('Manual/setting-triggered SMPP restart requested');
  runtimeBindTypeOverride = '';
  status.reconnect_attempts = 0;
  return connect();
}

function stop() {
  clearReconnect();
  closeSession('stop called', true);
  setDisconnected('disabled');
  return cloneStatus();
}

module.exports = {
  init,
  restart,
  stop,
  getStatus: cloneStatus,
  testBindModes,
};
