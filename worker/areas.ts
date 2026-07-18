import { eventAccess, type EventAccess } from './authorization.js'
import { appendAuditEvent } from './audit.js'
import { buildGateConfiguration } from '../shared/gates.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, hasRecentAuthentication, randomToken, requireSession } from './security.js'
import { STANDARD_MARK_DEFINITIONS } from './standardArea.js'

interface AreaInput {
  name?: string
  center?: { longitude?: number; latitude?: number }
}

async function requireOwner(
  request: Request,
  env: AppEnv,
  eventReference: string,
): Promise<EventAccess | Response> {
  assertSameOrigin(request)
  const session = await requireSession(request, env)
  const access = await eventAccess(env, eventReference, session.userId, session.displayName)
  if (!access?.isOwner) return json({ error: 'レースエリアを変更できるのは大会管理者だけです' }, { status: 403 })
  if (!hasRecentAuthentication(session)) {
    return json({
      code: 'RECENT_AUTHENTICATION_REQUIRED',
      error: 'レースエリア変更前にパスキーで再認証してください',
    }, { status: 403 })
  }
  return access
}

function validCoordinate(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

async function createArea(request: Request, env: AppEnv, eventReference: string): Promise<Response> {
  const authorized = await requireOwner(request, env, eventReference)
  if (authorized instanceof Response) return authorized
  const body = await readJson<AreaInput>(request, 16_384)
  const name = body.name?.trim()
  if (!name || name.length < 2 || name.length > 50) {
    return json({ error: 'レースエリア名は2〜50文字で入力してください' }, { status: 400 })
  }
  if (!validCoordinate(body.center?.longitude, -180, 180) || !validCoordinate(body.center?.latitude, -85, 85)) {
    return json({ error: 'レースエリアの中心位置を指定してください' }, { status: 400 })
  }
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM race_areas WHERE regatta_id = ?',
  ).bind(authorized.eventId).first<{ count: number }>()
  if ((count?.count ?? 0) >= 6) return json({ error: '無料枠設計では1大会6海面までです' }, { status: 409 })
  const duplicate = await env.DB.prepare(
    'SELECT id FROM race_areas WHERE regatta_id = ? AND name = ? COLLATE NOCASE LIMIT 1',
  ).bind(authorized.eventId, name).first<{ id: string }>()
  if (duplicate) return json({ error: '同じ名前のレースエリアがあります' }, { status: 409 })

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO race_areas (id, regatta_id, name, room_key, center_lng, center_lat)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    authorized.eventId,
    name,
    `area-${randomToken(9)}`,
    body.center.longitude,
    body.center.latitude,
  )]
  for (const [, label, markType] of STANDARD_MARK_DEFINITIONS) {
    statements.push(env.DB.prepare(
      'INSERT INTO marks (id, regatta_id, race_area_id, label, mark_type, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), authorized.eventId, id, label, markType, createdAt))
  }
  await env.DB.batch(statements)
  await appendAuditEvent(env, {
    access: authorized,
    action: 'race-area.create',
    entityType: 'race_area',
    entityId: id,
    after: { name, center: [body.center.longitude, body.center.latitude], standardMarks: STANDARD_MARK_DEFINITIONS.length },
    reason: '大会管理者が大会URL内にレースエリアを追加',
  })
  return json({
    area: { id, name, centerLng: body.center.longitude, centerLat: body.center.latitude },
    markCount: STANDARD_MARK_DEFINITIONS.length,
    createdAt,
  }, { status: 201 })
}

async function assignRaceArea(
  request: Request,
  env: AppEnv,
  eventReference: string,
  raceId: string,
): Promise<Response> {
  const authorized = await requireOwner(request, env, eventReference)
  if (authorized instanceof Response) return authorized
  const body = await readJson<{ raceAreaId?: string }>(request, 8_192)
  if (!body.raceAreaId) return json({ error: '移動先レースエリアを指定してください' }, { status: 400 })
  return assignRaceToArea(env, authorized, raceId, body.raceAreaId)
}

export async function assignRaceToArea(
  env: AppEnv,
  authorized: EventAccess,
  raceId: string,
  targetRaceAreaId: string,
): Promise<Response> {
  const race = await env.DB.prepare(
    `SELECT race.id, race.race_number, race.race_area_id, race.status,
            area.name AS area_name, area.center_lng, area.center_lat
     FROM races race JOIN race_areas area ON area.id = race.race_area_id
     WHERE race.id = ? AND race.regatta_id = ? LIMIT 1`,
  ).bind(raceId, authorized.eventId).first<{
    id: string; race_number: string; race_area_id: string; status: string
    area_name: string; center_lng: number | null; center_lat: number | null
  }>()
  if (!race) return json({ error: 'レースが見つかりません' }, { status: 404 })
  if (race.race_area_id === targetRaceAreaId) {
    return json({ raceId, raceAreaId: race.race_area_id, areaName: race.area_name, unchanged: true })
  }
  if (race.status !== 'planning') {
    return json({ error: '海面を変更できるのは運営準備を開始する前のレースだけです' }, { status: 409 })
  }
  const activity = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM mark_events WHERE race_id = ?) +
       (SELECT COUNT(*) FROM signal_events WHERE race_id = ?) +
       (SELECT COUNT(*) FROM leading_passage_observations WHERE race_id = ?) +
       (SELECT COUNT(*) FROM finish_observations WHERE race_id = ?) AS event_count`,
  ).bind(raceId, raceId, raceId, raceId).first<{ event_count: number }>()
  if ((activity?.event_count ?? 0) > 0) {
    return json({ error: '投下・信号・通過記録があるレースは海面を変更できません' }, { status: 409 })
  }
  const targetArea = await env.DB.prepare(
    'SELECT id, name, center_lng, center_lat FROM race_areas WHERE id = ? AND regatta_id = ? LIMIT 1',
  ).bind(targetRaceAreaId, authorized.eventId).first<{
    id: string; name: string; center_lng: number | null; center_lat: number | null
  }>()
  if (!targetArea) return json({ error: '移動先レースエリアが見つかりません' }, { status: 404 })
  const source = await env.DB.prepare(
    `SELECT id, revision, course_code, wind_direction, wind_speed, target_length_metres, gate_config_json
     FROM course_revisions WHERE race_id = ? ORDER BY revision DESC LIMIT 1`,
  ).bind(raceId).first<{
    id: string; revision: number; course_code: string; wind_direction: number | null
    wind_speed: number | null; target_length_metres: number | null; gate_config_json: string
  }>()
  if (!source) return json({ error: '移動元コース版が見つかりません' }, { status: 409 })
  const nodes = (await env.DB.prepare(
    `SELECT node_order, label, node_type, rounding, target_lng, target_lat
     FROM course_nodes WHERE course_revision_id = ? ORDER BY node_order`,
  ).bind(source.id).all<{
    node_order: number; label: string; node_type: string; rounding: string | null
    target_lng: number; target_lat: number
  }>()).results
  const targetMarks = new Map((await env.DB.prepare(
    'SELECT id, label FROM marks WHERE race_area_id = ? AND regatta_id = ?',
  ).bind(targetArea.id, authorized.eventId).all<{ id: string; label: string }>()).results.map((mark) => [mark.label, mark.id]))
  if (nodes.length < 3 || nodes.some((node) => !targetMarks.has(node.label))) {
    return json({ error: '移動先海面に対応する標準マークが不足しています' }, { status: 409 })
  }

  const deltaLng = targetArea.center_lng != null && race.center_lng != null ? targetArea.center_lng - race.center_lng : 0
  const deltaLat = targetArea.center_lat != null && race.center_lat != null ? targetArea.center_lat - race.center_lat : 0
  const shiftedNodes = nodes.map((node) => ({
    ...node,
    markId: targetMarks.get(node.label) as string,
    nodeType: node.node_type,
    target: [
      Math.max(-180, Math.min(180, node.target_lng + deltaLng)),
      Math.max(-85, Math.min(85, node.target_lat + deltaLat)),
    ] as const,
  }))
  let sourceGateFlags: { lower?: unknown; upper?: unknown; second?: unknown } = {}
  try {
    const parsed = JSON.parse(source.gate_config_json) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sourceGateFlags = parsed
  } catch {
    return json({ error: '移動元コースのゲート構成を読み取れません' }, { status: 409 })
  }
  let movedGateConfiguration: ReturnType<typeof buildGateConfiguration>
  try {
    movedGateConfiguration = buildGateConfiguration({
      lower: sourceGateFlags.lower === true,
      upper: sourceGateFlags.upper === true,
      second: sourceGateFlags.second === true,
    }, shiftedNodes)
  } catch (reason) {
    return json({ error: reason instanceof Error ? reason.message : '移動元コースのゲート構成が不正です' }, { status: 409 })
  }
  const revision = source.revision + 1
  const revisionId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE course_revisions SET status = 'superseded'
       WHERE id = ? AND race_id = ? AND status <> 'finalized'`,
    ).bind(source.id, raceId),
    env.DB.prepare(
      `INSERT INTO course_revisions
       (id, race_id, revision, course_code, wind_direction, wind_speed, target_length_metres,
        gate_config_json, status, based_on_revision, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?
       FROM races WHERE id = ? AND regatta_id = ? AND status = 'planning'`,
    ).bind(
      revisionId, raceId, revision, source.course_code, source.wind_direction, source.wind_speed,
      source.target_length_metres, JSON.stringify(movedGateConfiguration), source.revision, authorized.userId, createdAt,
      raceId, authorized.eventId,
    ),
    env.DB.prepare(
      'UPDATE races SET race_area_id = ?, updated_at = ? WHERE id = ? AND regatta_id = ? AND status = \'planning\'',
    ).bind(targetArea.id, createdAt, raceId, authorized.eventId),
  ]
  for (const node of shiftedNodes) {
    statements.push(env.DB.prepare(
      `INSERT INTO course_nodes
       (id, course_revision_id, mark_id, node_order, label, node_type, rounding, target_lng, target_lat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), revisionId, node.markId, node.node_order, node.label,
      node.node_type, node.rounding,
      node.target[0], node.target[1],
    ))
  }
  await env.DB.batch(statements)
  await appendAuditEvent(env, {
    access: authorized,
    raceId,
    action: 'race-area.assign',
    entityType: 'race',
    entityId: raceId,
    before: { raceAreaId: race.race_area_id, areaName: race.area_name, courseRevision: source.revision },
    after: { raceAreaId: targetArea.id, areaName: targetArea.name, courseRevision: revision, gateConfiguration: movedGateConfiguration },
    reason: `${race.race_number}を${targetArea.name}へ移動`,
  })
  return json({
    raceId,
    raceAreaId: targetArea.id,
    areaName: targetArea.name,
    revisionId,
    revision,
    createdAt,
    unchanged: false,
  })
}

export async function handleRaceAreaRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const collectionMatch = pathname.match(/^\/api\/events\/([^/]+)\/areas$/)
  const assignmentMatch = pathname.match(/^\/api\/events\/([^/]+)\/races\/([^/]+)\/area$/)
  if (collectionMatch) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'POST' } })
    return createArea(request, env, decodeURIComponent(collectionMatch[1]))
  }
  if (assignmentMatch) {
    if (request.method !== 'PATCH') return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'PATCH' } })
    return assignRaceArea(
      request,
      env,
      decodeURIComponent(assignmentMatch[1]),
      decodeURIComponent(assignmentMatch[2]),
    )
  }
  return null
}
