/**
 * Mufasa SMS — Backend API
 * Node.js + Express + SQLite (sql.js). MySQL-ready SQL.
 */
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
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

// Clean URL routes (must be before static so /admin.html can redirect to /admin)
const FRONTEND_ROOT = path.join(__dirname, '..');
function sendFrontendPage(res, file) { res.sendFile(path.join(FRONTEND_ROOT, file)); }
app.get('/', (req, res) => sendFrontendPage(res, 'login.html'));
app.get('/login', (req, res) => sendFrontendPage(res, 'login.html'));
app.get('/login.html', (req, res) => res.redirect(301, '/login'));
app.get('/admin', (req, res) => sendFrontendPage(res, 'admin.html'));
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));
app.get('/admin/:page', (req, res) => sendFrontendPage(res, 'admin.html'));
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
      n.rate AS number_rate, n.payout AS number_payout,
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
function ensurePrefs(userId){
  let p=db.get('SELECT * FROM user_preferences WHERE user_id=?',[userId]);
  if(!p){ db.run('INSERT INTO user_preferences (user_id,notification_sound,notification_popup) VALUES (?,?,?)',[userId,1,1]); p=db.get('SELECT * FROM user_preferences WHERE user_id=?',[userId]); }
  return p;
}
function periodBoundsForRule(period){
  const now=new Date(); const d0=new Date(now); d0.setHours(0,0,0,0);
  if(period==='monthly') return {start:dateOnly(new Date(now.getFullYear(),now.getMonth(),1)), end:dateOnly(new Date(now.getFullYear(),now.getMonth()+1,0))};
  if(period==='payment_cycle'){ const c=getPaymentConfig(); const b=cycleBounds(c,0); return {start:b.start,end:b.end}; }
  if(period==='lifetime') return {start:'1970-01-01', end:'2999-12-31'};
  return {start:dateOnly(d0), end:dateOnly(d0)};
}
function countForNotification(scope, key, bounds){
  let where='date(received_at) BETWEEN date(?) AND date(?)', params=[bounds.start,bounds.end];
  if(scope==='manager'){ where+=' AND manager_id=?'; params.push(+key); }
  else if(scope==='agent'){ where+=' AND agent_id=?'; params.push(+key); }
  else if(scope==='client'){ where+=' AND client_id=?'; params.push(+key); }
  else if(scope==='range'){ where+=' AND range_id=?'; params.push(+key); }
  else if(scope==='cli'){ where+=' AND cli=?'; params.push(String(key)); }
  return db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${where}`, params)?.c || 0;
}
function notificationRecipients(notifyRoles, chain){
  const roles=String(notifyRoles||'admin').split(',').map(x=>x.trim()).filter(Boolean);
  const ids=new Set();
  if(roles.includes('admin')) db.all("SELECT id FROM users WHERE role='admin' AND active=1").forEach(u=>ids.add(u.id));
  if(roles.includes('manager') && chain.manager_id) ids.add(chain.manager_id);
  if(roles.includes('agent') && chain.agent_id) ids.add(chain.agent_id);
  if(roles.includes('client') && chain.client_id) ids.add(chain.client_id);
  return [...ids];
}
function createNotificationEvent(rule, scopeKey, scopeName, threshold, count, bounds, chain){
  const exists=db.get(`SELECT id FROM notification_events WHERE rule_id=? AND scope_key=? AND period_start=? AND period_end=? AND threshold=?`,
    [rule.id,String(scopeKey),bounds.start,bounds.end,threshold]);
  if(exists) return;
  const msg=`${scopeName} reached ${threshold.toLocaleString()} SMS (${rule.period})`;
  db.run(`INSERT INTO notification_events (rule_id,scope,scope_key,scope_name,period,period_start,period_end,threshold,count,message) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [rule.id,rule.scope,String(scopeKey),scopeName,rule.period,bounds.start,bounds.end,threshold,count,msg]);
  const ev=db.get('SELECT id FROM notification_events ORDER BY id DESC LIMIT 1');
  if(!ev) return;
  notificationRecipients(rule.notify_roles, chain).forEach(uid=>db.run('INSERT INTO user_notifications (user_id,event_id) VALUES (?,?)',[uid,ev.id]));
}
function checkSmsMilestoneNotifications(smsRow){
  try{
    const rules=db.all('SELECT * FROM notification_rules WHERE active=1');
    const rangeName=db.get('SELECT name FROM ranges WHERE id=?',[smsRow.range_id])?.name || ('Range #'+smsRow.range_id);
    const managerName=smsRow.manager_id?db.get('SELECT username FROM users WHERE id=?',[smsRow.manager_id])?.username:'';
    const agentName=smsRow.agent_id?db.get('SELECT username FROM users WHERE id=?',[smsRow.agent_id])?.username:'';
    const clientName=smsRow.client_id?db.get('SELECT username FROM users WHERE id=?',[smsRow.client_id])?.username:'';
    const candidates={
      global:[['global','System']],
      manager: smsRow.manager_id?[[smsRow.manager_id,'Manager '+managerName]]:[],
      agent: smsRow.agent_id?[[smsRow.agent_id,'Agent '+agentName]]:[],
      client: smsRow.client_id?[[smsRow.client_id,'Client '+clientName]]:[],
      range: smsRow.range_id?[[smsRow.range_id,'Range '+rangeName]]:[],
      cli: smsRow.cli?[[smsRow.cli,'CLI '+smsRow.cli]]:[]
    };
    for(const rule of rules){
      if(rule.scope==='number') continue; // number-wise notifications intentionally disabled
      const list=candidates[rule.scope]||[]; const bounds=periodBoundsForRule(rule.period||'daily');
      const thresholds=String(rule.thresholds||'').split(',').map(x=>parseInt(x.trim())).filter(n=>n>0).sort((a,b)=>a-b);
      for(const [key,name] of list){
        const count=countForNotification(rule.scope,key,bounds);
        thresholds.forEach(th=>{ if(count>=th) createNotificationEvent(rule,key,name,th,count,bounds,smsRow); });
      }
    }
  }catch(e){ console.warn('notification check failed', e.message); }
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
    `SELECT id,username,name,email,whatsapp,contact,skype,active,parent_id
     FROM users WHERE role=? AND id IN (${ph}) AND id<>? ORDER BY id DESC`,
    [role, ...ids, req.user.id]
  );
  res.json(rows);
});

// create user (admin->manager, manager->agent, agent->client)
app.post('/api/users', authRequired, (req, res) => {
  const { username, password, role, name, email, whatsapp, contact, skype, active } = req.body || {};
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
    `INSERT INTO users (username,password,role,name,email,whatsapp,contact,skype,parent_id,active)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [cleanUsername, bcrypt.hashSync(String(password), 10), role, name || '', email || '',
     whatsapp || '', contact || '', skype || '', parentId, active === false ? 0 : 1]
  );
  logAction(req,'create_user','users',{username,role});
  res.json({ ok: true });
});

// update user
app.put('/api/users/:id', authRequired, (req, res) => {
  const id = +req.params.id;
  const ids = scopeIds(req.user);
  if (!ids.includes(id)) return res.status(403).json({ error: 'Not your user' });
  const { name, email, whatsapp, contact, skype, active, password } = req.body || {};
  db.run(
    `UPDATE users SET name=?,email=?,whatsapp=?,contact=?,skype=?,active=? WHERE id=?`,
    [name || '', email || '', whatsapp || '', contact || '', skype || '', active ? 1 : 0, id]
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
app.get('/api/ranges', authRequired, (req, res) => {
  const rows = db.all(`SELECT r.*,
    COALESCE((SELECT GROUP_CONCAT(test_number, ', ') FROM range_test_numbers t WHERE t.range_id=r.id AND t.active=1), r.test_number, '') AS test_numbers
    FROM ranges r ORDER BY r.id DESC`);
  rows.forEach(r => { if (r.test_numbers) r.test_number = r.test_numbers; });
  res.json(rows);
});
// only admin can set rates / create ranges
app.post('/api/ranges', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Range name required' });
  const ins = db.run(`INSERT INTO ranges (name,prefix,test_number,currency,rate_1_1,rate_7_1,rate_7_7,rate_30_45,memo)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    [b.name, b.prefix || '', '', b.currency || 'USD',
     b.rate_1_1 || 'NA', b.rate_7_1 || 'NA', b.rate_7_7 || 'NA', b.rate_30_45 || 'NA', b.memo || '']);
  const newRange = db.get('SELECT id FROM ranges WHERE name=? ORDER BY id DESC LIMIT 1', [b.name]);
  syncRangeTestNumbers(newRange ? newRange.id : ins.lastInsertRowid, b.test_numbers || b.test_number || '');
  logAction(req,'create_range','ranges',b.name);
  res.json({ ok: true });
});
app.put('/api/ranges/:id', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  db.run(`UPDATE ranges SET name=?,prefix=?,currency=?,rate_1_1=?,rate_7_1=?,rate_7_7=?,rate_30_45=?,memo=? WHERE id=?`,
    [b.name, b.prefix || '', b.currency || 'USD',
     b.rate_1_1 || 'NA', b.rate_7_1 || 'NA', b.rate_7_7 || 'NA', b.rate_30_45 || 'NA', b.memo || '', +req.params.id]);
  syncRangeTestNumbers(+req.params.id, b.test_numbers || b.test_number || '');
  logAction(req,'update_range','ranges',{id:+req.params.id});
  res.json({ ok: true });
});
app.delete('/api/ranges/:id', authRequired, requireRole('admin'), (req, res) => {
  db.run('DELETE FROM range_test_numbers WHERE range_id=?', [+req.params.id]);
  db.run('DELETE FROM ranges WHERE id=?', [+req.params.id]);
  logAction(req,'delete_range','ranges',{id:+req.params.id});
  res.json({ ok: true });
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
    if (user.role === 'admin') { where.push('mu.username=?'); params.push(q.owner); }
    else if (user.role === 'manager') { where.push('au.username=?'); params.push(q.owner); }
    else if (user.role === 'agent') { where.push('cu.username=?'); params.push(q.owner); }
  }
  if (q.allocation === 'unallocated') {
    const col = numberOwnerColumnForRole(user.role);
    where.push(`n.${col} IS NULL`);
  } else if (q.allocation === 'allocated') {
    const col = numberOwnerColumnForRole(user.role);
    where.push(`n.${col} IS NOT NULL`);
  }
  return { where: where.join(' AND '), params };
}
function numberSelectSql(where) {
  return `SELECT n.*, r.name AS range_name,
            COALESCE(NULLIF(n.rate,''), NULLIF(r.rate_30_45,''), NULLIF(r.rate_7_1,''), NULLIF(r.rate_7_7,''), NULLIF(r.rate_1_1,''), '0') AS effective_rate,
            cu.username AS client_name, au.username AS agent_name, mu.username AS manager_name
     FROM numbers n
     LEFT JOIN ranges r ON r.id=n.range_id
     LEFT JOIN users cu ON cu.id=n.client_id
     LEFT JOIN users au ON au.id=n.agent_id
     LEFT JOIN users mu ON mu.id=n.manager_id
     WHERE ${where}`;
}
app.get('/api/numbers/summary', authRequired, (req, res) => {
  const scope = numberScope(req.user, 'n');
  const ownerCol = numberOwnerColumnForRole(req.user.role);
  const rows = db.all(`SELECT r.id AS range_id, r.name AS range_name,
      COUNT(n.id) AS total,
      SUM(CASE WHEN n.${ownerCol} IS NULL THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN n.${ownerCol} IS NOT NULL THEN 1 ELSE 0 END) AS allocated,
      COALESCE(NULLIF(r.rate_30_45,''), NULLIF(r.rate_7_1,''), '0') AS rate
    FROM ranges r
    LEFT JOIN numbers n ON n.range_id=r.id AND ${scope.where}
    GROUP BY r.id, r.name
    ORDER BY r.name`, scope.params);
  res.json(rows.map(r => ({...r, total:+(r.total||0), available:+(r.available||0), allocated:+(r.allocated||0)})));
});

// list numbers visible to caller (supports server-side pagination with ?paged=1)
const NUMBER_PAGE_DEFAULT = 25;
const NUMBER_PAGE_MAX = 100000; // allows 5,000/All views while keeping a safety ceiling
function parsePositiveInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
app.get('/api/numbers', authRequired, (req, res) => {
  const query = buildNumberQuery(req.user, req.query || {});
  const baseSql = numberSelectSql(query.where);

  // IMPORTANT: total is always a fresh database COUNT(*) after scope/search/filter.
  // It never comes from import batch/file metadata.
  const countRow = db.get(`SELECT COUNT(*) AS c FROM (${baseSql}) x`, query.params);
  const total = countRow ? +(countRow.c || 0) : 0;

  const paged = req.query.paged || req.query.page || req.query.limit;
  if (paged) {
    const requestedLimitRaw = String(req.query.limit || NUMBER_PAGE_DEFAULT);
    const isAll = requestedLimitRaw.toLowerCase() === 'all';
    const requestedLimit = isAll ? Math.max(1, total) : parsePositiveInt(requestedLimitRaw, NUMBER_PAGE_DEFAULT);
    const limit = isAll ? Math.max(1, total) : Math.min(NUMBER_PAGE_MAX, Math.max(1, requestedLimit));
    const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limit));
    const requestedPage = parsePositiveInt(req.query.page || '1', 1);
    const page = Math.min(Math.max(1, requestedPage), totalPages);
    const offset = (page - 1) * limit;
    const sortMap = { range:'r.name', prefix:'n.prefix', number:'n.number', myVal:'n.rate', payVal:'n.payout', manager:'mu.username', agent:'au.username', client:'cu.username', owner:"COALESCE(mu.username,au.username,cu.username,'')" };
    const sortCol = sortMap[req.query.sort] || 'n.number';
    const dir = String(req.query.dir||'asc').toLowerCase()==='desc'?'DESC':'ASC';
    const rows = db.all(`${baseSql} ORDER BY ${sortCol} ${dir}, n.id ASC LIMIT ? OFFSET ?`, [...query.params, limit, offset]);
    return res.json({ rows, total, page, limit, totalPages, count_source: 'database_count' });
  }

  const rows = db.all(`${baseSql} ORDER BY n.number ASC`, query.params);
  res.json(rows);
});

// allocate selected numbers to a target user (one level down)
app.post('/api/numbers/allocate', authRequired, (req, res) => {
  const { ids, target_id, payterm, payout } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || !target_id)
    return res.status(400).json({ error: 'ids[] and target_id are required' });

  const target = db.get('SELECT * FROM users WHERE id=?', [target_id]);
  if (!target) return res.status(404).json({ error: 'Target not found' });

  const wantRole = { admin: 'manager', manager: 'agent', agent: 'client' }[req.user.role];
  if (!wantRole || target.role !== wantRole || target.parent_id !== req.user.id)
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
    // Manager -> Agent: keep manager chain and reset client ownership.
    const mgrId = target.parent_id;
    sets = "agent_id=?, manager_id=?, client_id=NULL, payout='0', rate=''";
    vals = [target.id, mgrId];
  } else if (target.role === 'client') {
    // Agent -> Client: snapshot chain for future SMS.
    const agentId = target.parent_id;
    const mgrId = agentId ? (db.get('SELECT parent_id FROM users WHERE id=?', [agentId])?.parent_id || null) : null;
    sets = 'client_id=?, agent_id=?, manager_id=?';
    vals = [target.id, agentId, mgrId];
  }
  if (payterm) { sets += ', payterm=?'; vals.push(payterm); }
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

  const vacuum = db.vacuum();
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

// smart divide: multi-range + multi-target, split UNALLOCATED evenly
app.post('/api/numbers/smart-divide', authRequired, (req, res) => {
  const { range_ids, target_ids, qty } = req.body || {};
  if (!Array.isArray(range_ids) || !range_ids.length || !Array.isArray(target_ids) || !target_ids.length || !qty)
    return res.status(400).json({ error: 'range_ids[], target_ids[], qty required' });

  const wantRole = { admin: 'manager', manager: 'agent', agent: 'client' }[req.user.role];
  // validate targets are children
  for (const tid of target_ids) {
    const t = db.get('SELECT * FROM users WHERE id=?', [tid]);
    if (!t || t.role !== wantRole || t.parent_id !== req.user.id)
      return res.status(403).json({ error: 'Invalid target(s)' });
  }
  const col = { manager: 'manager_id', agent: 'agent_id', client: 'client_id' }[wantRole];
  // "unallocated at this level" = the ownership column is null AND belongs to caller upstream
  let ownerCond = '1=1', ownerParams = [];
  if (req.user.role === 'manager') { ownerCond = 'manager_id=?'; ownerParams = [req.user.id]; }
  else if (req.user.role === 'agent') { ownerCond = 'agent_id=?'; ownerParams = [req.user.id]; }

  let total = 0; const report = [];
  for (const rid of range_ids) {
    const pool = db.all(
      `SELECT id FROM numbers WHERE range_id=? AND ${col} IS NULL AND ${ownerCond} LIMIT ?`,
      [rid, ...ownerParams, qty]
    );
    const take = pool.length;
    const perBase = Math.floor(take / target_ids.length);
    let rem = take % target_ids.length, ptr = 0;
    const split = target_ids.map(t => { const c = perBase + (rem > 0 ? 1 : 0); if (rem > 0) rem--; return { t, c }; });
    for (const s of split) {
      for (let k = 0; k < s.c; k++) {
        const nid = pool[ptr++].id;
        // set ownership + parent chain
        if (wantRole === 'client') {
          const agt = db.get('SELECT parent_id FROM users WHERE id=?', [s.t]);
          const mgr = agt ? db.get('SELECT parent_id FROM users WHERE id=?', [agt.parent_id]) : null;
          db.run('UPDATE numbers SET client_id=?, agent_id=?, manager_id=? WHERE id=?',
            [s.t, agt ? agt.parent_id : null, mgr ? mgr.parent_id : null, nid]);
        } else if (wantRole === 'agent') {
          const mgr = db.get('SELECT parent_id FROM users WHERE id=?', [s.t]);
          db.run("UPDATE numbers SET agent_id=?, manager_id=?, client_id=NULL, payout='0', rate='' WHERE id=?", [s.t, mgr ? mgr.parent_id : null, nid]);
        } else {
          db.run("UPDATE numbers SET manager_id=?, agent_id=NULL, client_id=NULL, payout='0', rate='' WHERE id=?", [s.t, nid]);
        }
      }
    }
    total += take;
    const rname = db.get('SELECT name FROM ranges WHERE id=?', [rid]);
    report.push({ range: rname ? rname.name : rid, taken: take, split });
  }
  logAction(req,'smart_divide_numbers','numbers',{total,report});
  res.json({ ok: true, total, report });
});

/* ============ SMS RECORDS / CDR STATS ============ */
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
app.get('/api/dashboard', authRequired, (req, res) => {
  const u = req.user;
  const smsScope = smsScopeWhere(u);
  const numScope = numberScopeWhere(u);
  const dExpr = ukDateExpr('received_at');
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
  const rows7 = smsRowsForScope(u, `${ukDateExpr('s.received_at')} >= ${ukDateNowSql('-6 days')}`);
  const rowsMonth = smsRowsForScope(u, `strftime('%Y-%m',${ukDateTimeExpr('s.received_at')})=strftime('%Y-%m',datetime('now','${ukSqlModifier()}'))`);
  const daily7 = [];
  for (let i = 6; i >= 0; i--) {
    const r = db.get(`SELECT ${ukDateNowSql('-'+i+' days')} d, COUNT(*) c FROM sms_records WHERE ${smsScope.where} AND ${normalSms} AND ${ukDateExpr('received_at')}=${ukDateNowSql('-'+i+' days')}`, smsScope.params);
    daily7.push({ date: r?.d || '', count: r?.c || 0 });
  }
  const recent = smsRowsForScope(u).slice(0,5).map(r=>({received_at:r.received_at,number:r.number,cli:r.cli,message:r.message,range_name:r.range_name,payout_rate:r.payout_rate}));
  res.json({
    sms_today: today,
    sms_yesterday: yesterday,
    sms_7d: d7,
    sms_month: month,
    payout_7d: sumPayout(rows7),
    payout_month: sumPayout(rowsMonth),
    managers, agents, clients, numbers,
    daily7,
    recent
  });
});

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
app.get('/api/payments', authRequired, (req, res) => {
  const ids = scopeIds(req.user);
  const ph = ids.map(() => '?').join(',');
  const rows = db.all(
    `SELECT p.*, u.username FROM payments p JOIN users u ON u.id=p.user_id
     WHERE p.user_id IN (${ph}) ORDER BY p.id DESC`, ids);
  res.json(rows);
});

/* ============ CLI LIMITS ============ */
app.get('/api/cli-limits', authRequired, (req, res) => {
  if (req.user.role === 'admin') return res.json(db.all('SELECT * FROM cli_limits ORDER BY id DESC'));
  // manager: only overall + specific-to-me
  const rows = db.all(
    `SELECT * FROM cli_limits WHERE type='overall' OR manager_id=? ORDER BY id DESC`, [req.user.id]);
  res.json(rows);
});
app.post('/api/cli-limits', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.cli || !b.limit_val) return res.status(400).json({ error: 'cli & limit required' });
  db.run('INSERT INTO cli_limits (cli,type,manager_id,limit_val,used) VALUES (?,?,?,?,0)',
    [b.cli, b.type || 'overall', b.type === 'specific' ? b.manager_id : null, b.limit_val]);
  res.json({ ok: true });
});
app.delete('/api/cli-limits/:id', authRequired, requireRole('admin'), (req, res) => {
  db.run('DELETE FROM cli_limits WHERE id=?', [+req.params.id]);
  res.json({ ok: true });
});

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

/* ============ NEWS ============ */
app.get('/api/news', authRequired, (req, res) => {
  if (req.user.role === 'admin') return res.json(db.all('SELECT * FROM news ORDER BY id DESC'));
  const rows = db.all(
    `SELECT * FROM news WHERE active=1 AND (audience='all' OR audience=?) ORDER BY id DESC`,
    [req.user.role]);
  res.json(rows);
});
app.post('/api/news', authRequired, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.body) return res.status(400).json({ error: 'title & body required' });
  db.run('INSERT INTO news (title,body,audience,created_by) VALUES (?,?,?,?)',
    [b.title, b.body, b.audience || 'all', 'Admin']);
  res.json({ ok: true });
});
app.delete('/api/news/:id', authRequired, requireRole('admin'), (req, res) => {
  db.run('DELETE FROM news WHERE id=?', [+req.params.id]);
  res.json({ ok: true });
});



/* ============ PAYMENT CONFIG / EARNINGS / WITHDRAWALS ============ */
const PAYOUT_RATE = 0.013;
function pad2(n){ return String(n).padStart(2,'0'); }
function dateOnly(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function getPaymentConfig(){
  let c = db.get('SELECT * FROM payment_config ORDER BY id ASC LIMIT 1');
  if(!c){ db.run(`INSERT INTO payment_config (cycle_type,start_day,end_day,release_day,timezone) VALUES ('weekly',1,0,1,'UTC')`); c=db.get('SELECT * FROM payment_config ORDER BY id ASC LIMIT 1'); }
  return c;
}
function cycleBounds(config, offset=0){
  const now=startOfDay(new Date());
  const type=(config.cycle_type||'weekly').toLowerCase();
  if(type==='custom' && config.custom_start && config.custom_end){
    let s=new Date(config.custom_start+'T00:00:00'), e=new Date(config.custom_end+'T23:59:59');
    const len=Math.max(1, Math.round((startOfDay(e)-startOfDay(s))/86400000)+1);
    if(offset<0){ s=addDays(s, offset*len); e=addDays(e, offset*len); }
    return { start:dateOnly(s), end:dateOnly(e), release: config.custom_release || dateOnly(addDays(e,1)) };
  }
  if(type==='monthly'){
    const monthStart=new Date(now.getFullYear(), now.getMonth()+offset, 1);
    const monthEnd=new Date(now.getFullYear(), now.getMonth()+offset+1, 0);
    const relDay=Number(config.release_day||1);
    const release=new Date(now.getFullYear(), now.getMonth()+offset+1, Math.max(1,relDay));
    return { start:dateOnly(monthStart), end:dateOnly(monthEnd), release:dateOnly(release) };
  }
  const startDay=Number(config.start_day ?? 1); // 0 Sun, 1 Mon
  const span=type==='biweekly'?14:7;
  const diff=(now.getDay()-startDay+7)%7;
  let start=addDays(now,-diff + offset*span);
  let end=addDays(start,span-1);
  let release=addDays(end,1);
  return { start:dateOnly(start), end:dateOnly(end), release:dateOnly(release) };
}
function smsCountForUser(user, start, end){
  let scope=smsScopeWhere(user);
  const row=db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${scope.where} AND date(received_at) BETWEEN date(?) AND date(?)`, [...scope.params,start,end]);
  return row?.c||0;
}
function lifetimeCountForUser(user){
  let scope=smsScopeWhere(user);
  const row=db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${scope.where}`, scope.params);
  return row?.c||0;
}
app.get('/api/payment-config', authRequired, (req,res)=>{
  const config=getPaymentConfig();
  res.json({ ...config, current_cycle:cycleBounds(config,0), last_cycle:cycleBounds(config,-1) });
});
app.put('/api/payment-config', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const type=['weekly','biweekly','monthly','custom'].includes((b.cycle_type||'').toLowerCase()) ? b.cycle_type.toLowerCase() : 'weekly';
  const existing=getPaymentConfig();
  db.run(`UPDATE payment_config SET cycle_type=?,start_day=?,end_day=?,release_day=?,custom_start=?,custom_end=?,custom_release=?,timezone=?,updated_at=datetime('now') WHERE id=?`,
    [type, Number(b.start_day||1), Number(b.end_day||0), Number(b.release_day||1), b.custom_start||'', b.custom_end||'', b.custom_release||'', b.timezone||'UTC', existing.id]);
  const config=getPaymentConfig();
  logAction(req,'update_payment_config','payments',config);
  res.json({ ok:true, config, current_cycle:cycleBounds(config,0), last_cycle:cycleBounds(config,-1) });
});
app.get('/api/earnings-summary', authRequired, (req,res)=>{
  const config=getPaymentConfig();
  const cur=cycleBounds(config,0), last=cycleBounds(config,-1);
  const currentRows=smsRowsForScope(req.user, `date(s.received_at) BETWEEN date(?) AND date(?)`, [cur.start, cur.end]);
  const lastRows=smsRowsForScope(req.user, `date(s.received_at) BETWEEN date(?) AND date(?)`, [last.start, last.end]);
  const monthStart=dateOnly(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const monthEnd=dateOnly(new Date(new Date().getFullYear(), new Date().getMonth()+1, 0));
  const monthRows=smsRowsForScope(req.user, `date(s.received_at) BETWEEN date(?) AND date(?)`, [monthStart, monthEnd]);
  const lifeRows=smsRowsForScope(req.user);
  res.json({
    config,
    current_cycle:cur,
    last_cycle:last,
    cards:{
      this_payment_cycle:sumPayout(currentRows),
      last_payment_cycle:sumPayout(lastRows),
      this_month:sumPayout(monthRows),
      lifetime:sumPayout(lifeRows)
    },
    sms:{ this_payment_cycle:currentRows.length, last_payment_cycle:lastRows.length, this_month:monthRows.length, lifetime:lifeRows.length }
  });
});
function userManagerId(u){
  if(u.role==='manager') return u.id;
  if(u.role==='agent') return db.get('SELECT parent_id FROM users WHERE id=?',[u.id])?.parent_id || null;
  if(u.role==='client'){
    const ag=db.get('SELECT parent_id FROM users WHERE id=?',[u.id]);
    return ag ? (db.get('SELECT parent_id FROM users WHERE id=?',[ag.parent_id])?.parent_id || null) : null;
  }
  return null;
}
app.get('/api/withdrawals', authRequired, (req,res)=>{
  let where='1=1', params=[];
  if(req.user.role==='manager'){ where='(w.user_id=? OR w.manager_id=?)'; params=[req.user.id,req.user.id]; }
  else if(req.user.role==='agent'){ where='w.user_id=?'; params=[req.user.id]; }
  else if(req.user.role==='client'){ return res.json([]); }
  const rows=db.all(`SELECT w.*, u.username, u.name, u.role, m.username AS manager_username
    FROM withdrawal_requests w
    JOIN users u ON u.id=w.user_id
    LEFT JOIN users m ON m.id=w.manager_id
    WHERE ${where} ORDER BY w.id DESC`, params);
  res.json(rows);
});
app.post('/api/withdrawals', authRequired, (req,res)=>{
  if(!['manager','agent'].includes(req.user.role)) return res.status(403).json({ error:'Only Manager or Agent can submit withdrawal requests' });
  const b=req.body||{}; const amount=Number(b.amount||0);
  if(!amount || amount<=0) return res.status(400).json({ error:'Valid amount required' });
  if(!b.wallet_address) return res.status(400).json({ error:'Binance wallet address required' });
  const status=req.user.role==='manager'?'Forwarded':'Pending';
  const managerId=userManagerId(req.user);
  db.run(`INSERT INTO withdrawal_requests (user_id,user_role,manager_id,amount,wallet_address,payment_method,status,forwarded_at)
          VALUES (?,?,?,?,?,?,?,${status==='Forwarded'?"datetime('now')":"NULL"})`,
    [req.user.id, req.user.role, managerId, amount, String(b.wallet_address).trim(), b.payment_method||'Binance', status]);
  logAction(req,'create_withdrawal_request','withdrawals',{amount,status});
  res.json({ ok:true, status });
});
app.post('/api/withdrawals/:id/forward', authRequired, requireRole('manager'), (req,res)=>{
  const id=+req.params.id;
  const w=db.get('SELECT * FROM withdrawal_requests WHERE id=?',[id]);
  if(!w) return res.status(404).json({ error:'Request not found' });
  if(w.manager_id!==req.user.id && w.user_id!==req.user.id) return res.status(403).json({ error:'Not your request' });
  if(w.status!=='Pending') return res.status(400).json({ error:'Only pending requests can be forwarded' });
  db.run(`UPDATE withdrawal_requests SET status='Forwarded', manager_note=?, forwarded_at=datetime('now') WHERE id=?`, [(req.body||{}).manager_note||'', id]);
  logAction(req,'forward_withdrawal','withdrawals',{id});
  res.json({ ok:true });
});
app.post('/api/withdrawals/:id/status', authRequired, requireRole('admin'), (req,res)=>{
  const id=+req.params.id; const b=req.body||{};
  const allowed=['Approved','Rejected','Done'];
  if(!allowed.includes(b.status)) return res.status(400).json({ error:'Invalid status' });
  const col=b.status==='Approved'?'approved_at':(b.status==='Rejected'?'rejected_at':'done_at');
  db.run(`UPDATE withdrawal_requests SET status=?, admin_note=?, screenshot_url=?, ${col}=datetime('now') WHERE id=?`, [b.status,b.admin_note||'',b.screenshot_url||'',id]);
  logAction(req,'admin_withdrawal_status','withdrawals',{id,status:b.status});
  res.json({ ok:true });
});

/* ============ INTEGRATION CONNECTORS ============ */
app.get('/api/integration-connectors', authRequired, (req,res)=>{
  res.json(db.all('SELECT * FROM integration_connectors ORDER BY id DESC'));
});
app.post('/api/integration-connectors', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  if(!b.name || !b.connector_type) return res.status(400).json({ error:'name and connector_type required' });
  db.run(`INSERT INTO integration_connectors (name,connector_type,direction,status,endpoint_url,config_json,notes) VALUES (?,?,?,?,?,?,?)`,
    [b.name,b.connector_type,b.direction||'both',b.status||'disabled',b.endpoint_url||'',b.config_json||'{}',b.notes||'']);
  logAction(req,'create_integration_connector','integrations',b.name);
  res.json({ ok:true });
});
app.put('/api/integration-connectors/:id', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  db.run(`UPDATE integration_connectors SET name=?,connector_type=?,direction=?,status=?,endpoint_url=?,config_json=?,notes=?,updated_at=datetime('now') WHERE id=?`,
    [b.name||'',b.connector_type||'API',b.direction||'both',b.status||'disabled',b.endpoint_url||'',b.config_json||'{}',b.notes||'',+req.params.id]);
  logAction(req,'update_integration_connector','integrations',{id:+req.params.id});
  res.json({ ok:true });
});
app.delete('/api/integration-connectors/:id', authRequired, requireRole('admin'), (req,res)=>{
  db.run('DELETE FROM integration_connectors WHERE id=?',[+req.params.id]);
  logAction(req,'delete_integration_connector','integrations',{id:+req.params.id});
  res.json({ ok:true });
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
  // Runtime mode is HTTP only. SMPP fields may exist in old DBs, but are not used or enabled.
  res.json({ ...c, smpp_host:'', smpp_port:'', smpp_system_id:'', smpp_password:'', smpp_bind_type:'disabled', smpp_enabled:0, ...carrierRuntimeStatus(), integration_mode: 'HTTP', generated_callback_url: publicCallbackUrl(req), endpoint_path:'/api/incoming-sms' });
});
app.put('/api/carrier-settings', authRequired, requireRole('admin'), (req,res)=>{
  if (!requireCarrierLock(req, res)) return;
  const b=req.body||{};
  const c=getCarrierSettings();
  // Force SMPP disabled at settings level too. No SMPP connect/reconnect loop exists in runtime.
  db.run(`UPDATE carrier_settings SET integration_status=?,carrier_ip=?,http_callback_url=?,api_key=?,auth_token=?,smpp_host='',smpp_port='',smpp_system_id='',smpp_password='',smpp_bind_type='disabled',smpp_enabled=0,notes=?,retention_days=?,updated_at=datetime('now') WHERE id=?`,
    [b.integration_status==='enabled'?'enabled':'disabled', b.carrier_ip||'', b.http_callback_url||'/api/incoming-sms', b.api_key||'', b.auth_token||'', b.notes||'', parseInt(b.retention_days||30), c.id]);
  cleanupWebhookLogs(b.retention_days||30);
  logAction(req,'update_carrier_settings','carrier_integration',{carrier_ip:b.carrier_ip,status:b.integration_status,mode:'HTTP_ONLY'});
  res.json({ ok:true, settings:{...getCarrierSettings(), smpp_host:'', smpp_port:'', smpp_system_id:'', smpp_password:'', smpp_bind_type:'disabled', smpp_enabled:0, ...carrierRuntimeStatus()}, generated_callback_url: publicCallbackUrl(req) });
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
  const retryRate=payoutRateFromRow({...rangeForRetry, number_rate:n.rate, number_payout:n.payout});
  const retrySenderType=classifySender(f.cli||'');
  const retryOtpCode=extractOtpCode(f.message||'');
  db.run(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,manager_id,payout_rate,payout_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [n.id,n.number,n.range_id,f.cli||'',retrySenderType,f.message||'',retryOtpCode,n.client_id,n.agent_id,n.manager_id,retryRate,retryRate]);
  const smsRow={number_id:n.id,number:n.number,range_id:n.range_id,cli:f.cli||'',sender_type:retrySenderType,message:f.message||'',otp_code:retryOtpCode,client_id:n.client_id,agent_id:n.agent_id,manager_id:n.manager_id};
  checkSmsMilestoneNotifications(smsRow);
  db.run(`UPDATE failed_sms_queue SET status='Retried',retry_count=retry_count+1,updated_at=datetime('now') WHERE id=?`,[id]);
  logAction(req,'retry_failed_sms','failed_sms_queue',{id,number:n.number});
  res.json({ ok:true });
});
app.delete('/api/failed-sms/:id', authRequired, requireRole('admin'), (req,res)=>{
  db.run(`UPDATE failed_sms_queue SET status='Ignored',updated_at=datetime('now') WHERE id=?`,[+req.params.id]);
  logAction(req,'ignore_failed_sms','failed_sms_queue',{id:+req.params.id});
  res.json({ ok:true });
});

/* ============ NOTIFICATION RULES / EVENTS / PREFERENCES ============ */
app.get('/api/notification-rules', authRequired, requireRole('admin'), (req,res)=>{
  res.json(db.all('SELECT * FROM notification_rules WHERE scope<>\'number\' ORDER BY id DESC'));
});
app.post('/api/notification-rules', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  if(!b.name) return res.status(400).json({ error:'Rule name required' });
  if(b.scope==='number') return res.status(400).json({ error:'Number-wise notifications disabled' });
  db.run('INSERT INTO notification_rules (name,scope,period,thresholds,notify_roles,active) VALUES (?,?,?,?,?,?)',
    [b.name,b.scope||'global',b.period||'daily',b.thresholds||'100,500,1000,5000,10000',b.notify_roles||'admin',b.active===false?0:1]);
  logAction(req,'create_notification_rule','notifications',b.name);
  res.json({ ok:true });
});
app.put('/api/notification-rules/:id', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  if(b.scope==='number') return res.status(400).json({ error:'Number-wise notifications disabled' });
  db.run('UPDATE notification_rules SET name=?,scope=?,period=?,thresholds=?,notify_roles=?,active=? WHERE id=?',
    [b.name||'',b.scope||'global',b.period||'daily',b.thresholds||'',b.notify_roles||'admin',b.active?1:0,+req.params.id]);
  logAction(req,'update_notification_rule','notifications',{id:+req.params.id});
  res.json({ ok:true });
});
app.delete('/api/notification-rules/:id', authRequired, requireRole('admin'), (req,res)=>{
  db.run('DELETE FROM notification_rules WHERE id=?',[+req.params.id]);
  logAction(req,'delete_notification_rule','notifications',{id:+req.params.id});
  res.json({ ok:true });
});
app.get('/api/notifications', authRequired, (req,res)=>{
  const rows=db.all(`SELECT un.id AS user_notification_id, un.read_at, ne.*
    FROM user_notifications un JOIN notification_events ne ON ne.id=un.event_id
    WHERE un.user_id=? ORDER BY un.id DESC LIMIT 100`, [req.user.id]);
  res.json(rows);
});
app.get('/api/notifications/unread-count', authRequired, (req,res)=>{
  const c=db.get('SELECT COUNT(*) c FROM user_notifications WHERE user_id=? AND read_at IS NULL',[req.user.id])?.c||0;
  res.json({ count:c });
});
app.post('/api/notifications/:id/read', authRequired, (req,res)=>{
  db.run(`UPDATE user_notifications SET read_at=datetime('now') WHERE id=? AND user_id=?`,[+req.params.id,req.user.id]);
  res.json({ ok:true });
});
app.post('/api/notifications/read-all', authRequired, (req,res)=>{
  db.run(`UPDATE user_notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL`,[req.user.id]);
  res.json({ ok:true });
});
app.get('/api/preferences', authRequired, (req,res)=>res.json(ensurePrefs(req.user.id)));
app.put('/api/preferences', authRequired, (req,res)=>{
  ensurePrefs(req.user.id);
  const b=req.body||{};
  db.run(`UPDATE user_preferences SET notification_sound=?,notification_popup=?,updated_at=datetime('now') WHERE user_id=?`,
    [b.notification_sound?1:0,b.notification_popup?1:0,req.user.id]);
  res.json(ensurePrefs(req.user.id));
});


/* ============ QA TEST SMS GENERATOR ============ */
function getQaSettings(){
  let row=db.get('SELECT * FROM qa_test_settings ORDER BY id ASC LIMIT 1');
  if(!row){db.run(`INSERT INTO qa_test_settings (enabled,max_batch_size,default_cli,default_message) VALUES (0,100,'TestCLI','Your test verification code is {code}')`); row=db.get('SELECT * FROM qa_test_settings ORDER BY id ASC LIMIT 1');}
  return row;
}
function makeBatchId(){ return 'TEST-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,8).toUpperCase(); }
function randomCode(){ return String(100000 + Math.floor(Math.random()*900000)); }
app.get('/api/test-generator/settings', authRequired, requireRole('admin'), (req,res)=>{
  res.json(getQaSettings());
});
app.put('/api/test-generator/settings', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{}; const cur=getQaSettings();
  db.run(`UPDATE qa_test_settings SET enabled=?, max_batch_size=?, default_cli=?, default_message=?, updated_at=datetime('now') WHERE id=?`,
    [b.enabled?1:0, Math.max(1, Math.min(1000, parseInt(b.max_batch_size||100))), b.default_cli||'TestCLI', b.default_message||'Your test verification code is {code}', cur.id]);
  logAction(req,'update_test_generator_settings','test_generator',{enabled:!!b.enabled});
  res.json({ok:true, settings:getQaSettings()});
});
app.post('/api/test-generator/generate', authRequired, requireRole('admin'), (req,res)=>{
  const settings=getQaSettings();
  if(!settings.enabled) return res.status(403).json({error:'Test SMS Generator is disabled'});
  const b=req.body||{};
  const qty=Math.max(1, Math.min(parseInt(b.quantity||1), parseInt(settings.max_batch_size||100)));
  let numbers=[];
  if(b.number){ numbers=[String(b.number).trim()]; }
  else if(Array.isArray(b.numbers) && b.numbers.length){ numbers=b.numbers.map(x=>String(x).trim()).filter(Boolean); }
  else {
    numbers=db.all('SELECT number FROM numbers WHERE client_id IS NOT NULL ORDER BY id DESC LIMIT ?', [qty]).map(x=>x.number);
  }
  if(!numbers.length) return res.status(400).json({error:'No target numbers selected/found. Allocate at least one number to a client first.'});
  const batchId=makeBatchId();
  const cli=b.cli||settings.default_cli||'TestCLI';
  let ok=0, failed=0, results=[];
  for(let i=0;i<qty;i++){
    const target=numbers[i % numbers.length];
    const code=randomCode();
    const template=(b.message||settings.default_message||'Your test verification code is {code}');
    const msg=template.replaceAll('{code}',code).replaceAll('{number}',target).replaceAll('{index}',String(i+1));
    const result=processIncomingSmsPayload(req,{number:target,cli,message:msg,test:true,test_batch_id:batchId},'TEST_GENERATOR',{isTest:1,testBatchId:batchId,source:'test_generator'});
    if(result.status===200) ok++; else failed++;
    results.push({number:target,status:result.status,body:result.body});
  }
  logAction(req,'generate_test_sms','test_generator',{batchId,ok,failed,quantity:qty});
  res.json({ok:true,batch_id:batchId,generated:ok,failed,results});
});
app.post('/api/test-generator/clear', authRequired, requireRole('admin'), (req,res)=>{
  const count=db.get('SELECT COUNT(*) c FROM sms_records WHERE is_test=1')?.c||0;
  db.run('DELETE FROM sms_records WHERE is_test=1');
  logAction(req,'clear_test_sms','test_generator',{count});
  res.json({ok:true,deleted:count});
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
  let smsPayoutRate=payoutRateFromRow({...rangeForSms, number_rate:n.rate, number_payout:n.payout});
  let limitReason = '';
  if (incomingHasZeroPayout(b)) {
    smsPayoutRate = '0';
    limitReason = 'external_payout_zero';
  } else if (!opts.isTest) {
    const limitStatus = evaluateDailyPayoutLimits(n, cli || '');
    if (limitStatus.exceeded) { smsPayoutRate = '0'; limitReason = limitStatus.reason; }
  }
  db.run(`INSERT INTO sms_records (number_id,number,range_id,cli,sender_type,message,otp_code,client_id,agent_id,manager_id,is_test,test_batch_id,source,payout_rate,payout_amount,limit_reason)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [n.id, n.number, n.range_id, cli || '', senderType, message || '', otpCode, n.client_id, n.agent_id, n.manager_id, opts.isTest?1:0, opts.testBatchId||'', opts.source||'carrier', smsPayoutRate, smsPayoutRate, limitReason]);
  const saved = db.get('SELECT id, received_at FROM sms_records ORDER BY id DESC LIMIT 1');
  const smsRow = { number_id:n.id, number:n.number, range_id:n.range_id, cli:cli||'', sender_type:senderType, message:message||'', otp_code:otpCode, client_id:n.client_id, agent_id:n.agent_id, manager_id:n.manager_id, is_test: opts.isTest?1:0 };
  logWebhook('success', b, number, n.number, cli, message, '', sourceIp);
  console.log('[INCOMING_SMS] saved', { id: saved ? saved.id : null, number: n.number, cli: cli || '', sender_type: senderType, otp_detected: !!otpCode, source: opts.source || 'carrier', manager_id: n.manager_id || null, agent_id: n.agent_id || null, client_id: n.client_id || null });
  checkSmsMilestoneNotifications(smsRow);
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
  app.listen(PORT, () => console.log(`\n✅ Mufasa SMS backend running: http://localhost:${PORT}\n`));
})();
