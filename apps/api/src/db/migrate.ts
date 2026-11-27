/**
 * مُشغّل الترحيلات: ملفات SQL مرتبة داخل db/migrations تُطبَّق مرة واحدة،
 * وتُسجّل في جدول schema_migrations مع بصمة SHA-256 للحماية من التعديل الصامت.
 * المنهجية إلى الأمام فقط (Forward-only)؛ أي تعديل لاحق يكون بملف ترحيل جديد.
 *
 * الاستخدام: npm run migrate  |  npm run db:status
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './pool.js';
import { logger } from '../lib/logger.js';

/**
 * مجلد الترحيلات: بجانب الملف المُنفَّذ (`dist/db/migrations`) كما في `src/db/migrations`.
 *
 * سبب البحث المزدوج: `tsc` لا ينسخ ملفات `.sql`، فبناء الإنتاج بلا خطوة نسخ إضافية كان يُنتج
 * حزمة **لا تستطيع الترحيل** (اكتُشف في P4-ز عند اختبار `node dist/db/migrate.js`).
 * النسخ يتم في سكربت البناء (`scripts/copy-assets.mjs`)، والبحث هنا شبكة أمان ثانية:
 * إن غاب المجلد بجانب الملف نبحث عنه في جذر الحزمة بصيغة المصدر والبناء.
 */
const here = dirname(fileURLToPath(import.meta.url));
const candidateDirs = [
  join(here, 'migrations'),
  join(here, '..', '..', 'src', 'db', 'migrations'),
];
async function resolveMigrationsDir(): Promise<string> {
  for (const candidate of candidateDirs) {
    try {
      const entries = await readdir(candidate);
      if (entries.some((name) => name.endsWith('.sql'))) return candidate;
    } catch {
      /* نجرب المرشح التالي */
    }
  }
  throw new Error(`لم يُعثر على مجلد الترحيلات في: ${candidateDirs.join(' | ')}`);
}
let migrationsDir = join(here, 'migrations');

/** إنشاء سجل الترحيلات إن لم يكن موجوداً (لا يُعدّ ترحيلاً بحد ذاته). */
export async function ensureRegistry(client: import('pg').PoolClient): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      id serial primary key,
      filename text not null unique,
      checksum text not null,
      applied_at timestamptz not null default now(),
      execution_ms integer not null
    )
  `);
}

async function listMigrations(): Promise<{ filename: string; sql: string; checksum: string }[]> {
  migrationsDir = await resolveMigrationsDir();
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (filename) => {
      const sql = await readFile(join(migrationsDir, filename), 'utf8');
      return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

export async function migrate(): Promise<{ applied: string[]; skipped: string[] }> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await ensureRegistry(client);
    const existing = await client.query<{ filename: string; checksum: string }>(
      'select filename, checksum from schema_migrations',
    );
    const registry = new Map(existing.rows.map((r) => [r.filename, r.checksum]));
    const migrations = await listMigrations();
    for (const m of migrations) {
      const previous = registry.get(m.filename);
      if (previous) {
        if (previous !== m.checksum) {
          throw new Error(
            `بصمة الترحيل ${m.filename} تغيّرت بعد التطبيق؛ لا يُسمح بتعديل ترحيل مُطبَّق. أنشئ ترحيلاً جديداً.`,
          );
        }
        skipped.push(m.filename);
        continue;
      }
      const started = Date.now();
      await client.query('begin');
      try {
        await client.query(m.sql);
        const ms = Date.now() - started;
        await client.query(
          'insert into schema_migrations (filename, checksum, execution_ms) values ($1, $2, $3)',
          [m.filename, m.checksum, ms],
        );
        await client.query('commit');
        applied.push(m.filename);
        logger.info({ migration: m.filename, ms }, 'تم تطبيق الترحيل');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
    return { applied, skipped };
  } finally {
    client.release();
  }
}

export async function migrationStatus(): Promise<
  { filename: string; applied: boolean; appliedAt: string | null; checksumOk: boolean }[]
> {
  const client = await getPool().connect();
  try {
    await ensureRegistry(client);
    const migrations = await listMigrations();
    const res = await client.query<{ filename: string; checksum: string; applied_at: Date }>(
      'select filename, checksum, applied_at from schema_migrations',
    );
    const registry = new Map(res.rows.map((r) => [r.filename, r]));
    return migrations.map((m) => {
      const row = registry.get(m.filename);
      return {
        filename: m.filename,
        applied: Boolean(row),
        appliedAt: row ? row.applied_at.toISOString() : null,
        checksumOk: row ? row.checksum === m.checksum : true,
      };
    });
  } finally {
    client.release();
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  const status = process.argv.includes('--status');
  try {
    if (status) {
      const rows = await migrationStatus();
      for (const r of rows) {
        console.log(
          `${r.applied ? 'مطبَّق ' : 'معلّق  '} ${r.filename}${r.appliedAt ? `  (${r.appliedAt})` : ''}` +
            (r.checksumOk ? '' : '  تحذير: البصمة مختلفة'),
        );
      }
    } else {
      const result = await migrate();
      console.log(
        `ترحيلات مطبَّقة: ${result.applied.length ? result.applied.join(', ') : 'لا جديد'} | متجاوزة: ${result.skipped.length}`,
      );
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'فشل الترحيل');
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
