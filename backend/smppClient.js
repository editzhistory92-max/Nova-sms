'use strict';

/**
 * SMPP client connector for Mufasa SMS.
 *
 * This module is intentionally isolated from the core panel logic.
 * It only reads carrier settings and forwards incoming deliver_sm payloads
 * to the same SMS processing function used by HTTP carrier integration.
 */
const smpp = require('smpp');

let session = null;
let reconnectTimer = null;
let getSettings = null;
let onIncomingSms = null;

const status = {
  enabled: false,
  state: 'DISCONNECTED', // CONNECTING | CONNECTED | DISCONNECTED | DISABLED | ERROR
  connected: false,
  host: '',
  port: '',
  bind_type: 'transceiver',
  last_connected_at: '',
  last_disconnected_at: '',
  last_error: '',
  last_pdu_at: '',
  reconnect_attempts: 0,
};

function now() {
  return new Date().toISOString();
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

function closeSession() {
  if (!session) return;
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
  reconnectTimer = setTimeout(() => connect().catch(() => {}), delayMs);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

async function connect() {
  if (!getSettings || !onIncomingSms) return cloneStatus();

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

  if (!enabled || !host || !systemId) {
    clearReconnect();
    closeSession();
    status.state = enabled ? 'DISCONNECTED' : 'DISABLED';
    status.connected = false;
    status.last_error = enabled ? 'SMPP host/system_id missing' : '';
    return cloneStatus();
  }

  clearReconnect();
  closeSession();

  status.state = 'CONNECTING';
  status.connected = false;
  status.last_error = '';
  status.reconnect_attempts += 1;

  const url = `smpp://${host}:${port}`;

  try {
    session = smpp.connect({
      url,
      auto_enquire_link_period: parseInt(process.env.SMPP_ENQUIRE_LINK_MS || '30000', 10),
    }, () => {
      if (!session) return;
      session.bind_transceiver({
        system_id: systemId,
        password,
      }, (pdu) => {
        if (pdu.command_status === 0) {
          status.state = 'CONNECTED';
          status.connected = true;
          status.last_connected_at = now();
          status.last_error = '';
        } else {
          status.state = 'ERROR';
          status.connected = false;
          status.last_error = `bind_transceiver failed: ${pdu.command_status}`;
          scheduleReconnect(15000);
        }
      });
    });

    session.on('deliver_sm', (pdu) => {
      status.last_pdu_at = now();
      try {
        const payload = buildPayloadFromDeliverSm(pdu);
        onIncomingSms(payload, `SMPP:${host}`);
        try { session.send(pdu.response()); } catch (_) {}
      } catch (e) {
        status.last_error = e.message;
        try { session.send(pdu.response({ command_status: smpp.ESME_RSYSERR })); } catch (_) {}
      }
    });

    session.on('close', () => {
      setDisconnected('closed');
      scheduleReconnect(10000);
    });

    session.on('error', (err) => {
      status.state = 'ERROR';
      status.connected = false;
      status.last_error = err && err.message ? err.message : String(err || 'SMPP error');
      scheduleReconnect(15000);
    });

    return cloneStatus();
  } catch (e) {
    status.state = 'ERROR';
    status.connected = false;
    status.last_error = e.message;
    scheduleReconnect(15000);
    return cloneStatus();
  }
}

function init(options) {
  getSettings = options.getSettings;
  onIncomingSms = options.onIncomingSms;
  return connect();
}

function restart() {
  status.reconnect_attempts = 0;
  return connect();
}

function stop() {
  clearReconnect();
  closeSession();
  setDisconnected('disabled');
  return cloneStatus();
}

module.exports = {
  init,
  restart,
  stop,
  getStatus: cloneStatus,
};
