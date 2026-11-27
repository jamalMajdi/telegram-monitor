/**
 * خدمة السجلات (P4-ج): ترقيم مؤشِّر شفّاف + تجميع للمدير.
 *
 * المؤشِّر مشفَّر نصياً (`v1:<id>`) حتى لا يُفترض في العميل أي ترتيب معرّفات؛
 * وأي مؤشِّر غير صالح يُرفض صراحةً (400) بدل تخمين صفحة.
 */
import type { AdminErrorGroup, LogFilters, LogRow, LogsStore } from './logsRepository.js';

export interface LogsPage {
  logs: LogRow[];
  nextCursor: string | null;
}

export interface AdminErrorsView {
  groups: AdminErrorGroup[];
  totals: { total: number; critical: number; byScope: Record<string, number> };
  windowHours: number;
}

export function encodeCursor(id: number): string {
  return Buffer.from(`v1:${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^v1:(\d{1,15})$/.exec(raw);
    if (!match) return null;
    return Number(match[1]);
  } catch {
    return null;
  }
}

export class LogsService {
  constructor(private readonly store: LogsStore) {}

  /** سجلّات المالك فقط؛ الاستعلام نفسه مقيَّد بـ`user_id` في المستودع. */
  async listForUser(userId: string, filters: Omit<LogFilters, 'cursorId' | 'limit'> & {
    limit: number;
    cursor?: string | null;
  }): Promise<LogsPage> {
    const cursorId = filters.cursor ? decodeCursor(filters.cursor) : null;
    const rows = await this.store.listForUser(userId, {
      ...filters,
      cursorId,
      // صف إضافي لمعرفة إن كانت هناك صفحة تالية.
      limit: filters.limit + 1,
    });
    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    const last = page[page.length - 1];
    return { logs: page, nextCursor: hasMore && last ? encodeCursor(last.id) : null };
  }

  async adminView(input: { windowHours: number; scope?: string; limit: number }): Promise<AdminErrorsView> {
    const since = new Date(Date.now() - input.windowHours * 3600 * 1000);
    const [groups, totals] = await Promise.all([
      this.store.groupForAdmin({ from: since, ...(input.scope ? { scope: input.scope } : {}), limit: input.limit }),
      this.store.totalsForAdmin(since),
    ]);
    return { groups, totals, windowHours: input.windowHours };
  }
}
