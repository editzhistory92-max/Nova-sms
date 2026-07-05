/**
 * Mufasa SMS — Backend API
 * Node.js + Express + SQLite (sql.js). MySQL-ready SQL.
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (_) {}
const bcrypt = require('bcryptjs');
const db = require('./db');
const { createTables } = require('./schema');
const { seed } = require('./seed');
const { sign, authRequired, requireRole, descendantIds } = require('./auth');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// serve the frontend panels (login/admin/manager/agent/client .html) from parent dir
app.use(express.static(path.join(__dirname, '..')));

app.get('/health', (req, res) => res.json({ ok: true, service: 'Mufasa SMS', time: new Date().toISOString() }));
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'Mufasa SMS', time: new Date().toISOString() }));

/* ============ helpers ============ */
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
  const candidates=[r.payout_rate,r.sms_payout_rate,r.number_payout,r.number_rate,r.rate_30_45,r.rate_7_1,r.rate_7_7,r.rate_1_1];
  for(const c of candidates){ const v=normalizeDecimalString(c); if(isPositiveDecimal(v)) return v; }
  return '0';
}
function attachSmsPayoutFields(rows){
  return (rows||[]).map(r=>{ const rate=payoutRateFromRow(r); return {...r,payout_rate:rate,payout_amount:rate}; });
}
function sumPayout(rows){ return (rows||[]).reduce((s,r)=>decimalAdd(s,r.payout_amount ?? r.payout_rate ?? payoutRateFromRow(r)), '0'); }
function smsRowsForScope(user, extraWhere='', extraParams=[]){
  const scope=smsScopeWhere(user,'s');
  const where=[scope.where]; const params=[...scope.params];
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
  const u = db.get('SELECT * FROM users WHERE username=?', [username.toLowerCase().trim()]);
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

  // permission: who can create what
  const allowed = { admin: 'manager', manager: 'agent', agent: 'client' };
  if (allowed[req.user.role] !== role)
    return res.status(403).json({ error: `You are not allowed to create this role` });

  // role-specific required fields
  if (role === 'manager' && !email) return res.status(400).json({ error: 'Manager email is required' });
  if (role === 'agent' && !whatsapp) return res.status(400).json({ error: 'Agent WhatsApp number is required' });

  const exists = db.get('SELECT id FROM users WHERE username=?', [username.toLowerCase().trim()]);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  db.run(
    `INSERT INTO users (username,password,role,name,email,whatsapp,contact,skype,parent_id,active)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [username.toLowerCase().trim(), bcrypt.hashSync(password, 10), role, name || '', email || '',
     whatsapp || '', contact || '', skype || '', req.user.id, active === false ? 0 : 1]
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
  // Test panel numbers are separate from actual panel numbers. If a test number exists in SMS Numbers table, it is hidden here.
  const rows = db.all(`SELECT t.id, t.range_id, t.test_number AS number, t.label, r.name AS range_name, r.prefix,
      COALESCE(NULLIF(r.rate_30_45,''), NULLIF(r.rate_7_1,''), 'Ask') AS payout
    FROM range_test_numbers t
    JOIN ranges r ON r.id=t.range_id
    WHERE t.active=1
      AND NOT EXISTS (
        SELECT 1 FROM numbers n
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(n.number,'+',''),' ',''),'-',''),'_','') =
              REPLACE(REPLACE(REPLACE(REPLACE(t.test_number,'+',''),' ',''),'-',''),'_','')
      )
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



/* ============ NUMBERS ============ */
// list numbers visible to caller (based on ownership column for their level)
app.get('/api/numbers', authRequired, (req, res) => {
  const u = req.user;
  let where = '1=1', params = [];
  if (u.role === 'manager') { where = 'n.manager_id=?'; params = [u.id]; }
  else if (u.role === 'agent') { where = 'n.agent_id=?'; params = [u.id]; }
  else if (u.role === 'client') { where = 'n.client_id=?'; params = [u.id]; }
  const rows = db.all(
    `SELECT n.*, r.name AS range_name,
            cu.username AS client_name, au.username AS agent_name, mu.username AS manager_name
     FROM numbers n
     LEFT JOIN ranges r ON r.id=n.range_id
     LEFT JOIN users cu ON cu.id=n.client_id
     LEFT JOIN users au ON au.id=n.agent_id
     LEFT JOIN users mu ON mu.id=n.manager_id
     WHERE ${where} ORDER BY n.number ASC`, params);
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
    sets = 'manager_id=?, agent_id=NULL, client_id=NULL';
    vals = [target.id];
  } else if (target.role === 'agent') {
    // Manager -> Agent: keep manager chain and reset client ownership.
    const mgrId = target.parent_id;
    sets = 'agent_id=?, manager_id=?, client_id=NULL';
    vals = [target.id, mgrId];
  } else if (target.role === 'client') {
    // Agent -> Client: snapshot chain for future SMS.
    const agentId = target.parent_id;
    const mgrId = agentId ? (db.get('SELECT parent_id FROM users WHERE id=?', [agentId])?.parent_id || null) : null;
    sets = 'client_id=?, agent_id=?, manager_id=?';
    vals = [target.id, agentId, mgrId];
  }
  if (payterm) { sets += ', payterm=?'; vals.push(payterm); }
  if (payout !== undefined && payout !== '') { sets += ', payout=?'; vals.push(String(payout)); }

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
    updateSql = `UPDATE numbers SET manager_id=NULL, agent_id=NULL, client_id=NULL WHERE id IN (${ph})`;
  } else if (req.user.role === 'manager') {
    where = `id IN (${ph}) AND manager_id=?`;
    params = [...ids, req.user.id];
    updateSql = `UPDATE numbers SET agent_id=NULL, client_id=NULL WHERE id IN (${ph}) AND manager_id=?`;
  } else if (req.user.role === 'agent') {
    where = `id IN (${ph}) AND agent_id=?`;
    params = [...ids, req.user.id];
    updateSql = `UPDATE numbers SET client_id=NULL WHERE id IN (${ph}) AND agent_id=?`;
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
          db.run('UPDATE numbers SET agent_id=?, manager_id=?, client_id=NULL WHERE id=?', [s.t, mgr ? mgr.parent_id : null, nid]);
        } else {
          db.run('UPDATE numbers SET manager_id=?, agent_id=NULL, client_id=NULL WHERE id=?', [s.t, nid]);
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
  const today = db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${smsScope.where} AND date(received_at)=date('now')`, smsScope.params)?.c || 0;
  const yesterday = db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${smsScope.where} AND date(received_at)=date('now','-1 day')`, smsScope.params)?.c || 0;
  const d7 = db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${smsScope.where} AND received_at >= datetime('now','-7 days')`, smsScope.params)?.c || 0;
  const month = db.get(`SELECT COUNT(*) c FROM sms_records WHERE ${smsScope.where} AND strftime('%Y-%m',received_at)=strftime('%Y-%m','now')`, smsScope.params)?.c || 0;
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
  const rows7 = smsRowsForScope(u, `s.received_at >= datetime('now','-7 days')`);
  const rowsMonth = smsRowsForScope(u, `strftime('%Y-%m',s.received_at)=strftime('%Y-%m','now')`);
  const daily7 = [];
  for (let i = 6; i >= 0; i--) {
    const r = db.get(`SELECT date('now','-${i} days') d, COUNT(*) c FROM sms_records WHERE ${smsScope.where} AND date(received_at)=date('now','-${i} days')`, smsScope.params);
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

/* ============ NUMBER IMPORT (Admin only) ============ */
app.post('/api/numbers/import', authRequired, requireRole('admin'), (req, res) => {
  const { range_id, range_name, prefix, numbers, payterm, payout } = req.body || {};
  if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: 'numbers[] required' });
  let rid = range_id ? +range_id : null;
  if (!rid) {
    if (!range_name) return res.status(400).json({ error: 'range_id or range_name is required' });
    const existing = db.get('SELECT id FROM ranges WHERE name=?', [range_name]);
    if (existing) rid = existing.id;
    else {
      db.run(`INSERT INTO ranges (name,prefix,test_number,currency) VALUES (?,?,?,?)`, [range_name, prefix || '', '', 'USD']);
      rid = db.get('SELECT id FROM ranges WHERE name=? ORDER BY id DESC', [range_name]).id;
    }
  }
  let inserted = 0, skipped = 0;
  for (const raw of numbers) {
    const number = String(raw || '').trim();
    if (!number) { skipped++; continue; }
    const exists = db.get('SELECT id FROM numbers WHERE number=?', [number]);
    if (exists) { skipped++; continue; }
    const ins = db.run(`INSERT INTO numbers (range_id,number,prefix,payterm,payout) VALUES (?,?,?,?,?)`,
      [rid, number, prefix || '', payterm || 'Weekly', payout || '0']);
    logNumberHistory(req,{id:ins.lastInsertRowid,number},'imported','','available',{range_id:rid});
    inserted++;
  }
  logAction(req,'import_numbers','numbers',{inserted,skipped,range_id:rid});
  res.json({ ok: true, inserted, skipped, range_id: rid });
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
  const c=getCarrierSettings();
  res.json({ ...c, ...carrierRuntimeStatus(), generated_callback_url: publicCallbackUrl(req), endpoint_path:'/api/incoming-sms' });
});
app.put('/api/carrier-settings', authRequired, requireRole('admin'), (req,res)=>{
  const b=req.body||{};
  const c=getCarrierSettings();
  db.run(`UPDATE carrier_settings SET integration_status=?,carrier_ip=?,http_callback_url=?,api_key=?,auth_token=?,smpp_host=?,smpp_port=?,smpp_system_id=?,smpp_password=?,notes=?,retention_days=?,updated_at=datetime('now') WHERE id=?`,
    [b.integration_status==='enabled'?'enabled':'disabled', b.carrier_ip||'', b.http_callback_url||'/api/incoming-sms', b.api_key||'', b.auth_token||'', b.smpp_host||'', b.smpp_port||'', b.smpp_system_id||'', b.smpp_password||'', b.notes||'', parseInt(b.retention_days||30), c.id]);
  cleanupWebhookLogs(b.retention_days||30);
  logAction(req,'update_carrier_settings','carrier_integration',{carrier_ip:b.carrier_ip,status:b.integration_status});
  res.json({ ok:true, settings:{...getCarrierSettings(),...carrierRuntimeStatus()}, generated_callback_url: publicCallbackUrl(req) });
});




app.post('/api/carrier-test', authRequired, requireRole('admin'), (req,res)=>{
  const c=getCarrierSettings();
  const callback = publicCallbackUrl(req);
  logAction(req,'test_carrier_endpoint','carrier_integration',{callback,status:c.integration_status,carrier_ip:c.carrier_ip});
  res.json({ ok:true, reachable:true, endpoint:callback, integration_status:c.integration_status, allowed_ips:String(c.carrier_ip||'').split(/[\s,;]+/).filter(Boolean), note:'Endpoint is available. Carrier requests will still be IP-checked at /api/incoming-sms.' });
});

app.get('/api/carrier-webhook-logs', authRequired, requireRole('admin'), (req,res)=>{
  const limit = Math.min(1000, parseInt(req.query.limit || '500'));
  res.json(db.all(`SELECT * FROM webhook_logs ORDER BY id DESC LIMIT ${limit}`));
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
  db.run(`INSERT INTO sms_records (number_id,number,range_id,cli,message,client_id,agent_id,manager_id,payout_rate,payout_amount) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [n.id,n.number,n.range_id,f.cli||'',f.message||'',n.client_id,n.agent_id,n.manager_id,retryRate,retryRate]);
  const smsRow={number_id:n.id,number:n.number,range_id:n.range_id,cli:f.cli||'',message:f.message||'',client_id:n.client_id,agent_id:n.agent_id,manager_id:n.manager_id};
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
function cleanPhone(v) { return String(v || '').trim().replace(/[^0-9]/g, ''); }
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
function processIncomingSmsPayload(req, payload, sourceIp='', opts={}) {
  const b = payload || {};
  // Generic: {number, cli, message}
  // Twilio-like: {To, From, Body}
  // Other providers: {to, from, text}, {msisdn, sender, content}, etc.
  const number = firstVal(b, ['number', 'to', 'To', 'recipient', 'destination', 'msisdn', 'receiver', 'called']);
  const cli = firstVal(b, ['cli', 'from', 'From', 'sender', 'originator', 'source', 'shortcode', 'service']);
  const message = firstVal(b, ['message', 'text', 'Text', 'body', 'Body', 'sms', 'content', 'msg']);

  if (!number) {
    logWebhook('failed', b, '', '', cli, message, 'number/to field required', sourceIp);
    addFailedSms(b, '', cli, message, 'number/to field required');
    return { status: 400, body: { error: 'number/to field required' } };
  }
  const n = findNumber(number);
  if (!n) {
    logWebhook('failed', b, number, '', cli, message, 'Number not found/allocated in system', sourceIp);
    addFailedSms(b, number, cli, message, 'Number not found/allocated in system');
    return { status: 404, body: { error: 'Number not found/allocated in system', number } };
  }

  const rangeForSms=db.get('SELECT * FROM ranges WHERE id=?',[n.range_id])||{};
  const smsPayoutRate=payoutRateFromRow({...rangeForSms, number_rate:n.rate, number_payout:n.payout});
  db.run(`INSERT INTO sms_records (number_id,number,range_id,cli,message,client_id,agent_id,manager_id,is_test,test_batch_id,source,payout_rate,payout_amount)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [n.id, n.number, n.range_id, cli || '', message || '', n.client_id, n.agent_id, n.manager_id, opts.isTest?1:0, opts.testBatchId||'', opts.source||'carrier', smsPayoutRate, smsPayoutRate]);
  const saved = db.get('SELECT id, received_at FROM sms_records ORDER BY id DESC LIMIT 1');
  const smsRow = { number_id:n.id, number:n.number, range_id:n.range_id, cli:cli||'', message:message||'', client_id:n.client_id, agent_id:n.agent_id, manager_id:n.manager_id };
  logWebhook('success', b, number, n.number, cli, message, '', sourceIp);
  checkSmsMilestoneNotifications(smsRow);
  return { status: 200, body: { ok: true, id: saved ? saved.id : null, received_at: saved ? saved.received_at : null, matched_number: n.number } };
}

// Internal/testing webhook. This stays open for local panel testing.
app.post('/api/webhook/sms', (req, res) => {
  const result = processIncomingSmsPayload(req, req.body || {}, getClientIp(req));
  res.status(result.status).json(result.body);
});

// Carrier HTTP callback endpoint. This is IP-restricted using Admin carrier settings.
app.post('/api/incoming-sms', (req, res) => {
  const settings = getCarrierSettings();
  const clientIp = getClientIp(req);
  if ((settings.integration_status || 'disabled') !== 'enabled') {
    logWebhook('failed', req.body || {}, '', '', '', '', 'Carrier integration disabled', clientIp);
    return res.status(403).json({ error: 'Carrier integration is disabled' });
  }
  if (!settings.carrier_ip || !carrierIpAllowed(settings, clientIp)) {
    logWebhook('failed', req.body || {}, '', '', '', '', `IP not allowed: ${clientIp}`, clientIp);
    return res.status(403).json({ error: 'IP not allowed', ip: clientIp });
  }
  const result = processIncomingSmsPayload(req, req.body || {}, clientIp);
  cleanupWebhookLogs(settings.retention_days||30);
  res.status(result.status).json(result.body);
});

/* ============ START ============ */
const PORT = process.env.PORT || 4000;
(async () => {
  await db.init();
  createTables();
  seed();
  app.listen(PORT, () => console.log(`\n✅ Mufasa SMS backend running: http://localhost:${PORT}\n`));
})();
