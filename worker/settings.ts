import { eventAccess } from './authorization.js'
import { appendAuditEvent } from './audit.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, hasRecentAuthentication, requireSession } from './security.js'
import { previewRetentionForEvent, runRetentionForEvent } from './retention.js'

const RETENTION_KEYS = [
  'finalizedRecordsDays',
  'observationsDays',
  'sampledPositionsDays',
  'localHighFrequencyTrackDays',
  'cloudBackupDays',
  'regularMessagesDays',
  'memberProfilesDays',
  'authSecretsAfterEventDays',
  'securityLogsDays',
] as const

type RetentionKey = typeof RETENTION_KEYS[number]
type RetentionPolicy = Record<RetentionKey, number>

async function owner(request: Request, env: AppEnv, eventReference: string) {
  const session = await requireSession(request, env)
  const access = await eventAccess(env, eventReference, session.userId, session.displayName)
  if (!access || !access.isOwner) throw new Response('大会管理者のみ操作できます', { status: 403 })
  return { access, session }
}

function recentAuthenticationRequiredResponse(): Response {
  return json({
    error: 'この重要操作にはパスキーでの再認証が必要です。再認証後15分以内にもう一度実行してください',
    code: 'REAUTHENTICATION_REQUIRED',
  }, { status: 428 })
}

export async function handleSettingsRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const previewMatch = pathname.match(/^\/api\/events\/([^/]+)\/settings\/retention\/preview$/)
  if (previewMatch) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'GET' } })
    const { access } = await owner(request, env, decodeURIComponent(previewMatch[1]))
    return json({ preview: await previewRetentionForEvent(env, access.eventId) })
  }
  const holdMatch = pathname.match(/^\/api\/events\/([^/]+)\/settings\/retention\/hold$/)
  if (holdMatch) {
    if (request.method !== 'PATCH') return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'PATCH' } })
    assertSameOrigin(request)
    const { access, session } = await owner(request, env, decodeURIComponent(holdMatch[1]))
    if (!hasRecentAuthentication(session)) return recentAuthenticationRequiredResponse()
    const body = await readJson<{ active?: boolean; until?: string | null; reason?: string }>(request, 16_384)
    if (typeof body.active !== 'boolean') return json({ error: '保存ホールドの有効・無効を指定してください' }, { status: 400 })
    const reason = body.reason?.trim() ?? ''
    if (reason.length < 5 || reason.length > 500) return json({ error: '保存ホールドの理由を5〜500文字で入力してください' }, { status: 400 })
    const previous = await env.DB.prepare(
      `SELECT retention_hold_until, retention_hold_reason
       FROM regatta_settings WHERE regatta_id = ? LIMIT 1`,
    ).bind(access.eventId).first<{ retention_hold_until: string | null; retention_hold_reason: string | null }>()
    if (!previous) return json({ error: '保存期間設定が見つかりません' }, { status: 404 })
    let holdUntil: string | null = null
    if (body.active) {
      if (body.until) {
        const parsed = new Date(body.until)
        if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
          return json({ error: '保存ホールド終了日は未来の日時を指定してください' }, { status: 400 })
        }
        holdUntil = parsed.toISOString()
      } else {
        holdUntil = '9999-12-31T23:59:59.999Z'
      }
    }
    const wasActive = Boolean(previous.retention_hold_until && Date.parse(previous.retention_hold_until) > Date.now())
    const action = body.active ? wasActive ? 'extend' : 'set' : 'release'
    const updatedAt = new Date().toISOString()
    const eventId = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE regatta_settings
         SET retention_hold_until = ?, retention_hold_reason = ?, updated_at = ?
         WHERE regatta_id = ?`,
      ).bind(holdUntil, body.active ? reason : null, updatedAt, access.eventId),
      env.DB.prepare(
        `INSERT INTO retention_hold_events
         (id, regatta_id, action, hold_until, reason, actor_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(eventId, access.eventId, action, holdUntil, reason, access.userId, updatedAt),
    ])
    const next = {
      active: body.active,
      until: holdUntil,
      reason: body.active ? reason : null,
      indefinite: body.active && holdUntil?.startsWith('9999-12-31'),
      updatedAt,
    }
    await appendAuditEvent(env, {
      access,
      action: `retention.hold.${action}`,
      entityType: 'retention_hold',
      entityId: eventId,
      before: previous,
      after: next,
      reason,
    })
    return json({ hold: next })
  }
  const runMatch = pathname.match(/^\/api\/events\/([^/]+)\/settings\/retention\/run$/)
  if (runMatch) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'POST' } })
    assertSameOrigin(request)
    const { access, session } = await owner(request, env, decodeURIComponent(runMatch[1]))
    if (!hasRecentAuthentication(session)) return recentAuthenticationRequiredResponse()
    return json({ report: await runRetentionForEvent(env, access.eventId, 'manual', new Date(), access) })
  }
  const match = pathname.match(/^\/api\/events\/([^/]+)\/settings\/retention$/)
  if (!match) return null
  const { access, session } = await owner(request, env, decodeURIComponent(match[1]))
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT retention_json, retention_hold_until, retention_hold_reason, updated_at
       FROM regatta_settings WHERE regatta_id = ? LIMIT 1`,
    ).bind(access.eventId).first<{
      retention_json: string
      retention_hold_until: string | null
      retention_hold_reason: string | null
      updated_at: string
    }>()
    if (!row) return json({ error: '保存期間設定が見つかりません' }, { status: 404 })
    const latestRun = await env.DB.prepare(
      `SELECT id, trigger_type, status, counts_json, detail, started_at, completed_at
       FROM retention_runs WHERE regatta_id = ? ORDER BY started_at DESC LIMIT 1`,
    ).bind(access.eventId).first()
    const latestBackup = await env.DB.prepare(
      `SELECT created_at, data_hash, event_sequence
       FROM backup_records WHERE regatta_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(access.eventId).first()
    const holdActive = Boolean(row.retention_hold_until && Date.parse(row.retention_hold_until) > Date.now())
    return json({
      policy: JSON.parse(row.retention_json),
      updatedAt: row.updated_at,
      hold: {
        active: holdActive,
        until: row.retention_hold_until,
        reason: row.retention_hold_reason,
        indefinite: row.retention_hold_until?.startsWith('9999-12-31') ?? false,
      },
      latestRun,
      latestBackup,
    })
  }
  if (request.method === 'PATCH') {
    assertSameOrigin(request)
    const body = await readJson<{ policy?: Partial<RetentionPolicy> }>(request, 16_384)
    const current = await env.DB.prepare(
      'SELECT retention_json FROM regatta_settings WHERE regatta_id = ? LIMIT 1',
    ).bind(access.eventId).first<{ retention_json: string }>()
    if (!current) return json({ error: '保存期間設定が見つかりません' }, { status: 404 })
    const previous = JSON.parse(current.retention_json) as RetentionPolicy
    const policy = { ...previous }
    for (const key of RETENTION_KEYS) {
      const value = body.policy?.[key]
      if (value == null) continue
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 36_500) {
        return json({ error: `${key}は1〜36500日で指定してください` }, { status: 400 })
      }
      policy[key] = value
    }
    const shortenedKeys = RETENTION_KEYS.filter((key) => policy[key] < previous[key])
    if (shortenedKeys.length && !hasRecentAuthentication(session)) {
      return recentAuthenticationRequiredResponse()
    }
    const updatedAt = new Date().toISOString()
    await env.DB.prepare(
      'UPDATE regatta_settings SET retention_json = ?, updated_at = ? WHERE regatta_id = ?',
    ).bind(JSON.stringify(policy), updatedAt, access.eventId).run()
    await appendAuditEvent(env, {
      access,
      action: 'retention.update',
      entityType: 'regatta_settings',
      entityId: access.eventId,
      before: previous,
      after: policy,
      reason: shortenedKeys.length ? `保存期間を短縮: ${shortenedKeys.join(', ')}` : '保存期間を更新',
    })
    return json({ policy, updatedAt, shortenedKeys })
  }
  return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'GET, PATCH' } })
}
