/**
 * مشغّل الاختبارات: يفصل اختبارات «قاعدة البيانات» عن اختبارات الوحدة.
 *
 * السبب: كل ملف اختبار يقيم قاعدة PostgreSQL مضمَّنة مستقلة (embedded-postgres) في /tmp.
 * تشغيل عدة قواعد في الوقت نفسه يتجاوز مساحة /tmp في البيئات المحدودة.
 *
 * كيف يُشغَّل الآن (بعد تدقيق ما قبل التسليم — P0):
 *   1) اختبارات الوحدة (بلا قاعدة بيانات) تُشغَّل بالتوازي الكامل في عملية واحدة.
 *   2) اختبارات قاعدة البيانات تُشغَّل **ملفاً لكل عملية** بالتتابع، بحدّ زمني لكل ملف.
 *
 * لماذا ملف لكل عملية: كانت كل ملفات القاعدة تُشغَّل في عملية واحدة متسلسلة. مع نمو
 * العدد (35 ملفاً) ظهرت أعطال تهيئة عشوائية: نسخ postgres مضمَّنة تتراكم داخل عملية
 * واحدة، وأحياناً يفشل `initdb`/الاتصال بلا علاقة بالكود (ECONNREFUSED على منفذ النسخة).
 * العزل بعملية لكل ملف يمنع هذا الصنف كله، ويُظهر توقيت كل ملف وحدّاً زمنياً واضحاً،
 * فصار الفشل يعني كوداً لا بنية تشغيل. (لا يتغيّر أي اختبار ولا تغطية.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const testDir = resolve(import.meta.dirname, '..', 'test');
const cwd = resolve(import.meta.dirname, '..');
const PER_FILE_TIMEOUT_MS = 240_000;

// بيئة اختبار حتمية: لا تعتمد على ملف .env المحلي (غير المتعقَّب). ما يمرّ هنا هو ما
// يمرّ في CI حرفياً، فلا يمرّ اختبار محلياً ويفشل على الخادم بسبب سرّ موجود في .env فقط.
//   • DATABASE_URL: قيمة تُرضي التحقّق عند الاستيراد؛ كل ملف قاعدة بيانات يقيم قاعدته
//     المضمَّنة ويضبط المتغيّر بنفسه قبل أول استعلام.
//   • مفاتيح التشفير: 32 بايت اصطناعية (base64) لاختبارات تيليجرام/البوت. لا صلة لها بأي
//     مفتاح حقيقي، ووجودها شرط لتجزئة بصمة الرقم وتشفير الجلسة داخل الاختبارات.
const TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test_placeholder',
  TG_SESSION_ENC_KEY: Buffer.alloc(32, 0x11).toString('base64'),
  TG_BOT_ENC_KEY: Buffer.alloc(32, 0x22).toString('base64'),
};
const childEnv = { ...process.env, ...TEST_ENV };

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort();
const isDatabaseBound = (file) => readFileSync(join(testDir, file), 'utf8').includes('startTestServer');

const unitFiles = files.filter((file) => !isDatabaseBound(file));
const dbFiles = files.filter(isDatabaseBound);

function spawnTests(filesToRun, extraArgs = [], onOutput) {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--test', ...extraArgs, ...filesToRun.map((file) => join(testDir, file))],
      { stdio: onOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: childEnv, cwd },
    );
    if (onOutput) {
      child.stdout.on('data', (chunk) => onOutput(String(chunk)));
      child.stderr.on('data', (chunk) => onOutput(String(chunk)));
    }
    child.on('exit', (code) => resolveRun(code ?? 1));
  });
}

function countTable(output, label) {
  const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)`, 'gm'))];
  return matches.reduce((sum, m) => sum + Number(m[1]), 0);
}

const totals = { pass: 0, fail: 0, skipped: 0, files: 0, failedFiles: [] };

// 1) اختبارات الوحدة: متوازية في عملية واحدة.
if (unitFiles.length > 0) {
  let unitOutput = '';
  const code = await spawnTests(unitFiles, [`--test-concurrency=${unitFiles.length || 1}`], (chunk) => {
    process.stdout.write(chunk);
    unitOutput += chunk;
  });
  totals.pass += countTable(unitOutput, 'pass');
  totals.fail += countTable(unitOutput, 'fail');
  totals.skipped += countTable(unitOutput, 'skipped');
  totals.files += unitFiles.length;
  if (code !== 0) totals.failedFiles.push(...unitFiles);
}

// 2) اختبارات قاعدة البيانات: ملف لكل عملية، بالتتابع.
for (const file of dbFiles) {
  const started = Date.now();
  let output = '';
  let timedOut = false;
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', join(testDir, file)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
    cwd,
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, PER_FILE_TIMEOUT_MS);
  child.stdout.on('data', (chunk) => (output += String(chunk)));
  child.stderr.on('data', (chunk) => (output += String(chunk)));
  const code = await new Promise((done) => child.on('exit', (value) => done(value ?? 1)));
  clearTimeout(timer);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const pass = countTable(output, 'pass');
  const fail = countTable(output, 'fail');
  totals.pass += pass;
  totals.fail += fail;
  totals.skipped += countTable(output, 'skipped');
  totals.files += 1;

  const ok = code === 0 && !timedOut;
  if (!ok) {
    totals.failedFiles.push(file);
    process.stdout.write(output);
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file} · نجح ${pass} · فشل ${fail} · ${seconds}s${timedOut ? ' (مهلة)' : ''}`);
}

console.log(
  `\nالإجمالي: ${totals.files} ملفاً · نجح ${totals.pass} · فشل ${totals.fail} · متجاوز ${totals.skipped}`,
);
if (totals.failedFiles.length > 0) {
  console.log(`ملفات فاشلة:\n${totals.failedFiles.join('\n')}`);
  process.exit(1);
}
process.exit(0);
