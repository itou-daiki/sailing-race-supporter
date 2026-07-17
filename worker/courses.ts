import { eventAccess } from './authorization.js'
import { appendAuditEvent } from './audit.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, requireSession } from './security.js'

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
  nodes?: CourseNodeInput[]
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

export async function handleCourseRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const match = pathname.match(/^\/api\/events\/([^/]+)\/races\/([^/]+)\/course-revisions$/)
  if (!match) return null
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'POST' } })
  assertSameOrigin(request)
  const session = await requireSession(request, env)
  const eventReference = decodeURIComponent(match[1])
  const raceId = decodeURIComponent(match[2])
  const access = await eventAccess(env, eventReference, session.userId, session.displayName)
  if (!access || (!access.isOwner && !['pro', 'ro', 'course-setter'].includes(access.role))) {
    return json({ error: 'コース案を作成する権限がありません' }, { status: 403 })
  }
  const race = await env.DB.prepare(
    'SELECT status FROM races WHERE id = ? AND regatta_id = ? LIMIT 1',
  ).bind(raceId, access.eventId).first<{ status: string }>()
  if (!race) return json({ error: 'レースが見つかりません' }, { status: 404 })
  if (race.status === 'finalized') return json({ error: '確定済みレースは管理者修正版を使用してください' }, { status: 409 })
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
    'SELECT id FROM marks WHERE regatta_id = ?',
  ).bind(access.eventId).all<{ id: string }>()).results.map((mark) => mark.id))
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
  const previous = await env.DB.prepare(
    'SELECT COALESCE(MAX(revision), 0) AS revision FROM course_revisions WHERE race_id = ?',
  ).bind(raceId).first<{ revision: number }>()
  const revision = (previous?.revision ?? 0) + 1
  const revisionId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const statements: D1PreparedStatement[] = [env.DB.prepare(
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
    JSON.stringify({ lower: body.lowerGate === true, upper: body.upperGate === true }),
    previous?.revision || null,
    access.userId,
    createdAt,
  )]
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
    after: { revision, courseCode, windDirection: body.windDirection, windSpeed: body.windSpeed, targetLengthMetres: body.targetLengthMetres, lowerGate: body.lowerGate, upperGate: body.upperGate, nodes },
  })
  return json({ revisionId, revision, createdAt, nodes })
}
