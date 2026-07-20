import { describe, expect, it } from 'vitest'
import type { EventAccess } from '../worker/authorization'
import type { AppEnv } from '../worker/index'
import { persistRealtimeOperation } from '../worker/operations'

const access: EventAccess = {
  eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
  userId: 'user-1', memberId: 'member-1', displayName: '1マーク担当',
  role: 'mark-boat', assignment: '1マーク', isOwner: false,
}

function operation(markId: string) {
  return {
    id: 'wind-1', type: 'wind' as const, raceId: 'race-1', clientTime: '2026-07-20T08:30:00.000Z',
    payload: {
      markId, directionDegrees: 332, speedKnots: 9.4, gustKnots: 11,
      averagingSeconds: 60, confidence: 'high', observedAt: '2026-07-20T08:30:00.000Z',
    },
  }
}

describe('mark wind persistence', () => {
  it('stores the assigned mark explicitly with the observation', async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = []
    const database = {
      prepare(sql: string) {
        let values: unknown[] = []
        const statement = {
          bind(...nextValues: unknown[]) { values = nextValues; return statement },
          async first() {
            if (sql.includes('SELECT id FROM event_members')) return { id: 'member-1' }
            if (sql.includes('SELECT mark.id FROM marks')) return { id: 'mark-1' }
            if (sql.includes('FROM event_member_scopes')) return { allowed: 1 }
            throw new Error(`Unexpected first query: ${sql}`)
          },
          async run() { inserts.push({ sql, values }); return { success: true } },
        }
        return statement
      },
    }

    const result = await persistRealtimeOperation({ DB: database } as unknown as AppEnv, access, operation('mark-1')) as {
      markId: string; directionDegrees: number; speedKnots: number
    }

    expect(result).toMatchObject({ markId: 'mark-1', directionDegrees: 332, speedKnots: 9.4 })
    const insert = inserts.find((item) => item.sql.includes('INSERT INTO wind_observations'))
    expect(insert?.values[5]).toBe('mark-1')
  })

  it('rejects a different mark outside the member scope', async () => {
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          async first() {
            if (sql.includes('SELECT id FROM event_members')) return { id: 'member-1' }
            if (sql.includes('SELECT mark.id FROM marks')) return { id: 'mark-2' }
            if (sql.includes('FROM event_member_scopes')) return null
            throw new Error(`Unexpected first query: ${sql}`)
          },
        }
        return statement
      },
    }

    await expect(persistRealtimeOperation(
      { DB: database } as unknown as AppEnv,
      access,
      operation('mark-2'),
    )).rejects.toMatchObject({ status: 403 })
  })
})
