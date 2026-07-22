import type { EventAccess } from './authorization.js'
import { appendAuditEventWithoutBlockingSecretDelivery } from './audit.js'
import { buildGateConfiguration } from '../shared/gates.js'
import { coursePresetForClass, coursePresetsForClass } from '../shared/coursePresets.js'
import { DEFAULT_RACE_AREA_CENTER } from '../shared/defaultRaceArea.js'
import { json, readJson } from './http.js'
import type { AppEnv } from './index.js'
import { generateOwnerRecoveryCode, normalizeOwnerRecoveryCode } from '../shared/ownerRecovery.js'
import { assertSameOrigin, hasRecentAuthentication, randomToken, requireSession, sha256Base64Url } from './security.js'
import { STANDARD_MARK_DEFINITIONS } from './standardArea.js'
import { normalizeOperationMode, type OperationMode } from '../shared/operationModes.js'
import {
  destinationPoint,
  generateCoursePlan,
  recommendedStartLineLength,
  type CourseTemplate,
} from '../shared/courseGeometry.js'
import { recommendedCourseLength, type SupportedSailingClass } from '../shared/classPerformance.js'

const CLASSES = new Set(['OP', 'ILCA 4', 'ILCA 6', 'ILCA 7', '420', '470', 'スナイプ'])
const COURSES = new Set(['O2', 'I2', 'L2', 'L3', 'W2', 'T2', 'トライアングル'])

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
  operationMode?: OperationMode
  center?: { longitude?: number; latitude?: number }
  signalBoatPosition?: { longitude?: number; latitude?: number }
  windDirection?: number
  windSpeed?: number
  lowerGate?: boolean
  targetLengthMetres?: number
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
  if (!hasRecentAuthentication(session)) {
    return json({
      error: '大会URLの発行にはパスキーでの再認証が必要です',
      code: 'REAUTHENTICATION_REQUIRED',
    }, { status: 428 })
  }
  const credentialCount = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ? AND revoked_at IS NULL',
  ).bind(session.userId).first<{ count: number }>()
  if (!credentialCount?.count) {
    return json({ error: '大会管理者の有効なパスキーを確認できません。再認証してください' }, { status: 403 })
  }
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
  const courseCode = body.courseCode ?? (className === 'スナイプ' ? 'W2' : 'O2')
  if (!COURSES.has(courseCode)) return json({ error: '未対応の初期コースです' }, { status: 400 })
  if (!coursePresetsForClass(className).some((preset) => preset.code === courseCode)) {
    return json({ error: '選択した競技ヨットクラスでは使用できない初期コースです' }, { status: 400 })
  }
  const operationMode = normalizeOperationMode(body.operationMode)

  const center = [
    coordinate(body.center?.longitude, DEFAULT_RACE_AREA_CENTER.longitude, -180, 180),
    coordinate(body.center?.latitude, DEFAULT_RACE_AREA_CENTER.latitude, -85, 85),
  ] as const
  const signalBoatPosition = [
    coordinate(body.signalBoatPosition?.longitude, center[0], -180, 180),
    coordinate(body.signalBoatPosition?.latitude, center[1], -85, 85),
  ] as const
  const windDirection = typeof body.windDirection === 'number' && Number.isFinite(body.windDirection)
    ? ((body.windDirection % 360) + 360) % 360
    : 350
  const windSpeed = typeof body.windSpeed === 'number' && Number.isFinite(body.windSpeed)
    ? Math.min(40, Math.max(1, body.windSpeed))
    : 8
  const preset = coursePresetForClass(className, courseCode)
  const lowerGate = body.lowerGate ?? preset.route.some((point) => point.includes('S/'))
  const recommendedLengthMetres = Math.round(
    recommendedCourseLength(className as SupportedSailingClass, windSpeed, undefined, courseCode as CourseTemplate).kilometres * 1_000,
  )
  const targetLengthMetres = typeof body.targetLengthMetres === 'number' && Number.isFinite(body.targetLengthMetres)
    ? Math.round(Math.min(30_000, Math.max(500, body.targetLengthMetres)))
    : recommendedLengthMetres
  const courseTemplate = courseCode as CourseTemplate
  const startLineLength = recommendedStartLineLength(targetLengthMetres, courseTemplate, className)
  const startPin = destinationPoint(signalBoatPosition, startLineLength, windDirection - 90)
  const initialCoursePlan = generateCoursePlan({
    center,
    startLine: { pin: startPin, signal: signalBoatPosition },
    windDirection,
    totalLengthMetres: targetLengthMetres,
    courseCode: courseTemplate,
    className,
    lowerGate,
    upperGate: false,
    secondGate: false,
  })
  const now = new Date().toISOString()
  const eventId = crypto.randomUUID()
  const slug = `${slugBase(name)}-${randomToken(6).replace(/[^a-z0-9]/giu, '').toLowerCase()}`
  const areaId = crypto.randomUUID()
  const ownerMemberId = crypto.randomUUID()
  const ownerRecoveryCode = credentialCount.count < 2 ? generateOwnerRecoveryCode() : null
  const ownerRecoveryId = ownerRecoveryCode ? crypto.randomUUID() : null
  const warning = warningTime(body.firstWarningAt)
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO regattas
       (id, slug, name, owner_user_id, starts_on, ends_on, status, default_locale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', 'ja', ?, ?)`,
    ).bind(eventId, slug, name, session.userId, startsOn, endsOn, now, now),
    env.DB.prepare(
      `INSERT INTO regatta_settings
       (regatta_id, retention_json, operation_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(eventId, JSON.stringify(RETENTION_DEFAULTS), operationMode, now, now),
    env.DB.prepare(
      `INSERT INTO event_members
       (id, regatta_id, user_id, display_name, role, assignment, status, joined_at)
       VALUES (?, ?, ?, ?, 'owner', ?, 'active', ?)`,
    ).bind(ownerMemberId, eventId, session.userId, session.displayName, operationMode === 'solo' ? '全運営' : '大会管理者', now),
    env.DB.prepare(
      `INSERT INTO race_areas (id, regatta_id, name, room_key, center_lng, center_lat)
       VALUES (?, ?, '海面A', 'area-a', ?, ?)`,
    ).bind(areaId, eventId, center[0], center[1]),
  ]
  if (ownerRecoveryCode && ownerRecoveryId) {
    statements.push(env.DB.prepare(
      `INSERT INTO owner_recovery_credentials
       (id, regatta_id, owner_user_id, secret_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      ownerRecoveryId,
      eventId,
      session.userId,
      await sha256Base64Url(normalizeOwnerRecoveryCode(ownerRecoveryCode)),
      now,
    ))
  }

  const markIds = new Map<string, string>()
  for (const [key, label, type] of STANDARD_MARK_DEFINITIONS) {
    const id = crypto.randomUUID()
    markIds.set(key, id)
    statements.push(env.DB.prepare(
      'INSERT INTO marks (id, regatta_id, race_area_id, label, mark_type, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, eventId, areaId, label, type, now))
  }

  const boats = operationMode === 'solo'
    ? [['ワンオペ運営艇', 'signal-boat', '全運営']] as const
    : [
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

  const nodeDefinitions = initialCoursePlan.map((node) => {
    const definition = STANDARD_MARK_DEFINITIONS.find(([standardKey]) => standardKey === node.key)
    if (!definition) throw new Error(`初期コース用の標準マーク ${node.key} が見つかりません`)
    return [node.key, node.label, node.nodeType, node.target] as const
  })
  for (let index = 0; index < raceCount; index += 1) {
    const raceId = crypto.randomUUID()
    const revisionId = crypto.randomUUID()
    const raceWarning = new Date(warning.getTime() + index * 75 * 60_000).toISOString()
    const initialCourseNodes = nodeDefinitions.map(([key, label, nodeType, target]) => {
      const markId = markIds.get(key)
      if (!markId) throw new Error(`標準マーク ${key} が見つかりません`)
      return { markId, label, nodeType, target }
    })
    const gateConfiguration = buildGateConfiguration(
      {
        lower: initialCourseNodes.some((node) => node.nodeType === 'gate' && (node.label.startsWith('下ゲート') || node.label.startsWith('内側ゲート'))),
        upper: initialCourseNodes.some((node) => node.nodeType === 'gate' && node.label.startsWith('上ゲート')),
        second: initialCourseNodes.some((node) => node.nodeType === 'gate' && node.label.startsWith('中ゲート')),
      },
      initialCourseNodes,
    )
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
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).bind(revisionId, raceId, courseCode, windDirection, windSpeed, targetLengthMetres, JSON.stringify(gateConfiguration), session.userId, now))
    initialCourseNodes.forEach(({ markId, label, nodeType, target }, nodeIndex) => {
      statements.push(env.DB.prepare(
        `INSERT INTO course_nodes
         (id, course_revision_id, mark_id, node_order, label, node_type, rounding, target_lng, target_lat)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), revisionId, markId, nodeIndex + 1, label, nodeType, nodeType === 'gate' ? 'gate' : 'port', target[0], target[1]))
    })
    const taskDefinitions = operationMode === 'solo'
      ? [
          ['ワンオペの安全条件と中止基準を確認', 'waiting', 'required', -30],
          ['使用端末・電源・通信を手元に準備', 'waiting', 'required', -20],
          ['採用コースを承認', 'blocked', 'required', -20],
          ['全必須マークを確認', 'blocked', 'required', -10],
          ['5分平均風を更新', 'waiting', 'required', -7],
          ['スタートライン方位を確認', 'waiting', 'required', -6],
          ['信号・公式音響端末を準備', 'waiting', 'required', -5],
          ['補助者不在時の緊急連絡手段を確認', 'waiting', 'reference', -15],
        ] as const
      : [
          ['全体運営準備を開始', 'waiting', 'required', -30],
          ['担当別最終確認を完了', 'waiting', 'required', -15],
          ['スタート要員の配置を最終確認', 'waiting', 'required', -5],
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
         (id, race_id, title, assignee_member_id, status, priority, due_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      ).bind(
        crypto.randomUUID(),
        raceId,
        title,
        operationMode === 'solo' ? ownerMemberId : null,
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
  const auditRecorded = await appendAuditEventWithoutBlockingSecretDelivery(env, {
    access,
    action: 'regatta.create',
    entityType: 'regatta',
    entityId: eventId,
    after: {
      name, slug, startsOn, endsOn, raceCount, className, courseCode, operationMode,
      lowerGate, windDirection, windSpeed, targetLengthMetres, signalBoatPosition,
      ownerRecovery: ownerRecoveryId ? 'issued-pending-confirmation' : 'two-or-more-passkeys',
    },
  })

  return json({
    event: { id: eventId, slug, name, startsOn, endsOn, status: 'draft', operationMode },
    url: `/e/${encodeURIComponent(slug)}`,
    auditRecorded,
    ownerRecoveryKit: ownerRecoveryCode && ownerRecoveryId ? {
      recoveryId: ownerRecoveryId,
      eventId,
      eventSlug: slug,
      eventName: name,
      ownerUserId: session.userId,
      issuedAt: now,
      recoveryCode: ownerRecoveryCode,
    } : null,
  }, { status: 201 })
}

export async function handleEventCollectionRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  if (pathname !== '/api/events') return null
  if (request.method === 'GET') return listEvents(request, env)
  if (request.method === 'POST') return createEvent(request, env)
  return json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'GET, POST' } })
}
