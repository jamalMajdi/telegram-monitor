/**
 * قاعدة بيانات تطوير محلية بدون صلاحيات مدير النظام:
 * تُشغّل نسخة PostgreSQL مضمّنة (embedded-postgres) على المنفذ 55432 وبيانات في /tmp.
 * هذا للتطوير والاختبار المحلي فقط؛ الإنتاج يستخدم خدمة PostgreSQL مُدارة أو خادماً مستقلاً.
 */
import EmbeddedPostgres from 'embedded-postgres';

const port = Number(process.env.DEV_DB_PORT ?? 55432);
const dataDir = process.env.DEV_DB_DIR ?? '/tmp/tg-dev-pg';
const database = process.env.DEV_DB_NAME ?? 'telegram_monitor';

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'devpassword',
  port,
  persistent: true,
  // صورة التشغيل هذه لا تتضمن locale en_US؛ نثبّت C.utf8 (ترميز UTF-8 كامل) بدلاً منه.
  initdbFlags: ['--locale=C.utf8', '--lc-messages=C', '--encoding=UTF8'],
});

console.log(`[dev-db] بدء PostgreSQL على المنفذ ${port} ببيانات في ${dataDir}`);
await pg.initialise();
await pg.start();
try {
  await pg.createDatabase(database);
  console.log(`[dev-db] أُنشئت قاعدة ${database}`);
} catch (err) {
  console.log(`[dev-db] قاعدة ${database} موجودة أو تعذّر إنشاؤها: ${err.message}`);
}
console.log('[dev-db] جاهزة. أوقف العملية لإنهاء الخدمة.');

async function stop() {
  try {
    await pg.stop();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
