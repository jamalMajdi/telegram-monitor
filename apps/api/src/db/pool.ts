import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool } = pg;
// أرقام NUMERIC/BIGINT تُعاد كأرقام JavaScript عند كونها آمنة، تجنّباً لتفاوت الأنواع في الواجهة.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
      connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      application_name: 'tg-api',
    });
    pool.on('error', (err) => {
      logger.error({ err: err.message }, 'خطأ في اتصال خامل بقاعدة البيانات');
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

/** تنفيذ مجموعة عمليات داخل معاملة واحدة؛ تُلغى كاملة عند أي خطأ. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      /* الاتصال تالف؛ يُعاد إلى المجمع ويُستبدل */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabase(): Promise<void> {
  await query('select 1');
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
