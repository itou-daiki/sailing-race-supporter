import { env, exports } from 'cloudflare:workers'
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { canonical } from '../worker/audit.js'
import { EventRoom } from '../worker/index.js'
import { runRetentionForEvent } from '../worker/retention.js'
import { sha256Base64Url } from '../worker/security.js'

function nextWebSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for a WebSocket message'))
    }, 2_000)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
    }
    const onMessage = (event: MessageEvent) => {
      cleanup()
      if (typeof event.data !== 'string') {
        reject(new Error('Expected a text WebSocket message'))
        return
      }
      try {
        resolve(JSON.parse(event.data) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    }
    const onError = () => {
      cleanup()
      reject(new Error('WebSocket emitted an error'))
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
  })
}

function nextWebSocketMatching(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for a matching WebSocket message'))
    }, 2_000)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
    }
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      try {
        const parsed = JSON.parse(event.data) as Record<string, unknown>
        if (!predicate(parsed)) return
        cleanup()
        resolve(parsed)
      } catch {
        // Ignore malformed and unrelated frames while waiting for the expected event.
      }
    }
    const onError = () => {
      cleanup()
      reject(new Error('WebSocket emitted an error'))
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
  })
}

async function openEventRoom(
  eventId: string,
  rawSessionToken: string,
  since = 0,
): Promise<{ socket: WebSocket; snapshot: Record<string, unknown> }> {
  const response = await exports.default.fetch(`https://example.test/api/events/${eventId}/room?since=${since}`, {
    headers: {
      Cookie: `srs_session=${rawSessionToken}`,
      Origin: 'https://example.test',
      Upgrade: 'websocket',
    },
  })
  expect(response.status).toBe(101)
  expect(response.webSocket).not.toBeNull()
  const socket = response.webSocket!
  const snapshot = nextWebSocketMessage(socket)
  socket.accept()
  const resolvedSnapshot = await snapshot
  expect(resolvedSnapshot).toMatchObject({ type: 'snapshot' })
  return { socket, snapshot: resolvedSnapshot }
}

async function connectEventRoom(eventId: string, rawSessionToken: string): Promise<WebSocket> {
  return (await openEventRoom(eventId, rawSessionToken)).socket
}

function sessionTokenFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie') ?? ''
  const match = cookie.match(/(?:^|,\s*)srs_session=([^;]+)/u)
  if (!match) throw new Error('Expected an srs_session cookie')
  return decodeURIComponent(match[1])
}

describe('Cloudflare Workers runtime integration', () => {
  it('serves the health endpoint through the production Worker entrypoint', async () => {
    const response = await exports.default.fetch('https://example.test/api/health')
    const payload = await response.json<{ service: string; status: string; version: string }>()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      service: 'Sailing Race Supporter',
      status: 'ok',
      version: '0.3.0',
    })
  })

  it('applies every D1 migration in the Workers runtime', async () => {
    const migrations = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()
    const tableCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).first<{ count: number }>()

    expect(migrations.results).toHaveLength(29)
    expect(tableCount?.count).toBeGreaterThanOrEqual(50)
  })

  it('issues a shareable event URL with races, marks, boats, and an owner recovery kit', async () => {
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString()
    const ownerId = 'runtime-event-create-owner'
    const sessionToken = 'runtime-event-create-session'
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(ownerId, '大会発行テスト管理者', now, now),
      env.DB.prepare(
        `INSERT INTO passkey_credentials
         (id, user_id, credential_id, public_key, sign_count, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      ).bind('runtime-event-create-passkey', ownerId, 'runtime-event-create-credential', new Uint8Array([1, 2, 3]), now),
      env.DB.prepare(
        `INSERT INTO auth_sessions
         (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(await sha256Base64Url(sessionToken), ownerId, now, expiresAt, now),
    ])

    const response = await exports.default.fetch('https://example.test/api/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: `srs_session=${sessionToken}`,
        Origin: 'https://example.test',
      },
      body: JSON.stringify({
        name: '2026 大会発行テスト',
        startsOn: '2026-07-19',
        endsOn: '2026-07-20',
        raceCount: 2,
        className: '470',
        courseCode: 'O2',
        firstWarningAt: '2026-07-19T03:00:00.000Z',
        center: { longitude: 139.4638, latitude: 35.283 },
      }),
    })
    const issued = await response.json<{
      event: { id: string; slug: string; name: string; status: string }
      url: string
      ownerRecoveryKit: { eventId: string; eventSlug: string; recoveryCode: string } | null
    }>()

    expect(response.status).toBe(201)
    expect(issued.event).toMatchObject({ name: '2026 大会発行テスト', status: 'draft' })
    expect(issued.url).toBe(`/e/${issued.event.slug}`)
    expect(issued.ownerRecoveryKit).toMatchObject({ eventId: issued.event.id, eventSlug: issued.event.slug })
    expect(issued.ownerRecoveryKit?.recoveryCode).toMatch(/^SRSO-/u)

    const [raceCount, markCount, boatCount, ownerMember, initialCourseNodes] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS count FROM races WHERE regatta_id = ?').bind(issued.event.id).first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM marks WHERE regatta_id = ?').bind(issued.event.id).first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM committee_boats WHERE regatta_id = ?').bind(issued.event.id).first<{ count: number }>(),
      env.DB.prepare(
        `SELECT display_name, role, assignment FROM event_members
         WHERE regatta_id = ? AND user_id = ? LIMIT 1`,
      ).bind(issued.event.id, ownerId).first<{ display_name: string; role: string; assignment: string }>(),
      env.DB.prepare(
        `SELECT node.label, node.node_type
         FROM course_nodes node
         JOIN course_revisions revision ON revision.id = node.course_revision_id
         JOIN races race ON race.id = revision.race_id
         WHERE race.regatta_id = ? AND race.race_order = 1 AND revision.revision = 1
         ORDER BY node.node_order`,
      ).bind(issued.event.id).all<{ label: string; node_type: string }>(),
    ])
    expect(raceCount?.count).toBe(2)
    expect(markCount?.count).toBeGreaterThanOrEqual(8)
    expect(boatCount?.count).toBe(5)
    expect(ownerMember).toEqual({ display_name: '大会発行テスト管理者', role: 'owner', assignment: '大会管理者' })
    expect(initialCourseNodes.results).toEqual([
      { label: 'スタート・ピン', node_type: 'start' },
      { label: 'シグナルボート', node_type: 'start' },
      { label: '1マーク', node_type: 'single' },
      { label: '2マーク', node_type: 'single' },
      { label: '下ゲート 3S', node_type: 'gate' },
      { label: '下ゲート 3P', node_type: 'gate' },
    ])

    const soloResponse = await exports.default.fetch('https://example.test/api/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: `srs_session=${sessionToken}`,
        Origin: 'https://example.test',
      },
      body: JSON.stringify({
        name: '2026 ワンオペ運営テスト',
        startsOn: '2026-07-19',
        endsOn: '2026-07-19',
        raceCount: 1,
        className: '470',
        courseCode: 'O2',
        operationMode: 'solo',
        firstWarningAt: '2026-07-19T03:00:00.000Z',
      }),
    })
    const soloIssued = await soloResponse.json<{
      event: { id: string; slug: string; operationMode: string }
    }>()
    expect(soloResponse.status).toBe(201)
    expect(soloIssued.event.operationMode).toBe('solo')

    const [soloSettings, soloBoats, soloOwner, soloTasks] = await Promise.all([
      env.DB.prepare('SELECT operation_mode FROM regatta_settings WHERE regatta_id = ?')
        .bind(soloIssued.event.id).first<{ operation_mode: string }>(),
      env.DB.prepare('SELECT name, role, call_sign FROM committee_boats WHERE regatta_id = ?')
        .bind(soloIssued.event.id).all<{ name: string; role: string; call_sign: string }>(),
      env.DB.prepare('SELECT id, assignment FROM event_members WHERE regatta_id = ? AND user_id = ?')
        .bind(soloIssued.event.id, ownerId).first<{ id: string; assignment: string }>(),
      env.DB.prepare(
        `SELECT task.title, task.assignee_member_id
         FROM operational_tasks task JOIN races race ON race.id = task.race_id
         WHERE race.regatta_id = ? ORDER BY task.title`,
      ).bind(soloIssued.event.id).all<{ title: string; assignee_member_id: string | null }>(),
    ])
    expect(soloSettings?.operation_mode).toBe('solo')
    expect(soloBoats.results).toEqual([{ name: 'ワンオペ運営艇', role: 'signal-boat', call_sign: '全運営' }])
    expect(soloOwner?.assignment).toBe('全運営')
    expect(soloTasks.results).toContainEqual(expect.objectContaining({ title: 'ワンオペの安全条件と中止基準を確認' }))
    expect(soloTasks.results.every((task) => task.assignee_member_id === soloOwner?.id)).toBe(true)
    expect(soloTasks.results.some((task) => task.title === '担当別最終確認を完了')).toBe(false)

    const soloBootstrapResponse = await exports.default.fetch(
      `https://example.test/api/events/${soloIssued.event.slug}/bootstrap`,
      { headers: { Cookie: `srs_session=${sessionToken}` } },
    )
    const soloBootstrap = await soloBootstrapResponse.json<{ regatta: { operation_mode: string } }>()
    expect(soloBootstrapResponse.status).toBe(200)
    expect(soloBootstrap.regatta.operation_mode).toBe('solo')

    const incompatibleCourseResponse = await exports.default.fetch('https://example.test/api/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: `srs_session=${sessionToken}`,
        Origin: 'https://example.test',
      },
      body: JSON.stringify({
        name: '不整合コース確認',
        startsOn: '2026-07-19',
        endsOn: '2026-07-19',
        className: '470',
        courseCode: 'W2',
        firstWarningAt: '2026-07-19T03:00:00.000Z',
      }),
    })
    expect(incompatibleCourseResponse.status).toBe(400)
    await expect(incompatibleCourseResponse.json()).resolves.toMatchObject({
      error: '選択した競技ヨットクラスでは使用できない初期コースです',
    })

    const listResponse = await exports.default.fetch('https://example.test/api/events', {
      headers: { Cookie: `srs_session=${sessionToken}` },
    })
    const listed = await listResponse.json<{ events: Array<{ id: string; relationship: string }> }>()
    expect(listResponse.status).toBe(200)
    expect(listed.events).toContainEqual(expect.objectContaining({ id: issued.event.id, relationship: 'owner' }))
  })

  it('exports branded race logs for CSV and the client-side PDF report', async () => {
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString()
    const token = 'runtime-log-export-session'
    const tokenHash = await sha256Base64Url(token)
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind('runtime-log-owner', 'ログ大会管理者', now, now),
      env.DB.prepare(
        `INSERT INTO auth_sessions
         (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(tokenHash, 'runtime-log-owner', now, expiresAt, now),
      env.DB.prepare(
        `INSERT INTO regattas
         (id, slug, name, owner_user_id, starts_on, ends_on, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind('runtime-log-event', 'runtime-log-event', 'ログ出力テスト大会', 'runtime-log-owner', '2026-07-18', '2026-07-19', now, now),
      env.DB.prepare(
        `INSERT INTO race_areas (id, regatta_id, name, room_key, center_lng, center_lat)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind('runtime-log-area', 'runtime-log-event', 'A海面', 'runtime-log-room', 139.76, 35.25),
      env.DB.prepare(
        `INSERT INTO races
         (id, regatta_id, race_area_id, race_number, race_order, class_name, course_code,
          target_minutes, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'setup', ?, ?)`,
      ).bind('runtime-log-race', 'runtime-log-event', 'runtime-log-area', '1R', 1, '470', 'L2', 50, now, now),
    ])

    const headers = { Cookie: `srs_session=${token}` }
    const csvResponse = await exports.default.fetch(
      'https://example.test/api/events/runtime-log-event/logs?raceId=runtime-log-race&format=csv&download=1',
      { headers },
    )
    const csv = await csvResponse.text()

    expect(csvResponse.status).toBe(200)
    expect(csvResponse.headers.get('content-type')).toContain('text/csv')
    expect(csv).toContain('"Sailing Race Supporter"')
    expect(csv).toContain('"Created by Dit-Lab.（Daiki ITO）"')
    expect(csv).toContain('"大会","ログ出力テスト大会"')
    expect(csv).toContain('"対象範囲","1R"')

    const jsonResponse = await exports.default.fetch(
      'https://example.test/api/events/runtime-log-event/logs?raceId=runtime-log-race&format=json&download=1',
      { headers },
    )
    const report = await jsonResponse.json<{
      createdBy: string
      event: { id: string; slug: string; name: string }
      raceId: string
      entries: unknown[]
    }>()

    expect(jsonResponse.status).toBe(200)
    expect(report).toMatchObject({
      createdBy: 'Sailing Race Supporter / Created by Dit-Lab.（Daiki ITO）',
      event: { id: 'runtime-log-event', slug: 'runtime-log-event', name: 'ログ出力テスト大会' },
      raceId: 'runtime-log-race',
      entries: [],
    })
  })

  it('persists an event room snapshot across Durable Object eviction', async () => {
    const stub = env.EVENT_ROOMS.getByName('runtime-event-room')
    await runInDurableObject(stub, (instance: EventRoom, state) => {
      expect(instance).toBeInstanceOf(EventRoom)
      state.storage.sql.exec(
        `INSERT INTO room_events
         (sequence, event_id, type, race_id, member_id, payload_json, client_time, server_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        42,
        'runtime-event-42',
        'wind',
        'race-runtime',
        'member-runtime',
        JSON.stringify({ directionDegrees: 350, speedKnots: 8.4 }),
        '2026-07-18T08:00:00.000Z',
        '2026-07-18T08:00:01.000Z',
      )
    })

    await evictDurableObject(stub)
    const response = await stub.fetch('https://example.test/snapshot?race=race-runtime', {
      headers: {
        'x-srs-event-id': 'runtime-event-room',
        'x-srs-member-id': 'runtime-owner-member',
        'x-srs-role': 'owner',
        'x-srs-owner': '1',
      },
    })
    const snapshot = await response.json<{
      sequence: number
      events: Array<{ id: string; sequence: number }>
    }>()

    expect(response.status).toBe(200)
    expect(snapshot.sequence).toBe(42)
    expect(snapshot.events).toEqual([
      expect.objectContaining({ id: 'runtime-event-42', sequence: 42 }),
    ])
  })

  it('shares course, operating-boat position, wind and mark drops within two seconds and replays a reconnect gap', async () => {
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString()
    const eventId = 'runtime-realtime-event'
    const raceId = 'runtime-realtime-race'
    const boatId = 'runtime-realtime-boat'
    const markId = 'runtime-realtime-mark'
    const courseId = 'runtime-realtime-course'
    const ownerToken = 'runtime-realtime-owner-session'
    const viewerToken = 'runtime-realtime-viewer-session'
    const privateToken = 'runtime-realtime-private-session'
    const [ownerTokenHash, viewerTokenHash, privateTokenHash] = await Promise.all([
      sha256Base64Url(ownerToken),
      sha256Base64Url(viewerToken),
      sha256Base64Url(privateToken),
    ])

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind('runtime-realtime-owner', 'リアルタイム大会管理者', now, now),
      env.DB.prepare(
        `INSERT INTO users (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind('runtime-realtime-viewer', '運営閲覧端末', now, now),
      env.DB.prepare(
        `INSERT INTO users (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind('runtime-realtime-private', 'プロテスト担当', now, now),
      env.DB.prepare(
        `INSERT INTO auth_sessions
         (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(ownerTokenHash, 'runtime-realtime-owner', now, expiresAt, now),
      env.DB.prepare(
        `INSERT INTO auth_sessions
         (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(viewerTokenHash, 'runtime-realtime-viewer', now, expiresAt, now),
      env.DB.prepare(
        `INSERT INTO auth_sessions
         (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(privateTokenHash, 'runtime-realtime-private', now, expiresAt, now),
      env.DB.prepare(
        `INSERT INTO regattas
         (id, slug, name, owner_user_id, starts_on, ends_on, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(eventId, 'runtime-realtime', '複数端末共有テスト大会', 'runtime-realtime-owner', '2026-07-18', '2026-07-19', now, now),
      env.DB.prepare(
        `INSERT INTO event_members
         (id, regatta_id, user_id, display_name, role, assignment, status, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).bind('runtime-realtime-owner-member', eventId, 'runtime-realtime-owner', 'リアルタイム大会管理者', 'owner', '大会管理者', now),
      env.DB.prepare(
        `INSERT INTO event_members
         (id, regatta_id, user_id, display_name, role, assignment, status, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).bind('runtime-realtime-viewer-member', eventId, 'runtime-realtime-viewer', '1マーク運営端末', 'mark-boat', '1マーク', now),
      env.DB.prepare(
        `INSERT INTO event_members
         (id, regatta_id, user_id, display_name, role, assignment, status, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).bind('runtime-realtime-private-member', eventId, 'runtime-realtime-private', 'プロテスト担当', 'protest', 'プロテスト', now),
      env.DB.prepare(
        `INSERT INTO race_areas (id, regatta_id, name, room_key, center_lng, center_lat)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind('runtime-realtime-area', eventId, 'A海面', 'runtime-realtime-room', 139.76, 35.25),
      env.DB.prepare(
        `INSERT INTO races
         (id, regatta_id, race_area_id, race_number, race_order, class_name, course_code,
          target_minutes, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'setup', ?, ?)`,
      ).bind(raceId, eventId, 'runtime-realtime-area', '1R', 1, '470', 'L2', 50, now, now),
      env.DB.prepare(
        `INSERT INTO committee_boats
         (id, regatta_id, name, role, call_sign, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
      ).bind(boatId, eventId, 'マークボートA', 'mark-boat', '1マーク'),
      env.DB.prepare(
        `INSERT INTO marks (id, regatta_id, race_area_id, label, mark_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(markId, eventId, 'runtime-realtime-area', '1マーク', 'windward', now),
      env.DB.prepare(
        `INSERT INTO course_revisions
         (id, race_id, revision, course_code, target_length_metres, gate_config_json,
          status, created_by, created_at)
         VALUES (?, ?, 1, 'L2', 2400, '{}', 'approved', ?, ?)`,
      ).bind(courseId, raceId, 'runtime-realtime-owner', now),
      env.DB.prepare(
        `INSERT INTO course_nodes
         (id, course_revision_id, node_order, label, node_type, target_lng, target_lat, mark_id)
         VALUES (?, ?, 1, ?, 'single', ?, ?, ?)`,
      ).bind('runtime-realtime-node', courseId, '1マーク', 139.761, 35.251, markId),
      env.DB.prepare(
        `INSERT INTO event_member_scopes
         (id, event_member_id, race_area_id, race_id, committee_boat_id, mark_id, permission, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'operate', ?)`,
      ).bind(
        'runtime-realtime-viewer-scope',
        'runtime-realtime-viewer-member',
        'runtime-realtime-area',
        raceId,
        boatId,
        markId,
        now,
      ),
    ])

    const ownerSocket = await connectEventRoom(eventId, ownerToken)
    const viewerConnection = await openEventRoom(eventId, viewerToken)
    const viewerSocket = viewerConnection.socket
    const sequences: number[] = []
    const share = async (operation: Record<string, unknown>) => {
      const operationId = operation.id as string
      const startedAt = Date.now()
      const received = nextWebSocketMatching(viewerSocket, (message) => {
        const event = message.event as { id?: unknown } | undefined
        return message.type === 'event' && event?.id === operationId
      })
      ownerSocket.send(JSON.stringify(operation))
      const frame = await received
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      const event = frame.event as { sequence: number; type: string; payload: Record<string, unknown> }
      sequences.push(event.sequence)
      return event
    }

    const courseEvent = await share({
      id: 'runtime-realtime-course-refresh',
      type: 'course',
      raceId,
      clientTime: now,
      payload: { revisionId: courseId },
    })
    expect(courseEvent).toMatchObject({ type: 'course', payload: { revisionId: courseId, courseCode: 'L2' } })

    const positionEvent = await share({
      id: 'runtime-realtime-position-update',
      type: 'position',
      raceId,
      clientTime: now,
      payload: {
        committeeBoatId: boatId,
        position: [139.7608, 35.2508],
        speedKnots: 6.4,
        courseDegrees: 18,
        accuracyMetres: 2.8,
      },
    })
    expect(positionEvent).toMatchObject({
      type: 'position',
      payload: { committeeBoatId: boatId, position: [139.7608, 35.2508], speedKnots: 6.4, courseDegrees: 18 },
    })

    const windEvent = await share({
      id: 'runtime-realtime-wind-observation',
      type: 'wind',
      raceId,
      clientTime: now,
      payload: {
        directionDegrees: 342,
        speedKnots: 9.6,
        gustKnots: 11.2,
        observedAt: now,
        committeeBoatId: boatId,
        position: [139.7608, 35.2508],
        confidence: 'high',
      },
    })
    expect(windEvent).toMatchObject({
      type: 'wind',
      payload: { directionDegrees: 342, speedKnots: 9.6, confidence: 'high', committeeBoatId: boatId },
    })

    const markEvent = await share({
      id: 'runtime-realtime-mark-drop',
      type: 'mark',
      raceId,
      clientTime: now,
      payload: {
        markId,
        actual: [139.7612, 35.2511],
        status: 'deployed',
        recordedAt: now,
        committeeBoatId: boatId,
        accuracyMetres: 2.4,
        positionSource: 'handheld-gps-manual',
        coordinateEntryMode: 'dmm-tail-4',
        coordinateDatum: 'WGS84',
      },
    })
    expect(markEvent).toMatchObject({
      type: 'mark',
      payload: { markId, actual: [139.7612, 35.2511], status: 'deployed', positionSource: 'handheld-gps-manual' },
    })
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right))
    expect(new Set(sequences).size).toBe(sequences.length)

    const lastViewerSequence = sequences.at(-1)!
    viewerSocket.close(1000, 'temporary disconnect')

    const privateMessageId = 'runtime-realtime-private-message'
    const privateMessageOnOwner = nextWebSocketMatching(ownerSocket, (message) => {
      const event = message.event as { id?: unknown } | undefined
      return message.type === 'event' && event?.id === privateMessageId
    })
    ownerSocket.send(JSON.stringify({
      id: privateMessageId,
      type: 'message',
      raceId,
      clientTime: now,
      payload: {
        body: 'プロテスト担当だけに共有する内容',
        targetType: 'member',
        targetId: 'runtime-realtime-private-member',
        priority: 'confirm',
      },
    }))
    await privateMessageOnOwner

    const roomStub = env.EVENT_ROOMS.getByName(eventId)
    await evictDurableObject(roomStub)
    const missedWindId = 'runtime-realtime-missed-wind'
    const missedWindOnOwner = nextWebSocketMatching(ownerSocket, (message) => {
      const event = message.event as { id?: unknown } | undefined
      return message.type === 'event' && event?.id === missedWindId
    })
    ownerSocket.send(JSON.stringify({
      id: missedWindId,
      type: 'wind',
      raceId,
      clientTime: now,
      payload: { directionDegrees: 350, speedKnots: 10.1, observedAt: now, confidence: 'medium' },
    }))
    await missedWindOnOwner

    const reconnected = await openEventRoom(eventId, viewerToken, lastViewerSequence)
    const replayEvents = reconnected.snapshot.events as Array<{ id: string; type: string; sequence: number }>
    const replayPositions = reconnected.snapshot.positions as Array<{
      id: string; type: string; payload: { committeeBoatId: string; position: number[] }
    }>
    expect(reconnected.snapshot).toMatchObject({
      type: 'snapshot',
      replayAfter: lastViewerSequence,
      resyncRequired: false,
    })
    expect(replayEvents).toContainEqual(expect.objectContaining({ id: missedWindId, type: 'wind' }))
    expect(replayEvents).not.toContainEqual(expect.objectContaining({ id: privateMessageId }))
    expect(replayPositions).toContainEqual(expect.objectContaining({
      id: 'runtime-realtime-position-update',
      type: 'position',
      payload: expect.objectContaining({ committeeBoatId: boatId, position: [139.7608, 35.2508] }),
    }))

    const privateConnection = await openEventRoom(eventId, privateToken)
    const privateReplayEvents = privateConnection.snapshot.events as Array<{ id: string; type: string }>
    expect(privateConnection.snapshot.positions).toEqual([])
    expect(privateReplayEvents).toContainEqual(expect.objectContaining({ id: privateMessageId, type: 'message' }))
    const privateBootstrapResponse = await exports.default.fetch(
      `https://example.test/api/events/${eventId}/bootstrap`,
      { headers: { Cookie: `srs_session=${privateToken}` } },
    )
    const privateBootstrap = await privateBootstrapResponse.json<{
      boats: Array<{ id: string; lng: number | null; lat: number | null; speed_knots: number | null }>
      winds: Array<{ committee_boat_id: string; lng: number | null; lat: number | null; speed_knots: number }>
    }>()
    expect(privateBootstrapResponse.status).toBe(200)
    expect(privateBootstrap.boats).toContainEqual(expect.objectContaining({
      id: boatId,
      lng: null,
      lat: null,
      speed_knots: null,
    }))
    expect(privateBootstrap.winds).toContainEqual(expect.objectContaining({
      committee_boat_id: boatId,
      lng: null,
      lat: null,
      speed_knots: 9.6,
    }))

    const persistence = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS count FROM position_samples WHERE id = ?').bind('runtime-realtime-position-update').first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM wind_observations WHERE id IN (?, ?)').bind('runtime-realtime-wind-observation', missedWindId).first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM mark_events WHERE id = ?').bind('runtime-realtime-mark-drop').first<{ count: number }>(),
    ])
    expect(persistence.map((row) => row?.count ?? 0)).toEqual([1, 2, 1])

    reconnected.socket.close(1000, 'test complete')
    privateConnection.socket.close(1000, 'test complete')
    ownerSocket.close(1000, 'test complete')
  })

  it('requires the owner revision workflow for mark corrections after race finalization', async () => {
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString()
    const eventId = 'runtime-finalized-event'
    const raceId = 'runtime-finalized-race'
    const markId = 'runtime-finalized-mark'
    const ownerToken = 'runtime-finalized-owner-session'
    const memberToken = 'runtime-finalized-member-session'
    const [ownerTokenHash, memberTokenHash] = await Promise.all([
      sha256Base64Url(ownerToken),
      sha256Base64Url(memberToken),
    ])

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind('runtime-finalized-owner', '大会URL発行者', now, now),
      env.DB.prepare(
        `INSERT INTO users (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind('runtime-finalized-member', '1マーク担当', now, now),
      env.DB.prepare(
        `INSERT INTO auth_sessions
         (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(ownerTokenHash, 'runtime-finalized-owner', now, expiresAt, now),
      env.DB.prepare(
        `INSERT INTO auth_sessions
         (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(memberTokenHash, 'runtime-finalized-member', now, expiresAt, now),
      env.DB.prepare(
        `INSERT INTO regattas
         (id, slug, name, owner_user_id, starts_on, ends_on, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(eventId, 'runtime-finalized', '確定後訂正テスト大会', 'runtime-finalized-owner', '2026-07-18', '2026-07-19', now, now),
      env.DB.prepare(
        `INSERT INTO event_members
         (id, regatta_id, user_id, display_name, role, assignment, status, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).bind('runtime-finalized-owner-member', eventId, 'runtime-finalized-owner', '大会URL発行者', 'owner', '大会管理者', now),
      env.DB.prepare(
        `INSERT INTO event_members
         (id, regatta_id, user_id, display_name, role, assignment, status, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).bind('runtime-finalized-mark-member', eventId, 'runtime-finalized-member', '1マーク担当', 'mark-boat', '1マーク', now),
      env.DB.prepare(
        `INSERT INTO race_areas (id, regatta_id, name, room_key, center_lng, center_lat)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind('runtime-finalized-area', eventId, 'A海面', 'runtime-finalized-area-room', 139.76, 35.25),
      env.DB.prepare(
        `INSERT INTO races
         (id, regatta_id, race_area_id, race_number, race_order, class_name, course_code,
          target_minutes, status, finalized_revision, finalized_at, finalized_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'finalized', 1, ?, ?, ?, ?)`,
      ).bind(raceId, eventId, 'runtime-finalized-area', '1R', 1, '470', 'L2', 50, now, 'runtime-finalized-owner', now, now),
      env.DB.prepare(
        `INSERT INTO race_finalizations
         (id, race_id, revision, state_hash, reason, finalized_by, finalized_at, snapshot_json)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      ).bind(
        'runtime-finalized-v1',
        raceId,
        'runtime-finalized-state-v1',
        '初回確定',
        'runtime-finalized-owner',
        now,
        JSON.stringify({ schemaVersion: 1, raceId, revision: 1 }),
      ),
      env.DB.prepare(
        `INSERT INTO marks (id, regatta_id, race_area_id, label, mark_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(markId, eventId, 'runtime-finalized-area', '1マーク', 'windward', now),
      env.DB.prepare(
        `INSERT INTO course_revisions
         (id, race_id, revision, course_code, target_length_metres, gate_config_json,
          status, created_by, created_at)
         VALUES (?, ?, 1, 'L2', 2400, '{}', 'finalized', ?, ?)`,
      ).bind('runtime-finalized-course', raceId, 'runtime-finalized-owner', now),
      env.DB.prepare(
        `INSERT INTO course_nodes
         (id, course_revision_id, node_order, label, node_type, target_lng, target_lat, mark_id)
         VALUES (?, ?, 1, ?, 'single', ?, ?, ?)`,
      ).bind('runtime-finalized-node', 'runtime-finalized-course', '1マーク', 139.761, 35.251, markId),
      env.DB.prepare(
        `INSERT INTO event_member_scopes
         (id, event_member_id, race_area_id, race_id, mark_id, permission, created_at)
         VALUES (?, ?, ?, ?, ?, 'operate', ?)`,
      ).bind('runtime-finalized-scope', 'runtime-finalized-mark-member', 'runtime-finalized-area', raceId, markId, now),
    ])

    const memberSocket = await connectEventRoom(eventId, memberToken)
    const rejectedOperationId = 'runtime-member-finalized-mark'
    const memberReply = nextWebSocketMessage(memberSocket)
    memberSocket.send(JSON.stringify({
      id: rejectedOperationId,
      type: 'mark',
      raceId,
      payload: {
        markId,
        actual: [139.7621, 35.2521],
        status: 'moved',
        recordedAt: now,
        positionSource: 'handheld-gps-manual',
        coordinateEntryMode: 'dmm-tail-4',
        coordinateDatum: 'WGS84',
      },
    }))
    await expect(memberReply).resolves.toMatchObject({
      type: 'error',
      code: 'RACE_FINALIZED',
      id: rejectedOperationId,
    })

    const ownerSocket = await connectEventRoom(eventId, ownerToken)
    const directOwnerOperationId = 'runtime-owner-direct-finalized-mark'
    const ownerReply = nextWebSocketMessage(ownerSocket)
    ownerSocket.send(JSON.stringify({
      id: directOwnerOperationId,
      type: 'mark',
      raceId,
      payload: {
        markId,
        actual: [139.762345, 35.252345],
        status: 'moved',
        recordedAt: now,
        accuracyMetres: 3,
        positionSource: 'handheld-gps-manual',
        coordinateEntryMode: 'dmm-tail-4',
        coordinateDatum: 'WGS84',
        note: 'ハンディGPS値に訂正',
      },
    }))
    await expect(ownerReply).resolves.toMatchObject({
      type: 'error',
      code: 'RACE_FINALIZED',
      id: directOwnerOperationId,
    })

    const revisionInput = {
      reason: 'ハンディGPSの原記録と照合したため',
      corrections: {
        markPosition: {
          markId,
          actual: [139.762345, 35.252345],
          recordedAt: now,
          accuracyMetres: 3,
          positionSource: 'handheld-gps-manual',
          coordinateEntryMode: 'dmm-tail-4',
          coordinateDatum: 'WGS84',
          note: 'ハンディGPS値に訂正',
        },
      },
    }
    const memberRevisionResponse = await exports.default.fetch(
      `https://example.test/api/events/${eventId}/races/${raceId}/post-finalization-revisions/drafts`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: `srs_session=${memberToken}`,
          Origin: 'https://example.test',
        },
        body: JSON.stringify(revisionInput),
      },
    )
    expect(memberRevisionResponse.status).toBe(403)

    const draftResponse = await exports.default.fetch(
      `https://example.test/api/events/${eventId}/races/${raceId}/post-finalization-revisions/drafts`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: `srs_session=${ownerToken}`,
          Origin: 'https://example.test',
        },
        body: JSON.stringify(revisionInput),
      },
    )
    expect(draftResponse.status).toBe(201)
    const createdDraft = await draftResponse.json<{
      draft: { id: string; baseRevision: number; status: string; corrections: { markPosition: { markId: string } } }
    }>()
    expect(createdDraft.draft).toMatchObject({
      baseRevision: 1,
      status: 'draft',
      corrections: { markPosition: { markId } },
    })

    const prePublishEvents = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM mark_events WHERE race_id = ?',
    ).bind(raceId).first<{ count: number }>()
    const prePublishFinalization = await env.DB.prepare(
      'SELECT MAX(revision) AS revision FROM race_finalizations WHERE race_id = ?',
    ).bind(raceId).first<{ revision: number }>()
    expect(prePublishEvents?.count).toBe(0)
    expect(prePublishFinalization?.revision).toBe(1)

    const memberBootstrap = await exports.default.fetch(
      `https://example.test/api/events/${eventId}/bootstrap`,
      { headers: { Cookie: `srs_session=${memberToken}` } },
    )
    const memberStateBeforePublish = await memberBootstrap.json<{
      markEvents: unknown[]
      races: Array<{ finalized_revision: number }>
      activeRevisionDrafts: unknown[]
    }>()
    expect(memberStateBeforePublish.markEvents).toEqual([])
    expect(memberStateBeforePublish.races[0]?.finalized_revision).toBe(1)
    expect(memberStateBeforePublish.activeRevisionDrafts).toEqual([])

    const ownerBootstrap = await exports.default.fetch(
      `https://example.test/api/events/${eventId}/bootstrap`,
      { headers: { Cookie: `srs_session=${ownerToken}` } },
    )
    const ownerStateBeforePublish = await ownerBootstrap.json<{
      activeRevisionDrafts: Array<{ id: string; race_id: string; base_revision: number; status: string }>
    }>()
    expect(ownerStateBeforePublish.activeRevisionDrafts).toEqual([
      expect.objectContaining({
        id: createdDraft.draft.id,
        race_id: raceId,
        base_revision: 1,
        status: 'draft',
      }),
    ])

    const wrongPhraseResponse = await exports.default.fetch(
      `https://example.test/api/events/${eventId}/races/${raceId}/post-finalization-revisions/drafts/${createdDraft.draft.id}/publish`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: `srs_session=${ownerToken}`,
          Origin: 'https://example.test',
        },
        body: JSON.stringify({ confirmationPhrase: '1R' }),
      },
    )
    expect(wrongPhraseResponse.status).toBe(400)
    await expect(wrongPhraseResponse.json()).resolves.toMatchObject({ code: 'FINALIZATION_PHRASE_MISMATCH' })

    const revisionResponse = await exports.default.fetch(
      `https://example.test/api/events/${eventId}/races/${raceId}/post-finalization-revisions/drafts/${createdDraft.draft.id}/publish`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: `srs_session=${ownerToken}`,
          Origin: 'https://example.test',
        },
        body: JSON.stringify({ confirmationPhrase: '1Rを確定' }),
      },
    )
    expect(revisionResponse.status).toBe(200)
    const revision = await revisionResponse.json<{
      revision: number
      stateHash: string
      corrections: {
        markPosition: {
          eventId: string
          markId: string
          actual: [number, number]
          status: string
          positionSource: string
          coordinateEntryMode: string
          coordinateDatum: string
        }
      }
    }>()
    expect(revision).toMatchObject({
      revision: 2,
      corrections: {
        markPosition: {
          markId,
          actual: [139.762345, 35.252345],
          status: 'confirmed',
          positionSource: 'handheld-gps-manual',
          coordinateEntryMode: 'dmm-tail-4',
          coordinateDatum: 'WGS84',
        },
      },
    })

    const publishedDraft = await env.DB.prepare(
      `SELECT status, published_finalization_id, published_at
       FROM post_finalization_revision_drafts WHERE id = ? LIMIT 1`,
    ).bind(createdDraft.draft.id).first<{
      status: string
      published_finalization_id: string
      published_at: string
    }>()
    expect(publishedDraft).toMatchObject({ status: 'published' })
    expect(publishedDraft?.published_finalization_id).toBeTruthy()
    expect(publishedDraft?.published_at).toBeTruthy()

    const ownerBootstrapAfterPublish = await exports.default.fetch(
      `https://example.test/api/events/${eventId}/bootstrap`,
      { headers: { Cookie: `srs_session=${ownerToken}` } },
    )
    const ownerStateAfterPublish = await ownerBootstrapAfterPublish.json<{
      markEvents: Array<{ mark_id: string; lng: number; lat: number; payload_json: string }>
      races: Array<{ finalized_revision: number }>
      activeRevisionDrafts: unknown[]
    }>()
    expect(ownerStateAfterPublish.activeRevisionDrafts).toEqual([])
    expect(ownerStateAfterPublish.races[0]?.finalized_revision).toBe(2)
    expect(ownerStateAfterPublish.markEvents).toContainEqual(expect.objectContaining({
      mark_id: markId,
      lng: 139.762345,
      lat: 35.252345,
      payload_json: expect.stringContaining('postFinalizationRevisionId'),
    }))

    const markEvent = await env.DB.prepare(
      `SELECT event_type, lng, lat, member_id, payload_json
       FROM mark_events WHERE id = ? LIMIT 1`,
    ).bind(revision.corrections.markPosition.eventId).first<{
      event_type: string
      lng: number
      lat: number
      member_id: string
      payload_json: string
    }>()
    expect(markEvent).toMatchObject({
      event_type: 'moved',
      lng: 139.762345,
      lat: 35.252345,
      member_id: 'runtime-finalized-owner-member',
    })
    expect(JSON.parse(markEvent!.payload_json)).toMatchObject({
      source: 'handheld-gps-manual',
      coordinateEntryMode: 'dmm-tail-4',
      coordinateDatum: 'WGS84',
      note: 'ハンディGPS値に訂正',
      baseFinalizationId: 'runtime-finalized-v1',
    })

    const finalized = await env.DB.prepare(
      `SELECT revision, state_hash, previous_finalization_id, snapshot_json
       FROM race_finalizations WHERE race_id = ? ORDER BY revision DESC LIMIT 1`,
    ).bind(raceId).first<{
      revision: number
      state_hash: string
      previous_finalization_id: string
      snapshot_json: string
    }>()
    expect(finalized).toMatchObject({
      revision: 2,
      state_hash: revision.stateHash,
      previous_finalization_id: 'runtime-finalized-v1',
    })
    expect(JSON.parse(finalized!.snapshot_json)).toMatchObject({
      schemaVersion: 2,
      type: 'post-finalization-revision',
      baseFinalization: {
        id: 'runtime-finalized-v1',
        revision: 1,
        stateHash: 'runtime-finalized-state-v1',
      },
      corrections: {
        markPosition: {
          eventId: revision.corrections.markPosition.eventId,
          markId,
        },
      },
    })

    const correction = await env.DB.prepare(
      `SELECT id, revision, reason, state_hash, previous_finalization_id, patch_json
       FROM post_finalization_revisions WHERE race_id = ? ORDER BY revision DESC LIMIT 1`,
    ).bind(raceId).first<{
      id: string
      revision: number
      reason: string
      state_hash: string
      previous_finalization_id: string
      patch_json: string
    }>()
    expect(correction).toMatchObject({
      revision: 2,
      reason: revisionInput.reason,
      state_hash: revision.stateHash,
      previous_finalization_id: 'runtime-finalized-v1',
    })
    expect(JSON.parse(correction!.patch_json)).toMatchObject({
      markPosition: { eventId: revision.corrections.markPosition.eventId, markId },
    })

    const audit = await env.DB.prepare(
      `SELECT action, entity_type, entity_id, actor_user_id
       FROM audit_events WHERE regatta_id = ? AND action = 'race.post-finalization-revision'
       ORDER BY sequence DESC LIMIT 1`,
    ).bind(eventId).first<{
      action: string
      entity_type: string
      entity_id: string
      actor_user_id: string
    }>()
    expect(audit).toEqual({
      action: 'race.post-finalization-revision',
      entity_type: 'race',
      entity_id: raceId,
      actor_user_id: 'runtime-finalized-owner',
    })

    const notificationId = 'runtime-finalized-revision-refresh'
    const notificationReply = nextWebSocketMessage(ownerSocket)
    ownerSocket.send(JSON.stringify({
      id: notificationId,
      type: 'course',
      raceId,
      payload: { action: 'refresh', finalizedRevision: revision.revision },
    }))
    await expect(notificationReply).resolves.toMatchObject({
      type: 'event',
      event: { id: notificationId, type: 'course', raceId },
    })

    const roomSnapshot = await env.EVENT_ROOMS.getByName(eventId)
      .fetch(`https://example.test/snapshot?race=${raceId}`, {
        headers: {
          'x-srs-event-id': eventId,
          'x-srs-member-id': 'runtime-finalized-owner-member',
          'x-srs-role': 'owner',
          'x-srs-owner': '1',
        },
      })
    const roomState = await roomSnapshot.json<{ events: Array<{ id: string; type: string }> }>()
    expect(roomState.events).toContainEqual(expect.objectContaining({ id: notificationId, type: 'course' }))
    expect(roomState.events).not.toContainEqual(expect.objectContaining({ type: 'mark' }))

    const disposableDraftResponse = await exports.default.fetch(
      `https://example.test/api/events/${eventId}/races/${raceId}/post-finalization-revisions/drafts`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Cookie: `srs_session=${ownerToken}`,
          Origin: 'https://example.test',
        },
        body: JSON.stringify({
          reason: '破棄操作の確認用下書き',
          corrections: { courseCode: 'L3' },
        }),
      },
    )
    expect(disposableDraftResponse.status).toBe(201)
    const disposableDraft = await disposableDraftResponse.json<{ draft: { id: string } }>()
    const discardResponse = await exports.default.fetch(
      `https://example.test/api/events/${eventId}/races/${raceId}/post-finalization-revisions/drafts/${disposableDraft.draft.id}`,
      {
        method: 'DELETE',
        headers: {
          Cookie: `srs_session=${ownerToken}`,
          Origin: 'https://example.test',
        },
      },
    )
    expect(discardResponse.status).toBe(200)
    await expect(discardResponse.json()).resolves.toMatchObject({
      id: disposableDraft.draft.id,
      status: 'discarded',
    })
    const discardedDraft = await env.DB.prepare(
      'SELECT status FROM post_finalization_revision_drafts WHERE id = ? LIMIT 1',
    ).bind(disposableDraft.draft.id).first<{ status: string }>()
    expect(discardedDraft?.status).toBe('discarded')

    memberSocket.close(1000, 'test complete')
    ownerSocket.close(1000, 'test complete')
  })

  it('runs retention without object storage and appends a system audit-chain event', async () => {
    const eventId = 'runtime-retention-event'
    const ownerId = 'runtime-retention-owner'
    const createdAt = '2020-01-02T00:00:00.000Z'
    const retentionAt = new Date('2026-07-18T10:00:00.000Z')
    const policy = {
      finalizedRecordsDays: 36_500,
      observationsDays: 36_500,
      sampledPositionsDays: 36_500,
      localHighFrequencyTrackDays: 7,
      regularMessagesDays: 36_500,
      memberProfilesDays: 36_500,
      authSecretsAfterEventDays: 36_500,
      securityLogsDays: 36_500,
    }
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(ownerId, '保存期間テスト管理者', createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO regattas
         (id, slug, name, owner_user_id, starts_on, ends_on, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'archived', ?, ?)`,
      ).bind(eventId, 'runtime-retention', '保存期間テスト大会', ownerId, '2020-01-01', '2020-01-02', createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO regatta_settings
         (regatta_id, retention_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(eventId, JSON.stringify(policy), createdAt, createdAt),
    ])

    const report = await runRetentionForEvent(env, eventId, 'cron', retentionAt)

    expect(report).toMatchObject({
      eventId,
      status: 'completed',
      startedAt: retentionAt.toISOString(),
    })
    expect(report.counts).toEqual({})

    const audit = await env.DB.prepare(
      `SELECT id, sequence, actor_user_id, actor_member_id, action, entity_type,
              entity_id, before_hash, after_hash, reason, client_time, server_time,
              previous_event_hash, event_hash
       FROM audit_events WHERE regatta_id = ? ORDER BY sequence`,
    ).bind(eventId).first<{
      id: string
      sequence: number
      actor_user_id: string | null
      actor_member_id: string | null
      action: string
      entity_type: string
      entity_id: string
      before_hash: string | null
      after_hash: string
      reason: string
      client_time: string | null
      server_time: string
      previous_event_hash: string | null
      event_hash: string
    }>()
    expect(audit).toMatchObject({
      sequence: 1,
      actor_user_id: null,
      actor_member_id: null,
      action: 'retention.run.completed',
      entity_type: 'retention_run',
      entity_id: report.runId,
      before_hash: null,
      reason: report.detail,
      client_time: null,
      previous_event_hash: null,
    })
    const afterHash = await sha256Base64Url(JSON.stringify(canonical({
      triggerType: 'cron',
      status: 'completed',
      counts: report.counts,
      startedAt: report.startedAt,
      completedAt: report.completedAt,
    })))
    expect(audit?.after_hash).toBe(afterHash)
    const expectedEventHash = await sha256Base64Url(JSON.stringify(canonical({
      id: audit?.id,
      regattaId: eventId,
      raceId: null,
      sequence: 1,
      actorUserId: null,
      action: 'retention.run.completed',
      entityType: 'retention_run',
      entityId: report.runId,
      beforeHash: null,
      afterHash,
      reason: report.detail,
      clientTime: null,
      serverTime: audit?.server_time,
      previousHash: null,
    })))
    expect(audit?.event_hash).toBe(expectedEventHash)

    const manualReport = await runRetentionForEvent(
      env,
      eventId,
      'manual',
      new Date('2026-07-19T10:00:00.000Z'),
      {
        eventId,
        eventSlug: 'runtime-retention',
        eventName: '保存期間テスト大会',
        userId: ownerId,
        memberId: `owner:${ownerId}`,
        displayName: '保存期間テスト管理者',
        role: 'owner',
        assignment: '大会管理者',
        isOwner: true,
      },
    )
    const manualAudit = await env.DB.prepare(
      `SELECT sequence, actor_user_id, actor_member_id, action, entity_id
       FROM audit_events WHERE regatta_id = ? ORDER BY sequence DESC LIMIT 1`,
    ).bind(eventId).first<{
      sequence: number
      actor_user_id: string | null
      actor_member_id: string | null
      action: string
      entity_id: string
    }>()
    expect(manualAudit).toEqual({
      sequence: 2,
      actor_user_id: ownerId,
      actor_member_id: null,
      action: 'retention.run.completed',
      entity_id: manualReport.runId,
    })
  })

  it('rotates a member recovery card once and revokes both the invite and active sessions', async () => {
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString()
    const ownerId = 'runtime-recovery-owner'
    const ownerToken = 'runtime-recovery-owner-session'
    const eventId = 'runtime-recovery-event'
    const eventSlug = 'runtime-recovery'
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(ownerId, '復元テスト大会管理者', now, now),
      env.DB.prepare(
        `INSERT INTO auth_sessions
         (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(await sha256Base64Url(ownerToken), ownerId, now, expiresAt, now),
      env.DB.prepare(
        `INSERT INTO regattas
         (id, slug, name, owner_user_id, starts_on, ends_on, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(eventId, eventSlug, '参加復元テスト大会', ownerId, '2026-07-18', '2026-07-19', now, now),
    ])
    const mutationHeaders = {
      'content-type': 'application/json',
      Origin: 'https://example.test',
      'cf-connecting-ip': '203.0.113.35',
    }
    const createResponse = await exports.default.fetch(
      `https://example.test/api/events/${eventSlug}/invites`,
      {
        method: 'POST',
        headers: { ...mutationHeaders, Cookie: `srs_session=${ownerToken}` },
        body: JSON.stringify({ role: 'mark-boat', assignment: '1マーク', maxUses: 2 }),
      },
    )
    const created = await createResponse.json<{ invite: { id: string }; url: string }>()
    const inviteSecret = new URL(created.url, 'https://example.test').hash.replace(/^#token=/u, '')
    expect(createResponse.status).toBe(201)
    expect(inviteSecret).not.toBe('')

    const firstRecoverySecret = 'member-recovery-secret-one-1234567890'
    const exchangeResponse = await exports.default.fetch(
      `https://example.test/api/invites/${created.invite.id}/exchange`,
      {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({
          secret: decodeURIComponent(inviteSecret),
          displayName: '第1マーク担当者',
          recoverySecret: firstRecoverySecret,
        }),
      },
    )
    const joined = await exchangeResponse.json<{
      member: { id: string; displayName: string; role: string; assignment: string }
    }>()
    const firstMemberToken = sessionTokenFrom(exchangeResponse)
    expect(exchangeResponse.status).toBe(201)
    expect(joined.member).toMatchObject({ displayName: '第1マーク担当者', role: 'mark-boat', assignment: '1マーク' })
    expect((await exports.default.fetch(
      `https://example.test/api/events/${eventSlug}/bootstrap`,
      { headers: { Cookie: `srs_session=${firstMemberToken}` } },
    )).status).toBe(200)

    const nextRecoverySecret = 'member-recovery-secret-two-0987654321'
    const recoverResponse = await exports.default.fetch(
      `https://example.test/api/events/${eventSlug}/recover`,
      {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({
          memberId: joined.member.id,
          recoverySecret: firstRecoverySecret,
          newRecoverySecret: nextRecoverySecret,
        }),
      },
    )
    const recovered = await recoverResponse.json<{
      member: { id: string; displayName: string; role: string; assignment: string }
    }>()
    const recoveredMemberToken = sessionTokenFrom(recoverResponse)
    expect(recoverResponse.status).toBe(200)
    expect(recovered.member).toEqual(joined.member)
    expect((await exports.default.fetch(
      `https://example.test/api/events/${eventSlug}/bootstrap`,
      { headers: { Cookie: `srs_session=${firstMemberToken}` } },
    )).status).toBe(401)
    expect((await exports.default.fetch(
      `https://example.test/api/events/${eventSlug}/bootstrap`,
      { headers: { Cookie: `srs_session=${recoveredMemberToken}` } },
    )).status).toBe(200)

    const replayResponse = await exports.default.fetch(
      `https://example.test/api/events/${eventSlug}/recover`,
      {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({
          memberId: joined.member.id,
          recoverySecret: firstRecoverySecret,
          newRecoverySecret: 'member-recovery-replay-secret-000000',
        }),
      },
    )
    expect(replayResponse.status).toBe(400)

    const revokeResponse = await exports.default.fetch(
      `https://example.test/api/events/${eventSlug}/invites/${created.invite.id}/revoke`,
      {
        method: 'POST',
        headers: { ...mutationHeaders, Cookie: `srs_session=${ownerToken}` },
        body: '{}',
      },
    )
    expect(revokeResponse.status).toBe(200)
    expect((await exports.default.fetch(
      `https://example.test/api/events/${eventSlug}/bootstrap`,
      { headers: { Cookie: `srs_session=${recoveredMemberToken}` } },
    )).status).toBe(401)

    const revokedInviteResponse = await exports.default.fetch(
      `https://example.test/api/invites/${created.invite.id}/exchange`,
      {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({
          secret: decodeURIComponent(inviteSecret),
          displayName: '再参加者',
          recoverySecret: 'member-recovery-secret-three-123456',
        }),
      },
    )
    expect(revokedInviteResponse.status).toBe(410)

    const state = await env.DB.prepare(
      `SELECT em.status,
              SUM(CASE WHEN credential.used_at IS NULL AND credential.revoked_at IS NULL THEN 1 ELSE 0 END) AS active_credentials,
              SUM(CASE WHEN credential.used_at IS NOT NULL THEN 1 ELSE 0 END) AS used_credentials,
              SUM(CASE WHEN credential.revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked_credentials
       FROM event_members em
       JOIN member_recovery_credentials credential ON credential.event_member_id = em.id
       WHERE em.id = ? GROUP BY em.status`,
    ).bind(joined.member.id).first<{
      status: string
      active_credentials: number
      used_credentials: number
      revoked_credentials: number
    }>()
    expect(state).toEqual({ status: 'revoked', active_credentials: 0, used_credentials: 1, revoked_credentials: 1 })
  })
})
