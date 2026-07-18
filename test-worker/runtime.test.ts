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

    expect(migrations.results).toHaveLength(26)
    expect(tableCount?.count).toBeGreaterThanOrEqual(50)
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
      .fetch(`https://example.test/snapshot?race=${raceId}`)
    const roomState = await roomSnapshot.json<{ events: Array<{ event_id: string; type: string }> }>()
    expect(roomState.events).toContainEqual(expect.objectContaining({ event_id: notificationId, type: 'course' }))
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

  it('deletes expired R2 archives and appends a system audit-chain event', async () => {
    const eventId = 'runtime-retention-event'
    const ownerId = 'runtime-retention-owner'
    const archiveId = 'runtime-retention-archive'
    const objectKey = `${eventId}/2020-01-02/${archiveId}.srs-backup`
    const createdAt = '2020-01-02T00:00:00.000Z'
    const retentionAt = new Date('2026-07-18T10:00:00.000Z')
    const policy = {
      finalizedRecordsDays: 36_500,
      observationsDays: 36_500,
      sampledPositionsDays: 36_500,
      localHighFrequencyTrackDays: 7,
      cloudBackupDays: 1,
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
    const stored = await env.BACKUP_ARCHIVES.put(objectKey, new Uint8Array([7, 6, 5, 4]), {
      customMetadata: { encrypted: 'true', eventId },
    })
    await env.DB.prepare(
      `INSERT INTO backup_archives
       (id, regatta_id, object_key, ciphertext_hash, server_data_hash, event_sequence,
        size_bytes, etag, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      archiveId,
      eventId,
      objectKey,
      'runtime-ciphertext-hash',
      'runtime-server-data-hash',
      0,
      4,
      stored.etag,
      ownerId,
      createdAt,
    ).run()

    const report = await runRetentionForEvent(env, eventId, 'cron', retentionAt)

    expect(report).toMatchObject({
      eventId,
      status: 'completed',
      counts: { cloudBackups: 1 },
      startedAt: retentionAt.toISOString(),
    })
    expect(await env.BACKUP_ARCHIVES.get(objectKey)).toBeNull()
    const archive = await env.DB.prepare(
      'SELECT deleted_at FROM backup_archives WHERE id = ? LIMIT 1',
    ).bind(archiveId).first<{ deleted_at: string | null }>()
    expect(archive?.deleted_at).toBe(retentionAt.toISOString())

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
