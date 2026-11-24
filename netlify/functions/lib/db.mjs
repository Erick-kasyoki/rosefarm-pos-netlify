// PostgreSQL access for the Netlify Function (works with Neon, Supabase or any Postgres).
import pg from 'pg';

export class ApiError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Return values the same way the old PHP/PDO code did, so the front end sees identical JSON:
// bigint (COUNT) -> number, DATE / TIMESTAMP -> plain text. NUMERIC stays text, exactly like PDO.
const TYPES = {
  getTypeParser: (oid, format) =>
    oid === 20 ? (v => parseInt(v, 10))
    : (oid === 1082 || oid === 1114) ? (v => v)
    : pg.types.getTypeParser(oid, format),
};

export const TZ = process.env.APP_TIMEZONE || 'Africa/Nairobi';
const SAFE_TZ = /^[A-Za-z0-9_/+-]+$/.test(TZ) ? TZ : 'UTC';

export function connectionString() {
  return process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL || process.env.NETLIFY_DATABASE_URL_UNPOOLED || '';
}

let pool = null;
/**
 * Which database?  1) DATABASE_URL, if you set one (any external Postgres: Neon, Supabase...), else
 * 2) Netlify Database, the Postgres built into Netlify. It is provisioned automatically on deploy
 *    and @netlify/database supplies the connection (no variables to set).
 */
async function getPool() {
  if (pool) return pool;
  const raw = connectionString();
  if (raw) {
    const u = new URL(raw);
    const local = ['localhost', '127.0.0.1', '::1', ''].includes(u.hostname);
    const mode = u.searchParams.get('sslmode');
    u.searchParams.delete('sslmode'); u.searchParams.delete('channel_binding');
    pool = new pg.Pool({
      connectionString: u.toString(),
      ssl: local || mode === 'disable' ? false : { rejectUnauthorized: true },
      max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000,
    });
    pool.on('error', e => console.error('[pos] idle db client error', e.message));
    return pool;
  }
  try {
    const { getDatabase } = await import('@netlify/database');
    pool = getDatabase().pool;
    return pool;
  } catch (e) {
    console.error('[pos] Netlify Database not available:', e && e.message);
    throw new ApiError('The database is not set up yet. In Netlify open your site > Data & Storage > Database and create the database (or redeploy), then reload this page.', 503);
  }
}

// "?" placeholders -> $1, $2 ... (keeps every query from the PHP version unchanged).
function toPg(sql) { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); }

/** One database connection for the whole request: q() runs a query, tx() wraps work in a transaction. */
export async function withDb(fn) {
  const client = await (await getPool()).connect();
  try {
    await client.query(`SET TIME ZONE '${SAFE_TZ}'`);
    let inTx = false;
    const db = {
      client,
      q: async (sql, params = []) => (await client.query({ text: toPg(sql), values: params, types: TYPES })),
      all: async (sql, params = []) => (await client.query({ text: toPg(sql), values: params, types: TYPES })).rows,
      one: async (sql, params = []) => (await client.query({ text: toPg(sql), values: params, types: TYPES })).rows[0] || null,
      val: async (sql, params = []) => { const r = (await client.query({ text: toPg(sql), values: params, types: TYPES })).rows[0]; return r ? Object.values(r)[0] : null; },
      raw: sql => client.query(sql),   // multi-statement scripts (no parameters)
      async tx(work) {
        await client.query('BEGIN'); inTx = true;
        try { const r = await work(db); await client.query('COMMIT'); inTx = false; return r; }
        catch (e) { try { await client.query('ROLLBACK'); } catch {} inTx = false; throw e; }
      },
    };
    return await fn(db);
  } finally {
    client.release();
  }
}
