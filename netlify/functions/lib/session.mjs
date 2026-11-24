// Stateless sessions: a signed, HttpOnly cookie (Netlify Functions have no server-side session store).
// Payload: { uid, last, mc }  last = time of the last request (idle timeout), mc = must change password.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './db.mjs';

const NAME = 'POSSESSID';
const hours = () => Math.max(1, parseInt(process.env.SESSION_HOURS || '12', 10) || 12);

function secret() {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 24) throw new ApiError('SESSION_SECRET is missing. In Netlify > Environment variables add SESSION_SECRET (a random string of 32+ characters), then redeploy.', 503);
  return s;
}
const b64 = b => Buffer.from(b).toString('base64url');
const sign = data => createHmac('sha256', secret()).update(data).digest('base64url');

export function readSession(req) {
  const m = (req.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(NAME + '='));
  const empty = {};
  if (!m) return empty;
  const tok = m.slice(NAME.length + 1);
  const [body, mac] = tok.split('.');
  if (!body || !mac) return empty;
  const want = sign(body);
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return empty;
  let s;
  try { s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return empty; }
  if (!s || typeof s !== 'object') return empty;
  const now = Math.floor(Date.now() / 1000);
  if (s.last && now - s.last > hours() * 3600) return empty;   // a till left open overnight does not stay signed in
  return s;
}

export function cookieFor(sess, req) {
  const secure = new URL(req.url).protocol === 'https:' || (req.headers.get('x-forwarded-proto') || '') === 'https';
  const flags = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  if (!sess || !sess.uid) return `${NAME}=; ${flags}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  const body = b64(JSON.stringify({ uid: sess.uid, last: Math.floor(Date.now() / 1000), mc: sess.mc ? 1 : 0 }));
  return `${NAME}=${body}.${sign(body)}; ${flags}`;
}
