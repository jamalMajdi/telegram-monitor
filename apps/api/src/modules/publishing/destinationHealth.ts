/**
 * صحة الوجهة: «سلسلة إخفاقات متتالية» لكل وجهة (P0 — تدقيق ما قبل التسليم).
 *
 * السؤال الذي يجيب عنه: **كم تسليماً منتهياً متتالياً (من الأحدث إلى الأقدم) فشل** على وجهة ما،
 * قبل أول نجاح؟ (سلسلة بادئة، لا «عدد الإخفاقات داخل نافذة»).
 * هذا هو معنى «الفشل المتكرر» عملياً: حجب البوت، حذف القناة، سحب الصلاحية، أو شبكة معطوبة
 * عند تلك الوجهة. تسليم واحد فاشل بين منشورات ناجحة **ليس** نمطاً يستحق تنبيهاً.
 *
 * لماذا استعلام واحد للجميع: نفس الحساب يُستخدم في ثلاث حالات (عرض شارة في الواجهة،
 * بناء تنبيه، وبريد تنبيه) — فلا تتباعد التعريفات الثلاثة مع الوقت.
 *
 * حدود مقصودة:
 * - لا نص حر: يعيد رموز أخطاء (`last_error_code`) وتواريخ وأعداداً فقط.
 * - مقصور على `user_id` دائماً (عزل المستخدمين).
 * - يعتمد على التسليمات المنتهية فقط (`published|partial|failed|uncertain|blocked`)؛
 *   ما ينتظر المراجعة أو في الطابور لا يُحسب إخفاقاً.
 */
import { query } from '../../db/pool.js';

export type TerminalStatus = 'published' | 'partial' | 'failed' | 'uncertain' | 'blocked';

export interface DestinationFailureStat {
  /**
   * عدد الإخفاقات المتتالية من الأحدث إلى الأقدم قبل أول تسليم منشور.
   * صفر/غائب إذا كان آخر تسليم ناجحاً. السلسلة محدودة بـ`window` (5) بطبيعتها.
   */
  streak: number;
  lastErrorCode: string | null;
  lastFailureAt: Date | null;
}

export interface DestinationHealthStore {
  stats(userId: string, window?: number): Promise<Map<string, DestinationFailureStat>>;
  /** عدد الوجهات التي بلغت السلسلة الحدّ (يُستخدم لبناء التنبيه). */
  countFailing(userId: string, threshold: number, window?: number): Promise<number>;
}

const DEFAULT_WINDOW = 5;

interface Row {
  destination_id: string;
  streak: string;
  last_error_code: string | null;
  last_failure_at: Date | null;
}

/** استعلام واحد مشترك: سلسلة إخفاقات لكل وجهة داخل نافذة آخر التسليمات المنتهية. */
const STATS_SQL = `
with ranked as (
  select d.destination_id,
         d.status::text as status,
         d.last_error_code,
         d.created_at,
         d.id,
         row_number() over (partition by d.destination_id order by d.created_at desc, d.id desc) as rn
    from deliveries d
   where d.user_id = $1
     and d.status in ('published', 'partial', 'failed', 'uncertain', 'blocked')
),
windowed as (
  select * from ranked where rn <= $2::int
),
-- أول تسليم ناجح في النافذة يقطع السلسلة: ما بعده لا يُحتسب مهما كان فاشلاً.
broken as (
  select destination_id, min(rn) as first_success_rn
    from windowed
   where status = 'published'
   group by destination_id
),
leading_failures as (
  select w.destination_id, w.rn, w.last_error_code, w.created_at
    from windowed w
    left join broken b on b.destination_id = w.destination_id
   where w.status <> 'published'
     and (b.first_success_rn is null or w.rn < b.first_success_rn)
)
select destination_id,
       count(*)::text as streak,
       (array_agg(last_error_code order by rn) filter (where last_error_code is not null))[1] as last_error_code,
       max(created_at) as last_failure_at
  from leading_failures
 group by destination_id
`;

export class PgDestinationHealth implements DestinationHealthStore {
  async stats(userId: string, window = DEFAULT_WINDOW): Promise<Map<string, DestinationFailureStat>> {
    const res = await query<Row>(STATS_SQL, [userId, Math.max(1, Math.min(window, 20))]);
    return new Map(
      res.rows.map((row) => [
        row.destination_id,
        {
          streak: Number(row.streak),
          lastErrorCode: row.last_error_code,
          lastFailureAt: row.last_failure_at,
        },
      ]),
    );
  }

  async countFailing(userId: string, threshold: number, window = DEFAULT_WINDOW): Promise<number> {
    const stats = await this.stats(userId, window);
    let count = 0;
    for (const stat of stats.values()) if (stat.streak >= threshold) count += 1;
    return count;
  }
}

/** عتبة «فشل متكرر» — ثابتة ومعلنة (ليست عتبة قابلة للضبط حتى لا تتباعد القيم). */
export const DESTINATION_FAILURE_THRESHOLD = 3;
