/**
 * Mufasa SMS — Backend API
 * Node.js + Express + SQLite (sql.js). MySQL-ready SQL.
 */
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (_) {}
const bcrypt = require('bcryptjs');
const db = require('./db');
const { createTables } = require('./schema');
const { seed } = require('./seed');
const { sign, authRequired, requireRole, descendantIds } = require('./auth');
const backup = require('./backup');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.text({ type: ['text/plain', 'text/*', 'application/xml', 'application/octet-stream'], limit: '2mb' }));
const upload = multer();
const importJobs = new Map();
const numberJobs = new Map();


// Short in-memory GET cache: removes duplicate heavy queries during rapid UI navigation.
// Any non-GET /api request clears this cache, so changes/incoming SMS are visible immediately after writes.
const apiReadCache = new Map();
function clearApiReadCache(){ try { apiReadCache.clear(); } catch (_) {} }
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') {
    clearApiReadCache();
    try { db.beginBatch && db.beginBatch(); } catch (_) {}
    let ended = false;
    const end = () => { if (ended) return; ended = true; try { db.endBatch && db.endBatch(); } catch (e) { console.warn('[DB_BATCH] save failed:', e.message); } };
    res.on('finish', end);
    res.on('close', end);
  }
  next();
});
function cachedJson(req, res, ttlMs, producer) {
  if (String(req.query._nocache || '') === '1') return res.json(producer());
  const uid = req.user ? `${req.user.id}:${req.user.role}` : 'anon';
  const key = `${uid}:${req.originalUrl}`;
  const now = Date.now();
  const hit = apiReadCache.get(key);
  if (hit && hit.expires > now) return res.json(hit.value);
  const value = producer();
  apiReadCache.set(key, { value, expires: now + Math.max(250, ttlMs || 1000) });
  if (apiReadCache.size > 400) {
    const cutoff = Date.now();
    for (const [k, v] of apiReadCache) if (v.expires <= cutoff || apiReadCache.size > 350) apiReadCache.delete(k);
  }
  return res.json(value);
}
function pad2(n){ return String(n).padStart(2,'0'); }
function fmtUtcSql(ms){ const d=new Date(ms); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`; }
function ukLocalDateToUtcSql(dateStr, plusDays=0){
  const m=String(dateStr||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return '';
  const base=Date.UTC(+m[1], +m[2]-1, +m[3]+plusDays, 0, 0, 0);
  let off=ukOffsetMinutes(new Date(base));
  let utc=base - off*60000;
  const off2=ukOffsetMinutes(new Date(utc));
  if(off2!==off) utc=base - off2*60000;
  return fmtUtcSql(utc);
}

// Clean URL routes (must be before static so /admin.html can redirect to /admin)
const FRONTEND_ROOT = path.join(__dirname, '..');
function sendFrontendPage(res, file) { res.sendFile(path.join(FRONTEND_ROOT, file)); }
app.get('/', (req, res) => sendFrontendPage(res, 'login.html'));
app.get('/login', (req, res) => sendFrontendPage(res, 'login.html'));
app.get('/login.html', (req, res) => res.redirect(301, '/login'));
app.get('/admin', (req, res) => sendFrontendPage(res, 'admin.html'));
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));
app.get('/admin/:page', (req, res) => sendFrontendPage(res, 'admin.html'));
app.get('/payment-login', (req, res) => sendFrontendPage(res, 'payment-login.html'));
app.get('/payment-login.html', (req, res) => res.redirect(301, '/payment-login'));
app.get('/payment', (req, res) => sendFrontendPage(res, 'payment.html'));
app.get('/payment.html', (req, res) => res.redirect(301, '/payment'));
app.get('/payment/:page', (req, res) => sendFrontendPage(res, 'payment.html'));
app.get('/management-login', (req, res) => sendFrontendPage(res, 'management-login.html'));
app.get('/management-login.html', (req, res) => res.redirect(301, '/management-login'));
app.get('/management', (req, res) => sendFrontendPage(res, 'management.html'));
app.get('/management.html', (req, res) => res.redirect(301, '/management'));
app.get('/management/:page', (req, res) => sendFrontendPage(res, 'management.html'));
app.get('/manager', (req, res) => sendFrontendPage(res, 'manager.html'));
app.get('/manager.html', (req, res) => res.redirect(301, '/manager'));
app.get('/manager/:page', (req, res) => sendFrontendPage(res, 'manager.html'));
app.get('/agent', (req, res) => sendFrontendPage(res, 'agent.html'));
app.get('/agent.html', (req, res) => res.redirect(301, '/agent'));
app.get('/agent/:page', (req, res) => sendFrontendPage(res, 'agent.html'));
app.get('/client', (req, res) => sendFrontendPage(res, 'client.html'));
app.get('/client.html', (req, res) => res.redirect(301, '/client'));
app.get('/client/:page', (req, res) => sendFrontendPage(res, 'client.html'));
app.get('/test-login', (req, res) => sendFrontendPage(res, 'test-login.html'));
app.get('/test-login.html', (req, res) => res.redirect(301, '/test-login'));
app.get('/test', (req, res) => sendFrontendPage(res, 'test.html'));
app.get('/test.html', (req, res) => res.redirect(301, '/test'));
app.get('/test/:page', (req, res) => sendFrontendPage(res, 'test.html'));

// serve frontend assets and static files from project root
app.use(express.static(FRONTEND_ROOT));

app.get('/health', (req, res) => res.json({ ok: true, service: 'Mufasa SMS', time: new Date().toISOString() }));
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'Mufasa SMS', time: new Date().toISOString() }));

/* ============ helpers ============ */
function ukOffsetMinutes(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(date).reduce((a, p) => (a[p.type] = p.value, a), {});
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch (_) { return 0; }
}
function ukSqlModifier() {
  const off = ukOffsetMinutes();
  return off >= 0 ? `+${off} minutes` : `${off} minutes`;
}
function ukDateExpr(column) { return `date(${column}, '${ukSqlModifier()}')`; }
function ukDateNowSql(extra = '') { return `date('now','${ukSqlModifier()}'${extra ? `, '${extra}'` : ''})`; }
function ukDateTimeExpr(column) { return `datetime(${column}, '${ukSqlModifier()}')`; }

function scopeIds(user) {
  // admin sees everyone; others see their downstream hierarchy
  if (user.role === 'admin') return db.all('SELECT id FROM users').map(r => r.id);
  return descendantIds(user.id);
}
function maskCli(cli) {
  if (!cli) return '';
  if (cli.length <= 2) return cli;
  return cli.slice(0, 2) + 'x'.repeat(cli.length - 2);
}

function safeJson(v){ try{return JSON.stringify(v||{});}catch(e){return '{}';} }

function normalizeDecimalString(input){
  let s=String(input ?? '').trim().replace(/[$,\s]/g,'');
  if(!s || s.toUpperCase()==='NA') return '';
  const m=s.match(/-?\d+(?:\.\d+)?/);
  if(!m) return '';
  s=m[0];
  if(!s.includes('.')) return String(BigInt(s));
  let [a,b]=s.split('.'); b=(b||'').replace(/0+$/,'');
  a=String(BigInt(a||'0'));
  return b ? `${a}.${b}` : a;
}
function isPositiveDecimal(s){
  s=normalizeDecimalString(s);
  if(!s) return false;
  return BigInt(s.replace('.','').replace('-','')) !== 0n && !s.startsWith('-');
}
function decimalAdd(a,b){
  a=normalizeDecimalString(a)||'0'; b=normalizeDecimalString(b)||'0';
  const [ai,af='']=a.split('.'); const [bi,bf='']=b.split('.');
  const scale=Math.max(af.length,bf.length);
  const av=BigInt(ai+af.padEnd(scale,'0'));
  const bv=BigInt(bi+bf.padEnd(scale,'0'));
  let sum=(av+bv).toString();
  const neg=sum.startsWith('-'); if(neg) sum=sum.slice(1);
  if(scale===0) return (neg?'-':'')+sum;
  sum=sum.padStart(scale+1,'0');
  let out=sum.slice(0,-scale)+'.'+sum.slice(-scale);
  out=out.replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1');
  return (neg?'-':'')+out;
}
function decimalMulInt(a,n){
  let total='0'; n=Number(n)||0;
  for(let i=0;i<n;i++) total=decimalAdd(total,a);
  return total;
}
function payoutRateFromRow(r){
  // sms_records payout snapshot must be final, including explicit zero from limits/external payout.
  if (r && Object.prototype.hasOwnProperty.call(r, 'payout_amount')) {
    const v = normalizeDecimalString(r.payout_amount);
    if (v !== '') return v;
  }
  if (r && Object.prototype.hasOwnProperty.call(r, 'payout_rate')) {
    const v = normalizeDecimalString(r.payout_rate);
    if (v !== '') return v;
  }
  const assignedType = normalizePaymentType(r.payterm || r.payment_type || 'weekly');
  const typed = payoutRateForPaymentType(r, assignedType);
  if(isPositiveDecimal(typed)) return typed;
  const candidates=[r.sms_payout_rate,r.number_payout,r.number_rate,r.rate_30_45,r.rate_7_1,r.rate_7_7,r.rate_1_1];
  for(const c of candidates){ const v=normalizeDecimalString(c); if(isPositiveDecimal(v)) return v; }
  return '0';
}
function attachSmsPayoutFields(rows){
  return (rows||[]).map(r=>{ const rate=payoutRateFromRow(r); return {...r,payout_rate:rate,payout_amount:rate}; });
}
function sumPayout(rows){ return (rows||[]).reduce((s,r)=>decimalAdd(s,r.payout_amount ?? r.payout_rate ?? payoutRateFromRow(r)), '0'); }
function smsRowsForScope(user, extraWhere='', extraParams=[]){
  const scope=smsScopeWhere(user,'s');
  // Normal SMS/report/earning modules should not mix Test Panel OTPs.
  // Test Panel data is served separately by /api/test-panel/sms.
  const where=[scope.where, 'COALESCE(s.is_test,0)=0']; const params=[...scope.params];
  if(extraWhere){ where.push(extraWhere); params.push(...extraParams); }
  const rows=db.all(`SELECT s.*, r.name AS range_name, r.rate_1_1, r.rate_7_1, r.rate_7_7, r.rate_30_45,
      n.rate AS number_rate, n.payout AS number_payout, n.payterm AS payterm, r.payment_type AS payment_type,
      cu.username AS client_name, au.username AS agent_name, mu.username AS manager_name
    FROM sms_records s
    LEFT JOIN numbers n ON n.id=s.number_id
    LEFT JOIN ranges r ON r.id=s.range_id
    LEFT JOIN users cu ON cu.id=s.client_id
    LEFT JOIN users au ON au.id=s.agent_id
    LEFT JOIN users mu ON mu.id=s.manager_id
    WHERE ${where.join(' AND ')} ORDER BY s.received_at DESC`, params);
  return attachSmsPayoutFields(rows);
}
function logAction(req, action, module, details=''){
  try{
    const u=req.user||{};
    db.run('INSERT INTO audit_logs (user_id,username,role,action,module,details,ip) VALUES (?,?,?,?,?,?,?)',
      [u.id||null,u.username||'',u.role||'',action,module,typeof details==='string'?details:safeJson(details),req.ip||'']);
  }catch(e){ console.warn('audit log failed', e.message); }
}
function logNumberHistory(req, numberRow, action, fromOwner='', toOwner='', details=''){
  try{
    db.run('INSERT INTO number_history (number_id,number,action,from_owner,to_owner,details,user_id) VALUES (?,?,?,?,?,?,?)',
      [numberRow?.id||null,numberRow?.number||'',action,fromOwner||'',toOwner||'',typeof details==='string'?details:safeJson(details),(req.user||{}).id||null]);
  }catch(e){ console.warn('number history failed', e.message); }
}
function logWebhook(status, payload, number='', matched='', cli='', message='', error='', sourceIp=''){
  try{ db.run('INSERT INTO webhook_logs (status,number,matched_number,cli,message,raw_payload,error,source_ip) VALUES (?,?,?,?,?,?,?,?)',
    [status, String(number||''), String(matched||''), String(cli||''), String(message||''), safeJson(payload), String(error||''), String(sourceIp||'')]); }
  catch(e){ console.warn('webhook log failed', e.message); }
}
function addFailedSms(payload, number='', cli='', message='', error=''){
  try{ db.run('INSERT INTO failed_sms_queue (number,cli,message,raw_payload,error) VALUES (?,?,?,?,?)',
    [String(number||''),String(cli||''),String(message||''),safeJson(payload),String(error||'')]); }
  catch(e){ console.warn('failed sms queue failed', e.message); }
}

/* ============ AUTH ============ */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username/password required' });
  const u = db.get('SELECT * FROM users WHERE username=? COLLATE NOCASE', [String(username).trim()]);
  if (!u) return res.status(401).json({ error: 'Invalid username or password' });
  if (!u.active) return res.status(403).json({ error: 'Account is disabled' });
  if (!bcrypt.compareSync(password, u.password)) return res.status(401).json({ error: 'Invalid username or password' });
  const token = sign(u);
  try{ db.run('INSERT INTO audit_logs (user_id,username,role,action,module,details,ip) VALUES (?,?,?,?,?,?,?)',[u.id,u.username,u.role,'login','auth','Successful login',req.ip||'']); }catch(e){}
  res.json({ token, user: { id: u.id, username: u.username, role: u.role, name: u.name } });
});

app.get('/api/me', authRequired, (req, res) => {
  const u = db.get('SELECT id,username,role,name,email,whatsapp FROM users WHERE id=?', [req.user.id]);
  res.json(u);
});

/* ============ USERS (managers/agents/clients) ============ */
// list users of a role within caller's scope
app.get('/api/users/:role', authRequired, (req, res) => {
  const role = req.params.role; // manager|agent|client
  const ids = scopeIds(req.user);
  if (!ids.length) return res.json([]);
  const ph = ids.map(() => '?').join(',');
  // for role list we want users of that role whose id is in scope (excluding self)
  const rows = db.all(
    `SELECT id,username,name,email,whatsapp,contact,skype,active,parent_id,payment_type
     FROM users WHERE role=? AND id IN (${ph}) AND id<>? ORDER BY id DESC`,
    [role, ...ids, req.user.id]
  );
  res.json(rows);
});

// create user (admin->manager, manager->agent, agent->client)
app.post('/api/users', authRequired, (req, res) => {
  const { username, password, role, name, email, whatsapp, contact, skype, active, payment_type } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ error: 'username, password, role required' });

  // permission: Admin can create Manager/Agent/Client. Manager can create Agent/Client. Agent can create Client.
  const allowed = {
    admin: ['manager','agent','client'],
    manager: ['agent','client'],
    agent: ['client']
  };
  if (!(allowed[req.user.role] || []).includes(role))
    return res.status(403).json({ error: `You are not allowed to create this role` });

  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) return res.status(400).json({ error: 'username required' });
  const exists = db.get('SELECT id FROM users WHERE username=? COLLATE NOCASE', [cleanUsername]);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  let parentId = req.body && req.body.parent_id ? parseInt(req.body.parent_id, 10) : req.user.id;
  if (!Number.isFinite(parentId) || parentId <= 0) parentId = req.user.id;
  // If a parent is provided, it must be in caller scope unless caller is admin.
  if (parentId !== req.user.id && req.user.role !== 'admin') {
    const ids = scopeIds(req.user);
    if (!ids.includes(parentId)) return res.status(403).json({ error: 'Invalid parent user' });
  }

  db.run(
    `INSERT INTO users (username,password,role,name,email,whatsapp,contact,skype,parent_id,active,payment_type)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [cleanUsername, bcrypt.hashSync(String(password), 10), role, name || '', email || '',
     whatsapp || '', contact || '', skype || '', parentId, active === false ? 0 : 1, role==='agent'?normalizePaymentType(payment_type||'weekly'):'weekly']
  );
  logAction(req,'create_user','users',{username,role});
  res.json({ ok: true });
});

// update user
app.put('/api/users/:id', authRequired, (req, res) => {
  const id = +req.params.id;
  const ids = scopeIds(req.user);
  if (!ids.includes(id)) return res.status(403).json({ error: 'Not your user' });
  const { name, email, whatsapp, contact, skype, active, password, payment_type } = req.body || {};
  db.run(
    `UPDATE users SET name=?,email=?,whatsapp=?,contact=?,skype=?,active=?,payment_type=CASE WHEN role='agent' THEN ? ELSE payment_type END WHERE id=?`,
    [name || '', email || '', whatsapp || '', contact || '', skype || '', active ? 1 : 0, normalizePaymentType(payment_type||'weekly'), id]
  );
  if (password) db.run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(password, 10), id]);
  logAction(req,'update_user','users',{id});
  res.json({ ok: true });
});

// delete user
app.delete('/api/users/:id', authRequired, (req, res) => {
  const id = +req.params.id;
  const ids = scopeIds(req.user);
  if (!ids.includes(id) || id === req.user.id) return res.status(403).json({ error: 'Not allowed' });
  db.run('DELETE FROM users WHERE id=?', [id]);
  logAction(req,'delete_user','users',{id});
  res.json({ ok: true });
});



/* ============ PAYMENT V2 HELPERS ============ */
const PAYMENT_TYPES = ['daily','weekly','monthly_30x45'];
function normalizePaymentType(v){
  const s=String(v||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
  if(['daily','day'].includes(s)) return 'daily';
  if(['weekly','week'].includes(s)) return 'weekly';
  if(['monthly','month','30x45','monthly_30x45','30_45'].includes(s)) return 'monthly_30x45';
  return 'weekly';
}
function paymentTypeLabel(t){ return ({daily:'Daily',weekly:'Weekly',monthly_30x45:'Monthly (30x45)'})[normalizePaymentType(t)] || 'Weekly'; }
function assignedPaymentTypeForNumber(n, rangeRow={}){ const u=n?.agent_id?db.get('SELECT payment_type FROM users WHERE id=?',[n.agent_id]):null; return normalizePaymentType(u?.payment_type || n?.payterm || rangeRow?.payment_type || 'weekly'); }
function payoutRateForPaymentType(row, type){
  type=normalizePaymentType(type);
  const candidates = type==='daily' ? [row.rate_1_1,row.number_rate,row.rate_7_1,row.rate_30_45] : (type==='monthly_30x45' ? [row.rate_30_45,row.number_rate,row.rate_7_1,row.rate_1_1] : [row.rate_7_1,row.rate_7_7,row.number_rate,row.rate_30_45,row.rate_1_1]);
  for(const c of candidates){ const v=normalizeDecimalString(c); if(isPositiveDecimal(v)) return v; }
  return '0';
}
function cents(v){ return Math.round((parseFloat(normalizeDecimalString(v)||'0')||0)*100); }
function moneyFromCents(c){ return (Math.max(0, Math.round(c||0))/100).toFixed(2).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1'); }
function ukParts(date=new Date()){
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(date).reduce((a,p)=>(a[p.type]=p.value,a),{});
}
function utcMsFromUkDate(dateStr, plusDays=0){
  const m=String(dateStr||'').match(/^(\d{4})-(\d{2})-(\d{2})$/); if(!m)return Date.now();
  const base=Date.UTC(+m[1],+m[2]-1,+m[3]+plusDays,0,0,0);
  let off=ukOffsetMinutes(new Date(base)); let out=base-off*60000; const off2=ukOffsetMinutes(new Date(out)); if(off2!==off)out=base-off2*60000; return out;
}
function utcSqlFromMs(ms){ const d=new Date(ms); const p=n=>String(n).padStart(2,'0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; }
function ukDateFromDb(ts){ return ukDateExprValue(ts); }
function ukDateExprValue(ts){
  const d = dbDateToDate(ts); if(!d)return '';
  const p=ukParts(d); return `${p.year}-${p.month}-${p.day}`;
}
function dbDateToDate(ts){
  const m=String(ts||'').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if(!m)return null; return new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+(m[4]||0),+(m[5]||0),+(m[6]||0)));
}
function paymentCycleInfo(type, earnedAt){
  type=normalizePaymentType(type); const d=dbDateToDate(earnedAt)||new Date(); const uk=ukParts(d); const date=`${uk.year}-${uk.month}-${uk.day}`;
  if(type==='daily') return {cycle_key:date, eligible_at:utcSqlFromMs(utcMsFromUkDate(date,1))};
  const startMs=utcMsFromUkDate(date,0); const weekdayMap={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}; const dow=weekdayMap[uk.weekday] ?? 0; const daysSinceTue=(dow-2+7)%7;
  if(type==='weekly'){
    const start=new Date(startMs-daysSinceTue*86400000); const key=utcSqlFromMs(start.getTime()).slice(0,10); return {cycle_key:key, eligible_at:utcSqlFromMs(start.getTime()+7*86400000)};
  }
  // 30-day work cycle anchored at Unix epoch in UK-date days; eligible after 30+45 days.
  const dayNo=Math.floor(utcMsFromUkDate(date,0)/86400000); const cycleStartDay=dayNo-(dayNo%30); const startDate=utcSqlFromMs(cycleStartDay*86400000).slice(0,10); return {cycle_key:startDate, eligible_at:utcSqlFromMs((cycleStartDay+75)*86400000)};
}
function walletValid(v){ return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(v||'').trim()); }
function agentManagerId(agentId){ return db.get("SELECT parent_id FROM users WHERE id=? AND role='agent'",[agentId])?.parent_id || null; }
function recordPaymentLedgerForSms(smsId, persist=true){
  const srow=db.get(`SELECT s.id,s.agent_id,s.manager_id,s.range_id,s.payout_amount,s.received_at,COALESCE(NULLIF(s.payment_type,''), r.payment_type) AS payment_type FROM sms_records s LEFT JOIN ranges r ON r.id=s.range_id WHERE s.id=?`,[smsId]);
  if(!srow || !srow.agent_id || cents(srow.payout_amount)<=0) return;
  if(db.get('SELECT id FROM payment_ledger WHERE sms_record_id=?',[smsId])) return;
  const type=normalizePaymentType(srow.payment_type||'weekly'); const cyc=paymentCycleInfo(type,srow.received_at);
  db.runNoSave(`INSERT INTO payment_ledger (sms_record_id,agent_id,manager_id,range_id,payment_type,amount,earned_at,cycle_key,eligible_at,status)
    VALUES (?,?,?,?,?,?,?,?,?,'open')`, [srow.id,srow.agent_id,srow.manager_id||agentManagerId(srow.agent_id),srow.range_id,type,normalizeDecimalString(srow.payout_amount)||'0',srow.received_at,cyc.cycle_key,cyc.eligible_at]);
  db.runNoSave('UPDATE sms_records SET payment_type=? WHERE id=?',[type,smsId]);
  if(persist) db.save();
}
function backfillPaymentLedger(){
  const rows=db.all(`SELECT s.id FROM sms_records s LEFT JOIN payment_ledger l ON l.sms_record_id=s.id WHERE l.id IS NULL AND COALESCE(s.is_test,0)=0 AND s.agent_id IS NOT NULL AND CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)>0 ORDER BY s.id ASC LIMIT 5000`);
  rows.forEach(r=>{ try{recordPaymentLedgerForSms(r.id, false)}catch(e){} });
  if(rows.length) db.save();
  if(rows.length) console.log('• Payment ledger backfilled:', rows.length);
}
function paymentOpenBalance(agentId,type,eligibleOnly=true){
  const now=utcSqlFromMs(Date.now()); const params=[agentId,normalizePaymentType(type),'open']; let where='agent_id=? AND payment_type=? AND status=?';
  if(eligibleOnly){ where+=' AND eligible_at<=?'; params.push(now); }
  return moneyFromCents(db.all(`SELECT amount FROM payment_ledger WHERE ${where}`,params).reduce((a,r)=>a+cents(r.amount),0));
}
function paymentPendingAmount(agentId,type){ return moneyFromCents(db.all(`SELECT amount FROM payment_requests_v2 WHERE agent_id=? AND payment_type=? AND status='Pending'`,[agentId,normalizePaymentType(type)]).reduce((a,r)=>a+cents(r.amount),0)); }
function paymentMinimum(type){ return normalizeDecimalString(db.get('SELECT min_withdrawal FROM payment_v2_settings WHERE payment_type=?',[normalizePaymentType(type)])?.min_withdrawal || '0') || '0'; }
function paymentNotify(agentId,requestId,event,message){ db.run('INSERT INTO payment_notifications_v2 (agent_id,request_id,event,message) VALUES (?,?,?,?)',[agentId,requestId,event,message]); }
function paymentAudit(req,action,body={}){ const u=req?.user||{}; db.run(`INSERT INTO payment_audit_logs (actor_id,actor_name,actor_role,action,request_id,agent_id,manager_id,payment_type,amount,wallet_address,status,details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [u.id||null,u.username||'',u.role||'',action,body.request_id||null,body.agent_id||null,body.manager_id||null,body.payment_type||'',body.amount||'',body.wallet_address||'',body.status||'',safeJson(body.details||{})]); }

function parseTestNumbers(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value || '').split(/[\s,;]+/).map(v => v.trim()).filter(Boolean);
}
function syncRangeTestNumbers(rangeId, testValue) {
  const nums = [...new Set(parseTestNumbers(testValue))];
  db.run('DELETE FROM range_test_numbers WHERE range_id=?', [rangeId]);
  nums.forEach(n => db.run('INSERT INTO range_test_numbers (range_id,test_number,active) VALUES (?,?,1)', [rangeId, n]));
  db.run('UPDATE ranges SET test_number=? WHERE id=?', [nums.join(', '), rangeId]);
  return nums;
}

/* ============ RANGES / RATE MANAGEMENT ============ */
app.get('/api/ranges', authRequired, (req, res) => cachedJson(req, res, 5000, () => {
  const includeDeleted = String(req.query.include_deleted || '').toLowerCase() === '1' || String(req.query.include_deleted || '').toLowerCase() === 'true';
  const where = includeDeleted ? '1=1' : "COALESCE(r.deleted_at,'')=''";
  const rows = db.all(`SELECT r.*,
    COALESCE((SELECT GROUP_CONCAT(test_number, ', ') FROM range_test_numbers t WHERE t.range_id=r.id AND t.active=1), r.test_number, '') AS test_numbers
    FROM ranges r WHERE ${where} ORDER BY r.name COLLATE NOCASE ASC, r.id ASC`);
  rows.forEach(r => { if (r.test_numbers) r.test_number = r.test_numbers; });
  return rows;
}));
// only admin can set rates / create ranges
app.post('/api/ranges', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Range name required' });
  const ins = db.run(`INSERT INTO ranges (name,prefix,test_number,currency,rate_1_1,rate_7_1,rate_7_7,rate_30_45,memo,payment_type)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [b.name, b.prefix || '', '', b.currency || 'USD',
     b.rate_1_1 || 'NA', b.rate_7_1 || 'NA', b.rate_7_7 || 'NA', b.rate_30_45 || 'NA', b.memo || '', normalizePaymentType(b.payment_type || b.payterm || 'weekly')]);
  const newRange = db.get('SELECT id FROM ranges WHERE name=? ORDER BY id DESC LIMIT 1', [b.name]);
  syncRangeTestNumbers(newRange ? newRange.id : ins.lastInsertRowid, b.test_numbers || b.test_number || '');
  logAction(req,'create_range','ranges',b.name);
  res.json({ ok: true });
});

function parseBulkRangeNames(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\r\n,;]+/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const name = String(item || '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
app.post('/api/ranges/bulk-create', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const names = parseBulkRangeNames(b.names || b.text || b.range_names);
  if (!names.length) return res.status(400).json({ error: 'Enter at least one range name' });
  const currency = b.currency || 'USD';
  const defaults = {
    prefix: b.prefix || '',
    rate_1_1: b.rate_1_1 || 'NA',
    rate_7_1: b.rate_7_1 || 'NA',
    rate_7_7: b.rate_7_7 || 'NA',
    rate_30_45: b.rate_30_45 || 'NA',
    memo: b.memo || ''
  };
  let inserted = 0, restored = 0, skipped = 0;
  const created = [], existing = [];
  try {
    // No long transaction here: job yields between chunks so other API calls remain responsive.
    // Changes are persisted once at the end with db.save().
    for (const name of names) {
      const old = db.get("SELECT id, COALESCE(deleted_at,'') AS deleted_at FROM ranges WHERE lower(name)=lower(?) LIMIT 1", [name]);
      if (old) {
        if (old.deleted_at) { db.runNoSave("UPDATE ranges SET deleted_at='' WHERE id=?", [old.id]); restored++; }
        else skipped++;
        existing.push(name);
        continue;
      }
      const ins = db.runNoSave(`INSERT INTO ranges (name,prefix,test_number,currency,rate_1_1,rate_7_1,rate_7_7,rate_30_45,memo,payment_type)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [name, defaults.prefix, '', currency, defaults.rate_1_1, defaults.rate_7_1, defaults.rate_7_7, defaults.rate_30_45, defaults.memo, normalizePaymentType(b.payment_type || 'weekly')]);
      inserted++;
      created.push({ id: ins.lastInsertRowid, name });
    }
    db.execNoSave('COMMIT');
    db.save();
  } catch (e) {
    try { db.execNoSave('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: e.message || 'Bulk range creation failed' });
  }
  clearApiReadCache();
  logAction(req, 'bulk_create_ranges', 'ranges', { inserted, restored, skipped, total: names.length });
  res.json({ ok: true, inserted, restored, skipped, total: names.length, created, existing });
});

function normalizeRangeImportRow(row) {
  const get = (...keys) => {
    for (const k of keys) {
      const found = Object.keys(row || {}).find(x => x.trim().toLowerCase() === k.trim().toLowerCase());
      if (found && row[found] !== undefined && row[found] !== null && String(row[found]).trim() !== '') return String(row[found]).trim();
    }
    return '';
  };
  const name = get('Range','Range Name','name','range_name','Country');
  const payout = get('Payout','30/45','rate_30_45','Rate','Rate 30/45');
  const currency = get('Currency','cur') || 'USD';
  return {
    name,
    prefix: get('Prefix','prefix'),
    test_number: get('Test Number','Test Numbers','test_number','test_numbers'),
    currency: currency === '$' ? 'USD' : currency,
    rate_1_1: get('1/1','rate_1_1') || 'NA',
    rate_7_1: get('7/1','rate_7_1') || payout || 'NA',
    rate_7_7: get('7/7','rate_7_7') || 'NA',
    rate_30_45: payout || get('30/45','rate_30_45') || 'NA',
    memo: get('Memo','memo','notes'),
    payment_type: normalizePaymentType(get('Payment Type','PaymentType','Pay Type','payterm','payment_type') || 'weekly')
  };
}

function isPhoneLikeLine(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  const d = s.replace(/[^0-9]/g, '');
  return d.length >= 5 && d.length >= Math.max(5, Math.floor(s.length * 0.65));
}
function normalizeTestPhone(v) { return String(v || '').trim().replace(/[^0-9+]/g, '').replace(/^\+/, ''); }
function parseRangeTestNumberBlocks(text) {
  const groups = [];
  let current = null;
  const pushRange = (name) => {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    if (!clean) return;
    current = { range_name: clean, test_numbers: [] };
    groups.push(current);
  };
  const tokens = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const raw = String(line || '').trim();
    if (!raw) return;
    // CSV/TSV rows: read cells left-to-right. Normal TXT lines are one token.
    const cells = raw.includes('\t') || raw.includes(',') || raw.includes(';')
      ? raw.split(/[\t,;]+/).map(x => x.trim()).filter(Boolean)
      : [raw];
    tokens.push(...cells);
  });
  for (const token of tokens) {
    if (isPhoneLikeLine(token)) {
      const n = normalizeTestPhone(token);
      if (!current) pushRange('Imported Range');
      if (n && !current.test_numbers.includes(n)) current.test_numbers.push(n);
    } else {
      pushRange(token);
    }
  }
  return groups.filter(g => g.range_name && g.test_numbers.length);
}
function sheetRowsToText(wb, XLSX) {
  const lines = [];
  for (const sheetName of wb.SheetNames || []) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    rows.forEach(row => {
      (row || []).forEach(cell => { const v = String(cell || '').trim(); if (v) lines.push(v); });
    });
  }
  return lines.join('\n');
}
function upsertRangeWithTestNumbers(rangeName, testNumbers, defaults = {}) {
  const name = String(rangeName || '').trim().replace(/\s+/g, ' ');
  if (!name) return { skipped: true };
  let row = db.get('SELECT id FROM ranges WHERE lower(name)=lower(?) LIMIT 1', [name]);
  let inserted = false, restored = false;
  if (!row) {
    const ins = db.runNoSave(`INSERT INTO ranges (name,prefix,test_number,currency,rate_1_1,rate_7_1,rate_7_7,rate_30_45,memo,payment_type)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [name, defaults.prefix || '', '', defaults.currency || 'USD', defaults.rate_1_1 || 'NA', defaults.rate_7_1 || 'NA', defaults.rate_7_7 || 'NA', defaults.rate_30_45 || 'NA', defaults.memo || '', normalizePaymentType(defaults.payment_type || 'weekly')]);
    row = { id: ins.lastInsertRowid };
    inserted = true;
  } else {
    const old = db.get("SELECT COALESCE(deleted_at,'') AS deleted_at FROM ranges WHERE id=?", [row.id]);
    if (old && old.deleted_at) { db.runNoSave("UPDATE ranges SET deleted_at='' WHERE id=?", [row.id]); restored = true; }
  }
  const existing = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=?', [row.id]).map(x => String(x.test_number));
  const seen = new Set(existing.map(normalizeTestPhone));
  let added = 0;
  for (const raw of testNumbers || []) {
    const n = normalizeTestPhone(raw);
    if (!n || seen.has(n)) continue;
    db.runNoSave('INSERT INTO range_test_numbers (range_id,test_number,active) VALUES (?,?,1)', [row.id, n]);
    seen.add(n); added++;
  }
  const finalNums = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=? AND active=1 ORDER BY id ASC', [row.id]).map(x => x.test_number);
  db.runNoSave('UPDATE ranges SET test_number=? WHERE id=?', [finalNums.join(', '), row.id]);
  return { id: row.id, name, inserted, restored, added_test_numbers: added, total_test_numbers: finalNums.length };
}
app.post('/api/ranges/import-test-bulk', authRequired, requireRole('admin'), upload.single('file'), (req, res) => {
  let text = '';
  try {
    if (req.file && req.file.buffer) {
      const fileName = String(req.file.originalname || '').toLowerCase();
      if (/\.xlsx?$/.test(fileName)) {
        const XLSX = require('xlsx');
        const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
        text = sheetRowsToText(wb, XLSX);
      } else {
        text = req.file.buffer.toString('utf8');
      }
    } else if (req.body && (req.body.text || req.body.content)) {
      text = String(req.body.text || req.body.content || '');
    }
    const groups = parseRangeTestNumberBlocks(text);
    if (!groups.length) return res.status(400).json({ error: 'No range/test-number blocks found. First line should be range name, followed by test numbers.' });
    const details = [];
    let inserted = 0, restored = 0, added_test_numbers = 0;
    // Process in chunks without a long transaction so other requests can run between chunks.
    try {
      for (const g of groups) {
        const r = upsertRangeWithTestNumbers(g.range_name, g.test_numbers, { currency: req.body?.currency || 'USD', payment_type: req.body?.payment_type || 'weekly' });
        if (r.inserted) inserted++;
        if (r.restored) restored++;
        added_test_numbers += r.added_test_numbers || 0;
        details.push(r);
      }
      db.execNoSave('COMMIT'); db.save();
    } catch(e) { try { db.execNoSave('ROLLBACK'); } catch(_){} throw e; }
    clearApiReadCache();
    logAction(req, 'import_ranges_with_test_numbers', 'ranges', { total_ranges: groups.length, inserted, restored, added_test_numbers });
    res.json({ ok: true, total_ranges: groups.length, inserted, restored, added_test_numbers, details });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Import failed' });
  }
});

app.post('/api/ranges/import', authRequired, requireRole('admin'), (req,res)=>{
  const rows = Array.isArray(req.body?.ranges) ? req.body.ranges : [];
  const updateExisting = req.body?.update_existing !== false;
  if(!rows.length) return res.status(400).json({error:'ranges[] required'});
  let inserted=0, updated=0, skipped=0, errors=[];
  for(const raw of rows){
    const r=normalizeRangeImportRow(raw);
    if(!r.name){ skipped++; errors.push({row: raw, error:'Range name missing'}); continue; }
    const existing=db.get('SELECT id FROM ranges WHERE name=?',[r.name]);
    if(existing && updateExisting){
      db.run(`UPDATE ranges SET prefix=?,currency=?,rate_1_1=?,rate_7_1=?,rate_7_7=?,rate_30_45=?,memo=?,payment_type=?,deleted_at='' WHERE id=?`,
        [r.prefix,r.currency,r.rate_1_1,r.rate_7_1,r.rate_7_7,r.rate_30_45,r.memo,r.payment_type,existing.id]);
      syncRangeTestNumbers(existing.id, r.test_number || '');
      updated++;
    } else if(existing){ skipped++; }
    else {
      const ins=db.run(`INSERT INTO ranges (name,prefix,test_number,currency,rate_1_1,rate_7_1,rate_7_7,rate_30_45,memo,payment_type) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [r.name,r.prefix,'',r.currency,r.rate_1_1,r.rate_7_1,r.rate_7_7,r.rate_30_45,r.memo,r.payment_type]);
      const nr=db.get('SELECT id FROM ranges WHERE name=? ORDER BY id DESC LIMIT 1',[r.name]);
      syncRangeTestNumbers(nr?nr.id:ins.lastInsertRowid, r.test_number || '');
      inserted++;
    }
  }
  logAction(req,'import_ranges_bulk','ranges',{inserted,updated,skipped,total:rows.length});
  res.json({ok:true,inserted,updated,skipped,total:rows.length,errors});
});
app.put('/api/ranges/:id', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  db.run(`UPDATE ranges SET name=?,prefix=?,currency=?,rate_1_1=?,rate_7_1=?,rate_7_7=?,rate_30_45=?,memo=?,payment_type=? WHERE id=?`,
    [b.name, b.prefix || '', b.currency || 'USD',
     b.rate_1_1 || 'NA', b.rate_7_1 || 'NA', b.rate_7_7 || 'NA', b.rate_30_45 || 'NA', b.memo || '', normalizePaymentType(b.payment_type || 'weekly'), +req.params.id]);
  syncRangeTestNumbers(+req.params.id, b.test_numbers || b.test_number || '');
  logAction(req,'update_range','ranges',{id:+req.params.id});
  res.json({ ok: true });
});
app.delete('/api/ranges/:id', authRequired, requireRole('admin'), (req, res) => {
  const rangeId = +req.params.id;
  const range = db.get('SELECT * FROM ranges WHERE id=?', [rangeId]);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  const deleteSms = truthy(req.query.delete_sms);
  const numberResult = deleteNumbersWhere('range_id=?', [rangeId], req, 'delete_range_numbers_during_range_delete', { rangeId, range: range.name }, deleteSms);
  let rangeSmsDeleted = 0, rangeSmsPreserved = 0;
  const rangeSmsCount = db.get('SELECT COUNT(*) c FROM sms_records WHERE range_id=?', [rangeId])?.c || 0;
  if (deleteSms) {
    db.run('DELETE FROM sms_records WHERE range_id=?', [rangeId]);
    rangeSmsDeleted = rangeSmsCount;
  } else {
    rangeSmsPreserved = rangeSmsCount;
  }
  db.run('DELETE FROM range_test_numbers WHERE range_id=?', [rangeId]);
  // Soft-delete the range so historical SMS reports can still show the old range name via joins.
  db.run("UPDATE ranges SET deleted_at=datetime('now') WHERE id=?", [rangeId]);
  logAction(req,'delete_range','ranges',{id:rangeId,range:range.name,deleteSms,numberResult,rangeSmsDeleted,rangeSmsPreserved});
  res.json({ ok: true, deleted_range: 1, deleted_numbers: numberResult.deleted || 0, deleted_sms: (numberResult.deleted_sms || 0) + rangeSmsDeleted, preserved_sms: (numberResult.preserved_sms || 0) + rangeSmsPreserved });
});

app.get('/api/test-numbers', authRequired, (req, res) => {
  // Test panel numbers are separate from actual panel numbers. UI should show only range name + number.
  const rows = db.all(`SELECT t.id, t.range_id, t.test_number AS number, t.label, t.created_at, r.name AS range_name, r.prefix,
      COALESCE(NULLIF(r.rate_30_45,''), NULLIF(r.rate_7_1,''), 'Ask') AS payout
    FROM range_test_numbers t
    JOIN ranges r ON r.id=t.range_id
    WHERE t.active=1
    ORDER BY r.name, t.id`);
  res.json(rows);
});

app.post('/api/test-numbers/import', authRequired, requireRole('admin'), (req, res) => {
  const { range_id, range_name, numbers } = req.body || {};
  if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: 'numbers[] required' });
  let range = range_id ? db.get('SELECT * FROM ranges WHERE id=?', [+range_id]) : null;
  if (!range && range_name) range = db.get('SELECT * FROM ranges WHERE name=?', [range_name]);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  let inserted = 0, skipped = 0;
  for (const raw of numbers) {
    const n = String(raw || '').trim();
    if (!n) { skipped++; continue; }
    const cleaned = cleanPhone(n);
    const existsInPanel = db.get(`SELECT id FROM numbers
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?`, [cleaned]);
    if (existsInPanel) { skipped++; continue; }
    const existsTest = db.get(`SELECT id FROM range_test_numbers WHERE range_id=? AND REPLACE(REPLACE(REPLACE(REPLACE(test_number,'+',''),' ',''),'-',''),'_','')=?`, [range.id, cleaned]);
    if (existsTest) { skipped++; continue; }
    db.run('INSERT INTO range_test_numbers (range_id,test_number,active) VALUES (?,?,1)', [range.id, n]);
    inserted++;
  }
  const joined = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=? AND active=1 ORDER BY id', [range.id]).map(x => x.test_number).join(', ');
  db.run('UPDATE ranges SET test_number=? WHERE id=?', [joined, range.id]);
  logAction(req, 'import_test_numbers', 'test_numbers', { range: range.name, inserted, skipped });
  res.json({ ok: true, inserted, skipped, range_id: range.id });
});

app.post('/api/test-numbers', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const number = String(b.number || '').trim();
  if (!number) return res.status(400).json({ error: 'number required' });
  let range = b.range_id ? db.get('SELECT * FROM ranges WHERE id=?', [+b.range_id]) : null;
  if (!range && b.range_name) range = db.get('SELECT * FROM ranges WHERE name=?', [String(b.range_name).trim()]);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  const cleaned = cleanPhone(number);
  const existsPanel = db.get(`SELECT id FROM numbers WHERE REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?`, [cleaned]);
  if (existsPanel) return res.status(409).json({ error: 'This number already exists in live SMS Numbers' });
  const existsTest = db.get(`SELECT id FROM range_test_numbers WHERE range_id=? AND REPLACE(REPLACE(REPLACE(REPLACE(test_number,'+',''),' ',''),'-',''),'_','')=?`, [range.id, cleaned]);
  if (existsTest) return res.status(409).json({ error: 'This test number already exists in this range' });
  db.run('INSERT INTO range_test_numbers (range_id,test_number,active) VALUES (?,?,1)', [range.id, number]);
  const joined = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=? AND active=1 ORDER BY id', [range.id]).map(x => x.test_number).join(', ');
  db.run('UPDATE ranges SET test_number=? WHERE id=?', [joined, range.id]);
  logAction(req, 'add_test_number', 'test_numbers', { range: range.name, number });
  res.json({ ok: true, inserted: 1, range_id: range.id });
});

app.delete('/api/test-numbers/:id', authRequired, requireRole('admin'), (req, res) => {
  const id = +req.params.id;
  const row = db.get('SELECT * FROM range_test_numbers WHERE id=?', [id]);
  if (!row) return res.status(404).json({ error: 'Test number not found' });
  db.run('DELETE FROM range_test_numbers WHERE id=?', [id]);
  const joined = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=? AND active=1 ORDER BY id', [row.range_id]).map(x => x.test_number).join(', ');
  db.run('UPDATE ranges SET test_number=? WHERE id=?', [joined, row.range_id]);
  logAction(req, 'delete_test_number', 'test_numbers', { id, number: row.test_number, range_id: row.range_id });
  res.json({ ok: true, deleted: 1 });
});

app.get('/api/test-panel/dashboard', authRequired, requireRole('admin','manager','agent','client','test'), (req, res) => {
  const nums = db.get('SELECT COUNT(*) c FROM range_test_numbers WHERE active=1')?.c || 0;
  const ukDay = ukDateExpr('s.received_at');
  const matchExpr = `REPLACE(REPLACE(REPLACE(REPLACE(t.test_number,'+',''),' ',''),'-',''),'_','')=REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')`;
  const today = db.get(`SELECT COUNT(*) c FROM sms_records s WHERE ${ukDay}=${ukDateNowSql()} AND EXISTS (
      SELECT 1 FROM range_test_numbers t WHERE t.active=1 AND ${matchExpr}
    )`)?.c || 0;
  const daily7 = db.all(`WITH days(n,d) AS (
      SELECT 6, ${ukDateNowSql('-6 days')} UNION ALL SELECT n-1, date(d,'+1 day') FROM days WHERE n>0
    ) SELECT d AS date, COALESCE((SELECT COUNT(*) FROM sms_records s WHERE ${ukDay}=d AND EXISTS (
      SELECT 1 FROM range_test_numbers t WHERE t.active=1 AND ${matchExpr}
    )),0) AS count FROM days ORDER BY d`);
  res.json({ today_otps: today, total_test_numbers: nums, daily7, reporting_timezone: 'Europe/London' });
});

app.get('/api/test-panel/sms', authRequired, requireRole('admin','manager','agent','client','test'), (req, res) => {
  const number = String(req.query.number || '').trim();
  const params = [];
  let extra = '';
  if (number) { extra = `AND REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')=?`; params.push(cleanPhone(number)); }
  const matchExpr = `REPLACE(REPLACE(REPLACE(REPLACE(t.test_number,'+',''),' ',''),'-',''),'_','')=REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')`;
  const rows = db.all(`SELECT s.*,
      COALESCE(r.name, (SELECT r2.name FROM range_test_numbers t LEFT JOIN ranges r2 ON r2.id=t.range_id WHERE t.active=1 AND ${matchExpr} ORDER BY t.id DESC LIMIT 1)) AS range_name,
      (SELECT t.id FROM range_test_numbers t WHERE t.active=1 AND ${matchExpr} ORDER BY t.id DESC LIMIT 1) AS test_number_id,
      (SELECT t.test_number FROM range_test_numbers t WHERE t.active=1 AND ${matchExpr} ORDER BY t.id DESC LIMIT 1) AS test_number,
      (SELECT t.created_at FROM range_test_numbers t WHERE t.active=1 AND ${matchExpr} ORDER BY t.id DESC LIMIT 1) AS test_number_created_at,
      cu.username AS client_name, au.username AS agent_name, mu.username AS manager_name
    FROM sms_records s
    LEFT JOIN ranges r ON r.id=s.range_id
    LEFT JOIN users cu ON cu.id=s.client_id
    LEFT JOIN users au ON au.id=s.agent_id
    LEFT JOIN users mu ON mu.id=s.manager_id
    WHERE EXISTS (SELECT 1 FROM range_test_numbers t WHERE t.active=1 AND ${matchExpr})
      AND datetime(s.received_at) >= datetime((SELECT t.created_at FROM range_test_numbers t WHERE t.active=1 AND ${matchExpr} ORDER BY t.id DESC LIMIT 1))
      ${extra}
    ORDER BY s.id DESC LIMIT 1000`, params);
  res.json(rows);
});

function testPanelNumbersPool() {
  return db.all(`SELECT t.id, t.range_id, t.test_number AS number, r.name AS range_name,
      COALESCE(NULLIF(r.rate_30_45,''), NULLIF(r.rate_7_1,''), NULLIF(r.rate_7_7,''), NULLIF(r.rate_1_1,''), '0') AS payout_rate
    FROM range_test_numbers t
    LEFT JOIN ranges r ON r.id=t.range_id
    WHERE t.active=1
    ORDER BY t.id ASC`);
}
function demoSqlDate(minutesAgo) {
  const d = new Date(Date.now() - (Number(minutesAgo)||0) * 60000);
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function generateTestPanelFakeMessages({ limit=25, cli='', message='' }, req) {
  const pool = testPanelNumbersPool();
  if (!pool.length) return { ok:false, error:'No test numbers found. Add/import test numbers first.' };
  const owners = db.all(`SELECT c.id AS client_id, c.username AS client_name, a.id AS agent_id, a.parent_id AS manager_id
    FROM users c LEFT JOIN users a ON a.id=c.parent_id
    WHERE c.role='client' AND c.active=1
    ORDER BY c.id ASC`);
  const max = Math.max(1, Math.min(1000, parseInt(limit || 25, 10)));
  const defaultClis = ['Affirm','TikTok','WhatsApp','Google','Telegram','JD STATUS','Amazon','Facebook','Binance','Verify'];
  const defaultTemplates = [
    '{service}: Your verification code is {code}. Do not share it with anyone.',
    'Your {service} code is {code}. This code will expire in 3 minutes.',
    '{code} is your {service} OTP. Never share this code.',
    'Use {code} to verify your {service} login request.',
    '{service} security code: {code}. If this was not you, ignore this message.'
  ];
  let inserted = 0;
  for (let i=0; i<max; i++) {
    const n = pool[i % pool.length];
    const service = cli || defaultClis[i % defaultClis.length];
    const code = String(100000 + Math.floor(Math.random() * 900000));
    const tpl = message || defaultTemplates[i % defaultTemplates.length];
    const body = String(tpl)
      .replaceAll('{code}', code)
      .replaceAll('{number}', n.number)
      .replaceAll('{service}', service)
      .replaceAll('{range}', n.range_name || 'Test Range')
      .replaceAll('{index}', String(i+1));
    const senderType = classifySender(service);
    const otpCode = extractOtpCode(body) || code;
    // Keep demo traffic at current time so generated limit, dashboard count and displayed rows match exactly.
    const when = demoSqlDate(0);
    const owner = owners.length ? owners[i % owners.length] : {};
    db.run(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,manager_id,is_test,test_batch_id,source,payout_rate,payout_amount,received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [null, n.number, n.range_id, service, senderType, body, otpCode, owner.client_id || null, owner.agent_id || null, owner.manager_id || null, 1, 'DEMO-' + Date.now(), 'test_panel_fake', n.payout_rate || '0', n.payout_rate || '0', when]);
    inserted++;
  }
  logAction(req, 'generate_test_panel_fake_sms', 'test_panel', { inserted, mode: message || cli ? 'custom' : 'default' });
  return { ok:true, inserted, available_test_numbers: pool.length };
}
app.post('/api/test-panel/fake/default', authRequired, requireRole('admin'), (req, res) => {
  const result = generateTestPanelFakeMessages({ limit: req.body?.limit || 25 }, req);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.post('/api/test-panel/fake/custom', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const cli = String(b.cli || '').trim();
  const message = String(b.message || '').trim();
  if (!cli) return res.status(400).json({ error:'CLI is required' });
  if (!message) return res.status(400).json({ error:'Message body is required' });
  const result = generateTestPanelFakeMessages({ limit: b.limit || 25, cli, message }, req);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.delete('/api/test-panel/fake', authRequired, requireRole('admin'), (req, res) => {
  const count = db.get("SELECT COUNT(*) c FROM sms_records WHERE source='test_panel_fake'")?.c || 0;
  db.run("DELETE FROM sms_records WHERE source='test_panel_fake'");
  logAction(req, 'clear_test_panel_fake_sms', 'test_panel', { count });
  res.json({ ok:true, deleted: count });
});


/* ============ NUMBERS ============ */
function numberOwnerColumnForRole(role) {
  if (role === 'admin') return 'manager_id';
  if (role === 'manager') return 'agent_id';
  if (role === 'agent') return 'client_id';
  return 'client_id';
}
function numberScope(user, alias='n') {
  const p = alias ? alias + '.' : '';
  if (user.role === 'manager') return { where: `${p}manager_id=?`, params: [user.id] };
  if (user.role === 'agent') return { where: `${p}agent_id=?`, params: [user.id] };
  if (user.role === 'client') return { where: `${p}client_id=?`, params: [user.id] };
  return { where: '1=1', params: [] };
}
function buildNumberQuery(user, q) {
  const scope = numberScope(user, 'n');
  const where = [scope.where];
  const params = [...scope.params];
  if (q.search) {
    where.push(`(n.number LIKE ? OR r.name LIKE ? OR n.prefix LIKE ? OR COALESCE(cu.username,'') LIKE ? OR COALESCE(au.username,'') LIKE ? OR COALESCE(mu.username,'') LIKE ?)`);
    const v = `%${q.search}%`;
    params.push(v, v, v, v, v, v);
  }
  if (q.range) { where.push('r.name=?'); params.push(q.range); }
  if (q.range_id) { where.push('n.range_id=?'); params.push(+q.range_id); }
  if (q.owner) {
    if (user.role === 'admin') {
      // Admin owner can be Manager allocation or direct Agent allocation.
      where.push('(mu.username=? OR au.username=?)'); params.push(q.owner, q.owner);
    }
    else if (user.role === 'manager') { where.push('au.username=?'); params.push(q.owner); }
    else if (user.role === 'agent') { where.push('cu.username=?'); params.push(q.owner); }
  }
  if (q.allocation === 'unallocated') {
    if (user.role === 'admin') where.push('n.manager_id IS NULL AND n.agent_id IS NULL AND n.client_id IS NULL');
    else { const col = numberOwnerColumnForRole(user.role); where.push(`n.${col} IS NULL`); }
  } else if (q.allocation === 'allocated') {
    if (user.role === 'admin') where.push('(n.manager_id IS NOT NULL OR n.agent_id IS NOT NULL OR n.client_id IS NOT NULL)');
    else { const col = numberOwnerColumnForRole(user.role); where.push(`n.${col} IS NOT NULL`); }
  }
  return { where: where.join(' AND '), params };
}
function numberFromSql(where) {
  return `FROM numbers n
     LEFT JOIN ranges r ON r.id=n.range_id
     LEFT JOIN users cu ON cu.id=n.client_id
     LEFT JOIN users au ON au.id=n.agent_id
     LEFT JOIN users mu ON mu.id=n.manager_id
     WHERE ${where}`;
}
function numberSelectSql(where, options = {}) {
  const lastSms = options.lastSms ? `,
            (SELECT MAX(s.received_at) FROM sms_records s WHERE s.number=n.number AND COALESCE(s.is_test,0)=0) AS last_sms_at` : '';
  return `SELECT n.*, r.name AS range_name,
            COALESCE(NULLIF(n.rate,''), NULLIF(r.rate_30_45,''), NULLIF(r.rate_7_1,''), NULLIF(r.rate_7_7,''), NULLIF(r.rate_1_1,''), '0') AS effective_rate,
            CASE WHEN n.manager_id IS NOT NULL THEN 'manager' WHEN n.agent_id IS NOT NULL THEN 'agent' WHEN n.client_id IS NOT NULL THEN 'client' ELSE 'unallocated' END AS owner_type,
            cu.username AS client_name, au.username AS agent_name, mu.username AS manager_name${lastSms}
     ${numberFromSql(where)}`;
}
app.get('/api/numbers/summary', authRequired, (req, res) => cachedJson(req, res, 3000, () => {
  const scope = numberScope(req.user, 'n');
  const ownerExpr = req.user.role === 'admin'
    ? '(n.manager_id IS NOT NULL OR n.agent_id IS NOT NULL OR n.client_id IS NOT NULL)'
    : `n.${numberOwnerColumnForRole(req.user.role)} IS NOT NULL`;
  const rows = db.all(`SELECT r.id AS range_id, r.name AS range_name,
      COUNT(n.id) AS total,
      SUM(CASE WHEN n.id IS NOT NULL AND NOT (${ownerExpr}) THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN n.id IS NOT NULL AND ${ownerExpr} THEN 1 ELSE 0 END) AS allocated,
      COALESCE(NULLIF(r.rate_30_45,''), NULLIF(r.rate_7_1,''), '0') AS rate
    FROM ranges r
    LEFT JOIN numbers n ON n.range_id=r.id AND ${scope.where}
    WHERE COALESCE(r.deleted_at,'')=''
    GROUP BY r.id, r.name
    ORDER BY r.name COLLATE NOCASE ASC`, scope.params);
  return rows.map(r => ({...r, total:+(r.total||0), available:+(r.available||0), allocated:+(r.allocated||0)}));
}));

// list numbers visible to caller (supports server-side pagination with ?paged=1)
const NUMBER_PAGE_DEFAULT = 25;
const NUMBER_PAGE_MAX = 100000; // allows 5,000/All views while keeping a safety ceiling
function parsePositiveInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
app.get('/api/numbers', authRequired, (req, res) => cachedJson(req, res, 1500, () => {
  const query = buildNumberQuery(req.user, req.query || {});
  const fromSql = numberFromSql(query.where);

  // Fast fresh COUNT(*) after scope/search/filter; no SELECT * subquery.
  const total = +(db.get(`SELECT COUNT(n.id) AS c ${fromSql}`, query.params)?.c || 0);

  const paged = req.query.paged || req.query.page || req.query.limit;
  if (paged) {
    const requestedLimitRaw = String(req.query.limit || NUMBER_PAGE_DEFAULT);
    const isAll = requestedLimitRaw.toLowerCase() === 'all';
    const requestedLimit = isAll ? Math.max(1, total) : parsePositiveInt(requestedLimitRaw, NUMBER_PAGE_DEFAULT);
    const limit = isAll ? Math.max(1, Math.min(total || 1, NUMBER_PAGE_MAX)) : Math.min(NUMBER_PAGE_MAX, Math.max(1, requestedLimit));
    const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limit));
    const requestedPage = parsePositiveInt(req.query.page || '1', 1);
    const page = Math.min(Math.max(1, requestedPage), totalPages);
    const offset = (page - 1) * limit;
    const sortMap = { range:'r.name COLLATE NOCASE', prefix:'n.prefix COLLATE NOCASE', number:'n.number', myVal:"CAST(COALESCE(NULLIF(n.rate,''),'0') AS REAL)", payVal:"CAST(COALESCE(NULLIF(n.payout,''),'0') AS REAL)", manager:'mu.username COLLATE NOCASE', agent:'au.username COLLATE NOCASE', client:'cu.username COLLATE NOCASE', owner:"COALESCE(mu.username,au.username,cu.username,'') COLLATE NOCASE" };
    const sortCol = sortMap[req.query.sort] || 'n.number';
    const dir = String(req.query.dir||'asc').toLowerCase()==='desc'?'DESC':'ASC';
    const withLastSms = String(req.query.last_sms || req.query.include_last_sms || '') === '1';
    const rows = db.all(`${numberSelectSql(query.where, { lastSms: withLastSms })} ORDER BY ${sortCol} ${dir}, n.id ASC LIMIT ? OFFSET ?`, [...query.params, limit, offset]);
    return { rows, total, page, limit, totalPages, count_source: 'fast_database_count' };
  }

  const rows = db.all(`${numberSelectSql(query.where)} ORDER BY n.number ASC`, query.params);
  return rows;
}));

// allocate selected numbers to a target user (one level down)
app.post('/api/numbers/allocate', authRequired, (req, res) => {
  const { ids, target_id, payterm, payout } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || !target_id)
    return res.status(400).json({ error: 'ids[] and target_id are required' });

  const target = db.get('SELECT * FROM users WHERE id=?', [target_id]);
  if (!target) return res.status(404).json({ error: 'Target not found' });

  const allowedTargets = { admin: ['manager','agent'], manager: ['agent'], agent: ['client'] }[req.user.role] || [];
  if (!allowedTargets.includes(target.role))
    return res.status(403).json({ error: 'You are not allowed to allocate to this role' });
  // Managers/Agents can allocate only to their direct child. Admin can allocate directly to any Manager or Agent.
  if (req.user.role !== 'admin' && target.parent_id !== req.user.id)
    return res.status(403).json({ error: 'You can only allocate to your direct child user' });

  const ph = ids.map(() => '?').join(',');
  const beforeRows = db.all(`SELECT id,number,manager_id,agent_id,client_id FROM numbers WHERE id IN (${ph})`, ids);
  if (!beforeRows.length) return res.status(404).json({ error: 'No numbers found' });

  let sets = '', vals = [];
  if (target.role === 'manager') {
    // Admin -> Manager: reset downstream ownership so old Agent/Client links do not remain.
    sets = "manager_id=?, agent_id=NULL, client_id=NULL, payout='0', rate=''";
    vals = [target.id];
  } else if (target.role === 'agent') {
    // Manager -> Agent keeps manager chain. Admin -> Agent direct has no manager owner.
    const mgrId = req.user.role === 'admin' ? null : target.parent_id;
    sets = "agent_id=?, manager_id=?, client_id=NULL, payout='0', rate=''";
    vals = [target.id, mgrId];
  } else if (target.role === 'client') {
    // Agent -> Client: snapshot chain for future SMS.
    const agentId = target.parent_id;
    const mgrId = agentId ? (db.get('SELECT parent_id FROM users WHERE id=?', [agentId])?.parent_id || null) : null;
    sets = 'client_id=?, agent_id=?, manager_id=?';
    vals = [target.id, agentId, mgrId];
  }
  if (target.role === 'agent' && payterm) { const pt=normalizePaymentType(payterm); sets += ', payterm=?'; vals.push(pt); try{ db.run('UPDATE users SET payment_type=? WHERE id=? AND role=\'agent\'',[pt,target.id]); }catch(e){} }
  // Rate lock rule: Admin->Manager and Manager->Agent must keep the existing/Admin rate.
  // Only Agent->Client can set/change client payout.
  if (req.user.role === 'agent' && payout !== undefined && payout !== '') { sets += ', payout=?'; vals.push(String(payout)); }

  db.run(`UPDATE numbers SET ${sets} WHERE id IN (${ph})`, [...vals, ...ids]);
  beforeRows.forEach(nr=>logNumberHistory(req,nr,'allocated','',target.username,{target_role:target.role}));
  logAction(req,'allocate_numbers','numbers',{count:beforeRows.length,target:target.username,target_role:target.role});
  res.json({ ok: true, count: beforeRows.length });
});

// unallocate selected numbers (clear the caller's ownership level downward, without changing old SMS snapshots)
app.post('/api/numbers/unallocate', authRequired, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids[] required' });
  const ph = ids.map(() => '?').join(',');

  let where = '', params = [];
  let updateSql = '';
  if (req.user.role === 'admin') {
    where = `id IN (${ph})`;
    params = ids;
    updateSql = `UPDATE numbers SET manager_id=NULL, agent_id=NULL, client_id=NULL, payout='0', rate='' WHERE id IN (${ph})`;
  } else if (req.user.role === 'manager') {
    where = `id IN (${ph}) AND manager_id=?`;
    params = [...ids, req.user.id];
    updateSql = `UPDATE numbers SET agent_id=NULL, client_id=NULL, payout='0', rate='' WHERE id IN (${ph}) AND manager_id=?`;
  } else if (req.user.role === 'agent') {
    where = `id IN (${ph}) AND agent_id=?`;
    params = [...ids, req.user.id];
    updateSql = `UPDATE numbers SET client_id=NULL, payout='0', rate='' WHERE id IN (${ph}) AND agent_id=?`;
  } else {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const beforeRows = db.all(`SELECT id,number,manager_id,agent_id,client_id FROM numbers WHERE ${where}`, params);
  if (!beforeRows.length) return res.status(404).json({ error: 'No matching allocated numbers found' });
  db.run(updateSql, params);
  beforeRows.forEach(nr=>logNumberHistory(req,nr,'unallocated','','','Unallocate selected numbers'));
  logAction(req,'unallocate_numbers','numbers',{count:beforeRows.length,role:req.user.role});
  res.json({ ok: true, count: beforeRows.length });
});

function truthy(v) { return v === true || v === 1 || v === '1' || String(v || '').toLowerCase() === 'true' || String(v || '').toLowerCase() === 'yes'; }
function deleteNumbersFromRows(rows, req, action, details = {}, deleteSms = false) {
  const cleanRows = (rows || [])
    .map(r => ({ id: parseInt(r.id, 10), number: String(r.number || '') }))
    .filter(r => Number.isFinite(r.id) && r.id > 0);
  const count = cleanRows.length;
  if (!count) return { deleted: 0, deleted_sms: 0, preserved_sms: 0, vacuum: false };

  let smsCount = 0;
  try {
    db.execNoSave('BEGIN TRANSACTION');
    db.execNoSave('DROP TABLE IF EXISTS tmp_delete_numbers');
    db.execNoSave('CREATE TEMP TABLE tmp_delete_numbers (id INTEGER PRIMARY KEY, number TEXT)');
    for (const r of cleanRows) db.runNoSave('INSERT OR IGNORE INTO tmp_delete_numbers (id,number) VALUES (?,?)', [r.id, r.number]);

    // Count linked SMS records. Delete them only when the caller explicitly asks.
    // number text match covers old SMS rows where number_id was not populated.
    smsCount = db.get(`SELECT COUNT(*) c FROM sms_records
      WHERE number_id IN (SELECT id FROM tmp_delete_numbers)
         OR number IN (SELECT number FROM tmp_delete_numbers WHERE number<>'')`)?.c || 0;
    if (deleteSms) {
      db.runNoSave(`DELETE FROM sms_records
        WHERE number_id IN (SELECT id FROM tmp_delete_numbers)
           OR number IN (SELECT number FROM tmp_delete_numbers WHERE number<>'')`);
    }
    db.runNoSave('DELETE FROM numbers WHERE id IN (SELECT id FROM tmp_delete_numbers)');
    db.execNoSave('DROP TABLE IF EXISTS tmp_delete_numbers');
    db.execNoSave('COMMIT');
    db.save();
  } catch (e) {
    try { db.execNoSave('ROLLBACK'); } catch (_) {}
    throw e;
  }

  // Do not VACUUM after every delete; it rewrites the whole DB and makes small delete/range actions feel frozen.
  const vacuum = false;
  logAction(req, action, 'numbers', { ...details, count, linkedSms: smsCount, deleteSms: !!deleteSms });
  return { deleted: count, deleted_sms: deleteSms ? smsCount : 0, preserved_sms: deleteSms ? 0 : smsCount, vacuum };
}
function deleteNumbersFromSelect(selectSql, params = [], req, action, details = {}, deleteSms = false) {
  const rows = db.all(selectSql, params);
  return deleteNumbersFromRows(rows, req, action, details, deleteSms);
}
function deleteNumbersWhere(whereSql, params = [], req, action, details = {}, deleteSms = false) {
  return deleteNumbersFromSelect(`SELECT id, number FROM numbers WHERE ${whereSql}`, params, req, action, details, deleteSms);
}

// hard delete selected numbers (Admin only). This is not a soft-delete, so no "Deleted" rows remain in lists.
app.post('/api/numbers/delete', authRequired, requireRole('admin'), (req, res) => {
  const ids = (req.body && Array.isArray(req.body.ids) ? req.body.ids : [])
    .map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0);
  if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
  const uniqueIds = [...new Set(ids)];
  const ph = uniqueIds.map(() => '?').join(',');
  const result = deleteNumbersWhere(`id IN (${ph})`, uniqueIds, req, 'delete_selected_numbers', { requested: ids.length }, truthy(req.body?.delete_sms));
  res.json({ ok: true, ...result });
});

// Move selected live SMS Numbers into Test Panel numbers.
// This removes them from live numbers table and keeps only range + number in range_test_numbers.
app.post('/api/numbers/move-to-test', authRequired, requireRole('admin'), (req, res) => {
  const ids = (req.body && Array.isArray(req.body.ids) ? req.body.ids : [])
    .map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0);
  if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
  const uniqueIds = [...new Set(ids)];
  const ph = uniqueIds.map(() => '?').join(',');
  const rows = db.all(`SELECT n.id,n.number,n.range_id,r.name AS range_name FROM numbers n LEFT JOIN ranges r ON r.id=n.range_id WHERE n.id IN (${ph})`, uniqueIds);
  if (!rows.length) return res.status(404).json({ error: 'No matching numbers found' });

  let moved = 0, skipped = 0, deletedFromLive = 0;
  const seenCleaned = new Set();
  const affectedRanges = new Set();
  for (const n of rows) {
    const cleaned = cleanPhone(n.number);
    if (!cleaned || !n.range_id) { skipped++; continue; }
    if (seenCleaned.has(cleaned)) { skipped++; continue; }
    seenCleaned.add(cleaned);
    const existsTest = db.get(`SELECT id FROM range_test_numbers
      WHERE range_id=? AND REPLACE(REPLACE(REPLACE(REPLACE(test_number,'+',''),' ',''),'-',''),'_','')=?`, [n.range_id, cleaned]);
    if (!existsTest) {
      db.run('INSERT INTO range_test_numbers (range_id,test_number,active) VALUES (?,?,1)', [n.range_id, n.number]);
    }
    const liveCount = db.get(`SELECT COUNT(*) c FROM numbers WHERE REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?`, [cleaned])?.c || 0;
    db.run(`DELETE FROM numbers WHERE REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?`, [cleaned]);
    deletedFromLive += liveCount;
    affectedRanges.add(n.range_id);
    moved++;
  }

  for (const rid of affectedRanges) {
    const joined = db.all('SELECT test_number FROM range_test_numbers WHERE range_id=? AND active=1 ORDER BY id', [rid]).map(x => x.test_number).join(', ');
    db.run('UPDATE ranges SET test_number=? WHERE id=?', [joined, rid]);
  }
  logAction(req, 'move_numbers_to_test_panel', 'numbers', { requested: ids.length, moved, skipped, deleted_from_live: deletedFromLive, ranges: [...affectedRanges] });
  res.json({ ok: true, moved, skipped, deleted_from_live: deletedFromLive, ranges: [...affectedRanges] });
});

// hard delete all numbers that match current filters/search/range (Admin only, DB-side, not current page only)
app.post('/api/numbers/delete-filtered', authRequired, requireRole('admin'), (req, res) => {
  const query = buildNumberQuery(req.user, req.body || {});
  const baseSql = numberSelectSql(query.where);
  const result = deleteNumbersFromSelect(`SELECT id, number FROM (${baseSql}) x`, query.params, req, 'delete_filtered_numbers', req.body || {}, truthy(req.body?.delete_sms));
  res.json({ ok: true, ...result });
});

// hard delete every number in the database (Admin only)
app.delete('/api/numbers/all', authRequired, requireRole('admin'), (req, res) => {
  const result = deleteNumbersWhere('1=1', [], req, 'delete_all_numbers', {}, truthy(req.query.delete_sms));
  db.run(`UPDATE number_import_batches SET status='deleted', deleted_at=datetime('now') WHERE status<>'deleted'`);
  res.json({ ok: true, ...result });
});

// hard delete all numbers for one range (Admin only)
app.delete('/api/numbers/range/:rangeId', authRequired, requireRole('admin'), (req, res) => {
  const rangeId = parsePositiveInt(req.params.rangeId, 0);
  if (!rangeId) return res.status(400).json({ error: 'Valid range id required' });
  const range = db.get('SELECT id,name FROM ranges WHERE id=?', [rangeId]);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  const result = deleteNumbersWhere('range_id=?', [rangeId], req, 'delete_range_numbers', { rangeId, range: range.name }, truthy(req.query.delete_sms));
  db.run(`UPDATE number_import_batches SET status='deleted', deleted_at=datetime('now') WHERE range_id=? AND status<>'deleted'`, [rangeId]);
  res.json({ ok: true, range_id: rangeId, range_name: range.name, ...result });
});

// unallocate a quantity from a range using the database directly (works even with server-side pagination).
app.post('/api/numbers/unallocate-by-range', authRequired, (req, res) => {
  const rangeId = parsePositiveInt(req.body?.range_id, 0);
  const qty = Math.min(NUMBER_PAGE_MAX, parsePositiveInt(req.body?.qty, 0));
  if (!rangeId || !qty) return res.status(400).json({ error: 'range_id and qty required' });
  if (!['admin','manager','agent'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });

  const scope = numberScope(req.user, 'n');
  const ownerCol = numberOwnerColumnForRole(req.user.role);
  const rows = db.all(`SELECT n.id,n.number,n.manager_id,n.agent_id,n.client_id
    FROM numbers n
    WHERE n.range_id=? AND ${scope.where} AND n.${ownerCol} IS NOT NULL
    ORDER BY n.id ASC LIMIT ?`, [rangeId, ...scope.params, qty]);
  if (!rows.length) return res.status(404).json({ error: 'Allocated numbers were not found' });
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');

  if (req.user.role === 'admin') db.run(`UPDATE numbers SET manager_id=NULL, agent_id=NULL, client_id=NULL, payout='0', rate='' WHERE id IN (${ph})`, ids);
  else if (req.user.role === 'manager') db.run(`UPDATE numbers SET agent_id=NULL, client_id=NULL, payout='0', rate='' WHERE id IN (${ph}) AND manager_id=?`, [...ids, req.user.id]);
  else if (req.user.role === 'agent') db.run(`UPDATE numbers SET client_id=NULL, payout='0', rate='' WHERE id IN (${ph}) AND agent_id=?`, [...ids, req.user.id]);

  rows.forEach(nr=>logNumberHistory(req,nr,'unallocated','','','Unallocate range quantity'));
  logAction(req,'unallocate_numbers_by_range','numbers',{rangeId,count:rows.length,role:req.user.role});
  res.json({ ok:true, count: rows.length });
});


function makeNumberJobId(){ return 'NUMJOB-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,8).toUpperCase(); }
function setJob(job, patch){ Object.assign(job, patch, { updated_at: new Date().toISOString() }); return job; }
function sleepImmediate(){ return new Promise(resolve => setImmediate(resolve)); }
function chunkIds(ids, size=1000){ const out=[]; for(let i=0;i<ids.length;i+=size) out.push(ids.slice(i,i+size)); return out; }
function auditJobAction(user, action, module, details={}){
  try{ db.run('INSERT INTO audit_logs (user_id,username,role,action,module,details,ip) VALUES (?,?,?,?,?,?,?)', [user.id||null,user.username||'',user.role||'',action,module,safeJson(details),'background-job']); }catch(e){}
}
async function performSmartDivideJob(job){
  const { user, range_ids, target_ids, qty, payterm } = job;
  const wantRole = { admin: 'manager', manager: 'agent', agent: 'client' }[user.role];
  const col = { manager: 'manager_id', agent: 'agent_id', client: 'client_id' }[wantRole];
  let ownerCond = '1=1', ownerParams = [];
  if (user.role === 'manager') { ownerCond = 'manager_id=?'; ownerParams = [user.id]; }
  else if (user.role === 'agent') { ownerCond = 'agent_id=?'; ownerParams = [user.id]; }
  const smartType = normalizePaymentType(payterm || 'weekly');
  setJob(job,{status:'processing',started_at:new Date().toISOString(),progress:0,processed:0,total:0,message:'Selecting numbers'});
  try{
    if(wantRole==='agent') target_ids.forEach(tid=>db.runNoSave('UPDATE users SET payment_type=? WHERE id=?',[smartType,tid]));
    const report=[]; let total=0; let planned=0;
    // First pass counts selected IDs and keeps pools in memory; avoids DB save per number.
    const rangePools=[];
    for(const rid of range_ids){
      const pool=db.all(`SELECT id FROM numbers WHERE range_id=? AND ${col} IS NULL AND ${ownerCond} LIMIT ?`, [rid, ...ownerParams, qty]).map(r=>r.id);
      rangePools.push({rid,pool}); planned += pool.length;
    }
    setJob(job,{total:planned,message:'Updating allocations'});
    // Process in chunks without a long transaction so other requests can run between chunks.
    for(const {rid,pool} of rangePools){
      const take=pool.length;
      const perBase=Math.floor(take/target_ids.length); let rem=take%target_ids.length, ptr=0;
      const split=target_ids.map(t=>{const c=perBase+(rem>0?1:0); if(rem>0)rem--; return {t,c};});
      for(const sp of split){
        const ids=pool.slice(ptr, ptr+sp.c); ptr += sp.c;
        for(const part of chunkIds(ids, 1000)){
          if(!part.length) continue;
          const ph=part.map(()=>'?').join(',');
          if(wantRole==='client'){
            const agt=db.get('SELECT parent_id FROM users WHERE id=?',[sp.t]);
            const mgr=agt?db.get('SELECT parent_id FROM users WHERE id=?',[agt.parent_id]):null;
            db.runNoSave(`UPDATE numbers SET client_id=?, agent_id=?, manager_id=? WHERE id IN (${ph})`, [sp.t, agt?agt.parent_id:null, mgr?mgr.parent_id:null, ...part]);
          } else if(wantRole==='agent'){
            const mgr=db.get('SELECT parent_id FROM users WHERE id=?',[sp.t]);
            db.runNoSave(`UPDATE numbers SET agent_id=?, manager_id=?, client_id=NULL, payout='0', rate='', payterm=? WHERE id IN (${ph})`, [sp.t, mgr?mgr.parent_id:null, smartType, ...part]);
          } else {
            db.runNoSave(`UPDATE numbers SET manager_id=?, agent_id=NULL, client_id=NULL, payout='0', rate='' WHERE id IN (${ph})`, [sp.t, ...part]);
          }
          total += part.length;
          setJob(job,{processed:total,progress:planned?Math.floor(total/planned*100):100});
          await sleepImmediate();
        }
      }
      const rname=db.get('SELECT name FROM ranges WHERE id=?',[rid]);
      report.push({range:rname?rname.name:rid,taken:take,split});
    }
    db.save(); clearApiReadCache();
    auditJobAction(user,'smart_divide_numbers_background','numbers',{total,report,payterm:smartType});
    setJob(job,{status:'done',progress:100,total,processed:total,report,completed_at:new Date().toISOString(),message:'Completed'});
  }catch(e){
    setJob(job,{status:'failed',error:e.message||String(e),completed_at:new Date().toISOString(),message:'Failed'});
  }
}
function validateSmartDivideTargets(user,wantRole,target_ids){
  for (const tid of target_ids) {
    const t = db.get('SELECT * FROM users WHERE id=?', [tid]);
    if (!t || t.role !== wantRole || (user.role !== 'admin' && t.parent_id !== user.id)) return false;
    if (user.role==='admin' && wantRole==='manager') continue;
    if (user.role==='admin' && wantRole==='agent') continue;
  }
  return true;
}
app.get('/api/number-jobs/:jobId', authRequired, (req,res)=>{
  const job=numberJobs.get(req.params.jobId);
  if(!job) return res.status(404).json({error:'Number job not found'});
  if(job.user.id!==req.user.id && req.user.role!=='admin') return res.status(403).json({error:'Not allowed'});
  const {user, ...safe}=job;
  res.json(safe);
});

// smart divide: multi-range + multi-target, split UNALLOCATED evenly
app.post('/api/numbers/smart-divide', authRequired, async (req, res) => {
  const { range_ids, target_ids, qty, payterm, background } = req.body || {};
  if (!Array.isArray(range_ids) || !range_ids.length || !Array.isArray(target_ids) || !target_ids.length || !qty)
    return res.status(400).json({ error: 'range_ids[], target_ids[], qty required' });
  const cleanRangeIds=range_ids.map(x=>parseInt(x,10)).filter(x=>x>0);
  const cleanTargetIds=target_ids.map(x=>parseInt(x,10)).filter(x=>x>0);
  const cleanQty=Math.max(1, Math.min(parseInt(qty,10)||0, NUMBER_PAGE_MAX));
  const wantRole = { admin: 'manager', manager: 'agent', agent: 'client' }[req.user.role];
  if(!wantRole) return res.status(403).json({error:'Not allowed'});
  if(!validateSmartDivideTargets(req.user,wantRole,cleanTargetIds)) return res.status(403).json({ error: 'Invalid target(s)' });
  const estimated=cleanRangeIds.length*cleanQty;
  const shouldBackground = background !== false && estimated >= 1000;
  const job={job_id:makeNumberJobId(),type:'smart_divide',status:'queued',progress:0,processed:0,total:estimated,user:{id:req.user.id,username:req.user.username,role:req.user.role},range_ids:cleanRangeIds,target_ids:cleanTargetIds,qty:cleanQty,payterm:normalizePaymentType(payterm||'weekly'),created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  numberJobs.set(job.job_id, job);
  setImmediate(()=>performSmartDivideJob(job));
  if(shouldBackground){
    const {user,...safe}=job;
    return res.json({ok:true,background:true,job_id:job.job_id,job:safe,message:'Number allocation started in background'});
  }
  // Small jobs: wait for completion but still yield internally so event loop stays responsive.
  while(['queued','processing'].includes(job.status)) await new Promise(r=>setTimeout(r,50));
  if(job.status==='failed') return res.status(500).json({ok:false,error:job.error||'Job failed',job_id:job.job_id});
  res.json({ok:true,total:job.total||0,report:job.report||[],job_id:job.job_id});
});


/* ============ SMS RECORDS / CDR STATS ============ */
function buildSmsPagedQuery(user, q = {}) {
  const scope = smsScopeWhere(user, 's');
  const where = [scope.where, 'COALESCE(s.is_test,0)=0'];
  const params = [...scope.params];
  if (q.from) { const start = ukLocalDateToUtcSql(String(q.from), 0); if (start) { where.push('s.received_at >= ?'); params.push(start); } }
  if (q.to) { const end = ukLocalDateToUtcSql(String(q.to), 1); if (end) { where.push('s.received_at < ?'); params.push(end); } }
  if (q.range) { where.push('r.name=?'); params.push(String(q.range)); }
  if (q.range_id) { where.push('s.range_id=?'); params.push(+q.range_id); }
  if (q.number) { where.push('s.number=?'); params.push(String(q.number)); }
  if (q.cli) { where.push('s.cli=?'); params.push(String(q.cli)); }
  if (q.manager) { where.push('mu.username=?'); params.push(String(q.manager)); }
  if (q.agent) { where.push('au.username=?'); params.push(String(q.agent)); }
  if (q.client) { where.push('cu.username=?'); params.push(String(q.client)); }
  if (q.search) {
    const v = `%${String(q.search).trim()}%`;
    where.push(`(s.number LIKE ? OR s.cli LIKE ? OR s.message LIKE ? OR COALESCE(r.name,'') LIKE ? OR COALESCE(mu.username,'') LIKE ? OR COALESCE(au.username,'') LIKE ? OR COALESCE(cu.username,'') LIKE ?)`);
    params.push(v, v, v, v, v, v, v);
  }
  const baseSql = `FROM sms_records s
    LEFT JOIN ranges r ON r.id=s.range_id
    LEFT JOIN numbers n ON n.id=s.number_id
    LEFT JOIN users cu ON cu.id=s.client_id
    LEFT JOIN users au ON au.id=s.agent_id
    LEFT JOIN users mu ON mu.id=s.manager_id
    WHERE ${where.join(' AND ')}`;
  return { baseSql, params };
}
app.get('/api/sms/paged', authRequired, (req, res) => cachedJson(req, res, 1200, () => {
  const q = req.query || {};
  const built = buildSmsPagedQuery(req.user, q);
  const total = +(db.get(`SELECT COUNT(*) c ${built.baseSql}`, built.params)?.c || 0);
  const totalPayment = normalizeDecimalString(db.get(`SELECT COALESCE(SUM(CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)),0) p ${built.baseSql}`, built.params)?.p || '0') || '0';
  const limitRaw = String(q.limit || '25');
  const limit = limitRaw.toLowerCase() === 'all' ? Math.max(1, Math.min(total || 1, 10000)) : Math.max(1, Math.min(parseInt(limitRaw || '25', 10) || 25, 1000));
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, parseInt(q.page || '1', 10) || 1), totalPages);
  const offset = (page - 1) * limit;
  const sortMap = { date:'s.received_at', number:'s.number', cli:'s.cli', range:'r.name', manager:'mu.username', agent:'au.username', client:'cu.username', payout:'CAST(COALESCE(NULLIF(s.payout_amount,\'\'),\'0\') AS REAL)' };
  const sortCol = sortMap[q.sort] || 's.received_at';
  const dir = String(q.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const rows = db.all(`SELECT s.*, r.name AS range_name, r.rate_1_1, r.rate_7_1, r.rate_7_7, r.rate_30_45,
      n.rate AS number_rate, n.payout AS number_payout, n.payterm AS payterm, r.payment_type AS payment_type,
      cu.username AS client_name, au.username AS agent_name, mu.username AS manager_name
    ${built.baseSql}
    ORDER BY ${sortCol} ${dir}, s.id DESC LIMIT ? OFFSET ?`, [...built.params, limit, offset]);
  return { rows: attachSmsPayoutFields(rows), total, page, limit, totalPages, totalPayment };
}));
app.get('/api/stats-summary/:by', authRequired, (req, res) => cachedJson(req, res, 1500, () => {
  const by = req.params.by;
  const built = buildSmsPagedQuery(req.user, req.query || {});
  const groupMap = {
    client: { expr:'cu.username', label:'client_name' },
    agent: { expr:'au.username', label:'agent_name' },
    manager: { expr:'mu.username', label:'manager_name' },
    range: { expr:'r.name', label:'range_name' },
    number: { expr:'s.number', label:'number' },
    cli: { expr:'s.cli', label:'cli' }
  };
  const g = groupMap[by];
  if (!g) { res.status(400); return { error: 'Invalid stats dimension' }; }
  const extra = ['client','agent','manager'].includes(by) ? ` AND ${g.expr} IS NOT NULL AND ${g.expr}<>''` : '';
  const rows = db.all(`SELECT ${g.expr} AS key, COUNT(*) AS sms,
      COALESCE(SUM(CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)),0) AS payment
    ${built.baseSql}${extra}
    GROUP BY ${g.expr}
    HAVING key IS NOT NULL AND key<>''
    ORDER BY sms DESC, key ASC`, built.params).map(r => ({...r, payment: normalizeDecimalString(r.payment)||'0'}));
  const totalSms = rows.reduce((a,r)=>a+(+r.sms||0),0);
  const totalPayment = rows.reduce((a,r)=>decimalAdd(a,r.payment||'0'),'0');
  return { rows, totalSms, totalPayment, by };
}));
app.get('/api/sms', authRequired, (req, res) => {
  res.json(smsRowsForScope(req.user));
});

// aggregated stats by dimension
app.get('/api/stats/:by', authRequired, (req, res) => {
  const by = req.params.by; // client|agent|manager|range|number
  const rows = smsRowsForScope(req.user);
  const keyFn = {
    client: r => r.client_name, agent: r => r.agent_name, manager: r => r.manager_name,
    range: r => r.range_name, number: r => r.number
  }[by];
  const map = {};
  rows.forEach(r => {
    const rawKey = keyFn ? keyFn(r) : '';
    // For user status pages, do not assign manager-only SMS to Agent/Client rows,
    // and do not assign admin-only SMS to Manager rows.
    if (['client','agent','manager'].includes(by) && !rawKey) return;
    const k = rawKey || '—';
    if (!map[k]) map[k] = { key: k, sms: 0, payment: '0' };
    map[k].sms += 1;
    map[k].payment = decimalAdd(map[k].payment, r.payout_amount || r.payout_rate || '0');
  });
  const out = Object.values(map);
  res.json({ rows: out, totalSms: rows.length, totalPayment: sumPayout(rows) });
});


/* ============ CLI SEARCH & ANALYTICS ============ */
function cliSearchScope(user, alias='s') {
  if (!['admin','manager'].includes(user.role)) return null;
  const p = alias ? alias + '.' : '';
  if (user.role === 'manager') return { where: `${p}manager_id=?`, params: [user.id] };
  return { where: '1=1', params: [] };
}
function hasCustomDate(q){ return !!(q.from || q.to); }
function dateRangeWhere(q, alias='s') {
  const p = alias ? alias + '.' : '';
  const where=[]; const params=[];
  const dExpr=ukDateExpr(`${p}received_at`);
  if(q.from){ where.push(`${dExpr} >= date(?)`); params.push(q.from); }
  if(q.to){ where.push(`${dExpr} <= date(?)`); params.push(q.to); }
  return { where: where.length ? where.join(' AND ') : '1=1', params };
}
function cliBaseWhere(user, cli, q, alias='s') {
  const scope=cliSearchScope(user, alias);
  if(!scope) return null;
  const dr=dateRangeWhere(q, alias);
  const p=alias ? alias+'.' : '';
  const where=[scope.where, `${p}cli=?`, dr.where];
  return { where: where.join(' AND '), params:[...scope.params, cli, ...dr.params] };
}
app.get('/api/cli-search/suggestions', authRequired, requireRole('admin','manager'), (req,res)=>{
  const prefix=String(req.query.q||'').trim();
  if(!prefix) return res.json([]);
  const scope=cliSearchScope(req.user,'s');
  const rows=db.all(`SELECT s.cli AS cli, COUNT(*) AS count
    FROM sms_records s
    WHERE ${scope.where} AND s.cli IS NOT NULL AND s.cli<>'' AND s.cli LIKE ?
    GROUP BY s.cli
    ORDER BY count DESC, s.cli ASC
    LIMIT 20`, [...scope.params, prefix+'%']);
  res.json(rows);
});
app.get('/api/cli-search', authRequired, requireRole('admin','manager'), (req,res)=>{
  const cli=String(req.query.cli||'').trim();
  if(!cli) return res.status(400).json({error:'CLI is required'});
  const custom=hasCustomDate(req.query);
  const base=cliBaseWhere(req.user, cli, req.query, 's');
  if(!base) return res.status(403).json({error:'Forbidden'});
  const countWhere=(extra, extraParams=[]) => db.get(`SELECT COUNT(*) AS c FROM sms_records s WHERE ${base.where} ${extra?(' AND '+extra):''}`, [...base.params, ...extraParams])?.c||0;
  let summary;
  if(custom){
    summary={ selected_period: countWhere(''), from:req.query.from||'', to:req.query.to||'' };
  } else {
    summary={
      today: countWhere(`${ukDateExpr('s.received_at')}=${ukDateNowSql()}`),
      yesterday: countWhere(`${ukDateExpr('s.received_at')}=${ukDateNowSql('-1 day')}`),
      last7: countWhere(`${ukDateExpr('s.received_at')} >= ${ukDateNowSql('-6 days')}`),
      month: countWhere(`strftime('%Y-%m',${ukDateTimeExpr('s.received_at')})=strftime('%Y-%m',datetime('now','${ukSqlModifier()}'))`)
    };
  }
  let rangeRows;
  if(custom){
    rangeRows=db.all(`SELECT COALESCE(r.name,'Unknown') AS range_name, COUNT(*) AS total_count
      FROM sms_records s LEFT JOIN ranges r ON r.id=s.range_id
      WHERE ${base.where}
      GROUP BY s.range_id, r.name ORDER BY total_count DESC`, base.params);
  } else {
    rangeRows=db.all(`SELECT COALESCE(r.name,'Unknown') AS range_name,
      SUM(CASE WHEN ${ukDateExpr('s.received_at')}=${ukDateNowSql()} THEN 1 ELSE 0 END) AS today_count,
      SUM(CASE WHEN ${ukDateExpr('s.received_at')}=${ukDateNowSql('-1 day')} THEN 1 ELSE 0 END) AS yesterday_count
      FROM sms_records s LEFT JOIN ranges r ON r.id=s.range_id
      WHERE ${base.where}
      GROUP BY s.range_id, r.name ORDER BY today_count DESC, yesterday_count DESC`, base.params);
  }
  res.json({ cli, custom_date:custom, summary, ranges:rangeRows });
});

/* ============ DASHBOARD ============ */
function smsScopeWhere(user, alias = '') {
  const p = alias ? alias + '.' : '';
  if (user.role === 'manager') return { where: `${p}manager_id=?`, params: [user.id] };
  if (user.role === 'agent') return { where: `${p}agent_id=?`, params: [user.id] };
  if (user.role === 'client') return { where: `${p}client_id=?`, params: [user.id] };
  return { where: '1=1', params: [] };
}
function numberScopeWhere(user, alias = '') {
  const p = alias ? alias + '.' : '';
  if (user.role === 'manager') return { where: `${p}manager_id=?`, params: [user.id] };
  if (user.role === 'agent') return { where: `${p}agent_id=?`, params: [user.id] };
  if (user.role === 'client') return { where: `${p}client_id=?`, params: [user.id] };
  return { where: '1=1', params: [] };
}
app.get('/api/dashboard', authRequired, (req, res) => cachedJson(req, res, 2500, () => {
  const u = req.user;
  const smsScope = smsScopeWhere(u);
  const numScope = numberScopeWhere(u);
  const dExpr = ukDateExpr('received_at');
  const sDExpr = ukDateExpr('s.received_at');
  const dtExpr = ukDateTimeExpr('received_at');
  const normalSms = 'COALESCE(is_test,0)=0';
  const today = db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${smsScope.where} AND ${normalSms} AND ${dExpr}=${ukDateNowSql()}`, smsScope.params)?.c || 0;
  const yesterday = db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${smsScope.where} AND ${normalSms} AND ${dExpr}=${ukDateNowSql('-1 day')}`, smsScope.params)?.c || 0;
  const d7 = db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${smsScope.where} AND ${normalSms} AND ${dExpr} >= ${ukDateNowSql('-6 days')}`, smsScope.params)?.c || 0;
  const month = db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${smsScope.where} AND ${normalSms} AND strftime('%Y-%m',${dtExpr})=strftime('%Y-%m',datetime('now','${ukSqlModifier()}'))`, smsScope.params)?.c || 0;
  const numbers = db.get(`SELECT COUNT(*) c FROM numbers WHERE ${numScope.where}`, numScope.params)?.c || 0;
  const managers = u.role === 'admin' ? (db.get(`SELECT COUNT(*) c FROM users WHERE role='manager'`)?.c || 0) : 0;
  let agents = 0, clients = 0;
  if (u.role === 'admin') {
    agents = db.get(`SELECT COUNT(*) c FROM users WHERE role='agent'`)?.c || 0;
    clients = db.get(`SELECT COUNT(*) c FROM users WHERE role='client'`)?.c || 0;
  } else if (u.role === 'manager') {
    agents = db.get(`SELECT COUNT(*) c FROM users WHERE role='agent' AND parent_id=?`, [u.id])?.c || 0;
    const ags = db.all(`SELECT id FROM users WHERE role='agent' AND parent_id=?`, [u.id]).map(x => x.id);
    if (ags.length) {
      const ph = ags.map(() => '?').join(',');
      clients = db.get(`SELECT COUNT(*) c FROM users WHERE role='client' AND parent_id IN (${ph})`, ags)?.c || 0;
    }
  } else if (u.role === 'agent') {
    clients = db.get(`SELECT COUNT(*) c FROM users WHERE role='client' AND parent_id=?`, [u.id])?.c || 0;
  }
  const payout7 = normalizeDecimalString(db.get(`SELECT COALESCE(SUM(CAST(COALESCE(NULLIF(payout_amount,''),'0') AS REAL)),0) p FROM sms_records WHERE ${smsScope.where} AND ${normalSms} AND ${dExpr} >= ${ukDateNowSql('-6 days')}`, smsScope.params)?.p || '0') || '0';
  const payoutMonth = normalizeDecimalString(db.get(`SELECT COALESCE(SUM(CAST(COALESCE(NULLIF(payout_amount,''),'0') AS REAL)),0) p FROM sms_records WHERE ${smsScope.where} AND ${normalSms} AND strftime('%Y-%m',${dtExpr})=strftime('%Y-%m',datetime('now','${ukSqlModifier()}'))`, smsScope.params)?.p || '0') || '0';
  const daily7 = [];
  for (let i = 6; i >= 0; i--) {
    const r = db.get(`SELECT ${ukDateNowSql('-'+i+' days')} d, COUNT(*) c FROM sms_records WHERE ${smsScope.where} AND ${normalSms} AND ${dExpr}=${ukDateNowSql('-'+i+' days')}`, smsScope.params);
    daily7.push({ date: r?.d || '', count: r?.c || 0 });
  }
  const recentRows = db.all(`SELECT s.*, r.name AS range_name, r.rate_1_1, r.rate_7_1, r.rate_7_7, r.rate_30_45, n.rate AS number_rate, n.payout AS number_payout, n.payterm AS payterm, r.payment_type AS payment_type
    FROM sms_records s
    LEFT JOIN numbers n ON n.id=s.number_id
    LEFT JOIN ranges r ON r.id=s.range_id
    WHERE ${smsScopeWhere(u,'s').where} AND COALESCE(s.is_test,0)=0
    ORDER BY s.received_at DESC, s.id DESC LIMIT 5`, smsScopeWhere(u,'s').params);
  const recent = attachSmsPayoutFields(recentRows).map(r=>({received_at:r.received_at,number:r.number,cli:r.cli,message:r.message,range_name:r.range_name,payout_rate:r.payout_rate}));
  return { sms_today: today, sms_yesterday: yesterday, sms_7d: d7, sms_month: month, payout_7d: payout7, payout_month: payoutMonth, managers, agents, clients, numbers, daily7, recent };
}));


/* ============ NUMBER IMPORT (Admin only, background/batched) ============ */
function makeImportJobId(){return 'IMPORT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,8).toUpperCase();}
function normalizeNumberForImport(n){return String(n||'').trim();}
function getOrCreateRange(range_id, range_name, prefix, firstNumber){
  if(range_id) return +range_id;
  if(!range_name) throw new Error('range_id or range_name is required');
  const existing=db.get('SELECT id FROM ranges WHERE name=?',[range_name]);
  if(existing) return existing.id;
  db.run(`INSERT INTO ranges (name,prefix,test_number,currency) VALUES (?,?,?,?)`,[range_name,prefix||'', '', 'USD']);
  return db.get('SELECT id FROM ranges WHERE name=? ORDER BY id DESC LIMIT 1',[range_name]).id;
}
async function processNumberImportJob(jobId, payload, user){
  console.log('[IMPORT] started', { jobId, total: (payload.numbers||[]).length, range_name: payload.range_name || '', file_name: payload.file_name || '' });
  const job=importJobs.get(jobId);
  if(!job) return;
  try{
    const { range_id, range_name, prefix, numbers, payterm, payout, file_name } = payload;
    const rid=getOrCreateRange(range_id, range_name, prefix, numbers[0]);
    const range=db.get('SELECT name FROM ranges WHERE id=?',[rid]);
    db.run(`INSERT INTO number_import_batches (batch_id,range_id,range_name,file_name,total,status,created_by) VALUES (?,?,?,?,?,?,?)`,
      [jobId,rid,range?range.name:(range_name||''),file_name||'',numbers.length,'processing',user.id]);
    const batchSize=parseInt(process.env.IMPORT_BATCH_SIZE||'1000',10);
    let inserted=0, skipped=0, processed=0;
    for(let i=0;i<numbers.length;i+=batchSize){
      const chunk=numbers.slice(i,i+batchSize);
      db.execNoSave('BEGIN TRANSACTION');
      try{
        for(const raw of chunk){
          const number=normalizeNumberForImport(raw);
          processed++;
          if(!number){skipped++; continue;}
          if(db.get('SELECT id FROM numbers WHERE number=?',[number])){skipped++; continue;}
          db.runNoSave(`INSERT INTO numbers (range_id,number,prefix,payterm,payout,import_batch_id,import_source,imported_by,imported_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
            [rid,number,prefix||'',payterm||'Weekly',payout||'0',jobId,'file',user.id]);
          inserted++;
        }
        db.execNoSave('COMMIT');
        db.save();
      }catch(e){
        try{db.execNoSave('ROLLBACK');}catch(_){}
        throw e;
      }
      job.processed=processed; job.inserted=inserted; job.skipped=skipped; job.progress=Math.round((processed/numbers.length)*100);
      db.run(`UPDATE number_import_batches SET inserted=?, skipped=? WHERE batch_id=?`,[inserted,skipped,jobId]);
      await new Promise(r=>setTimeout(r,0));
    }
    job.status='done'; job.progress=100; job.completed_at=new Date().toISOString();
    console.log('[IMPORT] completed', { jobId, inserted, skipped, total: numbers.length });
    db.run(`UPDATE number_import_batches SET inserted=?, skipped=?, status='done', completed_at=datetime('now') WHERE batch_id=?`,[inserted,skipped,jobId]);
    logAction({user},'import_numbers_background','numbers',{jobId,inserted,skipped,range_id:rid});
  }catch(e){
    job.status='failed'; job.error=e.message;
    console.error('[IMPORT] failed', { jobId, error: e.message });
    db.run(`UPDATE number_import_batches SET status='failed', error=?, completed_at=datetime('now') WHERE batch_id=?`,[e.message,jobId]);
  }
}
app.post('/api/numbers/import', authRequired, requireRole('admin'), (req, res) => {
  const { range_id, range_name, prefix, numbers, payterm, payout, file_name } = req.body || {};
  if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: 'numbers[] required' });
  const jobId=makeImportJobId();
  const job={job_id:jobId,status:'queued',total:numbers.length,processed:0,inserted:0,skipped:0,progress:0,error:'',created_at:new Date().toISOString()};
  importJobs.set(jobId,job);
  setImmediate(()=>processNumberImportJob(jobId,{range_id,range_name,prefix,numbers,payterm,payout,file_name},req.user));
  res.json({ok:true,background:true,job});
});
app.get('/api/numbers/import-jobs/:jobId', authRequired, requireRole('admin'), (req,res)=>{
  const job=importJobs.get(req.params.jobId);
  if(job) return res.json(job);
  const b=db.get('SELECT * FROM number_import_batches WHERE batch_id=?',[req.params.jobId]);
  if(!b) return res.status(404).json({error:'Import job not found'});
  res.json({job_id:b.batch_id,status:b.status,total:b.total,processed:b.inserted+b.skipped,inserted:b.inserted,skipped:b.skipped,progress:b.status==='done'?100:0,error:b.error,created_at:b.created_at,completed_at:b.completed_at});
});
app.get('/api/number-import-batches', authRequired, requireRole('admin'), (req,res)=>{
  const includeDeleted = String(req.query.include_deleted || '').toLowerCase() === '1' || String(req.query.include_deleted || '').toLowerCase() === 'true';
  const where = includeDeleted ? '1=1' : `status<>'deleted'`;
  res.json(db.all(`SELECT * FROM number_import_batches WHERE ${where} ORDER BY id DESC LIMIT 200`));
});
app.delete('/api/number-import-batches/:batchId', authRequired, requireRole('admin'), (req,res)=>{
  const batchId=req.params.batchId;
  const result = deleteNumbersWhere('import_batch_id=?', [batchId], req, 'delete_import_batch', { batchId }, truthy(req.query.delete_sms));
  db.run(`UPDATE number_import_batches SET status='deleted', deleted_at=datetime('now') WHERE batch_id=?`,[batchId]);
  res.json({ok:true,...result});
});
app.delete('/api/numbers/imported-all', authRequired, requireRole('admin'), (req,res)=>{
  const result = deleteNumbersWhere(`import_source='file' OR import_batch_id<>''`, [], req, 'delete_all_imported_numbers', {}, truthy(req.query.delete_sms));
  db.run(`UPDATE number_import_batches SET status='deleted', deleted_at=datetime('now') WHERE status<>'deleted'`);
  res.json({ok:true,...result});
});

/* ============ PAYMENTS ============ */


/* ============ PAYMENT V2 (separate payment system) ============ */
function paymentTypesSettings(){ return db.all('SELECT * FROM payment_v2_settings WHERE active=1 ORDER BY sort_order ASC').map(r=>({payment_type:r.payment_type,label:r.label,min_withdrawal:normalizeDecimalString(r.min_withdrawal)||'0'})); }
function agentPaymentSummary(agentId){
  return paymentTypesSettings().map(t=>{
    const available=paymentOpenBalance(agentId,t.payment_type,true), pending=paymentPendingAmount(agentId,t.payment_type), minimum=t.min_withdrawal;
    return {...t, available_balance:available, pending_amount:pending, minimum, can_request:cents(available)>=cents(minimum) && cents(available)>0 && cents(pending)===0};
  });
}
app.get('/api/payment-v2/settings', authRequired, requireRole('admin'), (req,res)=>res.json(paymentTypesSettings()));
app.put('/api/payment-v2/settings', authRequired, requireRole('admin'), (req,res)=>{
  const rows=Array.isArray(req.body?.settings)?req.body.settings:[];
  rows.forEach(r=>{ const t=normalizePaymentType(r.payment_type); db.run('UPDATE payment_v2_settings SET min_withdrawal=?, updated_at=datetime(\'now\') WHERE payment_type=?',[normalizeDecimalString(r.min_withdrawal)||'0',t]); paymentAudit(req,'update_minimum',{payment_type:t,amount:r.min_withdrawal,status:'settings'}); });
  res.json({ok:true,settings:paymentTypesSettings()});
});
app.get('/api/payment-v2/agent/summary', authRequired, requireRole('agent'), (req,res)=>res.json({agent_id:req.user.id, balances:agentPaymentSummary(req.user.id), wallet:db.get('SELECT * FROM agent_wallets WHERE agent_id=?',[req.user.id])||{wallet_address:'',network:'USDT_TRC20'}}));
app.get('/api/payment-v2/agent/wallet', authRequired, requireRole('agent'), (req,res)=>res.json(db.get('SELECT * FROM agent_wallets WHERE agent_id=?',[req.user.id])||{wallet_address:'',network:'USDT_TRC20'}));
app.put('/api/payment-v2/agent/wallet', authRequired, requireRole('agent'), (req,res)=>{
  const wallet=String(req.body?.wallet_address||'').trim(); if(!walletValid(wallet)) return res.status(400).json({error:'Invalid USDT TRC20 wallet. It should start with T and be 34 characters.'});
  const ex=db.get('SELECT agent_id FROM agent_wallets WHERE agent_id=?',[req.user.id]);
  if(ex) db.run('UPDATE agent_wallets SET wallet_address=?,network=\'USDT_TRC20\',updated_at=datetime(\'now\') WHERE agent_id=?',[wallet,req.user.id]);
  else db.run('INSERT INTO agent_wallets (agent_id,wallet_address,network) VALUES (?,?,\'USDT_TRC20\')',[req.user.id,wallet]);
  paymentAudit(req,'update_wallet',{agent_id:req.user.id,wallet_address:wallet,status:'saved'});
  res.json({ok:true,wallet_address:wallet,network:'USDT_TRC20'});
});
app.post('/api/payment-v2/agent/request', authRequired, requireRole('agent'), (req,res)=>{
  const type=normalizePaymentType(req.body?.payment_type); const wallet=db.get('SELECT * FROM agent_wallets WHERE agent_id=?',[req.user.id]);
  if(!wallet || !walletValid(wallet.wallet_address)) return res.status(400).json({error:'Save a valid USDT (TRC20) wallet first.'});
  if(db.get("SELECT id FROM payment_requests_v2 WHERE agent_id=? AND payment_type=? AND status='Pending'",[req.user.id,type])) return res.status(409).json({error:'A pending request already exists for this payment type.'});
  const amount=paymentOpenBalance(req.user.id,type,true); const min=paymentMinimum(type); if(cents(amount)<=0 || cents(amount)<cents(min)) return res.status(400).json({error:`Minimum withdrawal not reached. Available ${amount}, minimum ${min}.`});
  const rows=db.all("SELECT id FROM payment_ledger WHERE agent_id=? AND payment_type=? AND status='open' AND eligible_at<=?",[req.user.id,type,utcSqlFromMs(Date.now())]); if(!rows.length) return res.status(400).json({error:'No eligible balance found.'});
  try{ db.execNoSave('BEGIN');
    const ins=db.runNoSave(`INSERT INTO payment_requests_v2 (agent_id,manager_id,payment_type,amount,wallet_address,status) VALUES (?,?,?,?,?,'Pending')`,[req.user.id,agentManagerId(req.user.id),type,amount,wallet.wallet_address]);
    const ph=rows.map(()=>'?').join(','); db.runNoSave(`UPDATE payment_ledger SET status='requested',request_id=? WHERE id IN (${ph})`,[ins.lastInsertRowid,...rows.map(r=>r.id)]);
    db.execNoSave('COMMIT'); db.save(); paymentNotify(req.user.id,ins.lastInsertRowid,'submitted',`${paymentTypeLabel(type)} payment request submitted: $${amount}`); paymentAudit(req,'request_submitted',{request_id:ins.lastInsertRowid,agent_id:req.user.id,manager_id:agentManagerId(req.user.id),payment_type:type,amount,wallet_address:wallet.wallet_address,status:'Pending'}); res.json({ok:true,id:ins.lastInsertRowid,amount,status:'Pending'});
  }catch(e){ try{db.execNoSave('ROLLBACK')}catch(_){} res.status(500).json({error:e.message}); }
});
app.get('/api/payment-v2/agent/requests', authRequired, requireRole('agent'), (req,res)=>res.json(db.all('SELECT * FROM payment_requests_v2 WHERE agent_id=? ORDER BY id DESC LIMIT 300',[req.user.id])));
app.get('/api/payment-v2/agent/notifications', authRequired, requireRole('agent'), (req,res)=>res.json(db.all('SELECT * FROM payment_notifications_v2 WHERE agent_id=? ORDER BY id DESC LIMIT 100',[req.user.id])));
app.post('/api/payment-v2/agent/notifications/read-all', authRequired, requireRole('agent'), (req,res)=>{db.run("UPDATE payment_notifications_v2 SET read_at=datetime('now') WHERE agent_id=? AND read_at IS NULL",[req.user.id]);res.json({ok:true});});
app.get('/api/payment-v2/manager/agents', authRequired, requireRole('manager'), (req,res)=>{
  const agents=db.all("SELECT id,username,name FROM users WHERE role='agent' AND parent_id=? ORDER BY username COLLATE NOCASE",[req.user.id]);
  res.json(agents.map(a=>({agent_id:a.id,agent_name:a.username,name:a.name||'',balances:agentPaymentSummary(a.id),payment_status:db.get("SELECT status FROM payment_requests_v2 WHERE agent_id=? ORDER BY id DESC LIMIT 1",[a.id])?.status||'No Request'})));
});
app.get('/api/payment-v2/admin/summary', authRequired, requireRole('admin'), (req,res)=>{
  const pending=db.get("SELECT COUNT(*) c, COALESCE(SUM(CAST(amount AS REAL)),0) a FROM payment_requests_v2 WHERE status='Pending'");
  const paid=db.get("SELECT COUNT(*) c, COALESCE(SUM(CAST(amount AS REAL)),0) a FROM payment_requests_v2 WHERE status='Paid'");
  res.json({pending_count:pending?.c||0,pending_amount:normalizeDecimalString(pending?.a||0),paid_count:paid?.c||0,paid_amount:normalizeDecimalString(paid?.a||0),settings:paymentTypesSettings()});
});
app.get('/api/payment-v2/admin/requests', authRequired, requireRole('admin'), (req,res)=>{
  const status=req.query.status?String(req.query.status):''; const where=status?'WHERE pr.status=?':''; const params=status?[status]:[];
  const rows=db.all(`SELECT pr.*, au.username AS agent_name, au.name AS agent_full_name, mu.username AS manager_name, admin.username AS processed_by_name FROM payment_requests_v2 pr JOIN users au ON au.id=pr.agent_id LEFT JOIN users mu ON mu.id=pr.manager_id LEFT JOIN users admin ON admin.id=pr.processed_by ${where} ORDER BY pr.id DESC LIMIT 500`,params);
  res.json(rows.map(r=>({...r,payment_label:paymentTypeLabel(r.payment_type)})));
});
app.post('/api/payment-v2/admin/requests/:id/reject', authRequired, requireRole('admin'), (req,res)=>{
  const id=+req.params.id; const r=db.get("SELECT * FROM payment_requests_v2 WHERE id=? AND status='Pending'",[id]); if(!r)return res.status(404).json({error:'Pending request not found'});
  try{db.execNoSave('BEGIN'); db.runNoSave("UPDATE payment_requests_v2 SET status='Rejected',reject_reason=?,processed_by=?,rejected_at=datetime('now'),admin_notes=? WHERE id=?",[req.body?.reason||'',req.user.id,req.body?.notes||'',id]); db.runNoSave("UPDATE payment_ledger SET status='open',request_id=NULL WHERE request_id=?",[id]); db.execNoSave('COMMIT'); db.save(); paymentNotify(r.agent_id,id,'rejected',`${paymentTypeLabel(r.payment_type)} payment request rejected.`); paymentAudit(req,'request_rejected',{request_id:id,agent_id:r.agent_id,manager_id:r.manager_id,payment_type:r.payment_type,amount:r.amount,wallet_address:r.wallet_address,status:'Rejected',details:{reason:req.body?.reason||''}}); res.json({ok:true});}catch(e){try{db.execNoSave('ROLLBACK')}catch(_){} res.status(500).json({error:e.message});}
});
app.post('/api/payment-v2/admin/requests/:id/pay', authRequired, requireRole('admin'), upload.single('screenshot'), (req,res)=>{
  const id=+req.params.id; const r=db.get("SELECT * FROM payment_requests_v2 WHERE id=? AND status='Pending'",[id]); if(!r)return res.status(404).json({error:'Pending request not found'});
  let screenshotUrl=''; if(req.file&&req.file.buffer){ const dir=path.join(FRONTEND_ROOT,'uploads','payment-screenshots'); fs.mkdirSync(dir,{recursive:true}); const ext=(path.extname(req.file.originalname||'')||'.png').toLowerCase(); const file=`payment-${id}-${Date.now()}${ext}`; fs.writeFileSync(path.join(dir,file),req.file.buffer); screenshotUrl='/uploads/payment-screenshots/'+file; }
  try{db.execNoSave('BEGIN'); db.runNoSave("UPDATE payment_requests_v2 SET status='Paid',processed_by=?,paid_at=datetime('now'),txid=?,screenshot_url=?,admin_notes=? WHERE id=?",[req.user.id,req.body?.txid||'',screenshotUrl,req.body?.notes||'',id]); db.runNoSave("UPDATE payment_ledger SET status='paid' WHERE request_id=?",[id]); db.execNoSave('COMMIT'); db.save(); paymentNotify(r.agent_id,id,'paid',`${paymentTypeLabel(r.payment_type)} payment sent: $${r.amount}`); paymentAudit(req,'payment_sent',{request_id:id,agent_id:r.agent_id,manager_id:r.manager_id,payment_type:r.payment_type,amount:r.amount,wallet_address:r.wallet_address,status:'Paid',details:{txid:req.body?.txid||'',screenshot_url:screenshotUrl,notes:req.body?.notes||''}}); res.json({ok:true,screenshot_url:screenshotUrl});}catch(e){try{db.execNoSave('ROLLBACK')}catch(_){} res.status(500).json({error:e.message});}
});
app.get('/api/payment-v2/admin/audit-logs', authRequired, requireRole('admin'), (req,res)=>res.json(db.all('SELECT * FROM payment_audit_logs ORDER BY id DESC LIMIT 1000')));



/* ============ LIMIT MANAGEMENT (Admin only, payout-zero after daily UK limits) ============ */
function dailyLimitUsage(row){
  if(!row || !row.limit_type) return 0;
  if(row.limit_type==='range') return countTodayUk('s.range_id=?', [row.range_id]);
  if(row.limit_type==='range_number') return 0;
  if(row.limit_type==='number') return countTodayUk(`REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')=?`, [cleanPhone(row.number)]);
  if(row.limit_type==='cli') return countTodayUk('LOWER(s.cli)=LOWER(?)', [row.cli||'']);
  return 0;
}
function paidToday(whereSql, params=[]){ return db.get(`SELECT COUNT(*) c FROM sms_records s WHERE COALESCE(s.is_test,0)=0 AND ${ukDateExpr('s.received_at')}=${ukDateNowSql()} AND CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)>0 AND ${whereSql}`, params)?.c||0; }
function zeroedToday(whereSql, params=[]){ return db.get(`SELECT COUNT(*) c FROM sms_records s WHERE COALESCE(s.is_test,0)=0 AND ${ukDateExpr('s.received_at')}=${ukDateNowSql()} AND CAST(COALESCE(NULLIF(s.payout_amount,''),'0') AS REAL)=0 AND ${whereSql}`, params)?.c||0; }
function oneLimit(type, where, params=[]){ return db.get(`SELECT * FROM daily_limit_rules WHERE active=1 AND limit_type=? AND ${where} ORDER BY id DESC LIMIT 1`, [type, ...params]); }
app.get('/api/limit-management', authRequired, requireRole('admin'), (req,res)=>{
  const rows=db.all(`SELECT l.*, r.name AS range_name FROM daily_limit_rules l LEFT JOIN ranges r ON r.id=l.range_id ORDER BY l.id DESC`);
  res.json(rows.map(r=>{ const used=dailyLimitUsage(r); const limit=Number(r.daily_limit||0); return {...r, used_today:used, remaining_today:Math.max(0,limit-used), reporting_timezone:'Europe/London'}; }));
});
app.get('/api/limit-management/overview', authRequired, requireRole('admin'), (req,res)=>{
  const ranges=db.all('SELECT id,name FROM ranges ORDER BY name ASC').map(r=>{
    const rangeRule=oneLimit('range','range_id=?',[r.id]);
    const perRule=oneLimit('range_number','range_id=?',[r.id]);
    const where='s.range_id=?', params=[r.id];
    const today=countTodayUk(where,params);
    return {range_id:r.id,range_name:r.name,daily_limit:rangeRule?Number(rangeRule.daily_limit||0):0,per_number_limit:perRule?Number(perRule.daily_limit||0):0,today_otps:today,paid:paidToday(where,params),zeroed:zeroedToday(where,params)};
  });
  const cliSet=new Set();
  db.all("SELECT DISTINCT cli FROM sms_records WHERE cli IS NOT NULL AND cli<>'' ORDER BY cli ASC LIMIT 5000").forEach(x=>cliSet.add(String(x.cli)));
  db.all("SELECT cli FROM daily_limit_rules WHERE limit_type='cli' AND cli<>''").forEach(x=>cliSet.add(String(x.cli)));
  const clis=[...cliSet].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).map(cli=>{
    const rule=oneLimit('cli','LOWER(cli)=LOWER(?)',[cli]);
    const where='LOWER(s.cli)=LOWER(?)', params=[cli];
    const today=countTodayUk(where,params);
    return {cli,daily_limit:rule?Number(rule.daily_limit||0):0,today_otps:today,paid:paidToday(where,params),zeroed:zeroedToday(where,params)};
  });
  res.json({reporting_timezone:'Europe/London',ranges,clis});
});
app.post('/api/limit-management', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const type=String(b.limit_type||'').toLowerCase();
  const dailyLimit=Math.max(1, parseInt(b.daily_limit||0,10));
  if(!['range','number','cli'].includes(type)) return res.status(400).json({error:'limit_type must be range, number, or cli'});
  if(!dailyLimit) return res.status(400).json({error:'daily_limit required'});
  let rangeId=null, cli='', number='';
  if(type==='range'){
    rangeId=parseInt(b.range_id||0,10); if(!rangeId) return res.status(400).json({error:'range_id required'});
    if(!db.get('SELECT id FROM ranges WHERE id=?',[rangeId])) return res.status(404).json({error:'Range not found'});
    db.run("DELETE FROM daily_limit_rules WHERE limit_type='range' AND range_id=?",[rangeId]);
  } else if(type==='cli'){
    cli=String(b.cli||'').trim(); if(!cli) return res.status(400).json({error:'cli required'});
    db.run("DELETE FROM daily_limit_rules WHERE limit_type='cli' AND LOWER(cli)=LOWER(?)",[cli]);
  } else if(type==='number'){
    number=String(b.number||'').trim(); if(!number) return res.status(400).json({error:'number required'});
    db.run("DELETE FROM daily_limit_rules WHERE limit_type='number' AND REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?",[cleanPhone(number)]);
  }
  db.run(`INSERT INTO daily_limit_rules (limit_type,range_id,cli,number,daily_limit,active) VALUES (?,?,?,?,?,1)`,[type,rangeId,cli,number,dailyLimit]);
  logAction(req,'set_daily_limit','limit_management',{type,rangeId,cli,number,dailyLimit});
  res.json({ok:true});
});
app.post('/api/limit-management/range', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const rangeId=parseInt(b.range_id||0,10);
  if(!rangeId) return res.status(400).json({error:'range_id required'});
  if(!db.get('SELECT id FROM ranges WHERE id=?',[rangeId])) return res.status(404).json({error:'Range not found'});
  const daily=Math.max(0,parseInt(b.daily_limit||0,10));
  const per=Math.max(0,parseInt(b.per_number_limit||0,10));
  db.run("DELETE FROM daily_limit_rules WHERE limit_type IN ('range','range_number') AND range_id=?",[rangeId]);
  if(daily>0) db.run(`INSERT INTO daily_limit_rules (limit_type,range_id,daily_limit,active) VALUES ('range',?,?,1)`,[rangeId,daily]);
  if(per>0) db.run(`INSERT INTO daily_limit_rules (limit_type,range_id,daily_limit,active) VALUES ('range_number',?,?,1)`,[rangeId,per]);
  logAction(req,'save_range_daily_limits','limit_management',{rangeId,daily,per});
  res.json({ok:true});
});
app.post('/api/limit-management/cli', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const cli=String(b.cli||'').trim();
  const daily=Math.max(0,parseInt(b.daily_limit||0,10));
  if(!cli) return res.status(400).json({error:'cli required'});
  db.run("DELETE FROM daily_limit_rules WHERE limit_type='cli' AND LOWER(cli)=LOWER(?)",[cli]);
  if(daily>0) db.run(`INSERT INTO daily_limit_rules (limit_type,cli,daily_limit,active) VALUES ('cli',?,?,1)`,[cli,daily]);
  logAction(req,'save_cli_daily_limit','limit_management',{cli,daily});
  res.json({ok:true});
});
app.delete('/api/limit-management/:id', authRequired, requireRole('admin'), (req,res)=>{
  const id=+req.params.id;
  db.run('DELETE FROM daily_limit_rules WHERE id=?',[id]);
  logAction(req,'delete_daily_limit','limit_management',{id});
  res.json({ok:true});
});



/* ============ CARRIER INTEGRATION SETTINGS ============ */
function getCarrierSettings(){
  let row = db.get('SELECT * FROM carrier_settings ORDER BY id ASC LIMIT 1');
  if(!row){
    db.run(`INSERT INTO carrier_settings (integration_status,carrier_ip,http_callback_url,notes) VALUES ('disabled','','/api/incoming-sms','HTTP integration ready')`);
    row = db.get('SELECT * FROM carrier_settings ORDER BY id ASC LIMIT 1');
  }
  return row;
}
function publicCallbackUrl(req){
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:4000';
  return `${proto}://${host}/api/incoming-sms`;
}
function cleanIp(ip){ return String(ip||'').replace(/^::ffff:/,'').replace(/^::1$/,'127.0.0.1').trim(); }
function getClientIp(req){
  const cf = req.headers['cf-connecting-ip'];
  const xr = req.headers['x-real-ip'];
  const xf = req.headers['x-forwarded-for'];
  const raw = cf || xr || (xf ? String(xf).split(',')[0].trim() : '') || req.ip || req.socket?.remoteAddress || '';
  return cleanIp(raw);
}
function carrierIpAllowed(config, ip){
  const allowed = String(config.carrier_ip||'').split(/[\s,;]+/).map(cleanIp).filter(Boolean);
  return allowed.includes(cleanIp(ip));
}
function cleanupWebhookLogs(days){
  const d = Math.max(1, parseInt(days || 30));
  db.run(`DELETE FROM webhook_logs WHERE datetime(created_at) < datetime('now','-${d} days')`);
}
function getCarrierLockPassword(){
  let row = db.get('SELECT * FROM system_security ORDER BY id ASC LIMIT 1');
  if(!row){ db.run("INSERT INTO system_security (admin_security_code,carrier_lock_password) VALUES ('Dawood','Dawood')"); row=db.get('SELECT * FROM system_security ORDER BY id ASC LIMIT 1'); }
  return row.carrier_lock_password || process.env.CARRIER_LOCK_PASSWORD || 'Dawood';
}
function carrierLockPassword(){ return getCarrierLockPassword(); }
function carrierLockOk(req){
  const q = req.query || {};
  const b = req.body || {};
  const provided = req.headers['x-carrier-lock'] || q.carrier_lock || q.carrier_lock_password || b.carrier_lock || b.carrier_lock_password || '';
  return String(provided) === carrierLockPassword();
}
function requireCarrierLock(req, res){
  if (carrierLockOk(req)) return true;
  res.status(423).json({ error: 'Carrier Integration is locked', locked: true });
  return false;
}
function carrierRuntimeStatus(){
  const lastSuccess = db.get(`SELECT created_at, source_ip FROM webhook_logs WHERE status='success' ORDER BY id DESC LIMIT 1`);
  const last = db.get(`SELECT * FROM webhook_logs ORDER BY id DESC LIMIT 1`);
  let lastStatus = 'NO REQUESTS';
  if(last){
    if(last.status === 'success') lastStatus = 'SUCCESS';
    else if((last.error||'').includes('IP not allowed')) lastStatus = 'REJECTED (IP NOT ALLOWED)';
    else if((last.error||'').includes('disabled')) lastStatus = 'INTEGRATION DISABLED';
    else if((last.error||'').includes('number/to')) lastStatus = 'INVALID PAYLOAD';
    else lastStatus = 'FAILED';
  }
  return {
    last_sms_received: lastSuccess ? lastSuccess.created_at : '',
    last_success_ip: lastSuccess ? (lastSuccess.source_ip || '') : '',
    last_carrier_ip: last ? (last.source_ip || '') : '',
    last_request_status: lastStatus,
    last_error: last ? (last.error || '') : ''
  };
}
app.get('/api/carrier-settings', authRequired, requireRole('admin'), (req,res)=>{
  if (!requireCarrierLock(req, res)) return;
  const c=getCarrierSettings();
  res.json({ ...c, ...carrierRuntimeStatus(), integration_mode: 'HTTP', generated_callback_url: publicCallbackUrl(req), endpoint_path:'/api/incoming-sms' });
});
app.put('/api/carrier-settings', authRequired, requireRole('admin'), (req,res)=>{
  if (!requireCarrierLock(req, res)) return;
  const b=req.body||{};
  const c=getCarrierSettings();
  db.run(`UPDATE carrier_settings SET integration_status=?,carrier_ip=?,http_callback_url=?,api_key=?,auth_token=?,notes=?,retention_days=?,updated_at=datetime('now') WHERE id=?`,
    [b.integration_status==='enabled'?'enabled':'disabled', b.carrier_ip||'', b.http_callback_url||'/api/incoming-sms', b.api_key||'', b.auth_token||'', b.notes||'', parseInt(b.retention_days||30), c.id]);
  cleanupWebhookLogs(b.retention_days||30);
  logAction(req,'update_carrier_settings','carrier_integration',{carrier_ip:b.carrier_ip,status:b.integration_status,mode:'HTTP_ONLY'});
  res.json({ ok:true, settings:{...getCarrierSettings(), ...carrierRuntimeStatus()}, generated_callback_url: publicCallbackUrl(req) });
});




app.post('/api/carrier-test', authRequired, requireRole('admin'), (req,res)=>{
  if (!requireCarrierLock(req, res)) return;
  const c=getCarrierSettings();
  const callback = publicCallbackUrl(req);
  logAction(req,'test_carrier_endpoint','carrier_integration',{callback,status:c.integration_status,carrier_ip:c.carrier_ip});
  res.json({ ok:true, reachable:true, endpoint:callback, integration_status:c.integration_status, allowed_ips:String(c.carrier_ip||'').split(/[\s,;]+/).filter(Boolean), note:'Endpoint is available. Carrier requests will still be IP-checked at /api/incoming-sms.' });
});


app.get('/api/carrier-webhook-logs', authRequired, requireRole('admin'), (req,res)=>{
  if (!requireCarrierLock(req, res)) return;
  const limit = Math.min(1000, parseInt(req.query.limit || '500'));
  res.json(db.all(`SELECT * FROM webhook_logs ORDER BY id DESC LIMIT ${limit}`));
});
app.delete('/api/carrier-webhook-logs', authRequired, requireRole('admin'), (req,res)=>{
  if (!requireCarrierLock(req, res)) return;
  const count = db.get('SELECT COUNT(*) c FROM webhook_logs')?.c || 0;
  db.run('DELETE FROM webhook_logs');
  logAction(req,'clear_carrier_webhook_logs','carrier_integration',{count});
  res.json({ok:true,deleted:count});
});



/* ============ LOGS / FAILED QUEUE ============ */
app.get('/api/logs/activity', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500'));
});
app.get('/api/logs/number-history', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM number_history ORDER BY id DESC LIMIT 500'));
});
app.get('/api/logs/webhooks', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM webhook_logs ORDER BY id DESC LIMIT 500'));
});
app.get('/api/failed-sms', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM failed_sms_queue ORDER BY id DESC LIMIT 500'));
});
app.post('/api/failed-sms/:id/retry', authRequired, requireRole('admin'), (req,res)=>{
  const id=+req.params.id;
  const f=db.get('SELECT * FROM failed_sms_queue WHERE id=?',[id]);
  if(!f) return res.status(404).json({ error:'Failed SMS not found' });
  const n=findNumber(f.number);
  if(!n){ db.run(`UPDATE failed_sms_queue SET retry_count=retry_count+1, updated_at=datetime('now') WHERE id=?`,[id]); return res.status(404).json({ error:'Number still not found' }); }
  const rangeForRetry=db.get('SELECT * FROM ranges WHERE id=?',[n.range_id])||{};
  const retryPaymentType=assignedPaymentTypeForNumber(n, rangeForRetry);
  const retryRate=payoutRateForPaymentType({...rangeForRetry, number_rate:n.rate, number_payout:n.payout}, retryPaymentType);
  const retrySenderType=classifySender(f.cli||'');
  const retryOtpCode=extractOtpCode(f.message||'');
  db.run(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,manager_id,payout_rate,payout_amount,payment_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [n.id,n.number,n.range_id,f.cli||'',retrySenderType,f.message||'',retryOtpCode,n.client_id,n.agent_id,n.manager_id,retryRate,retryRate,retryPaymentType]);
  const retrySaved=db.get('SELECT id FROM sms_records ORDER BY id DESC LIMIT 1');
  if(retrySaved){ try{ recordPaymentLedgerForSms(retrySaved.id); }catch(e){ console.warn('[PAYMENT_V2] retry ledger failed:', e.message); } }
  const smsRow={number_id:n.id,number:n.number,range_id:n.range_id,cli:f.cli||'',sender_type:retrySenderType,message:f.message||'',otp_code:retryOtpCode,client_id:n.client_id,agent_id:n.agent_id,manager_id:n.manager_id};
  db.run(`UPDATE failed_sms_queue SET status='Retried',retry_count=retry_count+1,updated_at=datetime('now') WHERE id=?`,[id]);
  logAction(req,'retry_failed_sms','failed_sms_queue',{id,number:n.number});
  res.json({ ok:true });
});
app.delete('/api/failed-sms/:id', authRequired, requireRole('admin'), (req,res)=>{
  db.run(`UPDATE failed_sms_queue SET status='Ignored',updated_at=datetime('now') WHERE id=?`,[+req.params.id]);
  logAction(req,'ignore_failed_sms','failed_sms_queue',{id:+req.params.id});
  res.json({ ok:true });
});





/* ============ SMS WEBHOOK (incoming SMS from carrier/provider) ============ */
// Carrier/provider hits this endpoint. It supports our generic JSON and common provider field names.
function firstVal(obj, keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return obj[k];
  return '';
}

function normalizeIncomingPayload(req) {
  let body = req.body || {};
  if (typeof body === 'string') {
    const raw = body.trim();
    if (!raw) body = {};
    else {
      try { body = JSON.parse(raw); }
      catch (_) {
        body = {};
        raw.split('&').forEach(part => {
          const [k, ...rest] = part.split('=');
          if (!k) return;
          body[decodeURIComponent(k)] = decodeURIComponent(rest.join('=') || '');
        });
      }
    }
  }
  return { ...(req.query || {}), ...(body || {}) };
}
function cleanPhone(v) { return String(v || '').trim().replace(/[^0-9]/g, ''); }
function classifySender(cli) {
  const s = String(cli || '').trim();
  if (!s) return 'unknown';
  const digits = s.replace(/[^0-9]/g, '');
  if (/^[A-Za-z][A-Za-z0-9 _.-]{1,20}$/.test(s) && /[A-Za-z]/.test(s)) return 'alphanumeric_sender';
  if (/^\+?\d{10,15}$/.test(s)) return 'phone_number';
  if (/^\d{3,8}$/.test(digits) && digits.length === s.replace(/^\+/, '').length) return 'shortcode';
  return 'unknown';
}
function extractOtpCode(message) {
  const text = String(message || '');
  const digit = text.match(/\b\d{4,8}\b/);
  if (digit) return digit[0];
  const alphaNum = text.match(/\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,12}\b/);
  return alphaNum ? alphaNum[0] : '';
}
function incomingHasZeroPayout(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const raw = firstVal(payload, ['payout','Payout','payout_amount','payoutAmount','rate_payout']);
  return raw !== '' && normalizeDecimalString(raw) === '0';
}
function countTodayUk(whereSql, params=[]) {
  return db.get(`SELECT COUNT(*) c FROM sms_records s WHERE COALESCE(s.is_test,0)=0 AND ${ukDateExpr('s.received_at')}=${ukDateNowSql()} AND ${whereSql}`, params)?.c || 0;
}
function activeLimitRules(type) {
  return db.all('SELECT * FROM daily_limit_rules WHERE active=1 AND limit_type=? ORDER BY id ASC', [type]);
}
function evaluateDailyPayoutLimits(n, cli) {
  const reasons = [];
  const cleanN = cleanPhone(n.number);
  if (n.range_id) {
    for (const rule of activeLimitRules('range').filter(r => Number(r.range_id) === Number(n.range_id))) {
      const used = countTodayUk('s.range_id=?', [n.range_id]);
      if (used >= Number(rule.daily_limit || 0)) reasons.push(`range:${n.range_id}:${used}/${rule.daily_limit}`);
    }
    for (const rule of activeLimitRules('range_number').filter(r => Number(r.range_id) === Number(n.range_id))) {
      const used = countTodayUk(`s.range_id=? AND REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')=?`, [n.range_id, cleanN]);
      if (used >= Number(rule.daily_limit || 0)) reasons.push(`range_number:${n.range_id}:${n.number}:${used}/${rule.daily_limit}`);
    }
  }
  if (cleanN) {
    for (const rule of activeLimitRules('number')) {
      if (cleanPhone(rule.number) !== cleanN) continue;
      const used = countTodayUk(`REPLACE(REPLACE(REPLACE(REPLACE(s.number,'+',''),' ',''),'-',''),'_','')=?`, [cleanN]);
      if (used >= Number(rule.daily_limit || 0)) reasons.push(`number:${n.number}:${used}/${rule.daily_limit}`);
    }
  }
  const cliVal = String(cli || '').trim();
  if (cliVal) {
    for (const rule of activeLimitRules('cli')) {
      if (String(rule.cli || '').trim().toLowerCase() !== cliVal.toLowerCase()) continue;
      const used = countTodayUk('LOWER(s.cli)=LOWER(?)', [cliVal]);
      if (used >= Number(rule.daily_limit || 0)) reasons.push(`cli:${cliVal}:${used}/${rule.daily_limit}`);
    }
  }
  return { exceeded: reasons.length > 0, reason: reasons.join('; ') };
}
function findNumber(rawNumber) {
  const exact = String(rawNumber || '').trim();
  let n = db.get('SELECT * FROM numbers WHERE number=?', [exact]);
  if (n) return n;
  const cleaned = cleanPhone(exact);
  if (!cleaned) return null;
  return db.get(
    `SELECT * FROM numbers
     WHERE REPLACE(REPLACE(REPLACE(REPLACE(number,'+',''),' ',''),'-',''),'_','')=?`,
    [cleaned]
  );
}
function findTestNumber(rawNumber) {
  const cleaned = cleanPhone(rawNumber);
  if (!cleaned) return null;
  return db.get(`SELECT t.*, t.test_number AS number, r.name AS range_name
    FROM range_test_numbers t
    LEFT JOIN ranges r ON r.id=t.range_id
    WHERE t.active=1 AND REPLACE(REPLACE(REPLACE(REPLACE(t.test_number,'+',''),' ',''),'-',''),'_','')=?`, [cleaned]);
}
function processIncomingSmsPayload(req, payload, sourceIp='', opts={}) {
  const b = payload || {};
  // Generic: {number, cli, message}
  // Twilio-like: {To, From, Body}
  // Other providers: {to, from, text}, {msisdn, sender, content}, etc.
  const number = firstVal(b, ['number', 'to', 'To', 'recipient', 'destination', 'msisdn', 'receiver', 'called']);
  const cli = firstVal(b, ['cli', 'from', 'From', 'sender', 'originator', 'source', 'shortcode', 'service']);
  const message = firstVal(b, ['message', 'text', 'Text', 'body', 'Body', 'sms', 'content', 'msg']);
  const senderType = classifySender(cli);
  const otpCode = extractOtpCode(message);

  if (!number) {
    console.warn('[INCOMING_SMS] failed: number/to field required', { sourceIp, cli, payload: b });
    logWebhook('failed', b, '', '', cli, message, 'number/to field required', sourceIp);
    addFailedSms(b, '', cli, message, 'number/to field required');
    return { status: 400, body: { error: 'number/to field required' } };
  }
  let n = findNumber(number);
  let matchedTest = null;
  if (!n) {
    matchedTest = findTestNumber(number);
    if (matchedTest) {
      n = { id: null, number: matchedTest.test_number, range_id: matchedTest.range_id, rate: '', payout: '0', manager_id: null, agent_id: null, client_id: null };
      opts = { ...opts, isTest: 1, source: opts.source || 'carrier_test_number' };
    }
  }
  if (!n) {
    console.warn('[INCOMING_SMS] failed: number not found/allocated', { sourceIp, number, cli });
    logWebhook('failed', b, number, '', cli, message, 'Number not found/allocated in system', sourceIp);
    addFailedSms(b, number, cli, message, 'Number not found/allocated in system');
    return { status: 404, body: { error: 'Number not found/allocated in system', number } };
  }

  const rangeForSms=db.get('SELECT * FROM ranges WHERE id=?',[n.range_id])||{};
  const assignedPaymentType = assignedPaymentTypeForNumber(n, rangeForSms);
  let smsPayoutRate=payoutRateForPaymentType({...rangeForSms, number_rate:n.rate, number_payout:n.payout}, assignedPaymentType);
  let limitReason = '';
  if (incomingHasZeroPayout(b)) {
    smsPayoutRate = '0';
    limitReason = 'external_payout_zero';
  } else if (!opts.isTest) {
    const limitStatus = evaluateDailyPayoutLimits(n, cli || '');
    if (limitStatus.exceeded) { smsPayoutRate = '0'; limitReason = limitStatus.reason; }
  }
  db.run(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,manager_id,is_test,test_batch_id,source,payout_rate,payout_amount,limit_reason,payment_type)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [n.id, n.number, n.range_id, cli || '', senderType, message || '', otpCode, n.client_id, n.agent_id, n.manager_id, opts.isTest?1:0, opts.testBatchId||'', opts.source||'carrier', smsPayoutRate, smsPayoutRate, limitReason, assignedPaymentType]);
  const saved = db.get('SELECT id, received_at FROM sms_records ORDER BY id DESC LIMIT 1');
  if(saved && !opts.isTest) { try { recordPaymentLedgerForSms(saved.id, false); } catch(e) { console.warn('[PAYMENT_V2] ledger insert failed:', e.message); } }
  const smsRow = { number_id:n.id, number:n.number, range_id:n.range_id, cli:cli||'', sender_type:senderType, message:message||'', otp_code:otpCode, client_id:n.client_id, agent_id:n.agent_id, manager_id:n.manager_id, is_test: opts.isTest?1:0 };
  logWebhook('success', b, number, n.number, cli, message, '', sourceIp);
  console.log('[INCOMING_SMS] saved', { id: saved ? saved.id : null, number: n.number, cli: cli || '', sender_type: senderType, otp_detected: !!otpCode, source: opts.source || 'carrier', manager_id: n.manager_id || null, agent_id: n.agent_id || null, client_id: n.client_id || null });
  return { status: 200, body: { ok: true, id: saved ? saved.id : null, received_at: saved ? saved.received_at : null, matched_number: n.number, sender_type: senderType, otp_detected: !!otpCode } };
}

// Internal/testing webhook. This stays open for local panel testing.
app.post('/api/webhook/sms', upload.none(), (req, res) => {
  const payload = normalizeIncomingPayload(req);
  const result = processIncomingSmsPayload(req, payload, getClientIp(req));
  res.status(result.status).json(result.body);
});

function handleCarrierIncoming(req, res, payload) {
  const settings = getCarrierSettings();
  const clientIp = getClientIp(req);
  if ((settings.integration_status || 'disabled') !== 'enabled') {
    console.warn('[INCOMING_SMS] rejected: carrier integration disabled', { clientIp });
    logWebhook('failed', payload || {}, '', '', '', '', 'Carrier integration disabled', clientIp);
    return res.status(403).json({ error: 'Carrier integration is disabled' });
  }
  if (!settings.carrier_ip || !carrierIpAllowed(settings, clientIp)) {
    console.warn('[INCOMING_SMS] rejected: IP not allowed', { clientIp, allowed: settings.carrier_ip || '' });
    logWebhook('failed', payload || {}, '', '', '', '', `IP not allowed: ${clientIp}`, clientIp);
    return res.status(403).json({ error: 'IP not allowed', ip: clientIp });
  }
  const result = processIncomingSmsPayload(req, payload || {}, clientIp);
  cleanupWebhookLogs(settings.retention_days||30);
  return res.status(result.status).json(result.body);
}

// Carrier HTTP callback endpoint. Main production method: POST /api/incoming-sms
app.post('/api/incoming-sms', upload.none(), (req, res) => {
  const payload = normalizeIncomingPayload(req);
  return handleCarrierIncoming(req, res, payload);
});

// Optional GET support for carrier/browser diagnostics and carriers that test URLs via GET.
app.get('/api/incoming-sms', (req, res) => {
  const hasPayload = Object.keys(req.query || {}).some(k => ['number','to','To','recipient','destination','msisdn','receiver','called','message','text','body','Body','sms','content','msg'].includes(k));
  if (!hasPayload) {
    const settings = getCarrierSettings();
    return res.json({ ok: true, service: 'Mufasa SMS incoming SMS endpoint', method: 'POST preferred', path: '/api/incoming-sms', integration_status: settings.integration_status, accepted_content_types: ['application/json','application/x-www-form-urlencoded','multipart/form-data'] });
  }
  return handleCarrierIncoming(req, res, normalizeIncomingPayload(req));
});

/* ============ API INTEGRATION POLLING (incoming API pull channel) ============ */
let apiPollTimer = null;
const apiPollInProgress = new Set();
let lastApiIntegrationCleanupAt = 0;
function apiIntegrationLogLimit(){ return Math.max(1000, parseInt(process.env.API_INTEGRATION_LOG_LIMIT || '20000', 10) || 20000); }
function cleanupApiIntegrationTables(){
  const now=Date.now();
  if(now-lastApiIntegrationCleanupAt < 10*60*1000) return;
  lastApiIntegrationCleanupAt=now;
  const limit=apiIntegrationLogLimit();
  try{
    db.runNoSave(`DELETE FROM api_integration_logs WHERE id NOT IN (SELECT id FROM api_integration_logs ORDER BY id DESC LIMIT ${limit})`);
    db.runNoSave(`DELETE FROM api_integration_seen WHERE id NOT IN (SELECT id FROM api_integration_seen ORDER BY id DESC LIMIT ${Math.max(limit*2, 50000)})`);
  }catch(e){ console.warn('[API_INTEGRATION] cleanup failed:', e.message); }
}
async function withBackgroundDbBatch(fn){
  try{ db.beginBatch && db.beginBatch(); }catch(_){ }
  try{ return await fn(); }
  finally{ try{ db.endBatch && db.endBatch(); }catch(e){ console.warn('[DB_BATCH] background save failed:', e.message); } }
}
function maskToken(t){ t=String(t||''); if(!t) return ''; return t.length<=8 ? '********' : t.slice(0,4)+'********'+t.slice(-4); }
function publicApiIntegration(row){ if(!row) return row; return {...row, token: undefined, token_masked: maskToken(row.token)}; }
function ukDateStringJs(d=new Date()){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function buildApiIntegrationRequest(row){
  const url = new URL(row.base_url);
  const today = ukDateStringJs();
  const dt1 = `${today} 00:00:00`;
  const dt2 = `${today} 23:59:59`;
  if(row.auth_type === 'query_token' && row.token) url.searchParams.set(row.token_param || 'token', row.token);
  if(row.dt1_param) url.searchParams.set(row.dt1_param, dt1);
  if(row.dt2_param) url.searchParams.set(row.dt2_param, dt2);
  if(row.records_param) url.searchParams.set(row.records_param, String(row.records_limit || 100));
  const headers = { 'Accept': 'application/json,text/plain,text/html,*/*' };
  if(row.auth_type === 'bearer' && row.token) headers.Authorization = 'Bearer ' + row.token;
  if(row.auth_type === 'header' && row.token) headers[row.token_header || 'X-API-Key'] = row.token;
  return { url: url.toString(), headers, dt1, dt2 };
}
function stripHtml(v){ return String(v||'').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim(); }
function parseDelimited(text){
  const lines=String(text||'').trim().split(/\r?\n/).filter(Boolean);
  if(lines.length<2) return [];
  const delim=['|',',',';','\t'].sort((a,b)=>(lines[0].split(b).length-lines[0].split(a).length))[0];
  const headers=lines[0].split(delim).map(h=>stripHtml(h).toLowerCase());
  return lines.slice(1).map(line=>{ const vals=line.split(delim); const o={}; headers.forEach((h,i)=>o[h]=stripHtml(vals[i]||'')); return o; });
}
function parseHtmlTable(text){
  const rows=[...String(text||'').matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(m=>m[0]);
  if(!rows.length) return [];
  const parsed=rows.map(r=>[...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>stripHtml(c[1]))).filter(r=>r.length);
  if(parsed.length<2) return [];
  const headers=parsed[0].map(h=>h.toLowerCase());
  return parsed.slice(1).map(vals=>{const o={};headers.forEach((h,i)=>o[h]=vals[i]||'');return o;});
}
function extractArrayFromJson(j){
  if(Array.isArray(j)) return j;
  if(!j || typeof j!=='object') return [];
  for(const k of ['data','records','rows','result','results','messages','sms','items']) if(Array.isArray(j[k])) return j[k];
  return [j];
}
function parseApiResponse(text, contentType=''){
  const raw=String(text||'').trim();
  if(!raw) return [];
  if(contentType.includes('json') || raw.startsWith('{') || raw.startsWith('[')) {
    try { return extractArrayFromJson(JSON.parse(raw)); } catch(_) {}
  }
  if(raw.includes('<table') || /<tr[\s\S]*?<\/tr>/i.test(raw)) return parseHtmlTable(raw);
  return parseDelimited(raw);
}
function valAny(obj, keys){
  if(!obj || typeof obj!=='object') return '';
  const lower={}; Object.keys(obj).forEach(k=>lower[k.toLowerCase().replace(/[\s_-]+/g,'')]=obj[k]);
  for(const k of keys){ const key=k.toLowerCase().replace(/[\s_-]+/g,''); if(lower[key]!==undefined && lower[key]!==null && String(lower[key]).trim()!=='') return lower[key]; }
  return '';
}
function normalizeApiSmsRecord(r){
  const id=valAny(r,['id','message_id','messageid','msgid','smsid','uuid','record_id']);
  const dt=valAny(r,['dt','date','datetime','time','timestamp','received_at','receivedat']);
  const number=valAny(r,['number','to','destination','destination_addr','msisdn','receiver','recipient','called']);
  const cli=valAny(r,['cli','sender','from','source','source_addr','originator','shortcode','service']);
  const message=valAny(r,['message','text','body','sms','content','msg','short_message']);
  return { provider_message_id:String(id||''), dt:String(dt||''), number:String(number||'').trim(), cli:String(cli||'').trim(), message:String(message||'').trim(), raw:r };
}
function apiDuplicateKey(integrationId, rec){
  const base = rec.provider_message_id ? `${integrationId}:id:${rec.provider_message_id}` : `${integrationId}:hash:${rec.number}|${rec.cli}|${rec.message}|${rec.dt}`;
  return crypto.createHash('sha256').update(base).digest('hex');
}
function apiLog(row, status, reason, rec={}, smsId=null){
  try{ db.run(`INSERT INTO api_integration_logs (integration_id,integration_name,status,reason,number,cli,message,provider_message_id,duplicate_key,raw_json,sms_record_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [row.id,row.name,status,reason||'',rec.number||'',rec.cli||'',rec.message||'',rec.provider_message_id||'',rec.duplicate_key||'',safeJson(rec.raw||{}),smsId]); }
  catch(e){ console.warn('[API_INTEGRATION] log failed:', e.message); }
}
function apiSeen(key){ return !!db.get('SELECT id FROM api_integration_seen WHERE duplicate_key=?',[key]); }
function markApiSeen(row, rec){ try{ db.run('INSERT OR IGNORE INTO api_integration_seen (integration_id,duplicate_key,provider_message_id) VALUES (?,?,?)',[row.id,rec.duplicate_key,rec.provider_message_id||'']); }catch(e){} }
async function processApiIntegrationRow(row, rec){
  rec.duplicate_key=apiDuplicateKey(row.id,rec);
  if(apiSeen(rec.duplicate_key)) return {duplicate:1};
  if(!rec.number || !rec.message){ markApiSeen(row,rec); apiLog(row,'failed','Invalid data',rec); return {failed:1}; }
  if(!findNumber(rec.number) && !findTestNumber(rec.number)){ markApiSeen(row,rec); apiLog(row,'failed','Number not found',rec); return {failed:1}; }
  const result=processIncomingSmsPayload({ip:'API_PULL', api_integration:row.name}, {number:rec.number, cli:rec.cli, message:rec.message, api_dt:rec.dt, api_message_id:rec.provider_message_id}, 'API_PULL', {source:'api_integration'});
  markApiSeen(row,rec);
  if(result.status===200){ apiLog(row,'success','Saved',rec,result.body?.id||null); return {success:1}; }
  apiLog(row,'failed',result.body?.error||'Processing failed',rec); return {failed:1};
}
async function fetchApiIntegration(row, manual=false){
  if(apiPollInProgress.has(row.id)) return {ok:false, skipped:true, reason:'Already running'};
  apiPollInProgress.add(row.id);
  let summary={ok:true,total:0,received:0,success:0,failed:0,duplicate:0};
  const started=Date.now();
  try{
    const reqInfo=buildApiIntegrationRequest(row);
    // Avoid db.run() full-save here. The processing batch below persists once.
    db.runNoSave("UPDATE api_integrations SET last_poll_at=datetime('now') WHERE id=?",[row.id]);
    const resp=await fetch(reqInfo.url,{method:row.method||'GET',headers:reqInfo.headers,signal:AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined});
    const text=await resp.text();
    if(!resp.ok) throw new Error('HTTP '+resp.status+' '+text.slice(0,120));
    const allParsed=parseApiResponse(text, resp.headers.get('content-type')||'');
    const maxRecords=Math.max(1, Math.min(1000, parseInt(row.records_limit||100,10)||100));
    const parsed=allParsed.slice(0,maxRecords);
    summary.received=allParsed.length;
    summary.total=parsed.length;
    await withBackgroundDbBatch(async()=>{
      cleanupApiIntegrationTables();
      let dupLogged=0;
      let processed=0;
      for(const raw of parsed){
        const rec=normalizeApiSmsRecord(raw);
        const r=await processApiIntegrationRow(row,rec);
        summary.success+=r.success||0; summary.failed+=r.failed||0; summary.duplicate+=r.duplicate||0;
        if(r.duplicate && dupLogged<3){ rec.duplicate_key=apiDuplicateKey(row.id,rec); apiLog(row,'duplicate','Duplicate message',rec); dupLogged++; }
        processed++;
        if(processed % 25 === 0) await new Promise(resolve=>setImmediate(resolve));
      }
      db.runNoSave("UPDATE api_integrations SET last_success_at=datetime('now'), last_error='' WHERE id=?",[row.id]);
    });
    return summary;
  }catch(e){
    await withBackgroundDbBatch(async()=>{
      db.runNoSave("UPDATE api_integrations SET last_error=? WHERE id=?",[e.message,row.id]);
      apiLog(row,'failed',e.message,{});
      cleanupApiIntegrationTables();
    });
    return {ok:false,error:e.message};
  }finally{
    apiPollInProgress.delete(row.id);
    const took=Date.now()-started;
    if(took>10000) console.warn('[API_INTEGRATION] slow poll', {id:row.id,name:row.name,took_ms:took,total:summary.total,received:summary.received,success:summary.success,failed:summary.failed,duplicate:summary.duplicate});
  }
}

async function pollApiIntegrations(){
  const rows=db.all('SELECT * FROM api_integrations WHERE enabled=1 ORDER BY id ASC');
  const now=Date.now();
  for(const row of rows){
    const interval=Math.max(5,parseInt(row.poll_interval_sec||5,10));
    const last=row.last_poll_at ? new Date(row.last_poll_at.replace(' ','T')+'Z').getTime() : 0;
    if(!last || now-last >= interval*1000) fetchApiIntegration(row,false).catch(e=>console.warn('[API_INTEGRATION] poll failed:',e.message));
  }
}
function startApiIntegrationPoller(){ if(apiPollTimer) return; apiPollTimer=setInterval(()=>pollApiIntegrations().catch(()=>{}),5000); if(apiPollTimer.unref) apiPollTimer.unref(); }

app.get('/api/api-integrations', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM api_integrations ORDER BY id DESC').map(publicApiIntegration));
});
app.post('/api/api-integrations', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{}; if(!b.name||!b.base_url) return res.status(400).json({error:'name and base_url required'});
  db.run(`INSERT INTO api_integrations (name,base_url,enabled,method,auth_type,token,token_param,token_header,dt1_param,dt2_param,records_param,records_limit,poll_interval_sec,response_format)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [b.name,b.base_url,b.enabled?1:0,b.method||'GET',b.auth_type||'query_token',b.token||'',b.token_param||'token',b.token_header||'Authorization',b.dt1_param||'dt1',b.dt2_param||'dt2',b.records_param||'records',parseInt(b.records_limit||100,10),Math.max(5,parseInt(b.poll_interval_sec||5,10)),b.response_format||'auto']);
  logAction(req,'create_api_integration','api_integration',{name:b.name});
  res.json({ok:true});
});
app.put('/api/api-integrations/:id', authRequired, requireRole('admin'), (req,res)=>{
  const id=+req.params.id; const old=db.get('SELECT * FROM api_integrations WHERE id=?',[id]); if(!old) return res.status(404).json({error:'API integration not found'});
  const b=req.body||{}; const token=(b.token===undefined||b.token==='')?old.token:b.token;
  db.run(`UPDATE api_integrations SET name=?,base_url=?,enabled=?,method=?,auth_type=?,token=?,token_param=?,token_header=?,dt1_param=?,dt2_param=?,records_param=?,records_limit=?,poll_interval_sec=?,response_format=?,updated_at=datetime('now') WHERE id=?`,
    [b.name||old.name,b.base_url||old.base_url,b.enabled?1:0,b.method||old.method,b.auth_type||old.auth_type,token,b.token_param||old.token_param,b.token_header||old.token_header,b.dt1_param||old.dt1_param,b.dt2_param||old.dt2_param,b.records_param||old.records_param,parseInt(b.records_limit||old.records_limit||100,10),Math.max(5,parseInt(b.poll_interval_sec||old.poll_interval_sec||5,10)),b.response_format||old.response_format,id]);
  res.json({ok:true});
});
app.delete('/api/api-integrations/:id', authRequired, requireRole('admin'), (req,res)=>{ db.run('DELETE FROM api_integrations WHERE id=?',[+req.params.id]); res.json({ok:true}); });
app.post('/api/api-integrations/:id/fetch', authRequired, requireRole('admin'), async (req,res)=>{
  const row=db.get('SELECT * FROM api_integrations WHERE id=?',[+req.params.id]); if(!row) return res.status(404).json({error:'API integration not found'});
  res.json(await fetchApiIntegration(row,true));
});
app.get('/api/api-integration-logs', authRequired, requireRole('admin'), (req,res)=>{
  const limit=Math.min(1000,parseInt(req.query.limit||500,10));
  res.json(db.all(`SELECT * FROM api_integration_logs ORDER BY id DESC LIMIT ${limit}`));
});




function getAdminSecurityCode(){
  let row = db.get('SELECT * FROM system_security ORDER BY id ASC LIMIT 1');
  if(!row){ db.run("INSERT INTO system_security (admin_security_code) VALUES ('Dawood')"); row=db.get('SELECT * FROM system_security ORDER BY id ASC LIMIT 1'); }
  return row.admin_security_code || 'Dawood';
}



/* ============ DATABASE BACKUPS ============ */
app.get('/api/backups', authRequired, requireRole('admin'), (req, res) => {
  try {
    res.json({ backups: backup.listBackups(db), backup_dir: backup.getBackupDir(db), db_file: db.getDbFile ? db.getDbFile() : '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/backups/create', authRequired, requireRole('admin'), (req, res) => {
  try {
    const b = backup.createBackup(db, 'manual');
    backup.cleanupOldBackups(db);
    logAction(req, 'create_database_backup', 'backup', b.file);
    res.json({ ok: true, backup: b });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/backups/latest/download', authRequired, requireRole('admin'), (req, res) => {
  try {
    const latest = backup.getLatestBackup(db) || backup.createBackup(db, 'manual-latest');
    const filePath = backup.backupPath(db, latest.file);
    res.download(filePath, latest.file);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/backups/:file/download', authRequired, requireRole('admin'), (req, res) => {
  try {
    const filePath = backup.backupPath(db, req.params.file);
    res.download(filePath, req.params.file);
  } catch (e) { res.status(404).json({ error: e.message }); }
});
app.post('/api/backups/:file/restore', authRequired, requireRole('admin'), (req, res) => {
  try {
    const result = backup.restoreBackup(db, req.params.file);
    createTables();
    seed();
    logAction(req, 'restore_database_backup', 'backup', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/backups/:file', authRequired, requireRole('admin'), (req, res) => {
  try {
    backup.deleteBackup(db, req.params.file);
    logAction(req, 'delete_database_backup', 'backup', req.params.file);
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

/* ============ PROFILE / ACTIVITY ============ */
app.get('/api/profile', authRequired, (req, res) => {
  const u = db.get('SELECT id, username, role, name, email, whatsapp, contact, skype, active, created_at FROM users WHERE id=?', [req.user.id]);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});

app.put('/api/profile', authRequired, (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Profile editing is not available for clients' });
  const b = req.body || {};
  const current = db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!current) return res.status(404).json({ error: 'User not found' });

  const newUsername = String(b.username || current.username).trim();
  if (!newUsername) return res.status(400).json({ error: 'Username is required' });
  const exists = db.get('SELECT id FROM users WHERE username=? COLLATE NOCASE AND id<>?', [newUsername, req.user.id]);
  if (exists) return res.status(409).json({ error: 'Username already exists' });

  const newPassword = String(b.new_password || '');
  const confirmPassword = String(b.confirm_password || '');
  if (newPassword || confirmPassword) {
    if (!b.current_password) return res.status(400).json({ error: 'Current password is required' });
    if (!bcrypt.compareSync(String(b.current_password), current.password)) return res.status(400).json({ error: 'Current password is incorrect' });
    if (req.user.role === 'admin') {
      if (!b.admin_security_code) return res.status(400).json({ error: 'Admin security code is required to change password' });
      if (String(b.admin_security_code) !== getAdminSecurityCode()) return res.status(400).json({ error: 'Invalid admin security code' });
    }
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New password and confirmation do not match' });
    db.run('UPDATE users SET username=?, password=? WHERE id=?', [newUsername, bcrypt.hashSync(newPassword, 10), req.user.id]);
  } else {
    db.run('UPDATE users SET username=? WHERE id=?', [newUsername, req.user.id]);
  }
  const updated = db.get('SELECT id, username, role, name, email, whatsapp, contact, skype FROM users WHERE id=?', [req.user.id]);
  logAction(req, 'update_own_profile', 'profile', { username: newUsername, password_changed: !!newPassword });
  res.json({ ok: true, user: updated, token: sign(updated) });
});


app.put('/api/admin-security-code', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const oldCode=String(b.old_security_code||'');
  const newCode=String(b.new_security_code||'').trim();
  const confirm=String(b.confirm_security_code||'').trim();
  if(!oldCode) return res.status(400).json({error:'Old security code is required'});
  if(oldCode !== getAdminSecurityCode()) return res.status(400).json({error:'Old security code is incorrect'});
  if(!newCode || newCode.length < 3) return res.status(400).json({error:'New security code must be at least 3 characters'});
  if(newCode !== confirm) return res.status(400).json({error:'New security code and confirmation do not match'});
  const row=db.get('SELECT id FROM system_security ORDER BY id ASC LIMIT 1');
  if(row) db.run('UPDATE system_security SET admin_security_code=?, updated_at=datetime(\'now\') WHERE id=?',[newCode,row.id]);
  else db.run('INSERT INTO system_security (admin_security_code) VALUES (?)',[newCode]);
  logAction(req,'update_admin_security_code','security','Admin security code changed');
  res.json({ok:true});
});

app.put('/api/carrier-lock-password', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const securityCode=String(b.admin_security_code||'');
  const newPass=String(b.new_password||'').trim();
  const confirm=String(b.confirm_password||'').trim();
  if(!securityCode) return res.status(400).json({error:'Admin security code is required'});
  if(securityCode !== getAdminSecurityCode()) return res.status(400).json({error:'Invalid admin security code'});
  if(!newPass || newPass.length < 3) return res.status(400).json({error:'New carrier password must be at least 3 characters'});
  if(newPass !== confirm) return res.status(400).json({error:'New carrier password and confirmation do not match'});
  const row=db.get('SELECT id FROM system_security ORDER BY id ASC LIMIT 1');
  if(row) db.run('UPDATE system_security SET carrier_lock_password=?, updated_at=datetime(\'now\') WHERE id=?',[newPass,row.id]);
  else db.run('INSERT INTO system_security (admin_security_code,carrier_lock_password) VALUES (?,?)',[getAdminSecurityCode(),newPass]);
  logAction(req,'update_carrier_lock_password','security','Carrier integration password changed');
  res.json({ok:true});
});

app.post('/api/logout', authRequired, (req, res) => {
  logAction(req, 'logout', 'auth', 'User logged out');
  res.json({ ok: true });
});

app.get('/api/activity-log', authRequired, (req, res) => {
  if (req.user.role === 'client') return res.status(403).json({ error: 'Activity log is not available for clients' });
  const own = db.all("SELECT id, user_id, username, role, action, module, details, ip, created_at FROM audit_logs WHERE user_id=? AND action IN ('login','logout') ORDER BY id DESC LIMIT 200", [req.user.id]);
  let childRole = null;
  if (req.user.role === 'admin') childRole = 'manager';
  if (req.user.role === 'manager') childRole = 'agent';
  if (req.user.role === 'agent') childRole = 'client';
  let child = [];
  if (childRole) {
    const children = db.all('SELECT id FROM users WHERE role=? AND parent_id=?', [childRole, req.user.id]).map(x => x.id);
    // Admin managers are direct children of admin in this project. If some old data has null parent_id, include all managers for admin.
    let ids = children;
    if (req.user.role === 'admin') ids = db.all("SELECT id FROM users WHERE role='manager'").map(x => x.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      child = db.all(`SELECT id, user_id, username, role, action, module, details, ip, created_at FROM audit_logs WHERE user_id IN (${ph}) AND action IN ('login','logout') ORDER BY id DESC LIMIT 500`, ids);
    }
  }
  res.json({ own, child_role: childRole, child });
});

/* ============ START ============ */
const PORT = process.env.PORT || 4000;
(async () => {
  await db.init();
  createTables();
  seed();
  if (backup && backup.startAutomaticBackups) backup.startAutomaticBackups(db, console);
  try { backfillPaymentLedger(); } catch(e) { console.warn('[PAYMENT_V2] backfill failed:', e.message); }
  try { startApiIntegrationPoller(); console.log('• API Integration poller enabled: every 5 seconds'); } catch(e) { console.warn('[API_INTEGRATION] poller startup failed:', e.message); }
  app.listen(PORT, () => console.log(`\n✅ Mufasa SMS backend running: http://localhost:${PORT}\n`));
})();
