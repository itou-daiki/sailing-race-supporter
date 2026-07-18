import { env, exports } from 'cloudflare:workers'
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { EventRoom } from '../worker/index.js'
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

async function connectEventRoom(eventId: string, rawSessionToken: string): Promise<WebSocket> {
  const response = await exports.default.fetch(`https://example.test/api/events/${eventId}/room`, {
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
  await expect(snapshot).resolves.toMatchObject({ type: 'snapshot' })
  return socket
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

    expect(migrations.results).toHaveLength(25)
    expect(tableCount?.count).toBeGreaterThanOrEqual(49)
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
    const response = await stub.fetch('https://example.test/snapshot?race=race-runtime')
    const snapshot = await response.json<{
      sequence: number
      events: Array<{ event_id: string; sequence: number }>
    }>()

    expect(response.status).toBe(200)
    expect(snapshot.sequence).toBe(42)
    expect(snapshot.events).toEqual([
      expect.objectContaining({ event_id: 'runtime-event-42', sequence: 42 }),
    ])
  })

  it('rejects a member but appends an owner mark correction after race finalization', async () => {
    const now = '2026-07-18T09:00:00.000Z'
    const expiresAt = '2027-07-18T09:00:00.000Z'
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
    const correctionId = 'runtime-owner-finalized-mark'
    const ownerReply = nextWebSocketMessage(ownerSocket)
    ownerSocket.send(JSON.stringify({
      id: correctionId,
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
      type: 'event',
      event: {
        id: correctionId,
        type: 'mark',
        raceId,
        payload: {
          markId,
          actual: [139.762345, 35.252345],
          status: 'deployed',
          positionSource: 'handheld-gps-manual',
          coordinateEntryMode: 'dmm-tail-4',
          coordinateDatum: 'WGS84',
        },
      },
    })

    const markEvent = await env.DB.prepare(
      `SELECT event_type, lng, lat, member_id, payload_json
       FROM mark_events WHERE id = ? LIMIT 1`,
    ).bind(correctionId).first<{
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
    })

    const audit = await env.DB.prepare(
      `SELECT action, entity_type, entity_id, actor_user_id
       FROM audit_events WHERE regatta_id = ? ORDER BY sequence DESC LIMIT 1`,
    ).bind(eventId).first<{
      action: string
      entity_type: string
      entity_id: string
      actor_user_id: string
    }>()
    expect(audit).toEqual({
      action: 'realtime.mark',
      entity_type: 'mark',
      entity_id: correctionId,
      actor_user_id: 'runtime-finalized-owner',
    })

    const roomSnapshot = await env.EVENT_ROOMS.getByName(eventId)
      .fetch(`https://example.test/snapshot?race=${raceId}`)
    const roomState = await roomSnapshot.json<{ events: Array<{ event_id: string; type: string }> }>()
    expect(roomState.events).toContainEqual(expect.objectContaining({ event_id: correctionId, type: 'mark' }))

    memberSocket.close(1000, 'test complete')
    ownerSocket.close(1000, 'test complete')
  })

  it('uses the configured R2 binding for encrypted archive objects', async () => {
    const key = 'runtime-test/event/archive.srsbackup'
    await env.BACKUP_ARCHIVES.put(key, new Uint8Array([1, 2, 3, 4]), {
      customMetadata: { encrypted: 'true' },
    })

    const object = await env.BACKUP_ARCHIVES.get(key)
    expect(object?.customMetadata?.encrypted).toBe('true')
    expect([...new Uint8Array(await object!.arrayBuffer())]).toEqual([1, 2, 3, 4])
  })
})
