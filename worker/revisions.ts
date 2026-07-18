import { eventAccess } from './authorization.js'
import { appendAuditEvent, canonical } from './audit.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, hasRecentAuthentication, requireSession, sha256Base64Url } from './security.js'

interface RevisionInput {
  reason?: string
  corrections?: {
    courseCode?: string
    targetMinutes?: number
    warningAt?: string
    note?: string
  }
}

export async function handleRevisionRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const match = pathname.match(/^\/api\/events\/([^/]+)\/races\/([^/]+)\/post-finalization-revisions$/)
  if (!match) return null
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'POST' } })
  assertSameOrigin(request)
  const session = await requireSession(request, env)
  const eventReference = decodeURIComponent(match[1])
  const raceId = decodeURIComponent(match[2])
  const access = await eventAccess(env, eventReference, session.userId, session.displayName)
  if (!access || !access.isOwner) return json({ error: '確定後修正は大会を作成した管理者だけが実行できます' }, { status: 403 })
  if (!hasRecentAuthentication(session)) {
    return json({
      code: 'RECENT_AUTHENTICATION_REQUIRED',
      error: '確定後修正の前にパスキーで本人確認してください',
    }, { status: 403 })
  }
  const body = await readJson<RevisionInput>(request, 32_768)
  const reason = body.reason?.trim()
  if (!reason || reason.length < 5 || reason.length > 500) {
    return json({ error: '修正理由を5〜500文字で入力してください' }, { status: 400 })
  }
  const input = body.corrections ?? {}
  const corrections: Record<string, unknown> = {}
  if (input.courseCode != null) {
    const value = input.courseCode.trim()
    if (!value || value.length > 80) return json({ error: 'コース記号を確認してください' }, { status: 400 })
    corrections.courseCode = value
  }
  if (input.targetMinutes != null) {
    if (!Number.isFinite(input.targetMinutes) || input.targetMinutes < 5 || input.targetMinutes > 360) {
      return json({ error: '目標時間は5〜360分で指定してください' }, { status: 400 })
    }
    corrections.targetMinutes = Math.round(input.targetMinutes)
  }
  if (input.warningAt != null) {
    const parsed = new Date(input.warningAt)
    if (Number.isNaN(parsed.getTime())) return json({ error: '予告時刻を確認してください' }, { status: 400 })
    corrections.warningAt = parsed.toISOString()
  }
  if (input.note != null) {
    const note = input.note.trim()
    if (note.length > 2_000) return json({ error: '修正メモは2000文字以内にしてください' }, { status: 400 })
    corrections.note = note
  }
  if (!Object.keys(corrections).length) return json({ error: '少なくとも1つの修正内容を入力してください' }, { status: 400 })

  const race = await env.DB.prepare(
    `SELECT id, race_number, class_name, course_code, target_minutes, warning_at,
            status, finalized_revision, finalized_at
     FROM races WHERE id = ? AND regatta_id = ? LIMIT 1`,
  ).bind(raceId, access.eventId).first<Record<string, unknown>>()
  if (!race) return json({ error: 'レースが見つかりません' }, { status: 404 })
  if (race.status !== 'finalized') return json({ error: '未確定レースは通常の編集機能を使用してください' }, { status: 409 })
  const previous = await env.DB.prepare(
    `SELECT id, revision, state_hash FROM race_finalizations
     WHERE race_id = ? ORDER BY revision DESC LIMIT 1`,
  ).bind(raceId).first<{ id: string; revision: number; state_hash: string }>()
  if (!previous) return json({ error: '元の確定版が見つかりません' }, { status: 409 })
  const revision = previous.revision + 1
  const createdAt = new Date().toISOString()
  const stateHash = await sha256Base64Url(JSON.stringify(canonical({
    baseRace: race,
    previousStateHash: previous.state_hash,
    revision,
    corrections,
    reason,
  })))
  const finalizationId = crypto.randomUUID()
  const correctionId = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO race_finalizations
       (id, race_id, revision, state_hash, reason, finalized_by, finalized_at, previous_finalization_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(finalizationId, raceId, revision, stateHash, reason, access.userId, createdAt, previous.id),
    env.DB.prepare(
      `INSERT INTO post_finalization_revisions
       (id, race_id, revision, patch_json, reason, state_hash, previous_finalization_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(correctionId, raceId, revision, JSON.stringify(corrections), reason, stateHash, previous.id, access.userId, createdAt),
    env.DB.prepare(
      `UPDATE races SET finalized_revision = ?, finalized_at = ?, finalized_by = ?, updated_at = ?
       WHERE id = ? AND regatta_id = ? AND status = 'finalized'`,
    ).bind(revision, createdAt, access.userId, createdAt, raceId, access.eventId),
  ])
  await appendAuditEvent(env, {
    access,
    raceId,
    action: 'race.post-finalization-revision',
    entityType: 'race',
    entityId: raceId,
    before: { finalizedRevision: previous.revision, stateHash: previous.state_hash },
    after: { finalizedRevision: revision, stateHash, corrections },
    reason,
  })
  return json({ revision, createdAt, stateHash, corrections, reason })
}
