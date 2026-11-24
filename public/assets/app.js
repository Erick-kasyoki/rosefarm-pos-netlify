'use strict';
const BASE = '/api';
const applyTheme = t => document.documentElement.setAttribute('data-theme', t);
try { applyTheme(localStorage.getItem('pos-theme') || 'light'); } catch { }
const S = { user: null, settings: {}, cart: [], products: [], categories: [], customers: [], view: 'pos' };
const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => `${S.settings.currency || 'KES'} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Quantities: kg and litres can be fractions (1.25 kg); pieces, trays and packs are whole.
const DEC_UNITS = ['kg', 'L'];
const isDec = u => DEC_UNITS.includes(u);
const qfmt = n => String(+Number(n || 0).toFixed(3));
const per = u => (u && u !== 'pc' ? ` / ${u}` : '');
const UNIT_OPTIONS = [['pc', 'pc (piece)'], ['kg', 'kg (kilogram)'], ['L', 'L (litre)'], ['tray', 'tray'], ['pack', 'pack / packet'], ['dozen', 'dozen']].map(([value, label]) => ({ value, label }));
const isAdmin = () => S.user && S.user.role === 'admin';
const isManager = () => S.user && (S.user.role === 'admin' || S.user.role === 'manager');
const cap = w => String(w || '').charAt(0).toUpperCase() + String(w || '').slice(1);
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const fdt = s => new Date(String(s).replace(' ', 'T')).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const brandHtml = () => { const n = S.settings.store_name || 'Point of Sale'; return `<img src="assets/logo-small.png" alt=""><span>${esc(n)}</span>`; };
const themeLabel = () => document.documentElement.getAttribute('data-theme') === 'dark' ? 'Day mode' : 'Night mode';

async function api(route, { method = 'GET', params = {}, body } = {}) {
  const qs = new URLSearchParams({ route, ...params }).toString();
  const res = await fetch(`${BASE}?${qs}`, {
    method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'XMLHttpRequest', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { throw new Error(res.status === 413 ? 'That request was too large.' : 'The server did not answer properly (HTTP ' + res.status + '). Please try again; if it keeps happening, tell the administrator.'); }
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 't' + (err ? ' err' : ''); t.textContent = msg;
  $('#toast').appendChild(t); setTimeout(() => t.remove(), 3500);
}
const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { if (e.status === 401) return boot(); toast(e.message, true); } };

function modal(html, wide = false, sticky = false) {   // sticky: cannot be dismissed by clicking outside
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${html}</div>`;
  if (!sticky) o.addEventListener('mousedown', e => { if (e.target === o) o.remove(); });
  $('#modal-root').appendChild(o);
  return { el: o.firstChild, close: () => o.remove() };
}

function formModal(title, fields, values, onSave) {
  const html = `<h3>${esc(title)}</h3><form>${fields.map(f => {
    const v = values?.[f.name] ?? f.default ?? '';
    if (f.type === 'checkbox') return `<div class="field chk"><input type="checkbox" name="${f.name}" id="f_${f.name}" ${v === true || v === 'true' ? 'checked' : ''}><label for="f_${f.name}" style="margin:0">${esc(f.label)}</label></div>`;
    const input = f.type === 'select'
      ? `<select name="${f.name}">${f.options.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
      : `<input name="${f.name}" type="${f.type || 'text'}" value="${f.type === 'password' ? '' : esc(v)}" ${f.required ? 'required' : ''} ${f.step ? `step="${f.step}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} autocomplete="off">`;
    return `<div class="field"><label>${esc(f.label)}</label>${input}</div>`;
  }).join('')}<div class="actions"><button type="button" class="btn sec" data-x>Cancel</button><button class="btn">Save</button></div></form>`;
  const m = modal(html);
  $('[data-x]', m.el).onclick = m.close;
  $('form', m.el).onsubmit = guard(async e => {
    e.preventDefault();
    const o = {};
    fields.forEach(f => { const el = e.target.elements[f.name]; o[f.name] = f.type === 'checkbox' ? el.checked : el.value; });
    await onSave(o); m.close();
  });
  const first = $('input,select', m.el); if (first) first.focus();
}

// ---------- boot / auth ----------
async function boot() {
  S.bootErr = null;
  try {
    const r = await api('me');
    if (r.user) { S.user = r.user; S.settings = r.settings; document.title = S.settings.store_name || 'Point of Sale'; return shell(); }
    S.brand = r.brand || null;
  } catch (e) { S.bootErr = e.message; }
  S.user = null; S.cart = []; loginView();
}

const ICON = {
  at: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.3 4.2"/><path d="M6.5 6.6C3.7 8.4 2 12 2 12s4 7 10 7c1.6 0 3.1-.4 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
};
const afield = (name, label, type, icon, attrs = '') => `<label class="af"><span class="af-l">${label}</span><span class="af-box">${ICON[icon]}<input name="${name}" type="${type}" ${attrs}>${type === 'password' ? `<button type="button" class="eye" aria-label="Show password">${ICON.eye}</button>` : ''}</span></label>`;

function loginView() {
  const name = S.brand?.store_name || 'RoseFarm';
  let saved = ''; try { saved = localStorage.getItem('pos-user') || ''; } catch { }
  $('#app').innerHTML = `<div class="auth-wrap"><div class="auth" data-mode="login">
    <div class="auth-panel"><div class="auth-hero">
      <div class="logo-ring"><img src="assets/logo.png" alt="${esc(name)} logo"></div>
      <h2 id="hero-h" class="pop">Welcome</h2>
      <p id="hero-p" class="pop">Accounts are created by your administrator.</p>
    </div></div>
    <div class="auth-forms">
      <form class="auth-form login-form">
        <h1>Login</h1><p class="sub">Sign in to start your shift at ${esc(name)}.</p>
        ${afield('username', 'Username', 'text', 'at', `autocomplete="username" required value="${esc(saved)}"`)}
        ${afield('password', 'Password', 'password', 'lock', 'autocomplete="current-password" required')}
        <label class="chk"><input type="checkbox" name="remember" ${saved ? 'checked' : ''}><span>Remember me</span></label>
        <div class="auth-msg" role="alert" hidden></div>
        <button class="auth-btn">Sign in</button>
      </form>
    </div></div></div>`;

  const card = $('.auth'), lf = $('.login-form');
  const msg = (f, text, kind = 'err') => {
    const m = $('.auth-msg', f);
    if (!text) { m.hidden = true; return; }
    m.className = 'auth-msg ' + kind; m.textContent = text; m.hidden = false;
  };
  const busy = (f, on) => { const b = $('.auth-btn', f); b.disabled = on; b.classList.toggle('busy', on); };
  card.addEventListener('click', e => {
    const b = e.target.closest('.eye'); if (!b) return;
    const i = b.parentNode.querySelector('input'), show = i.type === 'password';
    i.type = show ? 'text' : 'password'; b.innerHTML = show ? ICON.eyeOff : ICON.eye;
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  lf.onsubmit = async e => {
    e.preventDefault(); const el = lf.elements; msg(lf, ''); busy(lf, true);
    try {
      const user = el.username.value.trim();
      const r = await api('login', { method: 'POST', body: { username: user, password: el.password.value } });
      try { el.remember.checked ? localStorage.setItem('pos-user', user) : localStorage.removeItem('pos-user'); } catch { }
      S.user = r.user; S.settings = r.settings; S.view = 'pos';
      document.title = S.settings.store_name || 'Point of Sale';
      card.classList.add('leaving'); setTimeout(shell, 380);
    } catch (err) { msg(lf, err.message); busy(lf, false); }
  };
  if (S.bootErr) { msg(lf, S.bootErr); S.bootErr = null; }
}

const NAV = [
  ['dashboard', 'Dashboard', 1], ['pos', 'Point of Sale'], ['sales', 'Sales'], ['customers', 'Customers'],
  ['products', 'Products', 1], ['categories', 'Categories', 1], ['stock', 'Stock', 1], ['suppliers', 'Suppliers', 1], ['expenses', 'Expenses', 1], ['reports', 'Reports', 1],
  ['users', 'Users', 2], ['settings', 'Settings', 2],
];   // 1 = managers and admins, 2 = admins only
const canSee = n => !n || !n[2] || (n[2] === 1 ? isManager() : isAdmin());
const VIEWS = { pos: viewPOS, sales: viewSales, customers: viewCustomers, dashboard: viewDashboard, products: viewProducts, categories: viewCategories, stock: viewStock, suppliers: viewSuppliers, expenses: viewExpenses, reports: viewReports, users: viewUsers, settings: viewSettings };

const NAV_ICON = { pos: '🛒', sales: '🧾', customers: '👥', dashboard: '🏠', products: '📦', categories: '🏷️', stock: '📋', suppliers: '🚚', expenses: '💳', reports: '📈', users: '👤', settings: '⚙️' };
const clockText = () => new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const isCollapsed = () => { try { return localStorage.getItem('pos-side') === '1'; } catch { return false; } };

const IC = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
};
const ZOOMS = [70, 80, 90, 100, 110, 125];
const getZoom = () => { try { return +localStorage.getItem('pos-zoom') || 100; } catch { return 100; } };
function applyZoom(z) { const sh = document.querySelector('.shell'); if (sh) sh.style.setProperty('--z', z / 100); const b = $('#zoomv'); if (b) b.textContent = z + '%'; try { localStorage.setItem('pos-zoom', z); } catch { } }
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
const initials = n => { const w = String(n || '?').trim().split(/\s+/); return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase(); };
const closePops = () => document.querySelectorAll('.pop.open').forEach(p => p.classList.remove('open'));
if (!window.__popBound) { window.__popBound = true; document.addEventListener('click', e => { if (!e.target.closest('.tb-wrap')) closePops(); }); }
const togglePop = id => { const el = document.getElementById(id), was = el.classList.contains('open'); closePops(); if (!was) el.classList.add('open'); };

// ---- top-bar search: pages, products, customers, suppliers, receipts, expenses, deliveries, users ----
const PAGE_WORDS = { pos: 'sell checkout till cart', dashboard: 'home overview summary', sales: 'history receipts', stock: 'inventory reorder low out add stock', expenses: 'bills costs spending', users: 'staff cashier manager admin accounts', settings: 'store name tax currency receipt footer', suppliers: 'vendors', customers: 'clients buyers', products: 'items prices catalogue', categories: 'groups', reports: 'analytics' };
function goView(view, fn) {   // open a page, then run fn once its search box exists
  go(view); let n = 0;
  const t = setInterval(() => { if (S.view === view && $('#q')) { clearInterval(t); fn(); } else if (++n > 50) clearInterval(t); }, 100);
}
function goSearch(view, text) { goView(view, () => { $('#q').value = text; $('#q').dispatchEvent(new Event('input')); const g = $('#go'); if (g) g.click(); }); }
function goReport(type) { go('reports'); guard(openReport)(type); }

function initGlobalSearch() {
  const inp = $('#gs'), pop = $('#gsPop'); let timer = null, seq = 0, acts = [], sel = -1;
  const hide = () => { pop.classList.remove('open'); sel = -1; };
  const hilite = () => { pop.querySelectorAll('.gs-i').forEach((e, i) => e.classList.toggle('sel', i === sel)); const e = pop.querySelectorAll('.gs-i')[sel]; if (e) e.scrollIntoView({ block: 'nearest' }); };
  const run = async () => {
    const t = inp.value.trim(); if (!t) return hide();
    const my = ++seq, low = t.toLowerCase();
    const d = await api('search', { params: { q: t } }).catch(() => ({}));
    if (my !== seq) return;   // a newer search is already running
    acts = []; let html = '';
    const group = (title, items) => { if (!items || !items.length) return; html += `<div class="gs-h">${title}</div>`; items.forEach(it => { html += `<button class="gs-i" data-a="${acts.length}"><span>${it.l}</span><small>${it.r || ''}</small></button>`; acts.push(it.go); }); };
    // pages and reports (matched by name or keywords)
    const pages = NAV.filter(canSee).filter(n => (n[1] + ' ' + (PAGE_WORDS[n[0]] || '')).toLowerCase().includes(low)).map(n => ({ l: '📄 ' + esc(n[1]), r: 'page', go: () => go(n[0]) }));
    const reps = isManager() ? REPORTS.filter(r => r[1].toLowerCase().includes(low) || r[0].includes(low)).map(r => ({ l: '📈 ' + esc(r[1]), r: 'report', go: () => goReport(r[0]) })) : [];
    group('Pages & reports', [...pages, ...reps].slice(0, 6));
    group('Products', (d.products || []).map(p => ({ l: esc(p.name), r: p.stock <= 0 ? 'Out of stock' : `${money(p.price)}${esc(per(p.unit))} · ${qfmt(p.stock)} left`, go: () => { if (p.stock <= 0) return toast(p.name + ' is out of stock', true); S.pendingAdd = p.id; go('pos'); } })));
    group('Customers', (d.customers || []).map(c => ({ l: esc(c.name), r: esc(c.phone || c.address || ''), go: () => goSearch('customers', c.name) })));
    group('Suppliers', (d.suppliers || []).map(c => ({ l: esc(c.name), r: esc(c.phone || ''), go: () => goSearch('suppliers', c.name) })));
    group('Categories', (d.categories || []).map(c => ({ l: esc(c.name), r: 'category', go: () => go('categories') })));
    group('Receipts', (d.sales || []).map(x => ({ l: esc(x.receipt_no) + (x.customer ? ' · ' + esc(x.customer) : ''), r: `${money(x.total)}${x.status === 'voided' ? ' · voided' : ''}`, go: guard(async () => showReceipt(await api('sales', { params: { id: x.id } }))) })));
    group('Expenses', (d.expenses || []).map(x => ({ l: esc(x.description || x.category), r: `${esc(x.expense_date)} · ${money(x.amount)}`, go: () => goView('expenses', () => { $('#from').value = x.expense_date; $('#to').value = x.expense_date; $('#q').value = ''; $('#go').click(); }) })));
    group('Stock deliveries', (d.deliveries || []).map(x => ({ l: esc(x.product_name), r: `+${qfmt(x.qty)} · ${esc(fdt(x.created_at))}`, go: () => goSearch('stock', x.product_name) })));
    group('Users', (d.users || []).map(x => ({ l: esc(x.full_name) + ' (' + esc(x.username) + ')', r: esc(cap(x.role)), go: () => go('users') })));
    pop.innerHTML = html || '<div class="pop-i muted">Nothing found</div>'; pop.classList.add('open'); sel = acts.length ? 0 : -1; hilite();
    pop.querySelectorAll('.gs-i').forEach(b => b.onclick = () => { acts[+b.dataset.a](); inp.value = ''; hide(); });
  };
  inp.oninput = () => { clearTimeout(timer); timer = setTimeout(guard(run), 220); };
  inp.onfocus = () => { if (inp.value.trim()) run(); };
  inp.onkeydown = e => {
    const n = acts.length;
    if (e.key === 'Escape') { hide(); inp.blur(); }
    else if (e.key === 'ArrowDown' && n) { e.preventDefault(); sel = (sel + 1) % n; hilite(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); sel = (sel - 1 + n) % n; hilite(); }
    else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); acts[sel](); inp.value = ''; hide(); }
  };
  document.addEventListener('click', e => { if (!e.target.closest('.tb-search')) hide(); });
}

async function refreshBell(force) {
  if (!isManager() || !$('#bell')) return;
  if (!force && Date.now() - (S.bellAt || 0) < 20000) return; S.bellAt = Date.now();
  try {
    const r = await api('report'), list = r.low_stock || [];
    const n = $('#bellN'); if (n) { n.textContent = list.length; n.style.display = list.length ? '' : 'none'; }
    const pop = $('#bellPop'); if (!pop) return;
    pop.innerHTML = `<div class="pop-h">Stock alerts</div>${list.slice(0, 8).map(p => `<div class="pop-i"><span>${esc(p.name)}</span><b class="${p.stock <= 0 ? 'bad' : 'warn'}">${p.stock <= 0 ? 'Out' : qfmt(p.stock) + ' ' + esc(p.unit)}</b></div>`).join('') || '<div class="pop-i muted">Everything is stocked 👍</div>'}${list.length > 8 ? `<div class="pop-i muted">+ ${list.length - 8} more</div>` : ''}<button class="pop-a" id="bellGo">Open Stock</button>`;
    $('#bellGo').onclick = () => { closePops(); go('stock'); };
  } catch { }
}

function shell() {
  if (S.clockTimer) clearInterval(S.clockTimer); if (S.bellTimer) clearInterval(S.bellTimer);
  const first = String(S.user.full_name || S.user.username).trim().split(/\s+/)[0];
  $('#app').innerHTML = `<div class="shell ${isCollapsed() ? 'collapsed' : ''}"><aside class="side"><button class="side-toggle" id="collapse" title="Collapse / expand menu" aria-label="Collapse or expand menu"><i>«</i></button><div class="brand" id="brand">${brandHtml()}</div>
    ${NAV.filter(canSee).map((n, i, a) => `${i > 0 && n[2] && !a[i - 1][2] ? '<hr class="navrule">' : ''}<button class="nav" data-v="${n[0]}" title="${n[1]}"><i>${NAV_ICON[n[0]] || '•'}</i><span>${n[1]}</span></button>`).join('')}</aside>
    <div class="content"><header class="topbar">
      <div class="clock" id="clock" title="Current date and time">${clockText()}</div>
      <div class="tb-search tb-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="gs" type="search" placeholder="Search…" autocomplete="off" aria-label="Search products, customers, suppliers, receipts"><div class="pop gs-pop" id="gsPop"></div></div><div class="tb-sp"></div>
      <div class="tb-wrap"><button class="tb-btn" id="zoomb" title="Screen size">${IC.sliders}<span id="zoomv">${getZoom()}%</span></button>
        <div class="pop" id="zoomPop"><div class="pop-h">Screen size</div>${ZOOMS.map(z => `<button class="pop-i btn-i" data-z="${z}">${z}%${z === 100 ? ' (normal)' : ''}</button>`).join('')}</div></div>
      <button class="tb-ico" id="theme" title="Day / night mode">${isDark() ? IC.sun : IC.moon}</button>
      ${isManager() ? `<div class="tb-wrap"><button class="tb-ico" id="bell" title="Stock alerts">${IC.bell}<em class="dot" id="bellN" style="display:none"></em></button><div class="pop" id="bellPop"></div></div>` : ''}
      <div class="tb-wrap"><button class="uchip" id="uchip"><b>${esc(first)}</b>${IC.chev}<span class="av">${esc(initials(S.user.full_name || S.user.username))}</span></button>
        <div class="pop right" id="userPop"><div class="pop-h">${esc(S.user.full_name)}</div><div class="pop-i muted">${esc(cap(S.user.role))} · ${esc(S.user.username)}</div><button class="pop-a" id="cpw" style="margin-bottom:6px">Change password</button><button class="pop-a" id="lo">Log out</button><div class="pop-i muted" style="font-size:11.5px;justify-content:center">Version ${esc(document.body.dataset.version || '—')}</div></div></div>
    </header><main class="main" id="main"></main></div></div>`;
  S.clockTimer = setInterval(() => { const c = $('#clock'); if (!c) return clearInterval(S.clockTimer); c.textContent = clockText(); }, 1000);
  S.bellTimer = setInterval(() => refreshBell(true), 120000);
  document.querySelectorAll('.nav[data-v]').forEach(b => b.onclick = () => go(b.dataset.v));
  $('#collapse').onclick = () => { const sh = $('.shell'); sh.classList.toggle('collapsed'); try { localStorage.setItem('pos-side', sh.classList.contains('collapsed') ? '1' : '0'); } catch { } };
  $('#theme').onclick = () => { const t = isDark() ? 'light' : 'dark'; applyTheme(t); $('#theme').innerHTML = isDark() ? IC.sun : IC.moon; try { localStorage.setItem('pos-theme', t); } catch { } };
  $('#zoomb').onclick = () => togglePop('zoomPop'); $('#uchip').onclick = () => togglePop('userPop'); if ($('#bell')) $('#bell').onclick = () => { togglePop('bellPop'); refreshBell(true); };
  document.querySelectorAll('[data-z]').forEach(b => b.onclick = () => { applyZoom(+b.dataset.z); closePops(); });
  $('#lo').onclick = async e => { e.preventDefault(); await api('logout', { method: 'POST' }).catch(() => { }); boot(); };
  $('#cpw').onclick = () => { closePops(); changePasswordModal(false); };
  initGlobalSearch();
  applyZoom(getZoom());
  if (S.user.must_change) {   // default or guessable password: nothing else works until it is replaced
    $('#main').innerHTML = '<div class="empty">Please choose a new password to continue.</div>';
    return changePasswordModal(true);
  }
  refreshBell(true);
  go(S.view);
}

function changePasswordModal(force) {
  const m = modal(`<h3>${force ? 'Choose a new password' : 'Change password'}</h3>
    ${force ? '<p style="color:var(--muted);margin-top:0">You are using a password that is easy to guess (or one that came with the system). Please set your own before you continue.</p>' : ''}
    <form><div class="field"><label>Current password</label><input name="cur" type="password" autocomplete="current-password" required></div>
    <div class="field"><label>New password (min 8 characters)</label><input name="new" type="password" autocomplete="new-password" minlength="8" required></div>
    <div class="field"><label>Repeat new password</label><input name="again" type="password" autocomplete="new-password" minlength="8" required></div>
    <p class="cp-err" role="alert" style="color:var(--bad);min-height:18px;margin:4px 0"></p>
    <div class="actions">${force ? '<button type="button" class="btn sec" data-out>Log out</button>' : '<button type="button" class="btn sec" data-x>Cancel</button>'}<button class="btn">Save password</button></div></form>`, false, force);
  const f = $('form', m.el), err = $('.cp-err', m.el);
  const x = $('[data-x]', m.el); if (x) x.onclick = m.close;
  const o = $('[data-out]', m.el); if (o) o.onclick = async () => { await api('logout', { method: 'POST' }).catch(() => { }); m.close(); boot(); };
  f.onsubmit = async e => {
    e.preventDefault(); err.textContent = '';
    const el = f.elements;
    if (el.new.value !== el.again.value) { err.textContent = 'The two new passwords do not match.'; return; }
    try {
      await api('change_password', { method: 'POST', body: { current_password: el.cur.value, new_password: el.new.value } });
      m.close(); toast('Password changed');
      if (force) boot();   // reload the user, settings and screen now that the account is unlocked
    } catch (ex) { err.textContent = ex.message; }
  };
  $('input', m.el).focus();
}

function go(v) {
  if (!VIEWS[v] || !canSee(NAV.find(n => n[0] === v))) v = 'pos';
  S.view = v;
  document.querySelectorAll('.nav[data-v]').forEach(b => b.classList.toggle('active', b.dataset.v === v));
  $('#main').innerHTML = '<div class="empty">Loading…</div>';
  guard(VIEWS[v])();
}

// ---------- receipt ----------
function receiptHtml(s) {
  const st = S.settings;
  return `<div class="receipt"><h4>${esc(st.store_name)}</h4><div class="c">${esc(st.address)}<br>${esc(st.phone)}</div><hr>
    <div>Receipt: ${esc(s.receipt_no)}${s.status === 'voided' ? ' <b>(VOIDED)</b>' : ''}</div><div>${esc(fdt(s.created_at))}</div>
    <div>Cashier: ${esc(s.cashier)}</div>${s.customer_name ? `<div>Customer: ${esc(s.customer_name)}</div>` : ''}<hr>
    ${s.items.map(i => `<div>${esc(i.name)}</div><div class="ri"><span>${qfmt(i.qty)}${i.unit && i.unit !== 'pc' ? ' ' + esc(i.unit) : ''} x ${Number(i.price).toFixed(2)}</span><span>${Number(i.line_total).toFixed(2)}</span></div>`).join('')}<hr>
    <div class="ri"><span>Subtotal</span><span>${Number(s.subtotal).toFixed(2)}</span></div>
    ${Number(s.discount) > 0 ? `<div class="ri"><span>Discount</span><span>-${Number(s.discount).toFixed(2)}</span></div>` : ''}
    <div class="ri"><span>Tax (${esc(st.tax_rate)}%)</span><span>${Number(s.tax).toFixed(2)}</span></div>
    <div class="ri tot"><span>TOTAL</span><span>${money(s.total)}</span></div>
    <div class="ri"><span>Paid (${esc(s.payment_method)})</span><span>${Number(s.amount_paid).toFixed(2)}</span></div>
    <div class="ri"><span>Change</span><span>${Number(s.change_due).toFixed(2)}</span></div><hr>
    <div class="c">${esc(st.receipt_footer)}</div></div>`;
}
function showReceipt(s) {
  const m = modal(`${receiptHtml(s)}<div class="actions"><button class="btn sec" data-x>Close</button>
    ${isManager() && s.status === 'completed' ? '<button class="btn bad" data-void>Void sale</button>' : ''}<button class="btn" data-p>Print receipt</button></div>`);
  $('[data-x]', m.el).onclick = m.close;
  $('[data-p]', m.el).onclick = () => { $('#receipt-print').innerHTML = receiptHtml(s); window.print(); };
  const v = $('[data-void]', m.el);
  if (v) v.onclick = guard(async () => {
    if (!confirm('Void this sale and return the items to stock?')) return;
    await api('void', { method: 'POST', params: { id: s.id } }); toast('Sale voided'); m.close(); if (S.view === 'sales') go('sales');
  });
}

// ---------- POS ----------
async function viewPOS() {
  [S.products, S.categories, S.customers] = await Promise.all([api('products'), api('categories'), api('customers')]);
  let cat = 0, method = 'cash';
  $('#main').innerHTML = `<div class="pos">
    <div class="pos-left"><div class="tools"><input id="q" placeholder="Search name / SKU, or scan barcode and press Enter" style="flex:1" autofocus></div>
      <div class="chips" id="chips"></div><div class="products" id="plist"></div></div>
    <div class="card cart"><div class="cart-head"><h3>Current sale</h3><button class="btn sec sm" id="clr">Clear</button></div>
      <div class="cart-items" id="items"></div>
      <div class="totals" id="tot"></div>
      <div class="row2"><input id="disc" type="number" min="0" step="0.01" placeholder="Discount (amount)">
        <select id="cust"><option value="">Walk-in customer</option>${S.customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="pay" id="pay"><button data-m="cash" class="active">Cash</button><button data-m="mpesa">M-Pesa</button><button data-m="card">Card</button></div>
      <div id="cashbox" class="row2"><input id="paid" type="number" min="0" step="0.01" placeholder="Amount received"><button class="btn sec" id="exact">Exact</button></div>
      <div id="chg" style="text-align:right;color:var(--muted);min-height:20px"></div>
      <button class="btn ok lg" id="chk">Complete sale</button></div></div>`;

  const renderChips = () => {
    $('#chips').innerHTML = `<span class="chip ${!cat ? 'active' : ''}" data-c="0">All</span>` + S.categories.map(c => `<span class="chip ${cat === c.id ? 'active' : ''}" data-c="${c.id}">${esc(c.name)}</span>`).join('');
    document.querySelectorAll('.chip').forEach(c => c.onclick = () => { cat = +c.dataset.c; renderChips(); renderProducts(); });
  };
  const renderProducts = () => {
    const t = $('#q').value.trim().toLowerCase();
    const list = S.products.filter(p => (!cat || p.category_id === cat) && (!t || p.name.toLowerCase().includes(t) || p.sku.toLowerCase().includes(t) || p.barcode === $('#q').value.trim()));
    $('#plist').innerHTML = list.length ? list.map(p => `<button class="prod ${p.stock <= 0 ? 'out' : ''}" data-id="${p.id}"><div class="n">${esc(p.name)}</div><div class="p">${money(p.price)}<small>${esc(per(p.unit))}</small></div><div class="st">${p.stock <= 0 ? 'Out of stock' : qfmt(p.stock) + ' ' + esc(p.unit) + ' in stock'}</div></button>`).join('') : '<div class="empty" style="grid-column:1/-1">No products found</div>';
    document.querySelectorAll('.prod').forEach(b => b.onclick = () => add(+b.dataset.id));
  };
  const lineTotal = l => l.amt != null ? l.amt : Math.round(l.price * l.qty * 100) / 100;
  const add = id => {
    const p = S.products.find(x => x.id === id); if (!p) return;
    const l = S.cart.find(x => x.id === id);
    const room = p.stock - (l ? l.qty : 0);
    if (room <= 0) return toast(`Only ${qfmt(p.stock)} ${p.unit} of ${p.name} in stock`, true);
    const step = Math.min(1, room);
    if (l) { l.qty = Math.round((l.qty + step) * 1000) / 1000; l.amt = null; }
    else S.cart.push({ id, name: p.name, price: +p.price, unit: p.unit, stock: p.stock, qty: step, amt: null });
    renderCart();
    if (!l && isDec(p.unit)) { const el = document.querySelector(`input[data-q="${id}"]`); if (el) { el.focus(); el.select(); } }
  };
  const calc = () => {
    const sub = Math.round(S.cart.reduce((a, l) => a + lineTotal(l), 0) * 100) / 100;
    const disc = Math.max(0, Math.min(+$('#disc').value || 0, sub));
    const tax = Math.round((sub - disc) * (+S.settings.tax_rate || 0)) / 100;
    return { sub, disc, tax, total: Math.round((sub - disc + tax) * 100) / 100 };
  };
  const renderTotals = () => {
    const c = calc();
    $('#tot').innerHTML = `<div><span>Subtotal</span><span>${money(c.sub)}</span></div>${c.disc ? `<div><span>Discount</span><span>-${money(c.disc)}</span></div>` : ''}
      ${+S.settings.tax_rate ? `<div><span>Tax (${esc(S.settings.tax_rate)}%)</span><span>${money(c.tax)}</span></div>` : ''}<div class="grand"><span>Total</span><span>${money(c.total)}</span></div>`;
    const paid = +$('#paid').value || 0;
    $('#chg').textContent = method === 'cash' && paid ? (paid >= c.total ? `Change: ${money(paid - c.total)}` : `Short by ${money(c.total - paid)}`) : '';
  };
  const renderCart = () => {
    $('#items').innerHTML = S.cart.length ? S.cart.map(l => {
      const dec = isDec(l.unit);
      return `<div class="line${dec ? ' dec' : ''}"><div><div class="nm">${esc(l.name)}</div><div class="sub">${money(l.price)}${esc(per(l.unit))}</div></div>
      <div class="qty"><button data-d="-1" data-id="${l.id}">−</button><input class="qin" data-q="${l.id}" type="number" inputmode="decimal" min="0" step="${dec ? 'any' : 1}" value="${qfmt(l.qty)}" aria-label="Quantity"><em>${esc(l.unit === 'pc' ? '' : l.unit)}</em><button data-d="1" data-id="${l.id}">+</button></div>
      <div class="lt"><b data-lt="${l.id}">${money(lineTotal(l))}</b> <button class="btn sec sm" data-rm="${l.id}">✕</button></div>
      ${dec ? `<div class="byamt">or sell by amount <input class="ain" data-a="${l.id}" type="number" inputmode="decimal" min="0" step="any" placeholder="${esc(S.settings.currency || 'KES')}" value="${l.amt != null ? l.amt : ''}"></div>` : ''}</div>`;
    }).join('') : '<div class="empty">No items yet<br>Tap a product or scan a barcode</div>';
    document.querySelectorAll('[data-d]').forEach(b => b.onclick = () => {
      const l = S.cart.find(x => x.id === +b.dataset.id), d = +b.dataset.d, st = isDec(l.unit) ? 0.5 : 1;
      if (d > 0 && l.qty + st > l.stock + 1e-9) return toast(`Only ${qfmt(l.stock)} ${l.unit} in stock`, true);
      l.qty = Math.round((l.qty + d * st) * 1000) / 1000; l.amt = null;
      if (l.qty <= 0) S.cart = S.cart.filter(x => x !== l); renderCart();
    });
    // typed quantity (decimals allowed for kg / L only)
    document.querySelectorAll('.qin').forEach(inp => {
      inp.onfocus = () => inp.select();
      inp.oninput = () => {
        const l = S.cart.find(x => x.id === +inp.dataset.q); let v = parseFloat(inp.value);
        if (!(v > 0)) v = 0; else if (!isDec(l.unit)) v = Math.floor(v);
        if (v > l.stock) { v = l.stock; toast(`Only ${qfmt(l.stock)} ${l.unit} in stock`, true); inp.value = qfmt(v); }
        l.qty = Math.round(v * 1000) / 1000; l.amt = null;
        const a = document.querySelector(`input[data-a="${l.id}"]`); if (a) a.value = '';
        document.querySelector(`[data-lt="${l.id}"]`).textContent = money(lineTotal(l)); renderTotals();
      };
      inp.onchange = () => { const l = S.cart.find(x => x.id === +inp.dataset.q); if (l.qty <= 0) { S.cart = S.cart.filter(x => x !== l); renderCart(); } else inp.value = qfmt(l.qty); };
    });
    // sell by money amount, e.g. "100 shillings of cooking oil"
    document.querySelectorAll('.ain').forEach(inp => inp.oninput = () => {
      const l = S.cart.find(x => x.id === +inp.dataset.a), amt = Math.round((parseFloat(inp.value) || 0) * 100) / 100;
      if (amt <= 0 || !l.price) { l.amt = null; return renderTotals(); }
      let q = Math.round(amt / l.price * 1000) / 1000;
      if (q > l.stock) { q = l.stock; toast(`Only ${qfmt(l.stock)} ${l.unit} in stock`, true); l.amt = null; inp.value = ''; }
      else l.amt = amt;
      l.qty = q;
      document.querySelector(`input[data-q="${l.id}"]`).value = qfmt(q);
      document.querySelector(`[data-lt="${l.id}"]`).textContent = money(lineTotal(l)); renderTotals();
    });
    document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { S.cart = S.cart.filter(x => x.id !== +b.dataset.rm); renderCart(); });
    renderTotals();
  };

  $('#q').oninput = renderProducts;
  $('#q').onkeydown = e => {
    if (e.key !== 'Enter') return;
    const v = e.target.value.trim(); if (!v) return;
    const hit = S.products.find(p => p.barcode === v || p.sku.toLowerCase() === v.toLowerCase()) || (() => { const f = S.products.filter(p => p.name.toLowerCase().includes(v.toLowerCase())); return f.length === 1 ? f[0] : null; })();
    if (hit) { add(hit.id); e.target.value = ''; renderProducts(); } else toast('No single matching product', true);
  };
  $('#disc').oninput = renderTotals; $('#paid').oninput = renderTotals;
  $('#exact').onclick = () => { $('#paid').value = calc().total; renderTotals(); };
  $('#clr').onclick = () => { S.cart = []; $('#disc').value = ''; $('#paid').value = ''; renderCart(); };
  $('#pay').onclick = e => {
    const b = e.target.closest('button'); if (!b) return; method = b.dataset.m;
    document.querySelectorAll('#pay button').forEach(x => x.classList.toggle('active', x === b));
    $('#cashbox').classList.toggle('hidden', method !== 'cash'); renderTotals();
  };
  $('#chk').onclick = guard(async () => {
    if (!S.cart.length) return toast('Cart is empty', true);
    const c = calc(), paid = +$('#paid').value || 0;
    if (method === 'cash' && paid < c.total) return toast('Enter an amount received that covers the total', true);
    $('#chk').disabled = true;
    try {
      const sale = await api('sales', { method: 'POST', body: {
        items: S.cart.map(l => l.amt != null ? { product_id: l.id, amount: l.amt } : { product_id: l.id, qty: l.qty }), discount: c.disc, payment_method: method,
        amount_paid: method === 'cash' ? paid : c.total, customer_id: $('#cust').value || null } });
      S.cart = []; $('#disc').value = ''; $('#paid').value = '';
      showReceipt(sale); toast(`Sale ${sale.receipt_no} complete`);
      S.products = await api('products'); renderProducts(); renderCart();
    } finally { $('#chk').disabled = false; }
  });
  renderChips(); renderProducts(); renderCart(); $('#q').focus();
  if (S.pendingAdd) { const id = S.pendingAdd; S.pendingAdd = null; add(id); }   // chosen from the top-bar search
}

// ---------- Sales ----------
async function viewSales() {
  $('#main').innerHTML = `<div class="head"><h2>Sales history</h2><div class="tools"><label>From</label><input type="date" id="from" value="${today()}"><label>To</label><input type="date" id="to" value="${today()}"><button class="btn" id="go">Show</button></div></div><div id="tbl"></div>`;
  const load = guard(async () => {
    const rows = await api('sales', { params: { from: $('#from').value, to: $('#to').value } });
    const ok = rows.filter(r => r.status === 'completed').reduce((a, r) => a + +r.total, 0);
    $('#tbl').innerHTML = `<p style="color:var(--muted)">${rows.length} sale(s) · completed total <b>${money(ok)}</b></p><table><tr><th>Receipt</th><th>Date</th><th>Cashier</th><th>Customer</th><th class="r">Items</th><th>Payment</th><th class="r">Total</th><th>Status</th></tr>
      ${rows.map(r => `<tr class="click" data-id="${r.id}"><td>${esc(r.receipt_no)}</td><td>${esc(fdt(r.created_at))}</td><td>${esc(r.cashier)}</td><td>${esc(r.customer_name || '—')}</td><td class="r">${r.items}</td><td>${esc(r.payment_method)}</td><td class="r">${money(r.total)}</td><td><span class="badge ${r.status === 'completed' ? 'ok' : 'bad'}">${r.status}</span></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No sales in this period</td></tr>'}</table>`;
    document.querySelectorAll('tr.click').forEach(tr => tr.onclick = guard(async () => showReceipt(await api('sales', { params: { id: tr.dataset.id } }))));
  });
  $('#go').onclick = load; load();
}

// ---------- Customers ----------
async function viewCustomers() {
  const f = [{ name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'address', label: 'Address' }];
  $('#main').innerHTML = `<div class="head"><h2>Customers</h2><button class="btn" id="add">+ Add customer</button></div>
    <p style="color:var(--muted);margin:-6px 0 12px">Search by name, phone, email or address.</p>
    <div class="tools" style="margin-bottom:14px"><input id="q" placeholder="Search customers…" style="width:320px"><button class="btn" id="go">Search</button><button class="btn sec" id="clr">Clear</button></div>
    <div class="card"><h3 style="margin:0 0 2px">Customer List</h3><p id="cnt" style="color:var(--muted);margin:0 0 8px"></p><div id="tbl"></div></div>
    <p style="margin-top:14px"><button class="btn sec" id="back">← Back to ${isManager() ? 'Dashboard' : 'Point of Sale'}</button></p>`;
  const load = guard(async () => {
    const rows = await api('customers', { params: { q: $('#q').value.trim() } });
    $('#cnt').textContent = `${rows.length} customer(s) found.`;
    $('#tbl').innerHTML = `<table><tr><th>ID</th><th>First name</th><th>Last name</th><th>Phone</th><th>Email</th><th>Address</th><th class="r">Actions</th></tr>${rows.map(c => `<tr><td>#${c.id}</td><td>${esc(c.first_name || c.name)}</td><td>${esc(c.last_name || '')}</td><td>${esc(c.phone || '')}</td><td>${esc(c.email || '')}</td><td>${esc(c.address || '')}</td>
      <td class="r"><button class="btn sec sm" data-e="${c.id}">Edit</button> ${isManager() ? `<button class="btn bad sm" data-d="${c.id}">Delete</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No customers found</td></tr>'}</table>`;
    document.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { const c = rows.find(x => x.id === +b.dataset.e); formModal('Edit customer', f, c, async o => { await api('customers', { method: 'PUT', params: { id: c.id }, body: o }); toast('Saved'); load(); }); });
    document.querySelectorAll('[data-d]').forEach(b => b.onclick = guard(async () => { if (confirm('Delete this customer? Their past sales are kept.')) { await api('customers', { method: 'DELETE', params: { id: b.dataset.d } }); load(); } }));
  });
  $('#go').onclick = load; $('#clr').onclick = () => { $('#q').value = ''; load(); };
  $('#q').onkeydown = e => { if (e.key === 'Enter') load(); };
  $('#back').onclick = () => go(isManager() ? 'dashboard' : 'pos');
  $('#add').onclick = () => formModal('New customer', f, {}, async o => { await api('customers', { method: 'POST', body: o }); toast('Customer added'); load(); });
  load();
}

// ---------- Dashboard ----------
const QUICK = [['products', '📦', 'Products', 'Manage products'], ['pos', '💰', 'Sales', 'Record and view sales'], ['customers', '👥', 'Customers', 'Manage customers'],
  ['stock', '📋', 'Stock Management', 'Manage inventory'], ['suppliers', '🚚', 'Suppliers', 'Manage suppliers'], ['reports', '📈', 'Reports', 'View business reports'],
  ['reports', '🧾', 'Sales Report', 'View sales performance', 'sales'], ['expenses', '💳', 'Expenses', 'Manage expenses'], ['users', '👤', 'User Management', 'Manage system users']];
async function viewDashboard() {
  const r = await api('report');
  const max = Math.max(1, ...r.daily.map(d => d.total));
  const stat = (l, v, s) => `<div class="card stat"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const c = r.counts, neg = r.net_profit_today < 0;
  const tile = (ic, l, v, cls = '') => `<div class="card dtile ${cls}"><i>${ic}</i><div><div class="l">${l}</div><div class="v">${v}</div></div></div>`;
  $('#main').innerHTML = `<div class="head"><h2>Dashboard</h2></div><p style="color:var(--muted);margin:-6px 0 12px">Overview of your shop's current activities.</p>
    <div class="grid g4 dtiles">${tile('💰', "Today's Sales", money(r.today.total))}${tile('🧾', 'Sales Today', r.today.count)}${tile('📦', 'Total Products', c.products)}${tile('📋', 'Products in Stock', c.in_stock)}
      ${tile('👥', 'Customers', c.customers)}${tile('🚚', 'Suppliers', c.suppliers)}${tile('⚠️', 'Low Stock', c.low, c.low ? 'warn' : '')}${tile('❌', 'Out of Stock', c.out, c.out ? 'bad' : '')}
      ${tile('💳', "Today's Expenses", money(r.expenses_today))}${tile('📈', "Today's Net Profit", `<span style="color:var(--${neg ? 'bad' : 'ok'},inherit)">${money(r.net_profit_today)}</span>`)}${tile('🗓️', 'This week', money(r.week.total))}${tile('📅', 'This month', money(r.month.total))}</div>
    <div class="card" style="margin-top:12px"><h3 style="margin:0">Quick Access</h3><p style="color:var(--muted);margin:2px 0 10px">Quickly access commonly used areas.</p>
      <div class="qa">${QUICK.filter(t => canSee(NAV.find(n => n[0] === t[0]))).map(t => `<button class="qa-t" data-go="${t[0]}" ${t[4] ? `data-rep="${t[4]}"` : ''}><i>${t[1]}</i><span><b>${t[2]}</b><small>${t[3]}</small></span></button>`).join('')}</div></div>
    <div class="grid g2" style="margin-top:12px">
      <div class="card"><b>Last 7 days</b><div class="bars">${r.daily.map(d => `<div class="bar" title="${money(d.total)}">${d.total ? Math.round(d.total) : ''}<i style="height:${Math.max(2, d.total / max * 100)}%"></i><span>${esc(d.label)}</span></div>`).join('')}</div></div>
      <div class="card"><b>Top products (30 days)</b><table style="box-shadow:none;margin-top:8px"><tr><th>Product</th><th class="r">Qty</th><th class="r">Revenue</th></tr>${r.top.map(t => `<tr><td>${esc(t.name)}</td><td class="r">${qfmt(t.qty)} ${esc(t.unit)}</td><td class="r">${money(t.revenue)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No sales yet</td></tr>'}</table></div>
      <div class="card"><b>Low stock</b><table style="box-shadow:none;margin-top:8px"><tr><th>Product</th><th class="r">Stock</th><th class="r">Reorder at</th></tr>${r.low_stock.map(p => `<tr><td>${esc(p.name)}</td><td class="r"><span class="badge ${p.stock <= 0 ? 'bad' : 'warn'}">${qfmt(p.stock)} ${esc(p.unit)}</span></td><td class="r">${qfmt(p.reorder_level)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Everything is stocked</td></tr>'}</table></div>
      <div class="card"><b>Today by payment method</b><table style="box-shadow:none;margin-top:8px"><tr><th>Method</th><th class="r">Sales</th><th class="r">Total</th></tr>${r.by_payment.map(p => `<tr><td>${esc(p.payment_method)}</td><td class="r">${p.count}</td><td class="r">${money(p.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No sales today</td></tr>'}</table></div></div>`;
  document.querySelectorAll('.qa-t').forEach(b => b.onclick = () => {
    if (!b.dataset.rep) return go(b.dataset.go);
    S.view = 'reports'; document.querySelectorAll('.nav[data-v]').forEach(n => n.classList.toggle('active', n.dataset.v === 'reports')); guard(openReport)(b.dataset.rep);
  });
}

// ---------- Products ----------
async function viewProducts() {
  [S.categories, S.suppliers] = await Promise.all([api('categories'), api('suppliers')]);
  const fields = () => [
    { name: 'sku', label: 'SKU', required: true }, { name: 'barcode', label: 'Barcode (optional)' }, { name: 'name', label: 'Product name', required: true },
    { name: 'category_id', label: 'Category', type: 'select', options: [{ value: '', label: '— none —' }, ...S.categories.map(c => ({ value: c.id, label: c.name }))] },
    { name: 'supplier_id', label: 'Supplier', type: 'select', options: [{ value: '', label: '— none —' }, ...S.suppliers.map(c => ({ value: c.id, label: c.name }))] },
    { name: 'unit', label: 'Sold by (unit)', type: 'select', options: UNIT_OPTIONS, default: 'pc' },
    { name: 'price', label: 'Selling price (per unit)', type: 'number', step: '0.01', required: true }, { name: 'cost', label: 'Cost price (per unit)', type: 'number', step: '0.01', default: 0 },
    { name: 'stock', label: 'Stock quantity (kg / L can have decimals)', type: 'number', step: 'any', default: 0 }, { name: 'reorder_level', label: 'Reorder level', type: 'number', step: 'any', default: 5 },
    { name: 'active', label: 'Active (available for sale)', type: 'checkbox', default: true }];
  $('#main').innerHTML = `<div class="head"><h2>Products</h2><input id="q" placeholder="Search…" style="width:220px"><button class="btn" id="add">+ Add product</button></div><div id="seed"></div><div id="tbl"></div>`;
  const load = guard(async () => {
    const rows = await api('products', { params: { all: 1, q: $('#q').value.trim() } });
    const all = $('#q').value.trim() ? await api('products', { params: { all: 1 } }) : rows;
    $('#seed').innerHTML = isAdmin() && !all.some(r => r.sku === 'MLK001')
      ? `<div class="card" style="margin-bottom:12px;display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap"><div><b>Load your shop products</b><div style="color:var(--muted)">Adds milk, mala, eggs, chicken, cereals, flours and cooking oil (26 items with example prices). Your existing products are not changed.</div></div><button class="btn" id="seedgo">Load shop products</button></div>` : '';
    if ($('#seedgo')) $('#seedgo').onclick = guard(async () => { await api('seed_shop', { method: 'POST' }); toast('Shop products loaded'); load(); });
    $('#tbl').innerHTML = `<table><tr><th>SKU</th><th>Name</th><th>Category</th><th>Supplier</th><th>Unit</th><th class="r">Price</th><th class="r">Cost</th><th class="r">Stock</th><th>Status</th><th></th></tr>${rows.map(p => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(p.category || '—')}</td><td>${esc(p.supplier || '—')}</td><td>${esc(p.unit)}</td><td class="r">${money(p.price)}</td><td class="r">${money(p.cost)}</td>
      <td class="r"><span class="badge ${p.stock <= p.reorder_level ? (p.stock <= 0 ? 'bad' : 'warn') : 'ok'}">${qfmt(p.stock)}</span></td><td>${p.active ? 'Active' : '<span class="badge">Inactive</span>'}</td>
      <td class="r"><button class="btn sec sm" data-e="${p.id}">Edit</button> ${p.active ? `<button class="btn bad sm" data-d="${p.id}">Deactivate</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">No products</td></tr>'}</table>`;
    document.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { const p = rows.find(x => x.id === +b.dataset.e); formModal('Edit product', fields(), p, async o => { await api('products', { method: 'PUT', params: { id: p.id }, body: o }); toast('Saved'); load(); }); });
    document.querySelectorAll('[data-d]').forEach(b => b.onclick = guard(async () => { if (confirm('Deactivate this product? Past sales are kept.')) { await api('products', { method: 'DELETE', params: { id: b.dataset.d } }); load(); } }));
  });
  $('#q').oninput = load;
  $('#add').onclick = () => formModal('New product', fields(), {}, async o => { await api('products', { method: 'POST', body: o }); toast('Product added'); load(); });
  load();
}

// ---------- Categories ----------
async function viewCategories() {
  const f = [{ name: 'name', label: 'Category name', required: true }];
  $('#main').innerHTML = `<div class="head"><h2>Categories</h2><button class="btn" id="add">+ Add category</button></div><div id="tbl"></div>`;
  const load = guard(async () => {
    const rows = await api('categories');
    $('#tbl').innerHTML = `<table><tr><th>Name</th><th class="r">Products</th><th></th></tr>${rows.map(c => `<tr><td>${esc(c.name)}</td><td class="r">${c.products}</td><td class="r"><button class="btn sec sm" data-e="${c.id}">Rename</button> <button class="btn bad sm" data-d="${c.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="3" class="empty">No categories</td></tr>'}</table>`;
    document.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { const c = rows.find(x => x.id === +b.dataset.e); formModal('Rename category', f, c, async o => { await api('categories', { method: 'PUT', params: { id: c.id }, body: o }); load(); }); });
    document.querySelectorAll('[data-d]').forEach(b => b.onclick = guard(async () => { if (confirm('Delete category? Its products will become uncategorised.')) { await api('categories', { method: 'DELETE', params: { id: b.dataset.d } }); load(); } }));
  });
  $('#add').onclick = () => formModal('New category', f, {}, async o => { await api('categories', { method: 'POST', body: o }); load(); });
  load();
}

// ---------- Users ----------
async function viewUsers() {
  const roles = [{ value: 'cashier', label: 'Cashier' }, { value: 'manager', label: 'Manager' }, { value: 'admin', label: 'Admin' }];
  $('#main').innerHTML = `<div class="head"><h2>System Users</h2><button class="btn" id="add">+ Add user</button></div>
    <p style="color:var(--muted);margin:-6px 0 12px">View and manage users registered in the system. Only an admin can create accounts here; staff cannot sign themselves up. <b>Cashier</b>: sells and views own sales. <b>Manager</b>: also products, expenses, reports and voids. <b>Admin</b>: everything, including users and settings.</p><div id="tbl"></div>`;
  const load = guard(async () => {
    const rows = await api('users');
    $('#tbl').innerHTML = `<table><tr><th>ID</th><th>Full name</th><th>Username</th><th>Role</th><th>Status</th><th>Created at</th><th class="r">Actions</th></tr>${rows.map(u => `<tr><td>#${u.id}</td><td>${esc(u.full_name)}</td><td>${esc(u.username)}</td>
      <td><span class="badge role-${esc(u.role)}">${esc(cap(u.role))}</span></td><td><span class="badge ${u.active ? 'ok' : 'bad'}">${u.active ? 'Active' : 'Inactive'}</span></td><td>${esc(String(u.created_at).slice(0, 19))}</td>
      <td class="r"><button class="btn sec sm" data-e="${u.id}">Edit</button> ${u.id === S.user.id ? '<span class="badge">Current User</span>' : `<button class="btn bad sm" data-x="${u.id}">Delete</button>`}</td></tr>`).join('')}</table>`;
    document.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { const u = rows.find(x => x.id === +b.dataset.e);
      formModal('Edit user: ' + u.username, [{ name: 'full_name', label: 'Full name', required: true }, { name: 'role', label: 'Role', type: 'select', options: roles }, { name: 'password', label: 'New password (leave blank to keep)', type: 'password' }, { name: 'active', label: 'Active', type: 'checkbox' }], u,
        async o => { await api('users', { method: 'PUT', params: { id: u.id }, body: o }); toast('Saved'); load(); }); });
    document.querySelectorAll('[data-x]').forEach(b => b.onclick = guard(async () => {
      const u = rows.find(x => x.id === +b.dataset.x);
      if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
      await api('users', { method: 'DELETE', params: { id: u.id } }); toast('User deleted'); load();
    }));
  });
  $('#add').onclick = () => formModal('New user', [{ name: 'username', label: 'Username', required: true }, { name: 'full_name', label: 'Full name', required: true }, { name: 'password', label: 'Password (min 8 chars)', type: 'password', required: true }, { name: 'role', label: 'Role', type: 'select', options: roles }], {},
    async o => { await api('users', { method: 'POST', body: o }); toast('User created'); load(); });
  load();
}

// ---------- Stock management ----------
async function viewStock() {
  $('#main').innerHTML = `<div class="head"><h2>Current Stock</h2></div><p style="color:var(--muted);margin:-6px 0 12px">Products and their current inventory levels.</p>
    <div class="tools" style="margin-bottom:12px"><input id="q" placeholder="Search product, category or supplier…" style="width:280px"><select id="f"><option value="">All stock levels</option><option value="Low stock">Low stock</option><option value="Out of stock">Out of stock</option></select></div>
    <div id="tbl"></div><div class="card" style="margin-top:16px"><b>Recently received stock</b><div id="log"></div></div>`;
  let rows = [];
  const stOf = p => p.stock <= 0 ? 'Out of stock' : p.stock <= p.reorder_level ? 'Low stock' : 'In stock';
  const draw = () => {
    const t = $('#q').value.trim().toLowerCase(), f = $('#f').value;
    const list = rows.filter(p => (!t || [p.name, p.category, p.supplier, p.sku].some(x => String(x || '').toLowerCase().includes(t))) && (!f || stOf(p) === f));
    $('#tbl').innerHTML = `<table><tr><th>ID</th><th>Product</th><th>Category</th><th>Supplier</th><th class="r">Current stock</th><th class="r">Reorder level</th><th>Status</th><th class="r">Action</th></tr>${list.map(p => `<tr><td>#${p.id}</td><td>${esc(p.name)}</td><td>${esc(p.category || '—')}</td><td>${esc(p.supplier || 'No Supplier')}</td>
      <td class="r"><b class="stk ${stOf(p) === 'In stock' ? 'good' : stOf(p) === 'Low stock' ? 'low' : 'none'}">${qfmt(p.stock)} ${esc(p.unit)}</b></td><td class="r">${qfmt(p.reorder_level)}</td><td>${stBadge(stOf(p))}</td><td class="r"><button class="btn sm" data-a="${p.id}">Add Stock</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No products match</td></tr>'}</table>`;
    document.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const p = rows.find(x => x.id === +b.dataset.a);
      formModal(`Add stock: ${p.name}`, [
        { name: 'qty', label: `Quantity received (${p.unit})`, type: 'number', step: isDec(p.unit) ? 'any' : '1', required: true },
        { name: 'cost', label: `Buying price per ${p.unit} (optional, updates cost price)`, type: 'number', step: '0.01', default: p.cost },
        { name: 'note', label: 'Note (optional)', placeholder: p.supplier ? 'From ' + p.supplier : 'e.g. delivery note no.' }], {},
        async o => { await api('stock_add', { method: 'POST', body: { product_id: p.id, ...o } }); toast(`Stock updated: ${p.name}`); load(); });
    });
  };
  const load = guard(async () => {
    const [pr, log] = await Promise.all([api('products'), api('stock_log')]); rows = pr; draw();
    $('#log').innerHTML = `<table style="box-shadow:none;margin-top:8px"><tr><th>Date</th><th>Product</th><th class="r">Received</th><th class="r">Buying price</th><th>Supplier</th><th>Note</th><th>By</th></tr>${log.map(r => `<tr><td>${esc(fdt(r.created_at))}</td><td>${esc(r.product_name)}</td><td class="r">${qfmt(r.qty)} ${esc(r.unit || '')}</td><td class="r">${money(r.cost)}</td><td>${esc(r.supplier_name || '—')}</td><td>${esc(r.note || '')}</td><td>${esc(r.added_by || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nothing received yet</td></tr>'}</table>`;
  });
  $('#q').oninput = draw; $('#f').onchange = draw; load();
}

// ---------- Suppliers ----------
async function viewSuppliers() {
  const f = [{ name: 'name', label: 'Supplier name', required: true }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'address', label: 'Address' }];
  $('#main').innerHTML = `<div class="head"><h2>Suppliers</h2><button class="btn" id="add">+ Add supplier</button></div>
    <p style="color:var(--muted);margin:-6px 0 12px">Search by supplier name, phone, email or address.</p>
    <div class="tools" style="margin-bottom:14px"><input id="q" placeholder="Search suppliers…" style="width:320px"><button class="btn" id="go">Search</button><button class="btn sec" id="clr">Clear</button></div>
    <div class="card"><h3 style="margin:0 0 2px">Supplier List</h3><p id="cnt" style="color:var(--muted);margin:0 0 8px"></p><div id="tbl"></div></div>`;
  const load = guard(async () => {
    const rows = await api('suppliers', { params: { q: $('#q').value.trim() } });
    $('#cnt').textContent = `${rows.length} supplier(s) found.`;
    $('#tbl').innerHTML = `<table><tr><th>ID</th><th>Supplier name</th><th>Phone</th><th>Email</th><th>Address</th><th class="r">Products</th><th class="r">Actions</th></tr>${rows.map(r => `<tr><td>#${r.id}</td><td>${esc(r.name)}</td><td>${esc(r.phone || '')}</td><td>${esc(r.email || '')}</td><td>${esc(r.address || '')}</td><td class="r">${r.products}</td>
      <td class="r"><button class="btn sec sm" data-e="${r.id}">Edit</button> <button class="btn bad sm" data-d="${r.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No suppliers yet. Add your milk, egg, chicken and flour suppliers.</td></tr>'}</table>`;
    document.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { const r = rows.find(x => x.id === +b.dataset.e); formModal('Edit supplier', f, r, async o => { await api('suppliers', { method: 'PUT', params: { id: r.id }, body: o }); toast('Saved'); load(); }); });
    document.querySelectorAll('[data-d]').forEach(b => b.onclick = guard(async () => { if (confirm('Delete this supplier? Their products stay, but will show no supplier.')) { await api('suppliers', { method: 'DELETE', params: { id: b.dataset.d } }); load(); } }));
  });
  $('#go').onclick = load; $('#clr').onclick = () => { $('#q').value = ''; load(); };
  $('#q').onkeydown = e => { if (e.key === 'Enter') load(); };
  $('#add').onclick = () => formModal('New supplier', f, {}, async o => { await api('suppliers', { method: 'POST', body: o }); toast('Supplier added'); load(); });
  load();
}

// ---------- Expenses ----------
const EXP_CATS = ['Rent', 'Electricity', 'Water', 'Transport', 'Salaries', 'Packaging', 'Licences & permits', 'Airtime & internet', 'Repairs', 'Stock losses', 'Other'];
const PAY_LABEL = { cash: 'Cash', bank: 'Bank', mpesa: 'M-Pesa', card: 'Card' };
async function viewExpenses() {
  const first = today().slice(0, 8) + '01';
  const f = () => [
    { name: 'expense_date', label: 'Date', type: 'date', required: true, default: today() },
    { name: 'category', label: 'Category', type: 'select', options: EXP_CATS.map(c => ({ value: c, label: c })), default: 'Other' },
    { name: 'description', label: 'Description', placeholder: 'e.g. Monthly electricity bill' },
    { name: 'amount', label: 'Amount', type: 'number', step: '0.01', required: true },
    { name: 'payment_method', label: 'Payment method', type: 'select', options: [{ value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank' }, { value: 'mpesa', label: 'M-Pesa' }], default: 'cash' }];
  $('#main').innerHTML = `<div class="head"><h2>Expenses Management</h2><button class="btn" id="add">+ Add expense</button></div>
    <div class="tools" style="margin-bottom:12px"><label>From</label><input type="date" id="from" value="${first}"><label>To</label><input type="date" id="to" value="${today()}">
      <input id="q" placeholder="Search description / category…" style="width:230px"><button class="btn" id="go">Search</button></div>
    <div class="grid g2" id="stats"></div><div class="card" style="margin-top:12px"><h3 style="margin:0 0 4px">Expense Records</h3><p style="color:var(--muted);margin:0 0 8px">View and manage recorded expenses.</p><div id="tbl"></div></div>`;
  let rows = [];
  const draw = () => {
    const t = $('#q').value.trim().toLowerCase();
    const list = rows.filter(r => !t || r.description.toLowerCase().includes(t) || r.category.toLowerCase().includes(t));
    const total = list.reduce((a, r) => a + +r.amount, 0);
    $('#stats').innerHTML = `<div class="card stat"><div class="l">Number of expenses</div><div class="v">${list.length}</div></div><div class="card stat"><div class="l">Total expenses</div><div class="v">${money(total)}</div></div>`;
    $('#tbl').innerHTML = `<table><tr><th>Expense ID</th><th>Date</th><th>Category</th><th>Description</th><th class="r">Amount</th><th>Payment</th><th class="r">Actions</th></tr>${list.map(r => `<tr><td>#${r.id}</td><td>${esc(r.expense_date)}</td><td><span class="badge">${esc(r.category)}</span></td><td>${esc(r.description)}</td><td class="r">${money(r.amount)}</td><td><span class="badge">${esc(PAY_LABEL[r.payment_method] || r.payment_method)}</span></td>
      <td class="r"><button class="btn sec sm" data-e="${r.id}">Edit</button> <button class="btn bad sm" data-d="${r.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No expenses in this period</td></tr>'}</table>`;
    document.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { const r = rows.find(x => x.id === +b.dataset.e);
      const fl = f(); if (!fl[1].options.some(o => o.value === r.category)) fl[1].options.push({ value: r.category, label: r.category });
      formModal('Edit expense', fl, r, async o => { await api('expenses', { method: 'PUT', params: { id: r.id }, body: o }); toast('Saved'); load(); }); });
    document.querySelectorAll('[data-d]').forEach(b => b.onclick = guard(async () => { if (confirm('Delete this expense?')) { await api('expenses', { method: 'DELETE', params: { id: b.dataset.d } }); load(); } }));
  };
  const load = guard(async () => { rows = await api('expenses', { params: { from: $('#from').value, to: $('#to').value } }); draw(); });
  $('#go').onclick = load; $('#q').oninput = draw;
  $('#add').onclick = () => formModal('New expense', f(), {}, async o => { await api('expenses', { method: 'POST', body: o }); toast('Expense added'); load(); });
  load();
}

// ---------- Reports ----------
const REPORTS = [
  ['sales', 'Sales Report', 'View sales made during a selected date range, including total sales and payment methods.', 'Open Sales Report', 'r-blue'],
  ['stock', 'Stock Report', 'View current stock levels, reorder levels, stock status and stock value.', 'Open Stock Report', 'r-green'],
  ['product', 'Product Report', 'View products, selling prices, margins, quantities sold, stock values and stock status.', 'Open Product Report', 'r-teal'],
  ['expense', 'Expense Report', 'View business expenses by date, category, payment method and amount.', 'Open Expense Report', 'r-orange'],
  ['pnl', 'Profit & Loss', 'View sales revenue, cost of goods sold, gross profit, expenses and net profit or loss.', 'Open Profit & Loss', 'r-gold'],
];
function csvDownload(name, cols, rows) {
  const cell = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const text = [cols.map(c => cell(c.h)), ...rows.map(r => cols.map(c => cell(c.csv ? c.csv(r) : r[c.k])))].map(l => l.join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const rtable = (cols, rows, foot) => `<table><tr>${cols.map(c => `<th class="${c.r ? 'r' : ''}">${esc(c.h)}</th>`).join('')}</tr>${rows.map(r => `<tr>${cols.map(c => `<td class="${c.r ? 'r' : ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="empty">No data for this period</td></tr>`}${foot || ''}</table>`;
const statCard = (l, v, s = '') => `<div class="card stat"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const stBadge = st => `<span class="badge ${st === 'In stock' ? 'ok' : st === 'Low stock' ? 'warn' : 'bad'}">${esc(st)}</span>`;
const miniTable = (h1, h2, rows, f) => `<table style="box-shadow:none"><tr><th>${h1}</th><th class="r">Count</th><th class="r">${h2}</th></tr>${rows.map(r => `<tr><td>${esc(f(r))}</td><td class="r">${r.count}</td><td class="r">${money(r.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No data</td></tr>'}</table>`;

const RDEF = {
  sales: {
    title: 'Sales Report', csv: 'sales-report.csv',
    cols: [{ h: 'Receipt', k: 'receipt_no' }, { h: 'Date', f: r => esc(fdt(r.created_at)), csv: r => r.created_at }, { h: 'Cashier', k: 'cashier' }, { h: 'Customer', f: r => esc(r.customer_name || '—'), csv: r => r.customer_name || '' },
      { h: 'Payment', f: r => esc(PAY_LABEL[r.payment_method] || r.payment_method), csv: r => r.payment_method }, { h: 'Discount', r: 1, f: r => money(r.discount), csv: r => r.discount }, { h: 'Tax', r: 1, f: r => money(r.tax), csv: r => r.tax },
      { h: 'Total', r: 1, f: r => money(r.total), csv: r => r.total }, { h: 'Status', f: r => `<span class="badge ${r.status === 'completed' ? 'ok' : 'bad'}">${esc(r.status)}</span>`, csv: r => r.status }],
    top: d => `<div class="grid g4">${statCard('Total sales', money(d.summary.total), d.summary.count + ' completed sale(s)')}${statCard('Discounts given', money(d.summary.discount))}${statCard('Tax collected', money(d.summary.tax))}${statCard('Voided sales', d.summary.voided, 'not counted in totals')}</div>
      <div class="card" style="margin:12px 0"><b>By payment method</b>${miniTable('Method', 'Total', d.by_payment, r => PAY_LABEL[r.payment_method] || r.payment_method)}</div>`,
  },
  stock: {
    title: 'Stock Report', csv: 'stock-report.csv', nodate: true,
    cols: [{ h: 'SKU', k: 'sku' }, { h: 'Product', k: 'name' }, { h: 'Category', k: 'category' }, { h: 'Unit', k: 'unit' }, { h: 'In stock', r: 1, f: r => qfmt(r.stock), csv: r => r.stock }, { h: 'Reorder at', r: 1, f: r => qfmt(r.reorder_level), csv: r => r.reorder_level },
      { h: 'Cost', r: 1, f: r => money(r.cost), csv: r => r.cost }, { h: 'Stock value (cost)', r: 1, f: r => money(r.stock_value), csv: r => r.stock_value }, { h: 'Retail value', r: 1, f: r => money(r.retail_value), csv: r => r.retail_value }, { h: 'Status', f: r => stBadge(r.status), csv: r => r.status }],
    top: d => `<div class="grid g4">${statCard('Products', d.summary.items)}${statCard('Stock value (at cost)', money(d.summary.stock_value))}${statCard('Retail value', money(d.summary.retail_value), 'if all sold at current prices')}${statCard('Needs attention', d.summary.low + d.summary.out, d.summary.low + ' low · ' + d.summary.out + ' out')}</div><div style="height:12px"></div>`,
  },
  product: {
    title: 'Product Report', csv: 'product-report.csv',
    cols: [{ h: 'SKU', k: 'sku' }, { h: 'Product', k: 'name' }, { h: 'Category', k: 'category' }, { h: 'Unit', k: 'unit' }, { h: 'Price', r: 1, f: r => money(r.price), csv: r => r.price }, { h: 'Cost', r: 1, f: r => money(r.cost), csv: r => r.cost }, { h: 'Margin', r: 1, f: r => r.margin_pct + '%', csv: r => r.margin_pct },
      { h: 'Sold (period)', r: 1, f: r => qfmt(r.qty_sold), csv: r => r.qty_sold }, { h: 'Revenue', r: 1, f: r => money(r.revenue), csv: r => r.revenue }, { h: 'In stock', r: 1, f: r => qfmt(r.stock), csv: r => r.stock }, { h: 'Stock value', r: 1, f: r => money(r.stock_value), csv: r => r.stock_value }, { h: 'Status', f: r => stBadge(r.status), csv: r => r.status }],
    top: () => '',
  },
  expense: {
    title: 'Expense Report', csv: 'expense-report.csv',
    cols: [{ h: 'ID', f: r => '#' + r.id, csv: r => r.id }, { h: 'Date', k: 'expense_date' }, { h: 'Category', k: 'category' }, { h: 'Description', k: 'description' }, { h: 'Payment', f: r => esc(PAY_LABEL[r.payment_method] || r.payment_method), csv: r => r.payment_method }, { h: 'Recorded by', f: r => esc(r.recorded_by || '—'), csv: r => r.recorded_by || '' }, { h: 'Amount', r: 1, f: r => money(r.amount), csv: r => r.amount }],
    top: d => `<div class="grid g4">${statCard('Total expenses', money(d.total), d.rows.length + ' record(s)')}</div>
      <div class="grid g2" style="margin:12px 0"><div class="card"><b>By category</b>${miniTable('Category', 'Total', d.by_category, r => r.category)}</div><div class="card"><b>By payment method</b>${miniTable('Method', 'Total', d.by_payment, r => PAY_LABEL[r.payment_method] || r.payment_method)}</div></div>`,
  },
};

async function viewReports() {
  $('#main').innerHTML = `<div class="head"><h2>Reports</h2></div><p style="color:var(--muted);margin:-6px 0 14px">Choose a report to open.</p>
    <div class="rcards">${REPORTS.map(r => `<div class="card rcard ${r[4]}"><h3>${esc(r[1])}</h3><p>${esc(r[2])}</p><button class="btn" data-r="${r[0]}">${esc(r[3])}</button></div>`).join('')}</div>`;
  document.querySelectorAll('[data-r]').forEach(b => b.onclick = () => openReport(b.dataset.r));
}

async function openReport(type) {
  if (type === 'pnl') return openPnl();
  const def = RDEF[type], first = today().slice(0, 8) + '01';
  $('#main').innerHTML = `<div class="head"><h2>${esc(def.title)}</h2><div class="tools"><button class="btn sec" id="back">← Reports</button>
    ${def.nodate ? '' : `<label>From</label><input type="date" id="from" value="${first}"><label>To</label><input type="date" id="to" value="${today()}">`}<button class="btn" id="go">${def.nodate ? 'Refresh' : 'Show'}</button><button class="btn sec" id="csv">Download CSV</button></div></div><div id="rep"></div>`;
  let data = null;
  const load = guard(async () => {
    data = await api('rpt', { params: { type, ...(def.nodate ? {} : { from: $('#from').value, to: $('#to').value }) } });
    $('#rep').innerHTML = def.top(data) + `<div class="card" style="overflow:auto;padding:0">${rtable(def.cols, data.rows)}</div>`;
  });
  $('#back').onclick = () => go('reports'); $('#go').onclick = load;
  $('#csv').onclick = () => data && csvDownload(def.csv, def.cols, data.rows);
  load();
}

async function openPnl() {
  const first = today().slice(0, 8) + '01';
  $('#main').innerHTML = `<div class="head"><h2>Profit &amp; Loss</h2><div class="tools"><button class="btn sec" id="back">← Reports</button><label>From</label><input type="date" id="from" value="${first}"><label>To</label><input type="date" id="to" value="${today()}"><button class="btn" id="go">Show</button></div></div><div id="rep"></div>`;
  const load = guard(async () => {
    const d = await api('rpt', { params: { type: 'pnl', from: $('#from').value, to: $('#to').value } });
    const row = (l, v, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="r">${money(v)}</td></tr>`;
    const loss = d.net_profit < 0;
    $('#rep').innerHTML = `<div class="grid g4">${statCard('Net sales', money(d.net_sales), d.sales_count + ' sale(s), after discounts')}${statCard('Gross profit', money(d.gross_profit), d.gross_margin + '% margin')}${statCard('Expenses', money(d.expenses))}${statCard(loss ? 'Net loss' : 'Net profit', `<span style="color:var(--${loss ? 'bad' : 'ok'},inherit)">${money(d.net_profit)}</span>`)}</div>
      <div class="grid g2" style="margin-top:12px"><div class="card"><b>Statement</b><table class="pnl" style="box-shadow:none;margin-top:8px">
        ${row('Sales revenue (net of discounts)', d.net_sales)}${row('Less: cost of goods sold', -d.cogs)}${row('Gross profit', d.gross_profit, 'sum')}${row('Less: expenses', -d.expenses)}${row(loss ? 'Net loss' : 'Net profit', d.net_profit, 'sum grand')}
        </table><p style="color:var(--muted);font-size:12.5px;margin:8px 0 0">Tax collected (${money(d.tax_collected)}) is not part of revenue. Voided sales are excluded.</p></div>
        <div class="card"><b>Expenses by category</b><table style="box-shadow:none;margin-top:8px"><tr><th>Category</th><th class="r">Total</th></tr>${d.expenses_by_category.map(r => `<tr><td>${esc(r.category)}</td><td class="r">${money(r.total)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">No expenses</td></tr>'}</table></div></div>`;
  });
  $('#back').onclick = () => go('reports'); $('#go').onclick = load; load();
}

// ---------- Settings ----------
async function viewSettings() {
  const s = S.settings;
  const f = (n, l, t = 'text') => `<div class="field"><label>${l}</label><input name="${n}" type="${t}" value="${esc(s[n])}" ${t === 'number' ? 'step="0.01" min="0"' : ''}></div>`;
  $('#main').innerHTML = `<div class="head"><h2>Settings</h2></div><form class="card" style="max-width:480px">${f('store_name', 'Store name')}${f('address', 'Address')}${f('phone', 'Phone')}${f('currency', 'Currency symbol/code')}${f('tax_rate', 'Tax rate (%)', 'number')}${f('receipt_footer', 'Receipt footer message')}<button class="btn">Save settings</button></form>`;
  $('form').onsubmit = guard(async e => {
    e.preventDefault();
    const o = {}; ['store_name', 'address', 'phone', 'currency', 'tax_rate', 'receipt_footer'].forEach(k => o[k] = e.target.elements[k].value);
    S.settings = await api('settings', { method: 'PUT', body: o }); toast('Settings saved');
    const b = $('#brand'); if (b) b.innerHTML = brandHtml();
  });
}

boot();
