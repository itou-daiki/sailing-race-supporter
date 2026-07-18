import { describe, expect, it } from 'vitest'
import type { EventAccess } from '../worker/authorization'
import type { AppEnv } from '../worker/index'
import { persistRealtimeOperation } from '../worker/operations'

describe('mark drop persistence', () => {
  it('stores GPS accuracy and a server-computed difference from the active course target', async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = []
    const database = {
      prepare(sql: string) {
        let values: unknown[] = []
        const statement = {
          bind(...nextValues: unknown[]) {
            values = nextValues
            return statement
          },
          async first() {
            if (sql.includes('SELECT id FROM races')) return { id: 'race-1' }
            if (sql.includes('SELECT status FROM races')) return { status: 'setup' }
            if (sql.includes('SELECT m.id AS mark_id')) {
              return { mark_id: 'mark-1', node_id: 'node-1', label: '1マーク', target_lng: 139.4661, target_lat: 35.2948 }
            }
            if (sql.includes('FROM committee_boats')) return { id: 'boat-1', name: 'マークボートA', call_sign: '1マーク' }
            if (sql.includes('SELECT id FROM event_members')) return { id: 'member-1' }
            if (sql.includes('MAX(sequence)')) return { sequence: 4 }
            throw new Error(`Unexpected first query: ${sql}`)
          },
          async run() {
            inserts.push({ sql, values })
            return { success: true }
          },
        }
        return statement
      },
    }
    const env = { DB: database } as unknown as AppEnv
    const access: EventAccess = {
      eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
      userId: 'owner-1', memberId: 'member-1', displayName: '大会管理者',
      role: 'owner', assignment: '大会管理者', isOwner: true,
    }

    const result = await persistRealtimeOperation(env, access, {
      id: 'drop-1',
      type: 'mark',
      raceId: 'race-1',
      clientTime: '2026-07-18T01:00:00.000Z',
      payload: {
        markId: 'mark-1', actual: [139.46638, 35.29455], status: 'deployed',
        committeeBoatId: 'boat-1', accuracyMetres: 3.2, recordedAt: '2026-07-18T01:00:00.000Z',
        positionSource: 'handheld-gps-manual', coordinateEntryMode: 'dmm-tail-4', coordinateDatum: 'WGS84',
        note: 'Garmin表示から転記',
      },
    }) as { accuracyMetres: number; targetDifferenceMetres: number; positionSource: string; coordinateEntryMode: string; coordinateDatum: string }

    expect(result.accuracyMetres).toBe(3.2)
    expect(result.targetDifferenceMetres).toBeCloseTo(37.7, 0)
    expect(result).toMatchObject({ positionSource: 'handheld-gps-manual', coordinateEntryMode: 'dmm-tail-4', coordinateDatum: 'WGS84' })
    const insert = inserts.find((item) => item.sql.includes('INSERT INTO mark_events'))
    expect(insert?.values[6]).toBe(3.2)
    expect(JSON.parse(insert?.values[12] as string)).toMatchObject({
      source: 'handheld-gps-manual', coordinateEntryMode: 'dmm-tail-4', coordinateDatum: 'WGS84', note: 'Garmin表示から転記',
      originalStatus: 'deployed', targetDifferenceMetres: result.targetDifferenceMetres,
    })
  })

  it('allows another authorized mark boat to verify a deployed mark without the mark assignment', async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = []
    const database = {
      prepare(sql: string) {
        let values: unknown[] = []
        const statement = {
          bind(...nextValues: unknown[]) { values = nextValues; return statement },
          async first() {
            if (sql.includes('SELECT id FROM races')) return { id: 'race-1' }
            if (sql.includes('SELECT status FROM races')) return { status: 'setup' }
            if (sql.includes('SELECT m.id AS mark_id')) {
              return { mark_id: 'mark-1', node_id: 'node-1', label: '1マーク', target_lng: 139.4661, target_lat: 35.2948 }
            }
            if (sql.includes('FROM committee_boats')) return { id: 'verify-boat', name: 'マークボートB', call_sign: '2マーク' }
            if (sql.includes('committee_boat_id = ? LIMIT 1')) return { allowed: 1 }
            if (sql.includes('SELECT id FROM event_members')) return { id: 'verifier-member' }
            if (sql.includes('SELECT event_type, committee_boat_id')) return { event_type: 'dropped', committee_boat_id: 'drop-boat' }
            if (sql.includes('MAX(sequence)')) return { sequence: 2 }
            throw new Error(`Unexpected first query: ${sql}`)
          },
          async run() { inserts.push({ sql, values }); return { success: true } },
        }
        return statement
      },
    }
    const env = { DB: database } as unknown as AppEnv
    const access: EventAccess = {
      eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
      userId: 'verifier-user', memberId: 'verifier-member', displayName: '2マーク担当',
      role: 'mark-boat', assignment: '2マーク', isOwner: false,
    }

    const result = await persistRealtimeOperation(env, access, {
      id: 'verify-mark-position',
      type: 'mark',
      raceId: 'race-1',
      payload: {
        markId: 'mark-1', actual: [139.46612, 35.29481], status: 'confirmed',
        committeeBoatId: 'verify-boat', accuracyMetres: 2.8,
      },
    }) as { status: string; previousCommitteeBoatId: string; independentVerification: boolean }

    expect(result).toMatchObject({
      status: 'confirmed',
      previousCommitteeBoatId: 'drop-boat',
      independentVerification: true,
    })
    const insert = inserts.find((item) => item.sql.includes('INSERT INTO mark_events'))
    expect(JSON.parse(insert?.values[12] as string)).toMatchObject({
      originalStatus: 'confirmed',
      previousCommitteeBoatId: 'drop-boat',
      independentVerification: true,
    })
  })

  it('still rejects moving or recovering a mark outside the member assignment', async () => {
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          async first() {
            if (sql.includes('SELECT id FROM races')) return { id: 'race-1' }
            if (sql.includes('SELECT status FROM races')) return { status: 'setup' }
            if (sql.includes('SELECT m.id AS mark_id')) {
              return { mark_id: 'mark-1', node_id: 'node-1', label: '1マーク', target_lng: 139.4661, target_lat: 35.2948 }
            }
            if (sql.includes('event_member_scopes')) return null
            throw new Error(`Unexpected first query: ${sql}`)
          },
        }
        return statement
      },
    }
    const env = { DB: database } as unknown as AppEnv
    const access: EventAccess = {
      eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
      userId: 'member-2', memberId: 'member-2', displayName: '2マーク担当',
      role: 'mark-boat', assignment: '2マーク', isOwner: false,
    }

    await expect(persistRealtimeOperation(env, access, {
      id: 'recover-other-mark', type: 'mark', raceId: 'race-1',
      payload: { markId: 'mark-1', actual: [139.4661, 35.2948], status: 'recovered' },
    })).rejects.toMatchObject({ status: 403 })
  })

  it('requires an assigned operating boat when a mark-boat member verifies another mark', async () => {
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          async first() {
            if (sql.includes('SELECT id FROM races')) return { id: 'race-1' }
            if (sql.includes('SELECT status FROM races')) return { status: 'setup' }
            if (sql.includes('SELECT m.id AS mark_id')) {
              return { mark_id: 'mark-1', node_id: 'node-1', label: '1マーク', target_lng: 139.4661, target_lat: 35.2948 }
            }
            if (sql.includes('SELECT id FROM event_members')) return { id: 'verifier-member' }
            throw new Error(`Unexpected first query: ${sql}`)
          },
        }
        return statement
      },
    }
    const env = { DB: database } as unknown as AppEnv
    const access: EventAccess = {
      eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
      userId: 'verifier-user', memberId: 'verifier-member', displayName: '2マーク担当',
      role: 'mark-boat', assignment: '2マーク', isOwner: false,
    }

    await expect(persistRealtimeOperation(env, access, {
      id: 'verify-without-boat', type: 'mark', raceId: 'race-1',
      payload: { markId: 'mark-1', actual: [139.4661, 35.2948], status: 'confirmed' },
    })).rejects.toMatchObject({ status: 400 })
  })

  it('rejects mark edits by members after race finalization', async () => {
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          async first() {
            if (sql.includes('SELECT id FROM races')) return { id: 'race-1' }
            if (sql.includes('SELECT status FROM races')) return { status: 'finalized' }
            throw new Error(`Unexpected first query: ${sql}`)
          },
        }
        return statement
      },
    }
    const env = { DB: database } as unknown as AppEnv
    const access: EventAccess = {
      eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
      userId: 'member-1', memberId: 'member-1', displayName: 'マーク担当',
      role: 'mark-boat', assignment: '1マーク', isOwner: false,
    }

    await expect(persistRealtimeOperation(env, access, {
      id: 'move-after-finalization', type: 'mark', raceId: 'race-1',
      payload: { markId: 'mark-1', actual: [139.4661, 35.2948], status: 'moved' },
    })).rejects.toMatchObject({ status: 409 })
  })

  it('requires the dedicated revision workflow even for the event owner after finalization', async () => {
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          async first() {
            if (sql.includes('SELECT id FROM races')) return { id: 'race-1' }
            if (sql.includes('SELECT status FROM races')) return { status: 'finalized' }
            throw new Error(`Unexpected first query: ${sql}`)
          },
        }
        return statement
      },
    }
    const env = { DB: database } as unknown as AppEnv
    const access: EventAccess = {
      eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
      userId: 'owner-1', memberId: 'member-1', displayName: '大会管理者',
      role: 'owner', assignment: '大会管理者', isOwner: true,
    }

    await expect(persistRealtimeOperation(env, access, {
      id: 'owner-move-after-finalization', type: 'mark', raceId: 'race-1',
      payload: { markId: 'mark-1', actual: [139.4661, 35.2948], status: 'moved' },
    })).rejects.toMatchObject({ status: 409 })
  })
})
