import type { EventAccess } from './authorization.js'
import { appendAuditEvent } from './audit.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { assertSameOrigin, randomToken, requireSession } from './security.js'

const CLASSES = new Set(['OP', 'ILCA 4', 'ILCA 6', 'ILCA 7', '420', '470', 'スナイプ'])
const COURSES = new Set(['O2', 'I2', 'L2', 'L3', 'W2', 'トライアングル'])

const RETENTION_DEFAULTS = {
  finalizedRecordsDays: 1826,
  observationsDays: 365,
  sampledPositionsDays: 90,
  localHighFrequencyTrackDays: 7,
  regularMessagesDays: 90,
  memberProfilesDays: 365,
  authSecretsAfterEventDays: 30,
  securityLogsDays: 365,
}

interface CreateEventInput {
  name?: string
  startsOn?: string
  endsOn?: string
  raceCount?: number
  className?: string
  courseCode?: string
  firstWarningAt?: string
  center?: { longitude?: number; latitude?: number }
}

interface EventListRow {
  id: string
  slug: string
  name: string
  starts_on: string
  ends_on: string
  status: string
  relationship: 'owner' | 'member'
  role: string
  assignment: string
}

function slugBase(name: string): string {
  const ascii = name.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 36)
  return ascii || 'regatta'
}

function isoDate(value: string | undefined, field: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Response(`${field} must be YYYY-MM-DD`, { status: 400 })
  }
  return value
}

function coordinate(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

function pointAt(origin: readonly [number, number], distanceMetres: number, bearingDegrees: number): readonly [number, number] {
  const radius = 6_371_008.8
  const angularDistance = distanceMetres / radius
  const bearing = bearingDegrees * Math.PI / 180
  const lat1 = origin[1] * Math.PI / 180
  const lng1 = origin[0] * Math.PI / 180
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
    Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  )
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
  )
  return [lng2 * 180 / Math.PI, lat2 * 180 / Math.PI]
}

function initialTargets(center: readonly [number, number]): Record<string, readonly [number, number]> {
  const gateCenter = pointAt(center, 150, 350)
  const mark1 = pointAt(center, 1_000, 350)
  return {
    'mark-1': mark1,
    'mark-1s': pointAt(mark1, 60, 260),
    'mark-1p': pointAt(mark1, 60, 80),
    'mark-1a': pointAt(mark1, 180, 80),
    'mark-2': pointAt(center, 780, 35),
    'mark-3s': pointAt(gateCenter, 65, 260),
    'mark-3p': pointAt(gateCenter, 65, 80),
    'mark-3': gateCenter,
    'start-pin': pointAt(center, 240, 260),
    'start-rc': pointAt(center, 240, 80),
  }
}

function warningTime(value: string | undefined): Date {
  if (value) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  const fallback = new Date(Date.now() + 60 * 60_000)
  fallback.setUTCMinutes(Math.ceil(fallback.getUTCMinutes() / 5) * 5, 0, 0)
  return fallback
}

async function listEvents(request: Request, env: AppEnv): Promise<Response> {
  const session = await requireSession(request, env)
  const rows = await env.DB.prepare(
    `SELECT DISTINCT
       r.id, r.slug, r.name, r.starts_on, r.ends_on, r.status,
       CASE WHEN r.owner_user_id = ? THEN 'owner' ELSE 'member' END AS relationship,
       CASE WHEN r.owner_user_id = ? THEN 'owner' ELSE COALESCE(em.role, 'viewer') END AS role,
       CASE WHEN r.owner_user_id = ? THEN '大会管理者' ELSE COALESCE(em.assignment, '') END AS assignment
     FROM regattas r
     LEFT JOIN event_members em
       ON em.regatta_id = r.id AND em.user_id = ? AND em.status = 'active'
     WHERE r.owner_user_id = ? OR em.id IS NOT NULL
     ORDER BY r.starts_on DESC, r.created_at DESC`,
  ).bind(session.userId, session.userId, session.userId, session.userId, session.userId).all<EventListRow>()
  return json({ events: rows.results })
}

async function createEvent(request: Request, env: AppEnv): Promise<Response> {
  assertSameOrigin(request)
  const session = await requireSession(request, env)
  const body = await readJson<CreateEventInput>(request, 16_384)
  const name = body.name?.trim()
  if (!name || name.length < 2 || name.length > 100) {
    return json({ error: '大会名は2〜100文字で入力してください' }, { status: 400 })
  }
  const startsOn = isoDate(body.startsOn, 'startsOn')
  const endsOn = isoDate(body.endsOn, 'endsOn')
  if (endsOn < startsOn) return json({ error: '終了日は開始日以降にしてください' }, { status: 400 })
  const raceCount = Math.trunc(body.raceCount ?? 3)
  if (raceCount < 1 || raceCount > 20) return json({ error: 'レース数は1〜20で指定してください' }, { status: 400 })
  const className = body.className ?? '470'
  if (!CLASSES.has(className)) return json({ error: '未対応の競技ヨットクラスです' }, { status: 400 })
  const courseCode = body.courseCode ?? 'O2'
  if (!COURSES.has(courseCode)) return json({ error: '未対応の初期コースです' }, { status: 400 })

  const center = [
    coordinate(body.center?.longitude, 139.4638, -180, 180),
    coordinate(body.center?.latitude, 35.283, -85, 85),
  ] as const
  const now = new Date().toISOString()
  const eventId = crypto.randomUUID()
  const slug = `${slugBase(name)}-${randomToken(6).replace(/[^a-z0-9]/giu, '').toLowerCase()}`
  const areaId = crypto.randomUUID()
  const ownerMemberId = crypto.randomUUID()
  const targets = initialTargets(center)
  const warning = warningTime(body.firstWarningAt)
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO regattas
       (id, slug, name, owner_user_id, starts_on, ends_on, status, default_locale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', 'ja', ?, ?)`,
    ).bind(eventId, slug, name, session.userId, startsOn, endsOn, now, now),
    env.DB.prepare(
      `INSERT INTO regatta_settings
       (regatta_id, retention_json, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).bind(eventId, JSON.stringify(RETENTION_DEFAULTS), now, now),
    env.DB.prepare(
      `INSERT INTO event_members
       (id, regatta_id, user_id, display_name, role, assignment, status, joined_at)
       VALUES (?, ?, ?, ?, 'owner', '大会管理者', 'active', ?)`,
    ).bind(ownerMemberId, eventId, session.userId, session.displayName, now),
    env.DB.prepare(
      `INSERT INTO race_areas (id, regatta_id, name, room_key, center_lng, center_lat)
       VALUES (?, ?, '海面A', 'area-a', ?, ?)`,
    ).bind(areaId, eventId, center[0], center[1]),
  ]

  const markDefinitions = [
    ['mark-1', '1マーク', 'rounding'],
    ['mark-1s', '上ゲート 1S', 'gate'],
    ['mark-1p', '上ゲート 1P', 'gate'],
    ['mark-1a', 'オフセット 1A', 'offset'],
    ['mark-2', '2マーク', 'rounding'],
    ['mark-3s', '下ゲート 3S', 'gate'],
    ['mark-3p', '下ゲート 3P', 'gate'],
    ['mark-3', '3マーク', 'rounding'],
    ['start-pin', 'スタート・ピン', 'pin'],
    ['start-rc', 'シグナルボート', 'signal'],
  ] as const
  const markIds = new Map<string, string>()
  for (const [key, label, type] of markDefinitions) {
    const id = crypto.randomUUID()
    markIds.set(key, id)
    statements.push(env.DB.prepare(
      'INSERT INTO marks (id, regatta_id, race_area_id, label, mark_type, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, eventId, areaId, label, type, now))
  }

  const boats = [
    ['マークボートA', 'mark-boat', '1マーク'],
    ['マークボートB', 'mark-boat', '2マーク'],
    ['マークボートC', 'mark-boat', '下ゲート'],
    ['シグナルボート', 'signal-boat', 'スタート／フィニッシュ'],
    ['プロテストボート', 'protest', 'プロテスト'],
  ] as const
  for (const [boatName, role, callSign] of boats) {
    statements.push(env.DB.prepare(
      `INSERT INTO committee_boats (id, regatta_id, name, role, call_sign, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
    ).bind(crypto.randomUUID(), eventId, boatName, role, callSign))
  }

  const nodeDefinitions = [
    ['start-pin', 'スタート・ピン', 'start'],
    ['start-rc', 'シグナルボート', 'start'],
    ['mark-1', '1マーク', 'single'],
    ['mark-1a', 'オフセット 1A', 'offset'],
    ['mark-2', '2マーク', 'single'],
    ['mark-3s', '下ゲート 3S', 'gate'],
    ['mark-3p', '下ゲート 3P', 'gate'],
  ] as const
  for (let index = 0; index < raceCount; index += 1) {
    const raceId = crypto.randomUUID()
    const revisionId = crypto.randomUUID()
    const raceWarning = new Date(warning.getTime() + index * 75 * 60_000).toISOString()
    statements.push(env.DB.prepare(
      `INSERT INTO races
       (id, regatta_id, race_area_id, race_number, race_order, class_name, course_code,
        target_minutes, warning_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?)`,
    ).bind(raceId, eventId, areaId, `${index + 1}R`, index + 1, className, courseCode, className === '420' ? 45 : className === 'スナイプ' ? 60 : 50, raceWarning, now, now))
    statements.push(env.DB.prepare(
      `INSERT INTO course_revisions
       (id, race_id, revision, course_code, wind_direction, wind_speed, target_length_metres,
        gate_config_json, status, created_by, created_at)
       VALUES (?, ?, 1, ?, 350, 8, 3000, ?, 'draft', ?, ?)`,
    ).bind(revisionId, raceId, courseCode, JSON.stringify({ lower: true, upper: false }), session.userId, now))
    nodeDefinitions.forEach(([key, label, nodeType], nodeIndex) => {
      const target = targets[key]
      statements.push(env.DB.prepare(
        `INSERT INTO course_nodes
         (id, course_revision_id, mark_id, node_order, label, node_type, rounding, target_lng, target_lat)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), revisionId, markIds.get(key), nodeIndex + 1, label, nodeType, key.includes('3') ? 'gate' : 'port', target[0], target[1]))
    })
    const taskDefinitions = [
      ['採用コースを承認', 'blocked', 'required', -20],
      ['全必須マークを確認', 'blocked', 'required', -10],
      ['5分平均風を更新', 'waiting', 'required', -7],
      ['スタートライン方位を確認', 'waiting', 'required', -6],
      ['公式音響端末を準備', 'waiting', 'required', -5],
      ['予備マークと通信手段を確認', 'waiting', 'reference', -15],
    ] as const
    for (const [title, taskStatus, priority, dueOffsetMinutes] of taskDefinitions) {
      statements.push(env.DB.prepare(
        `INSERT INTO operational_tasks
         (id, race_id, title, status, priority, due_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      ).bind(
        crypto.randomUUID(),
        raceId,
        title,
        taskStatus,
        priority,
        new Date(Date.parse(raceWarning) + dueOffsetMinutes * 60_000).toISOString(),
      ))
    }
  }

  await env.DB.batch(statements)
  const access: EventAccess = {
    eventId,
    eventSlug: slug,
    eventName: name,
    userId: session.userId,
    memberId: ownerMemberId,
    displayName: session.displayName,
    role: 'owner',
    assignment: '大会管理者',
    isOwner: true,
  }
  await appendAuditEvent(env, {
    access,
    action: 'regatta.create',
    entityType: 'regatta',
    entityId: eventId,
    after: { name, slug, startsOn, endsOn, raceCount, className, courseCode },
  })

  return json({
    event: { id: eventId, slug, name, startsOn, endsOn, status: 'draft' },
    url: `/e/${encodeURIComponent(slug)}`,
  }, { status: 201 })
}

export async function handleEventCollectionRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  if (pathname !== '/api/events') return null
  if (request.method === 'GET') return listEvents(request, env)
  if (request.method === 'POST') return createEvent(request, env)
  return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'GET, POST' } })
}
