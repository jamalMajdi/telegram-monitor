/**
 * خدمة الالتقاط (الخطوة الرابعة): تستهلك الرسائل النصية الجديدة الواردة من عميل الحساب المتصل،
 * وتقرّر: التقاط جديد / تكرار / استبعاد متعمّد، بلا حفظ نص أو وسائط ولا استيراد تاريخ.
 *
 * قرارات معتمدة مطبَّقة هنا:
 * - لا نص ولا وسائط في قاعدة البيانات أو السجلات (D06/D07).
 * - التحديثات غير المرتبطة بمصادر مراقبة لا تُحصى لكل مصدر، بل في عدّاد عام واحد (قرار 3).
 * - التكرار يُحسم بـ`ON CONFLICT DO NOTHING` داخل معاملة واحدة مع العدّاد (قرارا 3 و4).
 * - حرس نقطة الاستئناف في طبقة العميل لا يتقدّم إلا بعد نجاح هذه المعاملة (قرار 1).
 * - كل استبعاد متعمّد يُحسم بنجاح حتى لا تتوقف نقطة الاستئناف بسبب رسالة لا تخصّنا (شرط المستخدم).
 */
import { recordAudit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import type { IncomingTextMessage } from './gateway.js';
import type { TelegramAccountStore } from './accountRepository.js';
import type { TelegramConnectionManager } from './connectionManager.js';
import type { IngestStore, MonitoredSourceRow, SourceIngestStats } from './ingestRepository.js';
import type { MessageProcessingService } from '../processing/messageProcessingService.js';

export interface IngestServiceDeps {
  store: IngestStore;
  /** مالك الحساب (بمعرّفه الداخلي) — لمسار الالتقاط وحده. */
  accounts: Pick<TelegramAccountStore, 'findOwner'>;
  /** حالة الاتصال للقراءة فقط في لوحة الحالة. */
  connections: Pick<TelegramConnectionManager, 'getState'>;
  /** عدد محاولات إعادة حفظ الهوية قبل إعلان الفشل. */
  maxAttempts: number;
  /** مدة الاحتفاظ بهويات الرسائل بالأيام (قرار 2). */
  identityRetentionDays: number;
  /** تعطيل/تمكين الالتقاط من البيئة. */
  enabled: boolean;
  /**
   * خط المعالجة (الخطوة 5-ب). يعمل بعد نجاح تثبيت الهوية فقط، ولا يرفع أخطاءً،
   * فلا يؤثر فشله في تقدّم نقطة الاستئناف (Q4).
   */
  processing?: Pick<MessageProcessingService, 'process'>;
}

export interface IngestStatus {
  enabled: boolean;
  identityRetentionDays: number;
  /** عدّاد عام واحد للتحديثات غير المرتبطة بأي مصدر مراقب (بلا تفاصيل). */
  unmatchedUpdates: number;
  failedMessages: number;
  retries: number;
  duplicateReplays: number;
  sources: (SourceIngestStats & { connectionPhase: string })[];
  since: string;
}

interface Counters {
  unmatchedUpdates: number;
  failedMessages: number;
  retries: number;
  duplicateReplays: number;
}

/** يستخرج الهوية الرقمية للند من مفتاح المحادثة الذي تنتجه المكتبة: channel:<id> | chat:<id>. */
export function parsePeerKey(peerKey: string): { peerType: 'channel' | 'group'; peerId: string } | null {
  const match = /^(channel|chat):(\d{1,19})$/.exec(peerKey.trim());
  if (!match) return null;
  const peerId = match[2]!;
  if (!/^\d+$/.test(peerId) || BigInt(peerId) <= 0n) return null;
  return { peerType: match[1] === 'channel' ? 'channel' : 'group', peerId };
}

export class TelegramIngestService {
  private readonly counters: Counters = { unmatchedUpdates: 0, failedMessages: 0, retries: 0, duplicateReplays: 0 };
  private readonly startedAt = new Date();
  private purgeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: IngestServiceDeps) {}

  /** يعالج رسالة واردة. يرفع الخطأ فقط عند فشل حفظ الهوية بعد كل المحاولات (لتبقى النقطة مثبّتة). */
  async handle(message: IncomingTextMessage): Promise<void> {
    if (!this.deps.enabled) return;

    const peer = parsePeerKey(message.peerKey);
    if (!peer) {
      // محادثة خاصة: ليست مصدراً قابلاً للمراقبة ⇒ تُحسب في العدّاد العام وحده.
      if (/^user:\d+$/.test(message.peerKey)) {
        this.counters.unmatchedUpdates += 1;
        return;
      }
      // شكل غير معروف: يُهمل بلا عدّاد مصدر ولا صف.
      logger.debug({ peerKey: message.peerKey }, 'تحديث بمفتاح ند غير معروف — تم تجاهله');
      return;
    }

    const account = await this.deps.accounts.findOwner(message.accountId);
    if (!account) {
      this.counters.unmatchedUpdates += 1;
      return;
    }

    const source = await this.deps.store.findMonitoredSource({
      userId: account.userId,
      accountId: message.accountId,
      peerId: peer.peerId,
    });

    if (!source) {
      // محادثة غير مراقبة: عدّاد عام واحد فقط، بلا تفاصيل ولا سجلات (قرار 3).
      this.counters.unmatchedUpdates += 1;
      return;
    }

    await this.processForSource({ source, message });
  }

  private async processForSource(input: {
    source: MonitoredSourceRow;
    message: IncomingTextMessage;
  }): Promise<void> {
    const { source, message } = input;

    // 1) استبعادات متعمّدة: تُحسم فوراً حتى لا تتوقف نقطة الاستئناف.
    if (source.status !== 'active') {
      await this.deps.store.recordExcluded(source.id);
      return;
    }
    if (message.outgoing && !source.includeOwnMessages) {
      await this.deps.store.recordExcluded(source.id);
      return;
    }

    // 2) التقاط الهوية: إعادة محاولة محدودة، ثم تثبيت الخطأ ورفعه.
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.deps.maxAttempts; attempt += 1) {
      try {
        const result = await this.deps.store.recordMessage({
          userId: source.userId,
          accountId: source.accountId,
          source,
          telegramMessageId: message.messageId,
          sentAt: message.sentAt,
          // هوية المرسل (اسم/@username/التوقيع) تُحفظ مع الهوية لتُعرض في المنشور لاحقاً.
          sender: message.sender ?? null,
        });
        if (result.outcome === 'duplicate') {
          if (message.missed) this.counters.duplicateReplays += 1;
          return;
        }
        // الهوية مثبَّتة الآن في معاملة منتهية؛ المعالجة معاملة مستقلة (Q4).
        if (result.identityId && this.deps.processing) {
          await this.deps.processing.process({
            userId: source.userId,
            identityId: result.identityId,
            sourceId: source.id,
            text: message.text ?? '',
            caption: message.caption ?? '',
          });
        }
        return;
      } catch (err) {
        lastError = err;
        this.counters.retries += 1;
        logger.warn(
          { sourceId: source.id, attempt, err: (err as Error).message },
          'تعذّر حفظ هوية الرسالة؛ إعادة محاولة',
        );
      }
    }

    this.counters.failedMessages += 1;
    const code = 'INGEST_PERSIST_FAILED';
    await this.deps.store.recordFailure({ sourceId: source.id, code }).catch(() => undefined);
    await recordAudit({
      action: 'telegram.ingest_failed',
      actorUserId: source.userId,
      targetType: 'telegram_source',
      targetId: source.id,
      outcome: 'failure',
      metadata: { code },
    }).catch(() => undefined);
    // يرفع الخطأ ليُبقي حرس نقطة الاستئناف النقطة عند ما قبل هذه الرسالة (فلا تُفقد).
    throw lastError instanceof Error ? lastError : new Error('ingest_persist_failed');
  }

  async status(userId: string): Promise<IngestStatus> {
    const rows = await this.deps.store.statsForUser(userId);
    const sources = rows.map((row) => ({
      ...row,
      connectionPhase: this.deps.connections.getState(row.accountId, userId)?.phase ?? 'unknown',
    }));
    return {
      enabled: this.deps.enabled,
      identityRetentionDays: this.deps.identityRetentionDays,
      ...this.counters,
      sources,
      since: this.startedAt.toISOString(),
    };
  }

  async sourceStats(input: { userId: string; sourceId: string }): Promise<
    (SourceIngestStats & { connectionPhase: string }) | null
  > {
    const stats = await this.deps.store.statsForSource(input);
    if (!stats) return null;
    return {
      ...stats,
      connectionPhase: this.deps.connections.getState(stats.accountId, input.userId)?.phase ?? 'unknown',
    };
  }

  /** تنظيف الهويات المنتهية؛ مستقل تماماً عن إعدادات المستخدم (D09). */
  async purgeExpiredIdentities(): Promise<number> {
    const removed = await this.deps.store.purgeIdentitiesOlderThan(this.deps.identityRetentionDays);
    if (removed > 0) {
      logger.info({ removed, days: this.deps.identityRetentionDays }, 'حُذفت هويات رسائل تجاوزت مدة الاحتفاظ');
    }
    return removed;
  }

  /** مشغّل التنظيف الدوري + تنظيف عند البدء. يفشل بصمت مع تسجيل الخطأ فقط. */
  startBackgroundTasks(intervalMs: number): void {
    void this.purgeExpiredIdentities().catch((err: unknown) => {
      logger.error({ err: (err as Error).message }, 'فشل تنظيف هويات الرسائل عند البدء');
    });
    if (this.purgeTimer) return;
    this.purgeTimer = setInterval(() => {
      void this.purgeExpiredIdentities().catch((err: unknown) => {
        logger.error({ err: (err as Error).message }, 'فشل تنظيف هويات الرسائل الدوري');
      });
    }, intervalMs);
    this.purgeTimer.unref?.();
  }

  stopBackgroundTasks(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = null;
  }
}
