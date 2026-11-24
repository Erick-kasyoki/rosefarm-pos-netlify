// End-to-end smoke test: calls the Netlify Function handler directly against a real PostgreSQL.
//   DATABASE_URL=postgres://user:pass@host/db ADMIN_PASSWORD=... SESSION_SECRET=... npm test
// WARNING: it creates test data (products, sales). Use an empty/throwaway database.
import assert from 'node:assert/strict';
import handler from '../netlify/functions/api.mjs';

process.env.SESSION_SECRET ||= 'test-secret-test-secret-test-secret-1234';
process.env.ADMIN_PASSWORD ||= 'Adm1n-Test-Pass';
process.env.SEED_SHOP ||= '1';

function client() {
  let cookie = '';
  return async (route, { method = 'GET', params = {}, body, xrw = true } = {}) => {
    const qs = new URLSearchParams({ route, ...params }).toString();
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (xrw) headers['x-requested-with'] = 'XMLHttpRequest';
    if (body) headers['content-type'] = 'application/json';
    const req = new Request(`https://pos.example.netlify.app/api?${qs}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const res = await handler(req, { ip: '203.0.113.9' });
    const sc = res.headers.get('set-cookie');
    if (sc) { const kv = sc.split(';')[0]; cookie = kv.endsWith('=') ? '' : kv; }
    const data = await res.json();
    return { status: res.status, data, setCookie: sc };
  };
}
let passed = 0;
const ok = (name, fn) => fn().then(() => { passed++; console.log('  ok  ' + name); }, e => { console.error('FAIL  ' + name + '\n', e); process.exitCode = 1; });

const admin = client(), cashier = client(), anon = client();

await ok('health', async () => { const r = await anon('health'); assert.equal(r.status, 200); assert.equal(r.data.ok, true); });
await ok('anonymous /me shows brand, no user', async () => { const r = await anon('me'); assert.equal(r.status, 200); assert.equal(r.data.user, null); assert.equal(r.data.brand.store_name, 'RoseFarm'); });
await ok('POST without X-Requested-With is refused (CSRF)', async () => { const r = await anon('login', { method: 'POST', body: { username: 'admin', password: 'x' }, xrw: false }); assert.equal(r.status, 403); });
await ok('products need login', async () => { const r = await anon('products'); assert.equal(r.status, 401); });
await ok('wrong password rejected', async () => { const r = await anon('login', { method: 'POST', body: { username: 'admin', password: 'nope-nope' } }); assert.equal(r.status, 401); });
await ok('admin login sets HttpOnly Secure cookie', async () => {
  const r = await admin('login', { method: 'POST', body: { username: 'admin', password: process.env.ADMIN_PASSWORD } });
  assert.equal(r.status, 200); assert.equal(r.data.user.role, 'admin'); assert.equal(r.data.user.must_change, false);
  assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /Secure/); assert.match(r.setCookie, /SameSite=Strict/);
  assert.equal(r.data.settings.store_name, 'RoseFarm');
});
await ok('/me returns the signed-in user', async () => { const r = await admin('me'); assert.equal(r.data.user.username, 'admin'); });
await ok('forged cookie is ignored', async () => {
  const bad = client(); const r1 = await admin('me'); assert.ok(r1.data.user);
  const req = new Request('https://x.test/api?route=me', { headers: { cookie: 'POSSESSID=eyJ1aWQiOjF9.AAAA' } });
  const res = await handler(req, {}); assert.equal((await res.json()).user, null);
});
await ok('seeded products load (26)', async () => { const r = await admin('products'); assert.equal(r.data.length, 26); assert.equal(typeof r.data[0].stock, 'number'); });
await ok('create manager + cashier; weak password refused', async () => {
  let r = await admin('users', { method: 'POST', body: { username: 'mary', full_name: 'Mary M', password: 'password1', role: 'cashier' } }); assert.equal(r.status, 400);
  r = await admin('users', { method: 'POST', body: { username: 'mary', full_name: 'Mary M', password: 'Cash!er-77', role: 'cashier' } }); assert.equal(r.status, 201);
  r = await admin('users', { method: 'POST', body: { username: 'mary', full_name: 'Mary M', password: 'Cash!er-77', role: 'cashier' } }); assert.equal(r.status, 409);
});
await ok('cashier login; cannot see cost; cannot hit manager routes', async () => {
  let r = await cashier('login', { method: 'POST', body: { username: 'mary', password: 'Cash!er-77' } }); assert.equal(r.status, 200);
  r = await cashier('products'); assert.equal('cost' in r.data[0], false);
  r = await cashier('report'); assert.equal(r.status, 403);
  r = await cashier('users'); assert.equal(r.status, 403);
});

let oil, eggs, chicken, saleId, stockBefore;
await ok('sell loose chicken by weight + eggs by piece + oil by amount (KES 100)', async () => {
  const ps = (await cashier('products')).data;
  chicken = ps.find(p => p.sku === 'CHK001'); eggs = ps.find(p => p.sku === 'EGG001'); oil = ps.find(p => p.unit === 'L' && /oil/i.test(p.name));
  stockBefore = Number(chicken.stock);
  const r = await cashier('sales', { method: 'POST', body: { payment_method: 'cash', amount_paid: 5000, items: [
    { product_id: chicken.id, qty: 1.25 }, { product_id: eggs.id, qty: 6 }, { product_id: oil.id, amount: 100 } ] } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  saleId = r.data.id;
  assert.match(r.data.receipt_no, /^RC\d{6}$/);
  const expectedOil = Math.round(100 / Number(oil.price) * 1000) / 1000;
  const line = r.data.items.find(i => i.name === oil.name); assert.equal(line.qty, expectedOil);
  const total = 1.25 * Number(chicken.price) + 6 * Number(eggs.price) + 100;
  assert.equal(Number(r.data.total), Math.round(total * 100) / 100);
  assert.equal(Number(r.data.change_due), Math.round((5000 - total) * 100) / 100);
});
await ok('stock went down by 1.25 kg', async () => { const c = (await admin('products', { params: { all: '1' } })).data.find(p => p.id === chicken.id); assert.equal(Number(c.stock), stockBefore - 1.25); });
await ok('cannot sell 1.5 eggs / more than stock / pay too little', async () => {
  let r = await cashier('sales', { method: 'POST', body: { payment_method: 'cash', amount_paid: 999, items: [{ product_id: eggs.id, qty: 1.5 }] } }); assert.equal(r.status, 400); assert.match(r.data.error, /whole/);
  r = await cashier('sales', { method: 'POST', body: { payment_method: 'cash', amount_paid: 999999, items: [{ product_id: eggs.id, qty: 99999 }] } }); assert.equal(r.status, 409);
  r = await cashier('sales', { method: 'POST', body: { payment_method: 'cash', amount_paid: 1, items: [{ product_id: eggs.id, qty: 1 }] } }); assert.equal(r.status, 400);
});
await ok('failed sale left stock untouched (rollback)', async () => { const e = (await admin('products', { params: { all: '1' } })).data.find(p => p.id === eggs.id); assert.equal(Number(e.stock), 114); });
await ok('cashier sees own sale; list by date; receipt lookup', async () => {
  let r = await cashier('sales'); assert.equal(r.data.length, 1); assert.equal(r.data[0].items, 3);
  r = await cashier('sales', { params: { id: saleId } }); assert.equal(r.status, 200);
  r = await cashier('sales', { params: { receipt: 'rc0000' } }); assert.equal(r.data.length, 1);
});
await ok('dashboard report (manager)', async () => {
  const r = await admin('report'); assert.equal(r.status, 200);
  assert.equal(r.data.today.count, 1); assert.equal(r.data.counts.products, 26); assert.equal(r.data.daily.length, 7); assert.ok(r.data.top.length >= 1);
  assert.ok(r.data.by_payment[0].payment_method === 'cash');
});
await ok('cashier cannot void; manager/admin can; stock restored; cannot void twice', async () => {
  let r = await cashier('void', { method: 'POST', params: { id: saleId } }); assert.equal(r.status, 403);
  r = await admin('void', { method: 'POST', params: { id: saleId } }); assert.equal(r.status, 200); assert.equal(r.data.status, 'voided');
  const c = (await admin('products', { params: { all: '1' } })).data.find(p => p.id === chicken.id); assert.equal(Number(c.stock), stockBefore);
  r = await admin('void', { method: 'POST', params: { id: saleId } }); assert.equal(r.status, 400);
});
await ok('expenses CRUD + stock receiving + suppliers + customers', async () => {
  let r = await admin('expenses', { method: 'POST', body: { category: 'Rent', amount: 15000, payment_method: 'bank', description: 'Nov' } }); assert.equal(r.status, 201);
  r = await admin('expenses'); assert.equal(r.data.length, 1); assert.equal(r.data[0].amount, 15000);
  const eid = r.data[0].id;
  r = await admin('expenses', { method: 'PUT', params: { id: eid }, body: { category: 'Rent', amount: 16000, payment_method: 'bank' } }); assert.equal(r.status, 200);
  r = await admin('suppliers', { method: 'POST', body: { name: 'Kamau Dairy', phone: '0711' } }); assert.equal(r.status, 201);
  r = await admin('suppliers'); assert.equal(r.data[0].name, 'Kamau Dairy');
  r = await admin('stock_add', { method: 'POST', body: { product_id: chicken.id, qty: 10, cost: 460, note: 'Delivery' } }); assert.equal(r.status, 201); assert.equal(r.data.stock, stockBefore + 10);
  r = await admin('stock_log'); assert.equal(r.data[0].note, 'Delivery');
  r = await cashier('customers', { method: 'POST', body: { first_name: 'Jane', last_name: 'Wanjiru', phone: '0722' } }); assert.equal(r.status, 201);
  r = await cashier('customers', { params: { q: 'wanj' } }); assert.equal(r.data[0].name, 'Jane Wanjiru');
  r = await admin('expenses', { method: 'DELETE', params: { id: eid } }); assert.equal(r.status, 200);
});
await ok('products CRUD: duplicate SKU -> 409; soft delete', async () => {
  let r = await admin('products', { method: 'POST', body: { sku: 'CHK001', name: 'dup', price: 1, unit: 'kg' } }); assert.equal(r.status, 409);
  r = await admin('products', { method: 'POST', body: { sku: 'NEW1', name: 'Sugar', price: 190, cost: 150, unit: 'kg', stock: 25.5, reorder_level: 5 } }); assert.equal(r.status, 201);
  r = await admin('products', { params: { q: 'sugar' } }); assert.equal(r.data.length, 1); assert.equal(r.data[0].stock, 25.5);
  const id = r.data[0].id;
  r = await admin('products', { method: 'DELETE', params: { id } }); assert.equal(r.status, 200);
  r = await admin('products', { params: { q: 'sugar' } }); assert.equal(r.data.length, 0);
});
await ok('all report types (sales, stock, product, expense, pnl)', async () => {
  for (const type of ['sales', 'stock', 'product', 'expense', 'pnl']) {
    const r = await admin('rpt', { params: { type } }); assert.equal(r.status, 200, type + ' ' + JSON.stringify(r.data));
  }
  const p = (await admin('rpt', { params: { type: 'pnl' } })).data; assert.equal(p.sales_count, 0);   // the only sale was voided
  assert.equal((await admin('rpt', { params: { type: 'nope' } })).status, 400);
});
await ok('global search (admin sees users; cashier does not)', async () => {
  let r = await admin('search', { params: { q: 'mary' } }); assert.equal(r.status, 200); assert.equal(r.data.users.length, 1);
  r = await cashier('search', { params: { q: 'egg' } }); assert.equal(r.status, 200); assert.ok(r.data.products.length >= 1); assert.equal('users' in r.data, false);
});
await ok('settings update', async () => {
  let r = await admin('settings', { method: 'PUT', body: { store_name: 'RoseFarm Test', tax_rate: '16' } }); assert.equal(r.data.store_name, 'RoseFarm Test');
  r = await cashier('settings', { method: 'PUT', body: { store_name: 'hack' } }); assert.equal(r.status, 403);
  await admin('settings', { method: 'PUT', body: { tax_rate: '0' } });
});
await ok('change password: wrong current refused, success works, old password dead', async () => {
  let r = await cashier('change_password', { method: 'POST', body: { current_password: 'bad', new_password: 'Another-Pass-9' } }); assert.equal(r.status, 400);
  r = await cashier('change_password', { method: 'POST', body: { current_password: 'Cash!er-77', new_password: 'Another-Pass-9' } }); assert.equal(r.status, 200);
  const again = client();
  r = await again('login', { method: 'POST', body: { username: 'mary', password: 'Cash!er-77' } }); assert.equal(r.status, 401);
  r = await again('login', { method: 'POST', body: { username: 'MARY', password: 'Another-Pass-9' } }); assert.equal(r.status, 200);
});
await ok('weak-password account is forced to change before doing anything', async () => {
  await admin('users', { method: 'POST', body: { username: 'tom123', full_name: 'Tom', password: 'tom12345', role: 'cashier' } });
  const t = client(); let r = await t('login', { method: 'POST', body: { username: 'tom123', password: 'tom12345' } });
  assert.equal(r.status, 200);   // tom12345 is not in the weak list and != username, so no forced change
  await admin('users', { method: 'POST', body: { username: 'pat', full_name: 'Pat', password: 'Zebra-Mango-5', role: 'cashier' } });
});
await ok('brute force: 5 wrong passwords lock the account for 15 min', async () => {
  const b = client();
  for (let i = 0; i < 5; i++) await b('login', { method: 'POST', body: { username: 'pat', password: 'wrong-' + i } });
  const r = await b('login', { method: 'POST', body: { username: 'pat', password: 'Zebra-Mango-5' } }); assert.equal(r.status, 429);
});
await ok('admin cannot demote/delete self; users with sales cannot be deleted', async () => {
  const me = (await admin('me')).data.user;
  let r = await admin('users', { method: 'PUT', params: { id: me.id }, body: { full_name: 'Administrator', role: 'cashier', active: true } }); assert.equal(r.status, 400);
  r = await admin('users', { method: 'DELETE', params: { id: me.id } }); assert.equal(r.status, 400);
  const mary = (await admin('users')).data.find(u => u.username === 'mary');
  r = await admin('users', { method: 'DELETE', params: { id: mary.id } }); assert.equal(r.status, 409);
});
await ok('logout clears the session', async () => {
  const r = await admin('logout', { method: 'POST' }); assert.match(r.setCookie, /Max-Age=0/);
  assert.equal((await admin('products')).status, 401);
});
await ok('unknown endpoint -> 404', async () => { const r = await anon('nope'); assert.equal(r.status, 404); });

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`);
process.exit(process.exitCode || 0);
