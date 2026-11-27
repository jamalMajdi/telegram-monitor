/**
 * منطقة الخطر (P4-د، Q21/Q22): عبارات التأكيد مصدرها واحد.
 *
 * العبارة تُكتب يدوياً حرفياً — لا مربع اختيار، ولا `confirm: true`. والغرض أن يكون
 * الحذف **قراراً واعياً** لا نقرة عابرة: كلاهما نهائي، بلا سلة محذوفات ولا استرجاع.
 */

/** حذف البيانات التشغيلية فقط (المحتوى والتسليمات)، مع إبقاء الحساب والإعدادات. */
export const PURGE_PHRASE = 'احذف بياناتي';

/** الحذف النهائي للحساب بكل ما يخصه. */
export const DELETE_ACCOUNT_PHRASE = 'احذف حسابي نهائياً';

export function phrasesMatch(input: string, expected: string): boolean {
  // تطبيع المسافات العربية واللاتينية الطرفية فقط؛ لا تسامح في الحروف.
  return input.replace(/\s+/g, ' ').trim() === expected;
}

export function isPurgeConfirmed(input: unknown): boolean {
  return typeof input === 'string' && phrasesMatch(input, PURGE_PHRASE);
}

export function isDeleteConfirmed(input: unknown): boolean {
  return typeof input === 'string' && phrasesMatch(input, DELETE_ACCOUNT_PHRASE);
}
