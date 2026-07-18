import { env, exports } from 'cloudflare:workers'
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { EventRoom } from '../worker/index.js'

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
