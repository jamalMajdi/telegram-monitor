/**
 * مخزن جلسات MTProto في PostgreSQL: لا يُخزَّن إلا المغلّف المشفّر،
 * ولا تُعاد الجلسة إلا لمالكها (عزل صارم بمعرّف المستخدم في كل استعلام).
 */
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { decryptSession, encryptSession, type SessionPayload } from './sessionCipher.js';

export class TelegramSessionAccessError extends Error {
  constructor(message = 'الحساب غير موجود أو لا تملك صلاحية الوصول إليه.') {
    super(message);
    this.name = 'TelegramSessionAccessError';
  }
}

interface StoredRow {
  ciphertext: Buffer;
  key_version: number;
}

export async function saveTelegramSession(
  input: { accountId: string; userId: string; payload: SessionPayload },
  client: PoolClient | null = null,
): Promise<void> {
  const ownership = await runOwnershipCheck(input.accountId, input.userId, client);
  if (!ownership) throw new TelegramSessionAccessError();

  const { ciphertext, keyVersion } = encryptSession(input.accountId, {
    ...input.payload,
    savedAt: input.payload.savedAt ?? new Date().toISOString(),
  });

  const sql = `
    insert into telegram_sessions (account_id, ciphertext, key_version)
    values ($1, $2, $3)
    on conflict (account_id) do update
      set ciphertext = excluded.ciphertext,
          key_version = excluded.key_version,
          updated_at = now()
  `;
  const params = [ownership, ciphertext, keyVersion];
  if (client) await client.query(sql, params);
  else await query(sql, params);
  logger.debug({ accountId: input.accountId }, 'حُفظت جلسة تيليجرام مشفّرة');
}

export async function loadTelegramSession(input: {
  accountId: string;
  userId: string;
}): Promise<(SessionPayload & { keyVersion: number }) | null> {
  const ownerId = await runOwnershipCheck(input.accountId, input.userId, null);
  if (!ownerId) throw new TelegramSessionAccessError();

  const res = await query<StoredRow>(
    'select ciphertext, key_version from telegram_sessions where account_id = $1',
    [ownerId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const decrypted = decryptSession(ownerId, row.ciphertext);
  return {
    session: decrypted.session,
    updateState: decrypted.updateState,
    savedAt: decrypted.savedAt,
    keyVersion: decrypted.keyVersion,
  };
}

/**
 * حذف جلسة الحساب. يقبل منفّذاً (PoolClient) ليعمل داخل معاملة الفصل الذرّية.
 */
export async function deleteTelegramSession(
  accountId: string,
  userId: string,
  client: PoolClient | null = null,
): Promise<boolean> {
  const ownerId = await runOwnershipCheck(accountId, userId, client);
  if (!ownerId) throw new TelegramSessionAccessError();
  const sql = 'delete from telegram_sessions where account_id = $1';
  const res = client ? await client.query(sql, [ownerId]) : await query(sql, [ownerId]);
  return (res.rowCount ?? 0) > 0;
}

/** يتحقق من ملكية الحساب ويعيد معرّفه المعتمد من القاعدة (لا من العميل). */
async function runOwnershipCheck(
  accountId: string,
  userId: string,
  client: PoolClient | null,
): Promise<string | null> {
  const sql = 'select id from telegram_accounts where id = $1 and user_id = $2';
  const params = [accountId, userId];
  const res = client
    ? await client.query<{ id: string }>(sql, params)
    : await query<{ id: string }>(sql, params);
  return res.rows[0]?.id ?? null;
}
