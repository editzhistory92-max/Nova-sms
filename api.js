/**
 * Shared frontend API helper for all panels.
 * Uses localStorage token, adds Authorization header, redirects on 401.
 */
(function () {
  const TOKEN = () => localStorage.getItem('ms_token');
  const ROLE = () => localStorage.getItem('ms_role');

  function guard(expectedRole) {
    if (!TOKEN()) { location.href = '/login'; return false; }
    if (expectedRole && ROLE() !== expectedRole) { location.href = '/login'; return false; }
    return true;
  }

  async function req(method, path, body) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    const t = TOKEN();
    if (t) opt.headers['Authorization'] = 'Bearer ' + t;
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await fetch('/api' + path, opt);
    if (r.status === 401) { localStorage.clear(); location.href = '/login'; throw new Error('Session expired'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  let notifState = { unread: 0, prefs: { notification_sound: 1, notification_popup: 1 }, audioReady: false };
  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.24);
    } catch (e) {}
  }
  function ensureNotifUI() {
    if (document.getElementById('msNotifPanel')) return;
    const css = document.createElement('style');
    css.textContent = `
      .ms-notif-panel{position:fixed;right:22px;top:68px;width:min(380px,calc(100vw - 28px));background:#fff;border:1px solid #dbe4f0;border-radius:18px;box-shadow:0 24px 70px rgba(15,23,42,.18);z-index:9999;display:none;overflow:hidden;color:#0f2454}
      .ms-notif-panel.show{display:block}.ms-notif-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #e5eaf2;background:#f8fafc}.ms-notif-head b{font-size:15px}.ms-notif-actions{display:flex;gap:8px;align-items:center}.ms-notif-actions button{border:0;background:#eef4ff;color:#1d4ed8;border-radius:9px;padding:7px 9px;font-weight:700;cursor:pointer;font-size:12px}.ms-notif-list{max-height:330px;overflow:auto}.ms-notif-item{padding:13px 16px;border-bottom:1px solid #eef2f7}.ms-notif-item.unread{background:#f0f7ff}.ms-notif-item .m{font-weight:800;font-size:13px}.ms-notif-item .d{font-size:11.5px;color:#64748b;margin-top:4px}.ms-notif-foot{padding:12px 16px;background:#fbfdff;border-top:1px solid #e5eaf2;display:flex;align-items:center;justify-content:space-between;gap:10px}.ms-switch{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#334155}.ms-bell-float{position:fixed;right:22px;bottom:22px;width:48px;height:48px;border:0;border-radius:50%;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:white;box-shadow:0 12px 28px rgba(37,99,235,.24);z-index:9998;display:none}.ms-notif-count{position:absolute;top:-5px;right:-5px;background:#ef4444;color:#fff;border-radius:999px;min-width:18px;height:18px;display:none;align-items:center;justify-content:center;font-size:10px;font-weight:900}`;
    document.head.appendChild(css);
    const panel = document.createElement('div');
    panel.id = 'msNotifPanel'; panel.className = 'ms-notif-panel';
    panel.innerHTML = `<div class="ms-notif-head"><b>Notifications</b><div class="ms-notif-actions"><button id="msReadAll">Read all</button><button id="msCloseNotif">×</button></div></div><div class="ms-notif-list" id="msNotifList"><div class="ms-notif-item"><div class="d">Loading...</div></div></div><div class="ms-notif-foot"><label class="ms-switch"><input type="checkbox" id="msSoundToggle"> Sound alerts</label><button id="msRefreshNotif">Refresh</button></div>`;
    document.body.appendChild(panel);
    const float = document.createElement('button'); float.id='msBellFloat'; float.className='ms-bell-float'; float.innerHTML='🔔<span class="ms-notif-count" id="msNotifCount"></span>'; document.body.appendChild(float);
    document.getElementById('msCloseNotif').onclick=()=>panel.classList.remove('show');
    document.getElementById('msRefreshNotif').onclick=()=>loadNotifications(true);
    document.getElementById('msReadAll').onclick=async()=>{ await req('POST','/notifications/read-all',{}); await loadNotifications(false); };
    document.getElementById('msSoundToggle').onchange=async(e)=>{ notifState.prefs.notification_sound=e.target.checked?1:0; await req('PUT','/preferences',notifState.prefs); };
    float.onclick=()=>toggleNotifications();
  }
  function findBellButton(){
    return document.querySelector('[title="Notifications"], [title="News"], .tb-btn .badge, .tb-btn .dot')?.closest('button') || document.getElementById('msBellFloat');
  }
  function updateBadge(count){
    const badge = document.querySelector('.tb-btn .badge, .tb-btn .dot') || document.getElementById('msNotifCount');
    if (badge) { badge.style.display = count ? 'flex' : 'none'; badge.textContent = count > 99 ? '99+' : String(count); }
    const fb=document.getElementById('msNotifCount'); if(fb){fb.style.display=count?'flex':'none';fb.textContent=count>99?'99+':String(count);}
  }
  async function loadNotifications(openPanel){
    ensureNotifUI();
    try { notifState.prefs = await req('GET','/preferences'); document.getElementById('msSoundToggle').checked = !!notifState.prefs.notification_sound; } catch(e) {}
    const rows = await req('GET','/notifications');
    const unread = rows.filter(r=>!r.read_at).length;
    if (notifState.unread !== 0 && unread > notifState.unread && notifState.prefs.notification_sound) beep();
    notifState.unread = unread; updateBadge(unread);
    const list=document.getElementById('msNotifList');
    list.innerHTML = rows.map(r=>`<div class="ms-notif-item ${r.read_at?'':'unread'}" onclick="API.markNotificationRead(${r.user_notification_id})"><div class="m">${r.message}</div><div class="d">${(r.created_at||'').slice(0,16)} · ${r.scope} · ${Number(r.count||0).toLocaleString()} SMS</div></div>`).join('') || '<div class="ms-notif-item"><div class="d">No notifications yet</div></div>';
    if(openPanel) document.getElementById('msNotifPanel').classList.add('show');
  }
  async function toggleNotifications(){ await loadNotifications(true); }
  async function markNotificationRead(id){ try{await req('POST','/notifications/'+id+'/read',{}); await loadNotifications(false);}catch(e){} }
  function initNotifications(){
    initTopbarControls();
    if(!TOKEN()) return;
    ensureNotifUI();
    const bell=findBellButton();
    if(bell){ bell.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); toggleNotifications(); }); }
    else { document.getElementById('msBellFloat').style.display='block'; }
    document.addEventListener('click', ()=>{ notifState.audioReady = true; }, { once:true });
    loadNotifications(false).catch(()=>{});
    setInterval(()=>loadNotifications(false).catch(()=>{}), 30000);
  }


  function ensureSettingsUI(){
    if(document.getElementById('msSettingsPanel')) return;
    const panel=document.createElement('div');
    panel.id='msSettingsPanel'; panel.className='ms-notif-panel'; panel.style.top='68px';
    panel.innerHTML=`<div class="ms-notif-head"><b>Panel Settings</b><div class="ms-notif-actions"><button id="msCloseSettings">×</button></div></div>
      <div class="ms-notif-list" style="padding:14px 16px">
        <label class="ms-switch" style="justify-content:space-between;margin-bottom:12px"><span>Notification sound</span><input type="checkbox" id="msSetSound"></label>
        <label class="ms-switch" style="justify-content:space-between;margin-bottom:12px"><span>Popup notifications</span><input type="checkbox" id="msSetPopup"></label>
        <label class="ms-switch" style="justify-content:space-between"><span>Dark mode</span><input type="checkbox" id="msSetDark"></label>
      </div>`;
    document.body.appendChild(panel);
    document.getElementById('msCloseSettings').onclick=()=>panel.classList.remove('show');
    document.getElementById('msSetSound').onchange=async(e)=>{notifState.prefs.notification_sound=e.target.checked?1:0;await req('PUT','/preferences',notifState.prefs);const t=document.getElementById('msSoundToggle');if(t)t.checked=e.target.checked;};
    document.getElementById('msSetPopup').onchange=async(e)=>{notifState.prefs.notification_popup=e.target.checked?1:0;await req('PUT','/preferences',notifState.prefs);};
    document.getElementById('msSetDark').onchange=(e)=>setDarkMode(e.target.checked);
  }
  function setDarkMode(on){
    document.body.classList.toggle('ms-dark-mode', !!on);
    localStorage.setItem('ms_dark_mode', on?'1':'0');
  }
  function ensureThemeCSS(){
    if(document.getElementById('msThemeCss')) return;
    const st=document.createElement('style');st.id='msThemeCss';
    st.textContent=`
      body.ms-dark-mode{background:#0B0B0B!important;color:#E5E7EB!important}
      body.ms-dark-mode .main,body.ms-dark-mode .content{background:#0B0B0B!important;color:#E5E7EB!important}
      body.ms-dark-mode .card,body.ms-dark-mode .toolbar,body.ms-dark-mode .table-wrap,body.ms-dark-mode .modal,body.ms-dark-mode .modal-box,body.ms-dark-mode .ms-modal,body.ms-dark-mode .ms-notif-panel,body.ms-dark-mode .ms-profile-menu{background:#111827!important;border-color:#334155!important;color:#E5E7EB!important;box-shadow:0 18px 50px rgba(0,0,0,.42)!important}
      body.ms-dark-mode .topbar,body.ms-dark-mode .tb1,body.ms-dark-mode .appbar{background:#0F172A!important;border-color:#334155!important;color:#E5E7EB!important}
      body.ms-dark-mode .sidebar,body.ms-dark-mode .rail{background:#050505!important;border-color:#262626!important;color:#E5E7EB!important}
      body.ms-dark-mode .ms-notif-head,body.ms-dark-mode .ms-notif-foot,body.ms-dark-mode .ms-modal-head,body.ms-dark-mode .ms-modal-foot{background:#0F172A!important;border-color:#334155!important;color:#E5E7EB!important}
      body.ms-dark-mode .page-head h2,body.ms-dark-mode .card-head h3,body.ms-dark-mode .stat-info h3,body.ms-dark-mode .nm,body.ms-dark-mode .t1,body.ms-dark-mode .pt,body.ms-dark-mode .ms-modal-head h3,body.ms-dark-mode .ms-profile-item{color:#F8FAFC!important}
      body.ms-dark-mode .breadcrumb,body.ms-dark-mode .sub,body.ms-dark-mode .muted,body.ms-dark-mode .clock,body.ms-dark-mode .tb-date,body.ms-dark-mode .t2,body.ms-dark-mode .ps,body.ms-dark-mode .ms-notif-item .d{color:#CBD5E1!important}
      body.ms-dark-mode table,body.ms-dark-mode tbody{background:#111827!important}body.ms-dark-mode table th{background:#1E293B!important;color:#E2E8F0!important;border-color:#334155!important}body.ms-dark-mode table td{background:#111827!important;color:#E5E7EB!important;border-color:#334155!important}body.ms-dark-mode tbody tr:nth-child(even) td{background:#0F172A!important}body.ms-dark-mode tbody tr:hover td{background:#1E293B!important}
      body.ms-dark-mode input,body.ms-dark-mode select,body.ms-dark-mode textarea,body.ms-dark-mode .ms-field input{background:#0B1220!important;color:#F8FAFC!important;border-color:#475569!important}body.ms-dark-mode input::placeholder,body.ms-dark-mode textarea::placeholder{color:#94A3B8!important}
      body.ms-dark-mode .tag,body.ms-dark-mode .tag-mgr,body.ms-dark-mode .tag-agt,body.ms-dark-mode .tag-cli,body.ms-dark-mode .tag-client,body.ms-dark-mode .tag-blue,body.ms-dark-mode .tag-green,body.ms-dark-mode .tag-amber,body.ms-dark-mode .tag-red,body.ms-dark-mode .tag-gray{background:#334155!important;color:#F8FAFC!important;border-color:#64748B!important}
      body.ms-dark-mode .cell-money,body.ms-dark-mode .payout-rate,body.ms-dark-mode .rate-cell{color:#FDE68A!important}
      body.ms-dark-mode .btn-ghost,body.ms-dark-mode .ms-btn.ghost{background:#111827!important;color:#E5E7EB!important;border-color:#475569!important}
      body.ms-dark-mode .ms-profile-item:hover,body.ms-dark-mode .ms-notif-item.unread,body.ms-dark-mode .ms-notif-item:hover{background:#1E293B!important}
    `
    document.head.appendChild(st);
  }
  async function openSettings(){
    ensureNotifUI(); ensureSettingsUI();
    try{notifState.prefs=await req('GET','/preferences');}catch(e){}
    document.getElementById('msSetSound').checked=!!notifState.prefs.notification_sound;
    document.getElementById('msSetPopup').checked=!!notifState.prefs.notification_popup;
    document.getElementById('msSetDark').checked=localStorage.getItem('ms_dark_mode')==='1';
    document.getElementById('msSettingsPanel').classList.add('show');
  }

  function enhancePageSizeOptions(){
    const wanted=['10','25','50','100','500','1000','10000','All'];
    document.querySelectorAll('select').forEach(sel=>{
      const id=(sel.id||'').toLowerCase();
      if(!(id.includes('len') || id.includes('slen'))) return;
      const current=sel.value || '25';
      sel.innerHTML=wanted.map(v=>`<option value="${v}" ${v===current?'selected':''}>${v}</option>`).join('');
    });
  }

  function ensureProfileUI(){
    if(document.getElementById('msProfileMenu')) return;
    const css=document.createElement('style');
    css.textContent=`
      .ms-profile-menu{position:fixed;right:24px;top:60px;background:#fff;border:1px solid #E2E8F0;border-radius:14px;box-shadow:0 18px 48px rgba(15,23,42,.16);z-index:10000;display:none;min-width:190px;overflow:hidden}.ms-profile-menu.show{display:block}.ms-profile-item{padding:12px 14px;cursor:pointer;font-weight:700;color:#1E293B;border-bottom:1px solid #F1F5F9}.ms-profile-item:hover{background:#F8FAFC}.ms-profile-item:last-child{border-bottom:0}
      .ms-modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:10001;display:none;align-items:center;justify-content:center;padding:18px}.ms-modal-backdrop.show{display:flex}.ms-modal{width:min(720px,96vw);max-height:86vh;overflow:auto;background:#fff;border-radius:18px;border:1px solid #E2E8F0;box-shadow:0 28px 80px rgba(15,23,42,.22)}.ms-modal-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid #E2E8F0}.ms-modal-head h3{margin:0;color:#1E293B}.ms-modal-body{padding:18px}.ms-modal-foot{padding:14px 18px;border-top:1px solid #E2E8F0;display:flex;justify-content:flex-end;gap:10px}.ms-x{border:0;background:#F1F5F9;border-radius:9px;width:32px;height:32px;cursor:pointer}.ms-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.ms-field{margin-bottom:14px}.ms-field label{display:block;font-weight:800;font-size:13px;color:#334155;margin-bottom:7px}.ms-field input{width:100%;height:42px;border:1px solid #CBD5E1;border-radius:10px;padding:0 12px}.ms-btn{border:0;border-radius:10px;min-height:38px;padding:8px 14px;font-weight:800;cursor:pointer}.ms-btn.primary{background:linear-gradient(135deg,#2563EB,#06B6D4);color:white}.ms-btn.ghost{background:#fff;color:#334155;border:1px solid #CBD5E1}.ms-activity-table{width:100%;border-collapse:separate;border-spacing:0 4px}.ms-activity-table th{background:#F1F5F9;color:#334155;text-align:left;padding:10px;font-size:12px}.ms-activity-table td{background:#fff;border-bottom:1px solid #F1F5F9;padding:10px;color:#1E293B;font-size:13px}`;
    document.head.appendChild(css);
    const menu=document.createElement('div');menu.id='msProfileMenu';menu.className='ms-profile-menu';menu.innerHTML=`<div class="ms-profile-item" id="msOpenProfile">Profile</div><div class="ms-profile-item" id="msOpenActivity">Activity Log</div>`;document.body.appendChild(menu);
    const modal=document.createElement('div');modal.id='msProfileModal';modal.className='ms-modal-backdrop';modal.innerHTML=`<div class="ms-modal"><div class="ms-modal-head"><h3>Profile</h3><button class="ms-x" id="msCloseProfile">×</button></div><div class="ms-modal-body"><div class="ms-form-grid"><div class="ms-field"><label>Username</label><input id="msProfileUsername"></div><div class="ms-field"><label>Current Password</label><input type="password" id="msProfileCurrent" placeholder="Required for password change"></div><div class="ms-field"><label>New Password</label><input type="password" id="msProfileNew"></div><div class="ms-field"><label>Confirm New Password</label><input type="password" id="msProfileConfirm"></div><div class="ms-field ms-admin-only"><label>Admin Security Code</label><input type="password" id="msProfileAdminCode" placeholder="Required for admin password change"></div></div><div id="msSecurityCodeBox" class="ms-admin-only" style="margin-top:16px;padding-top:14px;border-top:1px solid #E2E8F0"><h4 style="margin:0 0 10px;color:#1E293B">Change Admin Security Code</h4><div class="ms-form-grid"><div class="ms-field"><label>Old Security Code</label><input type="password" id="msOldSecCode"></div><div class="ms-field"><label>New Security Code</label><input type="password" id="msNewSecCode"></div><div class="ms-field"><label>Confirm New Security Code</label><input type="password" id="msConfirmSecCode"></div></div><button class="ms-btn primary" id="msChangeSecCode" type="button">Change Security Code</button></div><div id="msProfileMsg" style="font-size:13px;color:#64748B;margin-top:10px"></div></div><div class="ms-modal-foot"><button class="ms-btn ghost" id="msProfileCancel">Cancel</button><button class="ms-btn primary" id="msProfileSave">Save Profile</button></div></div>`;document.body.appendChild(modal);
    const act=document.createElement('div');act.id='msActivityModal';act.className='ms-modal-backdrop';act.innerHTML=`<div class="ms-modal"><div class="ms-modal-head"><h3>Activity Log</h3><button class="ms-x" id="msCloseActivity">×</button></div><div class="ms-modal-body" id="msActivityBody">Loading...</div><div class="ms-modal-foot"><button class="ms-btn ghost" id="msActivityClose">Close</button></div></div>`;document.body.appendChild(act);
    document.getElementById('msOpenProfile').onclick=()=>{menu.classList.remove('show');openProfileModal();};
    document.getElementById('msOpenActivity').onclick=()=>{menu.classList.remove('show');openActivityModal();};
    document.getElementById('msCloseProfile').onclick=document.getElementById('msProfileCancel').onclick=()=>modal.classList.remove('show');
    document.getElementById('msCloseActivity').onclick=document.getElementById('msActivityClose').onclick=()=>act.classList.remove('show');
    document.getElementById('msProfileSave').onclick=saveOwnProfile;
    document.getElementById('msChangeSecCode').onclick=changeAdminSecurityCode;
  }
  function openProfileMenu(){
    if(ROLE()==='client'){ return; }
    ensureProfileUI();
    const m=document.getElementById('msProfileMenu');
    m.classList.toggle('show');
  }
  async function openProfileModal(){
    ensureProfileUI();
    try{const p=await req('GET','/profile');document.getElementById('msProfileUsername').value=p.username||'';document.getElementById('msProfileCurrent').value='';document.getElementById('msProfileNew').value='';document.getElementById('msProfileConfirm').value='';document.getElementById('msProfileAdminCode').value='';document.getElementById('msOldSecCode').value='';document.getElementById('msNewSecCode').value='';document.getElementById('msConfirmSecCode').value='';document.querySelectorAll('.ms-admin-only').forEach(el=>el.style.display=(ROLE()==='admin'?'block':'none'));document.getElementById('msProfileMsg').textContent=ROLE()==='admin'?'Admin password changes require the admin security code.':'Change username, or enter current/new passwords to change password.';document.getElementById('msProfileModal').classList.add('show');}catch(e){alert(e.message)}
  }
  async function saveOwnProfile(){
    try{
      const body={username:document.getElementById('msProfileUsername').value.trim(),current_password:document.getElementById('msProfileCurrent').value,new_password:document.getElementById('msProfileNew').value,confirm_password:document.getElementById('msProfileConfirm').value,admin_security_code:document.getElementById('msProfileAdminCode')?document.getElementById('msProfileAdminCode').value:''};
      const r=await req('PUT','/profile',body);
      localStorage.setItem('ms_token',r.token);localStorage.setItem('ms_user',r.user.username);localStorage.setItem('ms_role',r.user.role);localStorage.setItem('ms_name',r.user.name||r.user.username);
      document.getElementById('msProfileMsg').textContent='Profile updated successfully.';
      setTimeout(()=>location.reload(),700);
    }catch(e){document.getElementById('msProfileMsg').textContent='Error: '+e.message;}
  }
  async function changeAdminSecurityCode(){
    try{
      const body={old_security_code:document.getElementById('msOldSecCode').value,new_security_code:document.getElementById('msNewSecCode').value,confirm_security_code:document.getElementById('msConfirmSecCode').value};
      await req('PUT','/admin-security-code',body);
      document.getElementById('msProfileMsg').textContent='Security code updated successfully.';
      document.getElementById('msOldSecCode').value='';document.getElementById('msNewSecCode').value='';document.getElementById('msConfirmSecCode').value='';
    }catch(e){document.getElementById('msProfileMsg').textContent='Error: '+e.message;}
  }
  function renderActivityTable(title, rows){
    return `<h4 style="margin:14px 0 8px;color:#1E293B">${title}</h4><table class="ms-activity-table"><thead><tr><th>Date</th><th>User</th><th>Role</th><th>Action</th><th>IP</th></tr></thead><tbody>${(rows||[]).map(r=>`<tr><td>${(r.created_at||'').slice(0,19)}</td><td>${r.username||'—'}</td><td>${r.role||'—'}</td><td><b>${r.action}</b></td><td>${r.ip||'—'}</td></tr>`).join('')||'<tr><td colspan="5">No activity found</td></tr>'}</tbody></table>`;
  }
  async function openActivityModal(){
    if(ROLE()==='client') return;
    ensureProfileUI();
    document.getElementById('msActivityModal').classList.add('show');
    document.getElementById('msActivityBody').textContent='Loading...';
    try{const data=await req('GET','/activity-log');const role=ROLE();const childTitle=role==='admin'?'Manager Activity':(role==='manager'?'Agent Activity':'Client Activity');document.getElementById('msActivityBody').innerHTML=renderActivityTable('My Activity',data.own)+renderActivityTable(childTitle,data.child);}catch(e){document.getElementById('msActivityBody').textContent='Error: '+e.message;}
  }


  function paginateRows(key, rows, len, infoId, rerender) {
    rows = rows || [];
    const state = window.__pagerState || (window.__pagerState = {});
    const perPage = len === 'All' ? rows.length || 1 : Math.max(1, parseInt(len || '25'));
    const totalPages = len === 'All' ? 1 : Math.max(1, Math.ceil(rows.length / perPage));
    if (!state[key]) state[key] = { page: 1, signature: '' };
    const signature = rows.length + '|' + len;
    if (state[key].signature !== signature) { state[key].signature = signature; if (state[key].page > totalPages) state[key].page = 1; }
    if (state[key].page < 1) state[key].page = 1;
    if (state[key].page > totalPages) state[key].page = totalPages;
    const page = state[key].page;
    const sliced = len === 'All' ? rows : rows.slice((page - 1) * perPage, page * perPage);
    setTimeout(() => {
      const info = document.getElementById(infoId);
      if (!info) return;
      let foot = info.closest('.table-foot') || info.parentElement;
      if (!foot) return;
      let pag = foot.querySelector('.pagination');
      if (!pag) { pag = document.createElement('div'); pag.className = 'pagination'; foot.appendChild(pag); }
      const nums = [];
      const maxBtns = 7;
      let start = Math.max(1, page - 3), end = Math.min(totalPages, start + maxBtns - 1);
      start = Math.max(1, end - maxBtns + 1);
      for (let i = start; i <= end; i++) nums.push(i);
      pag.innerHTML = `<button data-pg="prev">‹</button>` + nums.map(n=>`<button data-pg="${n}" class="${n===page?'active':''}">${n}</button>`).join('') + `<button data-pg="next">›</button>`;
      pag.querySelectorAll('button').forEach(btn => btn.onclick = () => {
        const v = btn.dataset.pg;
        if (v === 'prev') state[key].page = Math.max(1, state[key].page - 1);
        else if (v === 'next') state[key].page = Math.min(totalPages, state[key].page + 1);
        else state[key].page = parseInt(v);
        if (typeof rerender === 'function') rerender();
      });
    }, 0);
    return { rows: sliced, total: rows.length, page, totalPages };
  }
  function initRoutePersistence(){
    if(!TOKEN()) return;
    const key='ms_last_page_'+(ROLE()||'');
    document.addEventListener('click', (e)=>{
      const el=e.target.closest('[data-page]');
      if(el && el.dataset && el.dataset.page) localStorage.setItem(key, el.dataset.page);
    }, true);
    setTimeout(()=>{
      const page=localStorage.getItem(key);
      if(!page || page==='dashboard'){document.documentElement.style.visibility='visible'; return;}
      const selector=['.sub-item','.dropitem','.rsubitem','.navtab','.tab','.ritem','.nav-item'].map(c=>`${c}[data-page="${page}"]`).join(',');
      const el=document.querySelector(selector);
      if(el) el.click();
      document.documentElement.style.visibility='visible';
    }, 180);
  }
  function initTopbarControls(){
    ensureThemeCSS();
    if(localStorage.getItem('ms_dark_mode')==='1') document.body.classList.add('ms-dark-mode');
    const themeBtns=[...document.querySelectorAll('[title="Theme"]')];
    themeBtns.forEach(b=>{b.addEventListener('click',(e)=>{e.preventDefault();e.stopPropagation();setDarkMode(!document.body.classList.contains('ms-dark-mode'));});});
    const settingsBtns=[...document.querySelectorAll('[title="Settings"]')];
    settingsBtns.forEach(b=>{b.addEventListener('click',(e)=>{e.preventDefault();e.stopPropagation();openSettings();});});
    document.querySelectorAll('.avatar,.who').forEach(a=>a.addEventListener('click',(e)=>{e.preventDefault();e.stopPropagation();openProfileMenu();}));
    document.querySelectorAll('[title="Fullscreen"]').forEach(b=>{if(!b.dataset.msFull){b.dataset.msFull='1';b.addEventListener('click',(e)=>{if(!document.fullscreenElement){document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen();}else{document.exitFullscreen&&document.exitFullscreen();}});}});
    document.querySelectorAll('[title="Logout"]').forEach(b=>{if(!b.dataset.msLogout){b.dataset.msLogout='1';b.addEventListener('click',()=>{window.API&&API.logout?API.logout():(localStorage.clear(),location.href='/login');});}});
  }
  window.API = {
    guard,
    role: ROLE,
    user: () => localStorage.getItem('ms_user'),
    name: () => localStorage.getItem('ms_name'),
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b),
    del: (p) => req('DELETE', p),
    logout: async () => { try{ await req('POST','/logout',{}); }catch(e){} localStorage.clear(); location.href = '/login'; },
    initNotifications,
    markNotificationRead,
    openSettings,
    openProfileMenu,
    paginateRows,
  };
  document.addEventListener('DOMContentLoaded', ()=>{ initNotifications(); initRoutePersistence(); enhancePageSizeOptions(); setInterval(enhancePageSizeOptions, 2000); });
})();
