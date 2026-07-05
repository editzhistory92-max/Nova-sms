/**
 * Shared frontend API helper for all panels.
 * Uses localStorage token, adds Authorization header, redirects on 401.
 */
(function () {
  const TOKEN = () => localStorage.getItem('ms_token');
  const ROLE = () => localStorage.getItem('ms_role');

  function guard(expectedRole) {
    if (!TOKEN()) { location.href = 'login.html'; return false; }
    if (expectedRole && ROLE() !== expectedRole) { location.href = 'login.html'; return false; }
    return true;
  }

  async function req(method, path, body) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    const t = TOKEN();
    if (t) opt.headers['Authorization'] = 'Bearer ' + t;
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await fetch('/api' + path, opt);
    if (r.status === 401) { localStorage.clear(); location.href = 'login.html'; throw new Error('Session expired'); }
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
    st.textContent=`body.ms-dark-mode{background:#0f172a!important;color:#e5e7eb!important}body.ms-dark-mode .main,body.ms-dark-mode .content{background:#0f172a!important}body.ms-dark-mode .card,body.ms-dark-mode .toolbar,body.ms-dark-mode .table-wrap,body.ms-dark-mode .topbar,body.ms-dark-mode .tb1,body.ms-dark-mode .sidebar,body.ms-dark-mode .rail,body.ms-dark-mode .navshell{background:#111827!important;border-color:#263244!important;color:#e5e7eb!important}body.ms-dark-mode table th{background:#172033!important;color:#cbd5e1!important}body.ms-dark-mode table td,body.ms-dark-mode .page-head h2,body.ms-dark-mode .card-head h3,body.ms-dark-mode .nm,body.ms-dark-mode .t1{color:#e5e7eb!important}body.ms-dark-mode input,body.ms-dark-mode select,body.ms-dark-mode textarea{background:#0b1220!important;color:#e5e7eb!important;border-color:#334155!important}`;
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
  function initTopbarControls(){
    ensureThemeCSS();
    if(localStorage.getItem('ms_dark_mode')==='1') document.body.classList.add('ms-dark-mode');
    const themeBtns=[...document.querySelectorAll('[title="Theme"]')];
    themeBtns.forEach(b=>{b.addEventListener('click',(e)=>{e.preventDefault();e.stopPropagation();setDarkMode(!document.body.classList.contains('ms-dark-mode'));});});
    const settingsBtns=[...document.querySelectorAll('[title="Settings"]')];
    settingsBtns.forEach(b=>{b.addEventListener('click',(e)=>{e.preventDefault();e.stopPropagation();openSettings();});});
    document.querySelectorAll('.avatar,.who').forEach(a=>a.addEventListener('click',(e)=>{e.preventDefault();openSettings();}));
    document.querySelectorAll('[title="Fullscreen"]').forEach(b=>{if(!b.dataset.msFull){b.dataset.msFull='1';b.addEventListener('click',(e)=>{if(!document.fullscreenElement){document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen();}else{document.exitFullscreen&&document.exitFullscreen();}});}});
    document.querySelectorAll('[title="Logout"]').forEach(b=>{if(!b.dataset.msLogout){b.dataset.msLogout='1';b.addEventListener('click',()=>{localStorage.clear();location.href='login.html';});}});
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
    logout: () => { localStorage.clear(); location.href = 'login.html'; },
    initNotifications,
    markNotificationRead,
    openSettings,
  };
  document.addEventListener('DOMContentLoaded', ()=>{ initNotifications(); enhancePageSizeOptions(); setInterval(enhancePageSizeOptions, 2000); });
})();
