import { eventAccess } from './authorization.js'
import { appendAuditEvent } from './audit.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, requireSession } from './security.js'

const RETENTION_KEYS = [
  'finalizedRecordsDays',
  'observationsDays',
  'sampledPositionsDays',
  'localHighFrequencyTrackDays',
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
  return access
}

export async function handleSettingsRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const match = pathname.match(/^\/api\/events\/([^/]+)\/settings\/retention$/)
  if (!match) return null
  const access = await owner(request, env, decodeURIComponent(match[1]))
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT retention_json, updated_at FROM regatta_settings WHERE regatta_id = ? LIMIT 1',
    ).bind(access.eventId).first<{ retention_json: string; updated_at: string }>()
    if (!row) return json({ error: '保存期間設定が見つかりません' }, { status: 404 })
    return json({ policy: JSON.parse(row.retention_json), updatedAt: row.updated_at })
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
    })
    return json({ policy, updatedAt })
  }
  return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'GET, PATCH' } })
}
