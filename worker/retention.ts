import type { AppEnv } from './index.js'
import { sha256Base64Url } from './security.js'

interface RetentionPolicy {
  finalizedRecordsDays: number
  observationsDays: number
  sampledPositionsDays: number
  localHighFrequencyTrackDays: number
  regularMessagesDays: number
  memberProfilesDays: number
  authSecretsAfterEventDays: number
  securityLogsDays: number
}

interface EventRetentionRow {
  id: string
  ends_on: string
  retention_json: string
  retention_hold_until: string | null
  retention_hold_reason: string | null
}

export interface RetentionReport {
  runId: string
  eventId: string
  status: 'completed' | 'skipped' | 'failed'
  counts: Record<string, number>
  detail: string
  startedAt: string
  completedAt: string
}

const DAY = 86_400_000
const MESSAGE_TOMBSTONE = '[保存期間経過により本文を削除]'

function eventEnd(value: string): number {
  const parsed = Date.parse(`${value}T23:59:59.999Z`)
  if (!Number.isFinite(parsed)) throw new Error('Invalid event end date')
  return parsed
}

function hasExpired(end: number, days: number, now: number): boolean {
  return now >= end + days * DAY
}

function changes(result: D1Result): number {
  return result.meta.changes ?? 0
}

async function eventRow(env: AppEnv, eventId: string): Promise<EventRetentionRow | null> {
  return env.DB.prepare(
    `SELECT regatta.id, regatta.ends_on, settings.retention_json,
            settings.retention_hold_until, settings.retention_hold_reason
     FROM regattas regatta
     JOIN regatta_settings settings ON settings.regatta_id = regatta.id
     WHERE regatta.id = ? LIMIT 1`,
  ).bind(eventId).first<EventRetentionRow>()
}

async function tombstoneMessages(env: AppEnv, eventId: string, deletedAt: string): Promise<number> {
  const candidates = await env.DB.prepare(
    `SELECT id, body FROM messages
     WHERE regatta_id = ? AND priority = 'normal' AND deleted_at IS NULL
     ORDER BY sent_at LIMIT 500`,
  ).bind(eventId).all<{ id: string; body: string }>()
  if (!candidates.results.length) return 0
  const statements: D1PreparedStatement[] = []
  for (const message of candidates.results) {
    const bodyHash = await sha256Base64Url(message.body)
    statements.push(
      env.DB.prepare(
        `UPDATE messages SET body = ?, body_hash = ?, deleted_at = ?
         WHERE id = ? AND regatta_id = ? AND deleted_at IS NULL`,
      ).bind(MESSAGE_TOMBSTONE, bodyHash, deletedAt, message.id, eventId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO retention_tombstones
         (id, regatta_id, entity_type, entity_id, content_hash, policy_key, deleted_at)
         VALUES (?, ?, 'message', ?, ?, 'regularMessagesDays', ?)`,
      ).bind(crypto.randomUUID(), eventId, message.id, bodyHash, deletedAt),
    )
  }
  await env.DB.batch(statements)
  return candidates.results.length
}

export async function runRetentionForEvent(
  env: AppEnv,
  eventId: string,
  triggerType: 'cron' | 'manual',
  now = new Date(),
): Promise<RetentionReport> {
  const row = await eventRow(env, eventId)
  if (!row) throw new Error('Retention event not found')
  const runId = crypto.randomUUID()
  const startedAt = now.toISOString()
  await env.DB.prepare(
    `INSERT INTO retention_runs (id, regatta_id, trigger_type, status, started_at)
     VALUES (?, ?, ?, 'running', ?)`,
  ).bind(runId, eventId, triggerType, startedAt).run()

  const finish = async (
    status: RetentionReport['status'],
    counts: Record<string, number>,
    detail: string,
  ): Promise<RetentionReport> => {
    const completedAt = new Date().toISOString()
    await env.DB.prepare(
      `UPDATE retention_runs SET status = ?, counts_json = ?, detail = ?, completed_at = ? WHERE id = ?`,
    ).bind(status, JSON.stringify(counts), detail, completedAt, runId).run()
    return { runId, eventId, status, counts, detail, startedAt, completedAt }
  }

  try {
    const nowTime = now.getTime()
    const end = eventEnd(row.ends_on)
    if (nowTime <= end) return finish('skipped', {}, '大会終了前のため自動削除しません')
    if (row.retention_hold_until && Date.parse(row.retention_hold_until) > nowTime) {
      return finish('skipped', {}, `保存ホールド中：${row.retention_hold_reason ?? '理由未記入'}`)
    }
    const policy = JSON.parse(row.retention_json) as RetentionPolicy
    const counts: Record<string, number> = {}

    if (hasExpired(end, policy.sampledPositionsDays, nowTime)) {
      counts.positionSamples = changes(await env.DB.prepare(
        'DELETE FROM position_samples WHERE regatta_id = ?',
      ).bind(eventId).run())
    }
    if (hasExpired(end, policy.observationsDays, nowTime)) {
      counts.windObservations = changes(await env.DB.prepare(
        'DELETE FROM wind_observations WHERE regatta_id = ?',
      ).bind(eventId).run())
    }
    if (hasExpired(end, policy.regularMessagesDays, nowTime)) {
      counts.messageBodies = await tombstoneMessages(env, eventId, startedAt)
    }
    if (hasExpired(end, policy.authSecretsAfterEventDays, nowTime)) {
      counts.recoveryCredentials = changes(await env.DB.prepare(
        `DELETE FROM member_recovery_credentials
         WHERE event_member_id IN (SELECT id FROM event_members WHERE regatta_id = ?)`,
      ).bind(eventId).run())
      counts.inviteSecrets = changes(await env.DB.prepare(
        `UPDATE invites SET token_hash = 'purged:' || id, revoked_at = COALESCE(revoked_at, ?)
         WHERE regatta_id = ? AND token_hash NOT LIKE 'purged:%'`,
      ).bind(startedAt, eventId).run())
    }
    if (hasExpired(end, policy.memberProfilesDays, nowTime)) {
      counts.memberProfiles = changes(await env.DB.prepare(
        `UPDATE event_members
         SET user_id = NULL,
             display_name = '匿名メンバー-' || substr(id, 1, 8),
             assignment = '保持期間終了', recovery_hash = NULL
         WHERE regatta_id = ? AND role <> 'owner' AND display_name NOT LIKE '匿名メンバー-%'`,
      ).bind(eventId).run())
    }
    if (hasExpired(end, policy.securityLogsDays, nowTime)) {
      counts.securityNetworkHashes = changes(await env.DB.prepare(
        'UPDATE recovery_attempts SET network_hash = NULL WHERE regatta_id = ? AND network_hash IS NOT NULL',
      ).bind(eventId).run())
    }

    return finish('completed', counts, '大会終了日と保存期間ポリシーに基づく日次処理を完了しました')
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown retention error'
    await finish('failed', {}, detail)
    throw error
  }
}

export async function runDailyRetention(env: AppEnv): Promise<void> {
  const events = await env.DB.prepare('SELECT id FROM regattas WHERE ends_on < date(?) ORDER BY ends_on LIMIT 100')
    .bind(new Date().toISOString()).all<{ id: string }>()
  for (const event of events.results) {
    try {
      await runRetentionForEvent(env, event.id, 'cron')
    } catch (error) {
      console.error('Retention run failed', event.id, error)
    }
  }
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').bind(now, new Date(Date.now() - 30 * DAY).toISOString()),
  ])
}
