import { eventAccess } from './authorization.js'
import { appendAuditEvent, canonical } from './audit.js'
import { buildGateConfiguration } from '../shared/gates.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, hasRecentAuthentication, requireSession, sha256Base64Url } from './security.js'

interface CourseNodeInput {
  markId?: string
  label?: string
  nodeType?: 'single' | 'gate' | 'start' | 'offset'
  rounding?: string
  target?: [number, number]
}

interface CourseRevisionInput {
  courseCode?: string
  windDirection?: number
  windSpeed?: number
  targetLengthMetres?: number
  lowerGate?: boolean
  upperGate?: boolean
  secondGate?: boolean
  nodes?: CourseNodeInput[]
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

export async function rollbackCourseRevision(
  env: AppEnv,
  access: NonNullable<Awaited<ReturnType<typeof eventAccess>>>,
  raceId: string,
  sourceRevision: number,
  finalized = false,
): Promise<Response> {
  const source = await env.DB.prepare(
    `SELECT id, revision, course_code, wind_direction, wind_speed, target_length_metres, gate_config_json
     FROM course_revisions WHERE race_id = ? AND revision = ? LIMIT 1`,
  ).bind(raceId, sourceRevision).first<{
    id: string; revision: number; course_code: string; wind_direction: number | null
    wind_speed: number | null; target_length_metres: number | null; gate_config_json: string
  }>()
  if (!source) return json({ error: '復元元のコース版が見つかりません' }, { status: 404 })
  const nodes = (await env.DB.prepare(
    `SELECT mark_id, node_order, label, node_type, rounding, target_lng, target_lat
     FROM course_nodes WHERE course_revision_id = ? ORDER BY node_order`,
  ).bind(source.id).all<{
    mark_id: string; node_order: number; label: string; node_type: string; rounding: string | null
    target_lng: number; target_lat: number
  }>()).results
  if (nodes.length < 3) return json({ error: '復元元のコース点が不足しています' }, { status: 409 })
  const previous = await env.DB.prepare(
    'SELECT COALESCE(MAX(revision), 0) AS revision FROM course_revisions WHERE race_id = ?',
  ).bind(raceId).first<{ revision: number }>()
  const revision = (previous?.revision ?? 0) + 1
  const revisionId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const rollbackReason = `コース第${source.revision}版を新しい第${revision}版として復元`
  let finalization: {
    id: string
    correctionId: string
    revision: number
    stateHash: string
    previousId: string
    previousRevision: number
    previousStateHash: string
    corrections: Record<string, unknown>
  } | undefined
  if (finalized) {
    const [race, previousFinalization] = await Promise.all([
      env.DB.prepare(
        `SELECT id, race_number, class_name, course_code, target_minutes, warning_at,
                status, finalized_revision, finalized_at
         FROM races WHERE id = ? AND regatta_id = ? LIMIT 1`,
      ).bind(raceId, access.eventId).first<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT id, revision, state_hash FROM race_finalizations
         WHERE race_id = ? ORDER BY revision DESC LIMIT 1`,
      ).bind(raceId).first<{ id: string; revision: number; state_hash: string }>(),
    ])
    if (!race || race.status !== 'finalized' || !previousFinalization) {
      return json({ error: '元の確定版が見つかりません' }, { status: 409 })
    }
    const finalizationRevision = previousFinalization.revision + 1
    const corrections = {
      courseCode: source.course_code,
      courseRevisionId: revisionId,
      courseRevision: revision,
      sourceCourseRevision: source.revision,
    }
    const stateHash = await sha256Base64Url(JSON.stringify(canonical({
      baseRace: race,
      previousStateHash: previousFinalization.state_hash,
      revision: finalizationRevision,
      corrections,
      reason: rollbackReason,
    })))
    finalization = {
      id: crypto.randomUUID(),
      correctionId: crypto.randomUUID(),
      revision: finalizationRevision,
      stateHash,
      previousId: previousFinalization.id,
      previousRevision: previousFinalization.revision,
      previousStateHash: previousFinalization.state_hash,
      corrections,
    }
  }
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE course_revisions SET status = 'superseded'
       WHERE race_id = ? AND revision = ? AND status <> 'finalized'`,
    ).bind(raceId, previous?.revision ?? 0),
    env.DB.prepare(
      `INSERT INTO course_revisions
       (id, race_id, revision, course_code, wind_direction, wind_speed, target_length_metres,
        gate_config_json, status, based_on_revision, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).bind(
      revisionId, raceId, revision, source.course_code, source.wind_direction, source.wind_speed,
      source.target_length_metres, source.gate_config_json, source.revision, access.userId, createdAt,
    ),
    env.DB.prepare(
      'UPDATE races SET course_code = ?, updated_at = ? WHERE id = ? AND regatta_id = ?',
    ).bind(source.course_code, createdAt, raceId, access.eventId),
  ]
  nodes.forEach((node) => statements.push(env.DB.prepare(
    `INSERT INTO course_nodes
     (id, course_revision_id, mark_id, node_order, label, node_type, rounding, target_lng, target_lat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), revisionId, node.mark_id, node.node_order, node.label,
    node.node_type, node.rounding, node.target_lng, node.target_lat,
  )))
  if (finalization) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO race_finalizations
         (id, race_id, revision, state_hash, reason, finalized_by, finalized_at, previous_finalization_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        finalization.id, raceId, finalization.revision, finalization.stateHash,
        rollbackReason, access.userId, createdAt, finalization.previousId,
      ),
      env.DB.prepare(
        `INSERT INTO post_finalization_revisions
         (id, race_id, revision, patch_json, reason, state_hash, previous_finalization_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        finalization.correctionId, raceId, finalization.revision, JSON.stringify(finalization.corrections),
        rollbackReason, finalization.stateHash, finalization.previousId, access.userId, createdAt,
      ),
      env.DB.prepare(
        `UPDATE races SET finalized_revision = ?, finalized_at = ?, finalized_by = ?, updated_at = ?
         WHERE id = ? AND regatta_id = ? AND status = 'finalized'`,
      ).bind(finalization.revision, createdAt, access.userId, createdAt, raceId, access.eventId),
    )
  }
  await env.DB.batch(statements)
  await appendAuditEvent(env, {
    access,
    raceId,
    action: finalization ? 'race.post-finalization-revision' : 'course.revision.rollback',
    entityType: finalization ? 'race' : 'course_revision',
    entityId: finalization ? raceId : revisionId,
    before: finalization
      ? { finalizedRevision: finalization.previousRevision, stateHash: finalization.previousStateHash, courseRevision: previous?.revision ?? 0 }
      : { revision: previous?.revision ?? 0 },
    after: {
      revision,
      sourceRevision: source.revision,
      courseCode: source.course_code,
      nodeCount: nodes.length,
      finalizedRevision: finalization?.revision,
      stateHash: finalization?.stateHash,
    },
    reason: rollbackReason,
  })
  return json({
    revisionId,
    revision,
    sourceRevision: source.revision,
    courseCode: source.course_code,
    createdAt,
    finalizedRevision: finalization?.revision,
    stateHash: finalization?.stateHash,
  })
}

export async function handleCourseRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const collectionMatch = pathname.match(/^\/api\/events\/([^/]+)\/races\/([^/]+)\/course-revisions$/)
  const rollbackMatch = pathname.match(/^\/api\/events\/([^/]+)\/races\/([^/]+)\/course-revisions\/(\d+)\/rollback$/)
  const match = rollbackMatch ?? collectionMatch
  if (!match) return null
  if (rollbackMatch && request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'POST' } })
  if (collectionMatch && !['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'GET, POST' } })
  assertSameOrigin(request)
  const session = await requireSession(request, env)
  const eventReference = decodeURIComponent(match[1])
  const raceId = decodeURIComponent(match[2])
  const access = await eventAccess(env, eventReference, session.userId, session.displayName)
  if (!access || (!access.isOwner && !['pro', 'ro', 'course-setter'].includes(access.role))) {
    return json({ error: 'コース案を作成する権限がありません' }, { status: 403 })
  }
  const race = await env.DB.prepare(
    'SELECT status, race_area_id FROM races WHERE id = ? AND regatta_id = ? LIMIT 1',
  ).bind(raceId, access.eventId).first<{ status: string; race_area_id: string }>()
  if (!race) return json({ error: 'レースが見つかりません' }, { status: 404 })
  if (collectionMatch && request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT revision.id, revision.revision, revision.course_code, revision.wind_direction,
              revision.wind_speed, revision.target_length_metres, revision.gate_config_json,
              revision.status, revision.based_on_revision, revision.created_at,
              user.display_name AS created_by,
              (SELECT COUNT(*) FROM course_nodes node WHERE node.course_revision_id = revision.id) AS node_count
       FROM course_revisions revision
       LEFT JOIN users user ON user.id = revision.created_by
       WHERE revision.race_id = ? ORDER BY revision.revision DESC LIMIT 100`,
    ).bind(raceId).all()
    return json({ revisions: rows.results })
  }
  if (race.status === 'finalized' && !access.isOwner) {
    return json({ error: '確定済みレースを変更できるのは大会管理者だけです' }, { status: 403 })
  }
  if (race.status === 'finalized' && collectionMatch && request.method === 'POST') {
    return json({ error: '確定済みレースは管理者修正版または履歴からの復元を使用してください' }, { status: 409 })
  }
  if (race.status === 'finalized' && !hasRecentAuthentication(session)) {
    return json({
      code: 'RECENT_AUTHENTICATION_REQUIRED',
      error: '確定後のコース修正前にパスキーで本人確認してください',
    }, { status: 403 })
  }
  if (rollbackMatch) return rollbackCourseRevision(
    env,
    access,
    raceId,
    Number(rollbackMatch[3]),
    race.status === 'finalized',
  )
  const body = await readJson<CourseRevisionInput>(request, 128 * 1_024)
  const courseCode = body.courseCode?.trim()
  if (!courseCode || courseCode.length > 80) return json({ error: 'コース記号を確認してください' }, { status: 400 })
  if (!finite(body.windDirection, 0, 360)) return json({ error: '風向は0〜360度で指定してください' }, { status: 400 })
  if (!finite(body.windSpeed, 0, 100)) return json({ error: '風速を確認してください' }, { status: 400 })
  if (!finite(body.targetLengthMetres, 100, 100_000)) return json({ error: 'コース長を確認してください' }, { status: 400 })
  if (!Array.isArray(body.nodes) || body.nodes.length < 3 || body.nodes.length > 30) {
    return json({ error: 'コース点は3〜30個で指定してください' }, { status: 400 })
  }
  const availableMarks = new Set((await env.DB.prepare(
    'SELECT id FROM marks WHERE regatta_id = ? AND race_area_id = ?',
  ).bind(access.eventId, race.race_area_id).all<{ id: string }>()).results.map((mark) => mark.id))
  const nodes: Array<{
    markId: string; label: string; nodeType: string; rounding: string | null; target: [number, number]
  }> = []
  for (const node of body.nodes) {
    if (!node.markId || !availableMarks.has(node.markId)) return json({ error: '大会外のマークが含まれています' }, { status: 400 })
    if (!node.label?.trim() || node.label.length > 100) return json({ error: 'マーク名を確認してください' }, { status: 400 })
    if (!node.nodeType || !['single', 'gate', 'start', 'offset'].includes(node.nodeType)) return json({ error: 'コース点種別を確認してください' }, { status: 400 })
    if (!Array.isArray(node.target) || !finite(node.target[0], -180, 180) || !finite(node.target[1], -85, 85)) {
      return json({ error: 'コース点座標を確認してください' }, { status: 400 })
    }
    nodes.push({ markId: node.markId, label: node.label.trim(), nodeType: node.nodeType, rounding: node.rounding?.slice(0, 20) ?? null, target: node.target })
  }
  let gateConfiguration: ReturnType<typeof buildGateConfiguration>
  try {
    gateConfiguration = buildGateConfiguration({
      lower: body.lowerGate === true,
      upper: body.upperGate === true,
      second: body.secondGate === true,
    }, nodes)
  } catch (reason) {
    return json({ error: reason instanceof Error ? reason.message : 'ゲート構成を確認してください' }, { status: 400 })
  }
  const previous = await env.DB.prepare(
    'SELECT COALESCE(MAX(revision), 0) AS revision FROM course_revisions WHERE race_id = ?',
  ).bind(raceId).first<{ revision: number }>()
  const revision = (previous?.revision ?? 0) + 1
  const revisionId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE course_revisions SET status = 'superseded'
       WHERE race_id = ? AND revision = ? AND status <> 'finalized'`,
    ).bind(raceId, previous?.revision ?? 0),
    env.DB.prepare(
      `INSERT INTO course_revisions
     (id, race_id, revision, course_code, wind_direction, wind_speed, target_length_metres,
      gate_config_json, status, based_on_revision, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).bind(
      revisionId,
      raceId,
      revision,
      courseCode,
      body.windDirection,
      body.windSpeed,
      body.targetLengthMetres,
      JSON.stringify(gateConfiguration),
      previous?.revision || null,
      access.userId,
      createdAt,
    ),
    env.DB.prepare(
      'UPDATE races SET course_code = ?, updated_at = ? WHERE id = ? AND regatta_id = ?',
    ).bind(courseCode, createdAt, raceId, access.eventId),
  ]
  nodes.forEach((node, index) => statements.push(env.DB.prepare(
    `INSERT INTO course_nodes
     (id, course_revision_id, mark_id, node_order, label, node_type, rounding, target_lng, target_lat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), revisionId, node.markId, index + 1, node.label,
    node.nodeType, node.rounding, node.target[0], node.target[1],
  )))
  await env.DB.batch(statements)
  await appendAuditEvent(env, {
    access,
    raceId,
    action: 'course.revision.create',
    entityType: 'course_revision',
    entityId: revisionId,
    after: {
      revision,
      courseCode,
      windDirection: body.windDirection,
      windSpeed: body.windSpeed,
      targetLengthMetres: body.targetLengthMetres,
      gateConfiguration,
      nodes,
    },
  })
  return json({ revisionId, revision, createdAt, gateConfiguration, nodes })
}
