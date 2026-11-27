/**
 * دليل المستخدمين الذي يحتاجه توصيل البريد (P0 — تدقيق ما قبل التسليم).
 *
 * عمليتان فقط، وكلتاهما للقراءة:
 *  - `emailOf(userId)`: عنوان التسليم (لا يُسجَّل ولا يُعاد في أي استجابة).
 *  - `listUsersWithDestinations()`: من يهمّه تنبيه النشر — من يملك وجهة واحدة على الأقل،
 *    حتى لا يُرسل بريد نشر لمن لا ينشر.
 */
import { query } from '../../db/pool.js';

export interface UserDirectory {
  emailOf(userId: string): Promise<string | null>;
  listUsersWithDestinations(limit?: number): Promise<string[]>;
}

export class PgUserDirectory implements UserDirectory {
  async emailOf(userId: string): Promise<string | null> {
    const res = await query<{ email: string; status: string }>('select email, status from users where id = $1', [userId]);
    const row = res.rows[0];
    if (!row || row.status !== 'active') return null;
    return row.email;
  }

  async listUsersWithDestinations(limit = 500): Promise<string[]> {
    const res = await query<{ id: string }>(
      `select distinct d.user_id as id
         from destinations d
         join users u on u.id = d.user_id
        where d.status = 'active' and u.status = 'active'
        order by 1
        limit $1`,
      [Math.max(1, Math.min(limit, 5000))],
    );
    return res.rows.map((row) => row.id);
  }
}
