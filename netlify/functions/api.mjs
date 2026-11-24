// RoseFarm POS API as a Netlify Function (v2). Served at /api, e.g. /api?route=products
// This is a 1:1 port of the old PHP public/api/index.php: same routes, same JSON, same rules.
import bcrypt from 'bcryptjs';
import { ApiError, withDb, TZ } from './lib/db.mjs';
import { readSession, cookieFor } from './lib/session.mjs';
import { SCHEMA_VERSION, SCHEMA_SQL, MIGRATE_SQL, SEED_SQL } from './lib/sql.mjs';

export const config = { path: '/api' };

// ---------- small helpers ----------
const out = (data, status = 200) => ({ data, status });
const DEBUG = process.env.DEBUG === '1';

// PHP-style round(): halves go away from zero.
const round = (x, d = 0) => { const f = 10 ** d, v = Number(x) * f; return Math.sign(v) * Math.round(Math.abs(v) + 1e-9) / f; };
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const num3 = v => round(num(v), 3);
const str = v => (v === null || v === undefined) ? '' : String(v);
const trim = v => str(v).trim();
const boolStr = v => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') ? 'true' : 'false';
const nul = v => { v = typeof v === 'string' ? v.trim() : v; return (v === '' || v === null || v === undefined) ? null : v; };
const ymd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const isDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

// Units that can be sold in fractions (1.25 kg, 0.5 L). Everything else (pc, tray, pack...) is sold whole.
const isDecimalUnit = u => u === 'kg' || u === 'L';
function cleanUnit(v) {
  const u = trim(v);
  if (u === '') return 'pc';
  if (u.length > 20) throw new ApiError('Unit is too long (max 20 characters)');
  return u.toLowerCase() === 'l' ? 'L' : (u.toLowerCase() === 'kg' ? 'kg' : u);
}

const WEAK_PASSWORDS = ['admin123', 'cashier123', 'password', 'password1', '12345678', '123456789', 'qwerty123', 'letmein123'];
function pwCheck(pw, username = '') {
  if (pw.length < 8) throw new ApiError('Password must be at least 8 characters');
  if (pw.length > 200) throw new ApiError('Password is too long');
  if (WEAK_PASSWORDS.includes(pw.toLowerCase()) || (username !== '' && pw.toLowerCase() === username.toLowerCase()))
    throw new ApiError('That password is too easy to guess. Choose a different one.');
}
function usernameCheck(un) {
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(un)) throw new ApiError('Username must be 3-50 characters: letters, numbers, dot, dash or underscore');
}
const hash = pw => bcrypt.hashSync(pw, 10);
// A valid bcrypt hash used when the username does not exist, so response time does not reveal which usernames exist.
const DUMMY_HASH = '$2y$10$HEFeB7dpq9IEdPnfmFkssuceM/TILZ1VMVpFUceXbaujNWuFbIIrq';

async function dupGuard(fn, msg) {
  try { return await fn(); } catch (e) { if (e && e.code === '23505') throw new ApiError(msg, 409); throw e; }
}

// ---------- first-run install / upgrade (replaces setup.php and bin/install.php) ----------
let ready = false;
async function ensureInstalled(db) {
  if (ready) return;
  await db.tx(async t => {
    await t.q('SELECT pg_advisory_xact_lock(727001)');   // two cold starts cannot install at the same time
    let fresh = false;
    if (!(await t.val("SELECT to_regclass('public.users')"))) { await t.raw(SCHEMA_SQL); fresh = true; }
    const v = await t.val("SELECT value FROM settings WHERE name = 'schema_version'");
    if (v !== SCHEMA_VERSION) {
      await t.raw(MIGRATE_SQL);
      await t.q("INSERT INTO settings (name, value) VALUES ('schema_version', ?) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value", [SCHEMA_VERSION]);
    }
    if (fresh && process.env.SEED_SHOP === '1') await t.raw(SEED_SQL);
    // First admin: only when the system has none. An existing admin is never touched.
    if ((await t.val("SELECT COUNT(*) FROM users WHERE role = 'admin'")) === 0) {
      const user = trim(process.env.ADMIN_USERNAME) || 'admin';
      const pass = str(process.env.ADMIN_PASSWORD);
      if (!/^[A-Za-z0-9._-]{3,50}$/.test(user)) throw new ApiError('ADMIN_USERNAME must be 3-50 characters: letters, numbers, dot, dash or underscore.', 503);
      if (pass.length < 8) throw new ApiError('No administrator exists yet. In Netlify > Environment variables set ADMIN_PASSWORD (8+ characters) and optionally ADMIN_USERNAME, then redeploy and reload this page.', 503);
      await t.q("INSERT INTO users (username, full_name, password_hash, role) VALUES (?, 'Administrator', ?, 'admin') ON CONFLICT (username) DO UPDATE SET role = 'admin', active = TRUE, password_hash = EXCLUDED.password_hash", [user, hash(pass)]);
    }
  });
  ready = true;
}

// ---------- session / permission helpers ----------
async function me(c) {
  if (!c.sess.uid) return null;
  return await c.db.one('SELECT id, username, full_name, role FROM users WHERE id = ? AND active', [c.sess.uid]);
}
async function needLogin(c, allowPending = false) {
  const u = await me(c);
  if (!u) throw new ApiError('Please log in', 401);
  if (!allowPending && c.sess.mc) throw new ApiError('Please set a new password before continuing.', 403);
  return u;
}
const isManager = u => u.role === 'admin' || u.role === 'manager';
async function needManager(c) { const u = await needLogin(c); if (!isManager(u)) throw new ApiError('Manager access required', 403); return u; }
async function needAdmin(c) { const u = await needLogin(c); if (u.role !== 'admin') throw new ApiError('Admin access required', 403); return u; }
const cleanRole = v => (v === 'admin' || v === 'manager') ? v : 'cashier';
const userPayload = (c, u) => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, must_change: !!c.sess.mc });

async function settings(db) {
  const o = {};
  for (const r of await db.all("SELECT name, value FROM settings WHERE name <> 'schema_version'")) o[r.name] = r.value;
  return o;
}

// ---------- login throttling ----------
async function attempts(db, kind, ip, name, minutes) {
  let sql = `SELECT COUNT(*) FROM login_attempts WHERE kind = ? AND ip = ? AND created_at > NOW() - INTERVAL '${parseInt(minutes, 10)} minutes'`;
  const p = [kind, ip];
  if (name !== null) { sql += ' AND username = ?'; p.push(name); }
  return await db.val(sql, p);
}
async function logAttempt(db, kind, ip, name = '') {
  await db.q('INSERT INTO login_attempts (ip, username, kind) VALUES (?,?,?)', [ip, name.toLowerCase().slice(0, 50), kind]);
  if (Math.random() < 0.05) await db.q("DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '2 days'");
}

// ---------- handlers ----------
async function login(c) {
  const b = c.body, db = c.db;
  const name = trim(b.username), pw = str(b.password), ip = c.ip;
  // 5 wrong tries for the same account from one place, or 30 from one place, pauses logins for 15 minutes.
  if (await attempts(db, 'login', ip, name.toLowerCase(), 15) >= 5 || await attempts(db, 'login', ip, null, 15) >= 30)
    throw new ApiError('Too many failed attempts. Please wait 15 minutes and try again.', 429);
  const u = await db.one('SELECT * FROM users WHERE LOWER(username) = LOWER(?) ORDER BY (username = ?) DESC LIMIT 1', [name, name]);
  const ok = bcrypt.compareSync(pw, u ? u.password_hash : DUMMY_HASH) && u;
  if (!ok) { await logAttempt(db, 'login', ip, name); throw new ApiError('Invalid username or password', 401); }
  if (u.active !== true) throw new ApiError('Your account is waiting for an admin to activate it.', 403);
  await db.q("DELETE FROM login_attempts WHERE kind = 'login' AND ip = ? AND username = ?", [ip, name.toLowerCase()]);
  // Accounts still using a shipped/guessable password must choose a new one before doing anything else.
  const mc = WEAK_PASSWORDS.includes(pw.toLowerCase()) || pw.toLowerCase() === u.username.toLowerCase();
  c.sess = { uid: u.id, mc: mc ? 1 : 0 };
  return out({ user: userPayload(c, u), settings: await settings(db) });
}

async function changePassword(c) {
  const u = await needLogin(c, true), b = c.body, db = c.db;
  const cur = str(b.current_password), nw = str(b.new_password);
  if (await attempts(db, 'login', c.ip, u.username.toLowerCase(), 15) >= 5) throw new ApiError('Too many failed attempts. Please wait 15 minutes and try again.', 429);
  const row = await db.one('SELECT password_hash FROM users WHERE id = ?', [u.id]);
  if (!row || !bcrypt.compareSync(cur, row.password_hash)) { await logAttempt(db, 'login', c.ip, u.username); throw new ApiError('Your current password is not correct', 400); }
  if (nw === cur) throw new ApiError('The new password must be different from the current one');
  pwCheck(nw, u.username);
  await db.q('UPDATE users SET password_hash = ? WHERE id = ?', [hash(nw), u.id]);
  c.sess = { uid: u.id, mc: 0 };
  return out({ ok: true });
}

async function categoriesSave(c, m, id) {
  await needManager(c);
  const name = trim(c.body.name);
  if (name === '') throw new ApiError('Name is required');
  await dupGuard(() => m === 'POST' ? c.db.q('INSERT INTO categories (name) VALUES (?)', [name]) : c.db.q('UPDATE categories SET name = ? WHERE id = ?', [name, id]), 'Category already exists');
  return out({ ok: true });
}

function productFields(b) {
  const name = trim(b.name), sku = trim(b.sku);
  if (name === '' || sku === '') throw new ApiError('SKU and name are required');
  const price = num(b.price), cost = num(b.cost);
  if (price < 0 || cost < 0) throw new ApiError('Price and cost cannot be negative');
  const unit = cleanUnit(b.unit ?? 'pc');
  let stock = num3(b.stock ?? 0), rl = num3(b.reorder_level ?? 5);
  if (!isDecimalUnit(unit)) { stock = round(stock); rl = round(rl); }   // whole units only
  return [sku, nul(b.barcode), name, nul(b.category_id), nul(b.supplier_id), unit, price, cost, stock, rl, boolStr(b.active ?? true)];
}

async function getSale(db, id) {
  const s = await db.one(`SELECT s.*, u.full_name AS cashier, c.name AS customer_name
            FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`, [id]);
  if (!s) throw new ApiError('Sale not found', 404);
  s.items = await db.all('SELECT name, qty::float AS qty, unit, price, line_total FROM sale_items WHERE sale_id = ? ORDER BY id', [id]);
  return s;
}

async function createSale(c, u) {
  const b = c.body, raw = Array.isArray(b.items) ? b.items : [];
  if (!raw.length) throw new ApiError('Cart is empty');
  const pm = b.payment_method ?? 'cash';
  if (!['cash', 'card', 'mpesa'].includes(pm)) throw new ApiError('Invalid payment method');

  // Merge repeated products. An item may carry a quantity or (for kg / L items) an amount of money,
  // e.g. "KES 100 of cooking oil"; the quantity is then worked out from the stored price.
  const merged = new Map();
  for (const it of raw) {
    const pid = parseInt(it?.product_id, 10) || 0;
    if (pid < 1) throw new ApiError('Invalid cart item');
    if (!merged.has(pid)) merged.set(pid, []);
    merged.get(pid).push(it);
  }
  const pids = [...merged.keys()].sort((a, z) => a - z);   // consistent lock order avoids deadlocks

  const sid = await c.db.tx(async t => {
    let subtotal = 0; const lines = [];
    for (const pid of pids) {
      const p = await t.one('SELECT id, name, unit, price, cost, stock::float AS stock FROM products WHERE id = ? AND active FOR UPDATE', [pid]);
      if (!p) throw new ApiError(`Product #${pid} not found or inactive`);
      const dec = isDecimalUnit(p.unit), price = num(p.price);
      let qty = 0, line = 0;
      for (const it of merged.get(pid)) {
        if (dec && it.amount !== undefined && num(it.amount) > 0 && price > 0) {
          const amt = round(num(it.amount), 2), q1 = round(amt / price, 3);
          if (q1 <= 0) throw new ApiError(`Amount is too small for ${p.name}`);
          qty += q1; line += amt;
        } else {
          const q1 = num3(it.qty ?? 0);
          if (q1 <= 0) throw new ApiError(`Invalid quantity for ${p.name}`);
          if (!dec && Math.abs(q1 - Math.round(q1)) > 1e-9) throw new ApiError(`${p.name} is sold in whole ${p.unit} only`);
          qty += q1; line += round(price * q1, 2);
        }
      }
      qty = round(qty, 3); line = round(line, 2);
      if (qty <= 0) throw new ApiError(`Invalid quantity for ${p.name}`);
      if (p.stock + 1e-9 < qty) {
        const left = String(parseFloat(p.stock.toFixed(3)));
        throw new ApiError(`Insufficient stock for ${p.name} (only ${left} ${p.unit} left)`, 409);
      }
      subtotal += line;
      lines.push([p, qty, line]);
    }
    subtotal = round(subtotal, 2);
    const discount = Math.max(0, Math.min(num(b.discount), subtotal));
    const rate = num((await settings(t)).tax_rate ?? 0);
    const tax = round((subtotal - discount) * rate / 100, 2);
    const total = round(subtotal - discount + tax, 2);
    const paid = pm === 'cash' ? num(b.amount_paid) : total;
    if (paid + 0.001 < total) throw new ApiError('Amount paid is less than the total');
    const change = round(paid - total, 2);

    const seq = await t.val("SELECT nextval('receipt_seq')");
    const receipt = 'RC' + String(seq).padStart(6, '0');
    const id = await t.val(`INSERT INTO sales (receipt_no, user_id, customer_id, subtotal, discount, tax, total, payment_method, amount_paid, change_due)
                       VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [receipt, u.id, nul(b.customer_id), subtotal, discount, tax, total, pm, paid, change]);
    for (const [p, qty, line] of lines) {
      await t.q('INSERT INTO sale_items (sale_id, product_id, name, unit, qty, price, cost, line_total) VALUES (?,?,?,?,?,?,?,?)',
        [id, p.id, p.name, p.unit, qty, p.price, p.cost, line]);
      await t.q('UPDATE products SET stock = stock - ? WHERE id = ?', [qty, p.id]);
    }
    return id;
  });
  return out(await getSale(c.db, sid), 201);
}

async function voidSale(c, id) {
  await c.db.tx(async t => {
    const s = await t.one('SELECT status FROM sales WHERE id = ? FOR UPDATE', [id]);
    if (!s) throw new ApiError('Sale not found', 404);
    if (s.status === 'voided') throw new ApiError('Sale is already voided');
    for (const it of await t.all('SELECT product_id, qty FROM sale_items WHERE sale_id = ?', [id]))
      if (it.product_id) await t.q('UPDATE products SET stock = stock + ? WHERE id = ?', [it.qty, it.product_id]);
    await t.q("UPDATE sales SET status = 'voided' WHERE id = ?", [id]);
  });
  return out(await getSale(c.db, id));
}

async function dashboardReport(c) {
  const db = c.db;
  const sum = async cond => {
    const r = await db.one(`SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS count FROM sales WHERE status='completed' AND ${cond}`);
    return { total: num(r.total), count: r.count };
  };
  const profit = num(await db.val(`SELECT COALESCE(SUM(si.line_total - si.cost * si.qty),0) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                        WHERE s.status='completed' AND s.created_at::date = CURRENT_DATE`));
  const expToday = num(await db.val('SELECT COALESCE(SUM(amount),0) FROM expenses WHERE expense_date = CURRENT_DATE'));
  return out({
    counts: await db.one(`SELECT (SELECT COUNT(*) FROM customers)::int AS customers, (SELECT COUNT(*) FROM suppliers)::int AS suppliers,
                              (SELECT COUNT(*) FROM products WHERE active)::int AS products,
                              (SELECT COUNT(*) FROM products WHERE active AND stock > 0)::int AS in_stock,
                              (SELECT COUNT(*) FROM products WHERE active AND stock > 0 AND stock <= reorder_level)::int AS low,
                              (SELECT COUNT(*) FROM products WHERE active AND stock <= 0)::int AS out`),
    expenses_today: expToday,
    net_profit_today: round(profit - expToday, 2),
    today: await sum('created_at::date = CURRENT_DATE'),
    week: await sum("created_at >= date_trunc('week', NOW())"),
    month: await sum("created_at >= date_trunc('month', NOW())"),
    profit_today: profit,
    daily: await db.all(`SELECT to_char(d, 'Dy DD') AS label, COALESCE(SUM(s.total),0)::float AS total
                      FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, '1 day') d
                      LEFT JOIN sales s ON s.created_at::date = d::date AND s.status='completed'
                      GROUP BY d ORDER BY d`),
    top: await db.all(`SELECT si.name, MAX(si.unit) AS unit, SUM(si.qty)::float AS qty, SUM(si.line_total)::float AS revenue
                    FROM sale_items si JOIN sales s ON s.id = si.sale_id
                    WHERE s.status='completed' AND s.created_at >= NOW() - INTERVAL '30 days'
                    GROUP BY si.name ORDER BY qty DESC LIMIT 5`),
    low_stock: await db.all('SELECT id, name, sku, unit, stock::float AS stock, reorder_level::float AS reorder_level FROM products WHERE active AND stock <= reorder_level ORDER BY stock LIMIT 20'),
    by_payment: await db.all(`SELECT payment_method, COUNT(*)::int AS count, SUM(total)::float AS total FROM sales
                           WHERE status='completed' AND created_at::date = CURRENT_DATE GROUP BY payment_method`),
  });
}

async function stockAdd(c, u) {
  const b = c.body, pid = parseInt(b.product_id, 10) || 0, qty = num3(b.qty ?? 0);
  if (qty <= 0) throw new ApiError('Enter a quantity greater than zero');
  await c.db.tx(async t => {
    const p = await t.one('SELECT p.id, p.name, p.unit, p.cost, p.supplier_id, sp.name AS supplier FROM products p LEFT JOIN suppliers sp ON sp.id = p.supplier_id WHERE p.id = ? FOR UPDATE OF p', [pid]);
    if (!p) throw new ApiError('Product not found', 404);
    if (!isDecimalUnit(p.unit) && Math.abs(qty - Math.round(qty)) > 1e-9) throw new ApiError(`${p.name} is counted in whole ${p.unit} only`);
    let cost = round(num(b.cost ?? 0), 2);
    if (cost < 0) throw new ApiError('Cost cannot be negative');
    if (cost > 0) await t.q('UPDATE products SET stock = stock + ?, cost = ? WHERE id = ?', [qty, cost, pid]);   // latest buying price becomes the cost
    else { await t.q('UPDATE products SET stock = stock + ? WHERE id = ?', [qty, pid]); cost = num(p.cost); }
    await t.q('INSERT INTO stock_receipts (product_id, product_name, qty, cost, supplier_id, supplier_name, note, user_id) VALUES (?,?,?,?,?,?,?,?)',
      [pid, p.name, qty, cost, p.supplier_id, p.supplier, trim(b.note).slice(0, 255) || null, u.id]);
  });
  return out({ ok: true, stock: num(await c.db.val('SELECT stock FROM products WHERE id = ?', [pid])) }, 201);
}

// Searches (almost) everything the signed-in user is allowed to see. Plain substring match, case-insensitive.
async function searchAll(c, u) {
  const db = c.db, t = trim(c.query.get('q')).toLowerCase();
  if (t === '') return out([]);
  const mgr = isManager(u), adm = u.role === 'admin';
  const m = cols => '(' + cols.map(col => `POSITION(? IN LOWER(COALESCE(${col}::text,''))) > 0`).join(' OR ') + ')';
  const ps = n => Array(n).fill(t);
  const r = {};
  r.products = (await db.all(`SELECT p.id, p.name, p.sku, p.unit, p.price, p.stock::float AS stock, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN suppliers sp ON sp.id = p.supplier_id
           WHERE p.active AND ${m(['p.name', 'p.sku', 'p.barcode', 'c.name', 'sp.name'])} ORDER BY p.name LIMIT 6`, ps(5)));
  r.customers = await db.all(`SELECT id, name, phone, address FROM customers WHERE ${m(['name', 'phone', 'email', 'address'])} ORDER BY name LIMIT 5`, ps(4));
  const sp = ps(5); let sw = '';
  if (!mgr) { sw = ' AND s.user_id = ?'; sp.push(u.id); }
  r.sales = await db.all(`SELECT s.id, s.receipt_no, s.total, s.status, s.payment_method, s.created_at, cu.name AS customer FROM sales s JOIN users us ON us.id = s.user_id LEFT JOIN customers cu ON cu.id = s.customer_id
           WHERE ${m(['s.receipt_no', 'cu.name', 'us.full_name', 's.payment_method', 's.total'])}${sw} ORDER BY s.id DESC LIMIT 6`, sp);
  if (mgr) {
    r.suppliers = await db.all(`SELECT id, name, phone FROM suppliers WHERE ${m(['name', 'phone', 'email', 'address'])} ORDER BY name LIMIT 5`, ps(4));
    r.categories = await db.all(`SELECT id, name FROM categories WHERE ${m(['name'])} ORDER BY name LIMIT 4`, ps(1));
    r.expenses = await db.all(`SELECT id, expense_date::text AS expense_date, category, description, amount::float AS amount FROM expenses WHERE ${m(['description', 'category', 'amount', 'expense_date', 'payment_method'])} ORDER BY expense_date DESC LIMIT 6`, ps(5));
    r.deliveries = await db.all(`SELECT id, created_at, product_name, qty::float AS qty, supplier_name FROM stock_receipts WHERE ${m(['product_name', 'supplier_name', 'note'])} ORDER BY id DESC LIMIT 5`, ps(3));
  }
  if (adm) r.users = await db.all(`SELECT id, username, full_name, role FROM users WHERE ${m(['username', 'full_name', 'role'])} ORDER BY username LIMIT 5`, ps(3));
  return out(r);
}

function dateRange(c, defaults = true) {
  let from = c.query.get('from') || '', to = c.query.get('to') || '';
  if (!isDate(from)) from = defaults ? ymd().slice(0, 8) + '01' : null;
  if (!isDate(to)) to = defaults ? ymd() : null;
  return [from, to];
}

function expenseFields(b) {
  const cat = trim(b.category); if (cat === '') throw new ApiError('Category is required');
  const amt = round(num(b.amount ?? 0), 2); if (amt <= 0) throw new ApiError('Amount must be greater than zero');
  const pm = b.payment_method ?? 'cash'; if (!['cash', 'bank', 'mpesa'].includes(pm)) throw new ApiError('Invalid payment method');
  let date = b.expense_date ?? ''; if (!isDate(String(date))) date = ymd();
  return [date, cat.slice(0, 60), trim(b.description).slice(0, 255), amt, pm];
}

async function rpt(c) {
  const db = c.db, type = c.query.get('type') || '';
  const [from, to] = dateRange(c);
  const sd = "s.status = 'completed' AND s.created_at >= ?::date AND s.created_at < (?::date + 1)";
  const rg = [from, to];
  const exp = async () => num(await db.val('SELECT COALESCE(SUM(amount),0) FROM expenses WHERE expense_date BETWEEN ?::date AND ?::date', rg));

  switch (type) {
    case 'sales': {
      const rows = await db.all(`SELECT s.id, s.receipt_no, s.created_at, u.full_name AS cashier, c.name AS customer_name, s.subtotal::float AS subtotal, s.discount::float AS discount,
                              s.tax::float AS tax, s.total::float AS total, s.payment_method, s.status
                       FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
                       WHERE s.created_at >= ?::date AND s.created_at < (?::date + 1) ORDER BY s.id DESC LIMIT 3000`, rg);
      const sum = await db.one(`SELECT COUNT(*)::int AS count, COALESCE(SUM(subtotal),0)::float AS subtotal, COALESCE(SUM(discount),0)::float AS discount,
                             COALESCE(SUM(tax),0)::float AS tax, COALESCE(SUM(total),0)::float AS total FROM sales s WHERE ${sd}`, rg);
      const voided = await db.val("SELECT COUNT(*) FROM sales s WHERE s.status = 'voided' AND s.created_at >= ?::date AND s.created_at < (?::date + 1)", rg);
      const by = await db.all(`SELECT payment_method, COUNT(*)::int AS count, SUM(total)::float AS total FROM sales s WHERE ${sd} GROUP BY payment_method ORDER BY total DESC`, rg);
      return out({ from, to, rows, summary: { ...sum, voided }, by_payment: by });
    }
    case 'stock': {
      const rows = await db.all(`SELECT p.sku, p.name, COALESCE(c.name,'') AS category, p.unit, p.stock::float AS stock, p.reorder_level::float AS reorder_level,
                              p.cost::float AS cost, p.price::float AS price, (p.stock * p.cost)::float AS stock_value, (p.stock * p.price)::float AS retail_value,
                              CASE WHEN p.stock <= 0 THEN 'Out of stock' WHEN p.stock <= p.reorder_level THEN 'Low stock' ELSE 'In stock' END AS status
                       FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.active ORDER BY p.name`);
      const t = { items: rows.length, stock_value: 0, retail_value: 0, low: 0, out: 0 };
      for (const r of rows) {
        t.stock_value += r.stock_value; t.retail_value += r.retail_value;
        if (r.status === 'Low stock') t.low++;
        if (r.status === 'Out of stock') t.out++;
      }
      return out({ rows, summary: t });
    }
    case 'product': {
      const rows = await db.all(`SELECT p.sku, p.name, COALESCE(c.name,'') AS category, p.unit, p.price::float AS price, p.cost::float AS cost,
                              CASE WHEN p.price > 0 THEN ROUND(((p.price - p.cost) / p.price * 100)::numeric, 1) ELSE 0 END::float AS margin_pct,
                              p.stock::float AS stock, (p.stock * p.cost)::float AS stock_value,
                              COALESCE(x.qty,0)::float AS qty_sold, COALESCE(x.revenue,0)::float AS revenue,
                              CASE WHEN p.stock <= 0 THEN 'Out of stock' WHEN p.stock <= p.reorder_level THEN 'Low stock' ELSE 'In stock' END AS status
                       FROM products p LEFT JOIN categories c ON c.id = p.category_id
                       LEFT JOIN (SELECT si.product_id, SUM(si.qty) AS qty, SUM(si.line_total) AS revenue FROM sale_items si JOIN sales s ON s.id = si.sale_id
                                  WHERE ${sd} GROUP BY si.product_id) x ON x.product_id = p.id
                       WHERE p.active ORDER BY x.revenue DESC NULLS LAST, p.name`, rg);
      return out({ from, to, rows });
    }
    case 'expense': {
      const rows = await db.all(`SELECT e.id, e.expense_date::text AS expense_date, e.category, e.description, e.amount::float AS amount, e.payment_method, u.full_name AS recorded_by
                       FROM expenses e LEFT JOIN users u ON u.id = e.user_id WHERE e.expense_date BETWEEN ?::date AND ?::date ORDER BY e.expense_date DESC, e.id DESC`, rg);
      return out({
        from, to, rows, total: await exp(),
        by_category: await db.all('SELECT category, COUNT(*)::int AS count, SUM(amount)::float AS total FROM expenses WHERE expense_date BETWEEN ?::date AND ?::date GROUP BY category ORDER BY total DESC', rg),
        by_payment: await db.all('SELECT payment_method, COUNT(*)::int AS count, SUM(amount)::float AS total FROM expenses WHERE expense_date BETWEEN ?::date AND ?::date GROUP BY payment_method ORDER BY total DESC', rg),
      });
    }
    case 'pnl': {
      const r = await db.one(`SELECT COUNT(*)::int AS count, COALESCE(SUM(s.subtotal - s.discount),0)::float AS net_sales, COALESCE(SUM(s.tax),0)::float AS tax FROM sales s WHERE ${sd}`, rg);
      const cogs = num(await db.val(`SELECT COALESCE(SUM(si.cost * si.qty),0) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE ${sd}`, rg));
      const e = await exp();
      const gross = round(r.net_sales - cogs, 2);
      return out({
        from, to, sales_count: r.count, net_sales: r.net_sales, tax_collected: r.tax, cogs: round(cogs, 2),
        gross_profit: gross, gross_margin: r.net_sales > 0 ? round(gross / r.net_sales * 100, 1) : 0,
        expenses: e, net_profit: round(gross - e, 2),
        expenses_by_category: await db.all('SELECT category, SUM(amount)::float AS total FROM expenses WHERE expense_date BETWEEN ?::date AND ?::date GROUP BY category ORDER BY total DESC', rg),
      });
    }
  }
  throw new ApiError('Unknown report');
}

// ---------- router ----------
async function route(c) {
  const { db, query, body: b } = c;
  const r = query.get('route') || '';
  const m = c.method;
  const id = parseInt(query.get('id'), 10) || 0;

  switch (`${m} ${r}`) {
    // ----- auth -----
    case 'POST login': return login(c);
    case 'POST logout': c.sess = {}; return out({ ok: true });
    case 'POST change_password': return changePassword(c);
    case 'GET me': {
      const u = await me(c);
      if (!u) {
        const n = await db.one("SELECT value FROM settings WHERE name = 'store_name'");
        return out({ user: null, brand: { store_name: n ? n.value : null } });
      }
      return out({ user: userPayload(c, u), settings: c.sess.mc ? {} : await settings(db) });
    }

    // ----- settings -----
    case 'PUT settings':
      await needAdmin(c);
      for (const k of ['store_name', 'address', 'phone', 'currency', 'tax_rate', 'receipt_footer'])
        if (k in b) await db.q('INSERT INTO settings (name, value) VALUES (?,?) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value', [k, str(b[k])]);
      return out(await settings(db));

    // ----- categories -----
    case 'GET categories':
      await needLogin(c);
      return out(await db.all('SELECT c.id, c.name, COUNT(p.id)::int AS products FROM categories c LEFT JOIN products p ON p.category_id = c.id AND p.active GROUP BY c.id ORDER BY c.name'));
    case 'POST categories':
    case 'PUT categories': return categoriesSave(c, m, id);
    case 'DELETE categories':
      await needManager(c); await db.q('DELETE FROM categories WHERE id = ?', [id]); return out({ ok: true });

    // ----- products -----
    case 'GET products': {
      const mgr = isManager(await needLogin(c));
      const where = [], p = [];
      const all = query.get('all');
      if (!all || all === '0') where.push('p.active');
      const qq = query.get('q');
      if (qq) { where.push('(LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ? OR p.barcode = ?)'); const t = '%' + qq.toLowerCase() + '%'; p.push(t, t, qq); }
      const rows = await db.all('SELECT p.*, c.name AS category, sp.name AS supplier FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN suppliers sp ON sp.id = p.supplier_id'
        + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY p.name', p);
      return out(rows.map(x => {
        x.stock = num(x.stock); x.reorder_level = num(x.reorder_level);
        if (!mgr) { delete x.cost; delete x.supplier; delete x.supplier_id; }   // buying prices and suppliers are not for cashiers
        return x;
      }));
    }
    case 'POST products': {
      await needManager(c); const f = productFields(b);
      await dupGuard(() => db.q('INSERT INTO products (sku, barcode, name, category_id, supplier_id, unit, price, cost, stock, reorder_level, active) VALUES (?,?,?,?,?,?,?,?,?,?,?)', f), 'SKU or barcode already exists');
      return out({ ok: true }, 201);
    }
    case 'PUT products': {
      await needManager(c); const f = productFields(b); f.push(id);
      await dupGuard(() => db.q('UPDATE products SET sku=?, barcode=?, name=?, category_id=?, supplier_id=?, unit=?, price=?, cost=?, stock=?, reorder_level=?, active=? WHERE id=?', f), 'SKU or barcode already exists');
      return out({ ok: true });
    }
    case 'DELETE products':
      await needManager(c); await db.q('UPDATE products SET active = FALSE WHERE id = ?', [id]); return out({ ok: true });

    // ----- customers -----
    case 'GET customers': {
      await needLogin(c);
      let p = [], sql = 'SELECT id, name, first_name, last_name, phone, email, address FROM customers';
      const qq = query.get('q');
      if (qq) {
        sql += " WHERE LOWER(name) LIKE ? OR LOWER(COALESCE(phone,'')) LIKE ? OR LOWER(COALESCE(email,'')) LIKE ? OR LOWER(COALESCE(address,'')) LIKE ?";
        const t = '%' + qq.toLowerCase() + '%'; p = [t, t, t, t];
      }
      return out(await db.all(sql + ' ORDER BY name', p));
    }
    case 'POST customers':
    case 'PUT customers': {
      await needLogin(c);
      let fn = trim(b.first_name); const ln = trim(b.last_name);
      if (fn === '' && ln === '' && trim(b.name) !== '') fn = trim(b.name);   // older clients send one "name"
      if (fn === '') throw new ApiError('First name is required');
      const f = [`${fn} ${ln}`.trim(), fn, nul(ln), nul(b.phone), nul(b.email), nul(b.address)];
      if (m === 'POST') await db.q('INSERT INTO customers (name, first_name, last_name, phone, email, address) VALUES (?,?,?,?,?,?)', f);
      else await db.q('UPDATE customers SET name=?, first_name=?, last_name=?, phone=?, email=?, address=? WHERE id=?', [...f, id]);
      return out({ ok: true }, m === 'POST' ? 201 : 200);
    }
    case 'DELETE customers':
      await needManager(c); await db.q('DELETE FROM customers WHERE id = ?', [id]); return out({ ok: true });

    // ----- sales -----
    case 'POST sales': return createSale(c, await needLogin(c));
    case 'GET sales': {
      const u = await needLogin(c);
      if (id) {
        const s = await getSale(db, id);
        if (!isManager(u) && Number(s.user_id) !== Number(u.id)) throw new ApiError('Not allowed', 403);
        return out(s);
      }
      const receipt = query.get('receipt');
      if (receipt) {   // quick lookup by receipt number, any date (used by the top-bar search)
        let w = 'LOWER(s.receipt_no) LIKE ?'; const pp = ['%' + receipt.trim().toLowerCase() + '%'];
        if (!isManager(u)) { w += ' AND s.user_id = ?'; pp.push(u.id); }
        return out(await db.all(`SELECT s.id, s.receipt_no, s.total, s.status, s.created_at FROM sales s WHERE ${w} ORDER BY s.id DESC LIMIT 5`, pp));
      }
      const where = ['s.created_at >= ?::date', 's.created_at < (?::date + 1)'];
      const p = [query.get('from') || ymd(), query.get('to') || ymd()];
      if (!isManager(u)) { where.push('s.user_id = ?'); p.push(u.id); }
      return out(await db.all(`SELECT s.id, s.receipt_no, s.total, s.payment_method, s.status, s.created_at, u.full_name AS cashier, c.name AS customer_name,
                          (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id)::int AS items
                   FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
                   WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT 500`, p));
    }
    case 'POST void': await needManager(c); return voidSale(c, id);

    // ----- reports -----
    case 'GET report': await needManager(c); return dashboardReport(c);

    // ----- users -----
    case 'GET users':
      await needAdmin(c);
      return out(await db.all('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id DESC'));
    case 'POST users': {
      await needAdmin(c);
      const un = trim(b.username), fn = trim(b.full_name), pw = str(b.password);
      if (un === '' || fn === '') throw new ApiError('Username and full name are required');
      usernameCheck(un); pwCheck(pw, un);
      const role = cleanRole(b.role);
      await dupGuard(() => db.q('INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)', [un, fn, hash(pw), role]), 'Username already taken');
      return out({ ok: true }, 201);
    }
    case 'PUT users': {
      const a = await needAdmin(c);
      const fn = trim(b.full_name); if (fn === '') throw new ApiError('Full name is required');
      const role = cleanRole(b.role), active = boolStr(b.active ?? true);
      if (id === Number(a.id) && (active === 'false' || role !== 'admin')) throw new ApiError('You cannot deactivate or demote your own account');
      await db.q('UPDATE users SET full_name=?, role=?, active=? WHERE id=?', [fn, role, active, id]);
      if (b.password) {
        pwCheck(str(b.password), str(await db.val('SELECT username FROM users WHERE id = ?', [id])));
        await db.q('UPDATE users SET password_hash=? WHERE id=?', [hash(str(b.password)), id]);
      }
      return out({ ok: true });
    }
    case 'DELETE users': {
      const a = await needAdmin(c);
      if (id === Number(a.id)) throw new ApiError('You cannot delete your own account');
      try { await db.q('DELETE FROM users WHERE id = ?', [id]); }
      catch (e) {
        if (e && e.code === '23503') throw new ApiError('This user has recorded sales, so it cannot be deleted. Untick Active to block the login instead.', 409);
        throw e;
      }
      return out({ ok: true });
    }

    case 'POST seed_shop':
      await needAdmin(c);
      await db.raw(SEED_SQL);
      return out({ ok: true, products: await db.val('SELECT COUNT(*) FROM products') });

    case 'GET search': return searchAll(c, await needLogin(c));

    // ----- suppliers (admin + manager) -----
    case 'GET suppliers': {
      await needManager(c);
      let p = [], sql = 'SELECT sp.*, (SELECT COUNT(*) FROM products WHERE supplier_id = sp.id AND active)::int AS products FROM suppliers sp';
      const qq = query.get('q');
      if (qq) { sql += " WHERE LOWER(sp.name) LIKE ? OR LOWER(COALESCE(sp.phone,'')) LIKE ? OR LOWER(COALESCE(sp.email,'')) LIKE ? OR LOWER(COALESCE(sp.address,'')) LIKE ?"; const t = '%' + qq.toLowerCase() + '%'; p = [t, t, t, t]; }
      return out(await db.all(sql + ' ORDER BY sp.name', p));
    }
    case 'POST suppliers':
    case 'PUT suppliers': {
      await needManager(c);
      const name = trim(b.name); if (name === '') throw new ApiError('Supplier name is required');
      const f = [name, nul(b.phone), nul(b.email), nul(b.address)];
      if (m === 'POST') await db.q('INSERT INTO suppliers (name, phone, email, address) VALUES (?,?,?,?)', f);
      else await db.q('UPDATE suppliers SET name=?, phone=?, email=?, address=? WHERE id=?', [...f, id]);
      return out({ ok: true }, m === 'POST' ? 201 : 200);
    }
    case 'DELETE suppliers':
      await needManager(c); await db.q('DELETE FROM suppliers WHERE id = ?', [id]); return out({ ok: true });   // products keep working, supplier becomes empty

    // ----- receive stock (admin + manager) -----
    case 'POST stock_add': return stockAdd(c, await needManager(c));
    case 'GET stock_log':
      await needManager(c);
      return out(await db.all(`SELECT r.id, r.created_at, r.product_name, p.unit, r.qty::float AS qty, r.cost::float AS cost, r.supplier_name, r.note, u.full_name AS added_by
                   FROM stock_receipts r LEFT JOIN products p ON p.id = r.product_id LEFT JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 15`));

    // ----- expenses (admin + manager) -----
    case 'GET expenses': {
      await needManager(c);
      const [from, to] = dateRange(c, false);
      const w = [], p = [];
      if (from) { w.push('e.expense_date >= ?::date'); p.push(from); }
      if (to) { w.push('e.expense_date <= ?::date'); p.push(to); }
      return out(await db.all('SELECT e.id, e.expense_date::text AS expense_date, e.category, e.description, e.amount::float AS amount, e.payment_method, u.full_name AS recorded_by FROM expenses e LEFT JOIN users u ON u.id = e.user_id'
        + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY e.expense_date DESC, e.id DESC LIMIT 1000', p));
    }
    case 'POST expenses':
    case 'PUT expenses': {
      const u = await needManager(c);
      const [date, cat, desc, amt, pm] = expenseFields(b);
      if (m === 'POST') await db.q('INSERT INTO expenses (expense_date, category, description, amount, payment_method, user_id) VALUES (?,?,?,?,?,?)', [date, cat, desc, amt, pm, u.id]);
      else await db.q('UPDATE expenses SET expense_date=?, category=?, description=?, amount=?, payment_method=? WHERE id=?', [date, cat, desc, amt, pm, id]);
      return out({ ok: true }, m === 'POST' ? 201 : 200);
    }
    case 'DELETE expenses':
      await needManager(c); await db.q('DELETE FROM expenses WHERE id = ?', [id]); return out({ ok: true });

    // ----- reports hub -----
    case 'GET rpt': await needManager(c); return rpt(c);
  }
  throw new ApiError('Unknown endpoint', 404);
}

// ---------- entry point ----------
function dbProblem(e) {
  const msg = String(e && e.message || '');
  if (e && e.code === '42P01') return 'The database tables are not installed yet. Reload the page; they are created automatically on first use.';
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '28P01', '3D000', '28000'].includes(e && e.code) || /timeout|could not connect|password authentication|SSL/i.test(msg))
    return 'Cannot reach the database. In Netlify check Data & Storage > Database (or DATABASE_URL if you set one).' + (DEBUG ? ` (${msg})` : '');
  return null;
}

export default async (req, context) => {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const send = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
  try {
    const url = new URL(req.url), method = req.method.toUpperCase();
    const query = url.searchParams, routeName = query.get('route') || '';

    if (routeName === 'health') {
      try { await withDb(db => db.q('SELECT 1')); return send({ ok: true }); }
      catch (e) { console.error('[pos] health check failed:', e.message); return send({ ok: false }, 503); }
    }
    // Every change must come from this app's own page: browsers will not add this header to a request sent from another site.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && req.headers.get('x-requested-with') !== 'XMLHttpRequest')
      throw new ApiError('Invalid request', 403);

    let body = {};
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const raw = await req.text();
      if (raw.length > 1048576) throw new ApiError('Request is too large', 413);
      try { const j = JSON.parse(raw || '{}'); if (j && typeof j === 'object' && !Array.isArray(j)) body = j; } catch { /* empty body */ }
    }
    const sess = readSession(req);
    const ip = String((context && context.ip) || req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || '0.0.0.0').slice(0, 45);

    const result = await withDb(async db => {
      await ensureInstalled(db);
      const c = { req, db, query, body, sess, ip, method };
      const res = await route(c);
      return { res, sess: c.sess };
    });
    const resp = send(result.res.data, result.res.status);
    // Re-issue the cookie on every request while signed in (sliding idle timeout); clear it after logout.
    if (result.sess && result.sess.uid) resp.headers.append('Set-Cookie', cookieFor(result.sess, req));
    else if (sess.uid || routeName === 'logout') resp.headers.append('Set-Cookie', cookieFor(null, req));
    return resp;
  } catch (e) {
    if (e instanceof ApiError) return send({ error: e.message }, e.status || 400);
    console.error('[pos] error', e && e.code, e && e.message);
    const dbMsg = dbProblem(e);
    if (dbMsg) return send({ error: dbMsg }, 503);
    return send({ error: DEBUG ? `Server error: ${e && e.message}` : 'Something went wrong on the server. Please try again or contact the administrator.' }, 500);
  }
};
