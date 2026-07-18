import { eventAccess } from './authorization.js'
import { appendAuditEvent, canonical } from './audit.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, hasRecentAuthentication, requireSession, sha256Base64Url } from './security.js'
import { geodesicDistanceMetres } from '../shared/geo.js'
import { isFinalizationPhraseValid } from '../shared/finalization.js'

interface MarkPositionRevisionInput {
  markId?: string
  actual?: unknown
  recordedAt?: string
  committeeBoatId?: string
  accuracyMetres?: number
  positionSource?: 'device-geolocation' | 'handheld-gps-manual'
  coordinateEntryMode?: 'dmm-tail-4' | 'decimal-tail-4' | 'decimal-full'
  coordinateDatum?: string
  note?: string
}

interface RevisionInput {
  reason?: string
  corrections?: {
    courseCode?: string
    targetMinutes?: number
    warningAt?: string
    note?: string
    markPosition?: MarkPositionRevisionInput
  }
}

interface PreviousFinalization {
  id: string
  revision: number
  state_hash: string
}

interface RevisionDraftRow {
  id: string
  race_id: string
  base_finalization_id: string
  base_revision: number
  reason: string
  corrections_json: string
  selected_items_json: string
  status: 'draft' | 'published' | 'discarded'
  created_by: string
  created_at: string
  updated_at: string
}

function fail(error: string, status = 400, code?: string): never {
  throw json(code ? { error, code } : { error }, { status })
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${label}を確認してください`)
  }
  return value
}

function coordinatePair(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) fail('マーク位置の緯度経度を確認してください')
  return [
    finiteNumber(value[0], '経度', -180, 180),
    finiteNumber(value[1], '緯度', -85, 85),
  ]
}

async function normalizedMarkPositionCorrection(
  env: AppEnv,
  access: NonNullable<Awaited<ReturnType<typeof eventAccess>>>,
  raceId: string,
  input: MarkPositionRevisionInput,
  createdAt: string,
  publication?: { revisionId: string; baseFinalizationId: string },
): Promise<{ patch: Record<string, unknown>; statement?: D1PreparedStatement }> {
  const markId = input.markId?.trim()
  if (!markId || markId.length > 120) fail('訂正対象のマークを確認してください')
  const mark = await env.DB.prepare(
    `SELECT mark.id, mark.label, node.target_lng, node.target_lat
     FROM marks mark
     JOIN course_nodes node ON node.mark_id = mark.id
     JOIN course_revisions revision ON revision.id = node.course_revision_id
     WHERE mark.id = ? AND mark.regatta_id = ? AND revision.race_id = ?
       AND revision.revision = (
         SELECT MAX(latest.revision) FROM course_revisions latest WHERE latest.race_id = revision.race_id
       )
     LIMIT 1`,
  ).bind(markId, access.eventId, raceId).first<{
    id: string
    label: string
    target_lng: number
    target_lat: number
  }>()
  if (!mark) fail('対象マークは現在のコースに含まれていません', 404)

  const actual = coordinatePair(input.actual)
  const accuracyMetres = input.accuracyMetres == null
    ? null
    : finiteNumber(input.accuracyMetres, 'GPS表示精度', 0, 10_000)
  const positionSource = input.positionSource === 'handheld-gps-manual'
    ? 'handheld-gps-manual'
    : 'device-geolocation'
  const coordinateEntryMode = positionSource === 'handheld-gps-manual'
    ? input.coordinateEntryMode
    : null
  if (positionSource === 'handheld-gps-manual' && !coordinateEntryMode) {
    fail('ハンディGPSの座標入力方式を確認してください')
  }
  const coordinateDatum = (input.coordinateDatum ?? 'WGS84').replaceAll(' ', '').toUpperCase()
  if (coordinateDatum !== 'WGS84') fail('WGS 84の座標だけを保存できます')
  const note = input.note?.trim() || null
  if (note && note.length > 120) fail('マーク位置メモは120文字以内にしてください')
  const recordedAtDate = new Date(input.recordedAt ?? createdAt)
  if (Number.isNaN(recordedAtDate.getTime())) fail('マーク位置の記録時刻を確認してください')
  const recordedAt = recordedAtDate.toISOString()
  const committeeBoatId = input.committeeBoatId?.trim() || null
  if (committeeBoatId) {
    const boat = await env.DB.prepare(
      `SELECT id FROM committee_boats
       WHERE id = ? AND regatta_id = ? AND status = 'active' LIMIT 1`,
    ).bind(committeeBoatId, access.eventId).first<{ id: string }>()
    if (!boat) fail('運営ボートが見つかりません', 404)
  }
  const targetDifferenceMetres = Math.round(geodesicDistanceMetres(
    [mark.target_lng, mark.target_lat],
    actual,
  ) * 100) / 100
  const patch: Record<string, unknown> = {
    markId,
    label: mark.label,
    actual,
    // Publishing this correction is itself an explicit owner confirmation.
    // Keep the physical audit event as `moved`, while the materialized mark
    // state remains confirmed and does not become an impossible locked task.
    status: 'confirmed',
    recordedAt,
    committeeBoatId,
    accuracyMetres,
    positionSource,
    coordinateEntryMode,
    coordinateDatum,
    note,
    targetDifferenceMetres,
  }
  if (!publication) return { patch }

  const member = await env.DB.prepare(
    `SELECT id FROM event_members
     WHERE id = ? AND regatta_id = ? AND status = 'active' LIMIT 1`,
  ).bind(access.memberId, access.eventId).first<{ id: string }>()
  if (!member) fail('有効な大会メンバー情報が見つかりません', 403)
  const nextSequence = await env.DB.prepare(
    'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM mark_events WHERE race_id = ?',
  ).bind(raceId).first<{ sequence: number }>()
  const eventId = crypto.randomUUID()
  patch.eventId = eventId
  return {
    patch,
    statement: env.DB.prepare(
      `INSERT INTO mark_events
       (id, race_id, mark_id, event_type, lng, lat, accuracy_metres, member_id,
        committee_boat_id, client_time, server_time, sequence, payload_json)
       VALUES (?, ?, ?, 'moved', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      eventId,
      raceId,
      markId,
      actual[0],
      actual[1],
      accuracyMetres,
      member.id,
      committeeBoatId,
      recordedAt,
      createdAt,
      nextSequence?.sequence ?? 1,
      JSON.stringify({
        source: positionSource,
        coordinateEntryMode,
        coordinateDatum,
        note,
        originalStatus: 'moved',
        targetDifferenceMetres,
        postFinalizationRevisionId: publication.revisionId,
        baseFinalizationId: publication.baseFinalizationId,
      }),
    ),
  }
}

function normalizeScalarCorrections(input: NonNullable<RevisionInput['corrections']>): Record<string, unknown> {
  const corrections: Record<string, unknown> = {}
  if (input.courseCode != null) {
    const value = input.courseCode.trim()
    if (!value || value.length > 80) fail('コース記号を確認してください')
    corrections.courseCode = value
  }
  if (input.targetMinutes != null) {
    if (!Number.isFinite(input.targetMinutes) || input.targetMinutes < 5 || input.targetMinutes > 360) {
      fail('目標時間は5〜360分で指定してください')
    }
    corrections.targetMinutes = Math.round(input.targetMinutes)
  }
  if (input.warningAt != null) {
    const parsed = new Date(input.warningAt)
    if (Number.isNaN(parsed.getTime())) fail('予告時刻を確認してください')
    corrections.warningAt = parsed.toISOString()
  }
  if (input.note != null) {
    const note = input.note.trim()
    if (note.length > 2_000) fail('修正メモは2000文字以内にしてください')
    corrections.note = note
  }
  return corrections
}

async function loadFinalizedRace(
  env: AppEnv,
  eventId: string,
  raceId: string,
): Promise<Record<string, unknown>> {
  const race = await env.DB.prepare(
    `SELECT id, race_number, class_name, course_code, target_minutes, warning_at,
            status, finalized_revision, finalized_at
     FROM races WHERE id = ? AND regatta_id = ? LIMIT 1`,
  ).bind(raceId, eventId).first<Record<string, unknown>>()
  if (!race) fail('レースが見つかりません', 404)
  if (race.status !== 'finalized') fail('未確定レースは通常の編集機能を使用してください', 409)
  return race
}

async function loadLatestFinalization(env: AppEnv, raceId: string): Promise<PreviousFinalization> {
  const previous = await env.DB.prepare(
    `SELECT id, revision, state_hash FROM race_finalizations
     WHERE race_id = ? ORDER BY revision DESC LIMIT 1`,
  ).bind(raceId).first<PreviousFinalization>()
  if (!previous) fail('元の確定版が見つかりません', 409)
  return previous
}

async function createRevisionDraft(
  request: Request,
  env: AppEnv,
  access: NonNullable<Awaited<ReturnType<typeof eventAccess>>>,
  raceId: string,
): Promise<Response> {
  const body = await readJson<RevisionInput>(request, 32_768)
  const reason = body.reason?.trim()
  if (!reason || reason.length < 5 || reason.length > 500) fail('修正理由を5〜500文字で入力してください')
  await loadFinalizedRace(env, access.eventId, raceId)
  const previous = await loadLatestFinalization(env, raceId)
  const existing = await env.DB.prepare(
    `SELECT id FROM post_finalization_revision_drafts
     WHERE race_id = ? AND status = 'draft' LIMIT 1`,
  ).bind(raceId).first<{ id: string }>()
  if (existing) fail('このレースには管理者修正中の下書きがあります', 409, 'ACTIVE_REVISION_DRAFT_EXISTS')

  const draftId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const input = body.corrections ?? {}
  const corrections = normalizeScalarCorrections(input)
  if (input.markPosition) {
    const normalized = await normalizedMarkPositionCorrection(
      env,
      access,
      raceId,
      input.markPosition,
      createdAt,
    )
    corrections.markPosition = normalized.patch
  }
  const selectedItems = Object.keys(corrections)
  if (!selectedItems.length) fail('少なくとも1つの修正内容を入力してください')
  await env.DB.prepare(
    `INSERT INTO post_finalization_revision_drafts
     (id, race_id, base_finalization_id, base_revision, reason, corrections_json,
      selected_items_json, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
  ).bind(
    draftId,
    raceId,
    previous.id,
    previous.revision,
    reason,
    JSON.stringify(corrections),
    JSON.stringify(selectedItems),
    access.userId,
    createdAt,
    createdAt,
  ).run()
  await appendAuditEvent(env, {
    access,
    raceId,
    action: 'race.post-finalization-revision.draft.create',
    entityType: 'post_finalization_revision_draft',
    entityId: draftId,
    after: { baseRevision: previous.revision, corrections, selectedItems, status: 'draft' },
    reason,
  })
  return json({
    draft: {
      id: draftId,
      raceId,
      baseRevision: previous.revision,
      reason,
      corrections,
      selectedItems,
      status: 'draft',
      createdAt,
      updatedAt: createdAt,
    },
  }, { status: 201 })
}

async function publishRevisionDraft(
  request: Request,
  env: AppEnv,
  access: NonNullable<Awaited<ReturnType<typeof eventAccess>>>,
  raceId: string,
  draftId: string,
): Promise<Response> {
  const body = await readJson<{ confirmationPhrase?: string }>(request, 8_192)
  const race = await loadFinalizedRace(env, access.eventId, raceId)
  if (!isFinalizationPhraseValid(String(race.race_number), body.confirmationPhrase ?? '')) {
    fail(`${String(race.race_number)}を確定 と入力して再確定してください`, 400, 'FINALIZATION_PHRASE_MISMATCH')
  }
  const draft = await env.DB.prepare(
    `SELECT id, race_id, base_finalization_id, base_revision, reason, corrections_json,
            selected_items_json, status, created_by, created_at, updated_at
     FROM post_finalization_revision_drafts
     WHERE id = ? AND race_id = ? AND status = 'draft' LIMIT 1`,
  ).bind(draftId, raceId).first<RevisionDraftRow>()
  if (!draft) fail('管理者修正版の下書きが見つかりません', 404)
  if (draft.created_by !== access.userId) fail('この下書きを再確定できません', 403)
  const previous = await loadLatestFinalization(env, raceId)
  if (previous.id !== draft.base_finalization_id || previous.revision !== draft.base_revision) {
    fail('元の確定版が更新されています。下書きを破棄して作り直してください', 409, 'REVISION_BASE_CHANGED')
  }
  let draftCorrections: NonNullable<RevisionInput['corrections']>
  try {
    draftCorrections = JSON.parse(draft.corrections_json) as NonNullable<RevisionInput['corrections']>
  } catch {
    fail('管理者修正版の下書きが壊れています', 409)
  }
  const corrections = normalizeScalarCorrections(draftCorrections)
  const revision = previous.revision + 1
  const createdAt = new Date().toISOString()
  const finalizationId = crypto.randomUUID()
  const correctionId = crypto.randomUUID()
  const statements: D1PreparedStatement[] = []
  if (draftCorrections.markPosition) {
    const normalized = await normalizedMarkPositionCorrection(
      env,
      access,
      raceId,
      draftCorrections.markPosition,
      createdAt,
      { revisionId: correctionId, baseFinalizationId: previous.id },
    )
    corrections.markPosition = normalized.patch
    if (!normalized.statement) fail('マーク位置の確定イベントを作成できません', 500)
    statements.push(normalized.statement)
  }
  const snapshot = canonical({
    schemaVersion: 2,
    type: 'post-finalization-revision',
    capturedAt: createdAt,
    raceId,
    revision,
    draftId,
    baseFinalization: {
      id: previous.id,
      revision: previous.revision,
      stateHash: previous.state_hash,
    },
    corrections,
    reason: draft.reason,
    createdBy: access.userId,
  })
  const snapshotJson = JSON.stringify(snapshot)
  const stateHash = await sha256Base64Url(snapshotJson)
  statements.unshift(
    env.DB.prepare(
      `INSERT INTO race_finalizations
       (id, race_id, revision, state_hash, reason, finalized_by, finalized_at,
        previous_finalization_id, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(finalizationId, raceId, revision, stateHash, draft.reason, access.userId, createdAt, previous.id, snapshotJson),
    env.DB.prepare(
      `INSERT INTO post_finalization_revisions
       (id, race_id, revision, patch_json, reason, state_hash, previous_finalization_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(correctionId, raceId, revision, JSON.stringify(corrections), draft.reason, stateHash, previous.id, access.userId, createdAt),
    env.DB.prepare(
      `UPDATE races SET finalized_revision = ?, finalized_at = ?, finalized_by = ?, updated_at = ?
       WHERE id = ? AND regatta_id = ? AND status = 'finalized'`,
    ).bind(revision, createdAt, access.userId, createdAt, raceId, access.eventId),
    env.DB.prepare(
      `UPDATE post_finalization_revision_drafts
       SET status = 'published', published_finalization_id = ?, published_at = ?, updated_at = ?
       WHERE id = ? AND race_id = ? AND status = 'draft'`,
    ).bind(finalizationId, createdAt, createdAt, draftId, raceId),
  )
  await env.DB.batch(statements)
  await appendAuditEvent(env, {
    access,
    raceId,
    action: 'race.post-finalization-revision',
    entityType: 'race',
    entityId: raceId,
    before: { finalizedRevision: previous.revision, stateHash: previous.state_hash, draftId },
    after: { finalizedRevision: revision, stateHash, corrections, draftId },
    reason: draft.reason,
  })
  return json({ revision, createdAt, stateHash, corrections, reason: draft.reason, draftId })
}

async function discardRevisionDraft(
  env: AppEnv,
  access: NonNullable<Awaited<ReturnType<typeof eventAccess>>>,
  raceId: string,
  draftId: string,
): Promise<Response> {
  const draft = await env.DB.prepare(
    `SELECT id, reason, base_revision, created_by FROM post_finalization_revision_drafts
     WHERE id = ? AND race_id = ? AND status = 'draft' LIMIT 1`,
  ).bind(draftId, raceId).first<{ id: string; reason: string; base_revision: number; created_by: string }>()
  if (!draft) fail('管理者修正版の下書きが見つかりません', 404)
  if (draft.created_by !== access.userId) fail('この下書きを破棄できません', 403)
  const discardedAt = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE post_finalization_revision_drafts
     SET status = 'discarded', updated_at = ? WHERE id = ? AND race_id = ? AND status = 'draft'`,
  ).bind(discardedAt, draftId, raceId).run()
  await appendAuditEvent(env, {
    access,
    raceId,
    action: 'race.post-finalization-revision.draft.discard',
    entityType: 'post_finalization_revision_draft',
    entityId: draftId,
    before: { status: 'draft', baseRevision: draft.base_revision },
    after: { status: 'discarded', discardedAt },
    reason: draft.reason,
  })
  return json({ id: draftId, status: 'discarded', discardedAt })
}

export async function handleRevisionRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const draftsMatch = pathname.match(/^\/api\/events\/([^/]+)\/races\/([^/]+)\/post-finalization-revisions\/drafts$/)
  const draftMatch = pathname.match(/^\/api\/events\/([^/]+)\/races\/([^/]+)\/post-finalization-revisions\/drafts\/([^/]+)$/)
  const publishMatch = pathname.match(/^\/api\/events\/([^/]+)\/races\/([^/]+)\/post-finalization-revisions\/drafts\/([^/]+)\/publish$/)
  const match = publishMatch ?? draftMatch ?? draftsMatch
  if (!match) return null
  const allowedMethod = draftsMatch ? 'POST' : publishMatch ? 'POST' : 'DELETE'
  if (request.method !== allowedMethod) {
    return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: allowedMethod } })
  }
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
  if (draftsMatch) return createRevisionDraft(request, env, access, raceId)
  const draftId = decodeURIComponent(match[3])
  if (publishMatch) return publishRevisionDraft(request, env, access, raceId, draftId)
  return discardRevisionDraft(env, access, raceId, draftId)
}
