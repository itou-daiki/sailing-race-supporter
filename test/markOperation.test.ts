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
      },
    }) as { accuracyMetres: number; targetDifferenceMetres: number }

    expect(result.accuracyMetres).toBe(3.2)
    expect(result.targetDifferenceMetres).toBeCloseTo(37.7, 0)
    const insert = inserts.find((item) => item.sql.includes('INSERT INTO mark_events'))
    expect(insert?.values[6]).toBe(3.2)
    expect(JSON.parse(insert?.values[12] as string)).toMatchObject({
      source: 'web', originalStatus: 'deployed', targetDifferenceMetres: result.targetDifferenceMetres,
    })
  })
})
