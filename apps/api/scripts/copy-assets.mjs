/**
 * نسخ أصول غير-TypeScript إلى مجلد البناء (P4-ز).
 *
 * `tsc` ينسخ `.js` فقط؛ ملفات الترحيلات `.sql` أصول تشغيل حقيقية: بلا نسخها يفشل
 * `node dist/db/migrate.js` في الإنتاج (اختبار «التجهيز للإنتاج» أمسك هذا).
 */
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pairs = [['src/db/migrations', 'dist/db/migrations']];

for (const [from, to] of pairs) {
  const source = join(root, from);
  const target = join(root, to);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  console.log(`[build] نُسخت ${from} → ${to}`);
}
