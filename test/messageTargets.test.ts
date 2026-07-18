import { describe, expect, it } from 'vitest'
import type { EventAccess } from '../worker/authorization'
import type { AppEnv } from '../worker/index'
import { persistRealtimeOperation } from '../worker/operations'

describe('operational message targets', () => {
  it('resolves a race-area target and creates receipts only for its operations members', async () => {
    const prepared: Array<{ sql: string; values: unknown[] }> = []
    const database = {
      prepare(sql: string) {
        const record = { sql, values: [] as unknown[] }
        prepared.push(record)
        const statement = {
          bind(...values: unknown[]) {
            record.values = values
            return statement
          },
          async first() {
            if (sql.includes("status = 'active' LIMIT 1")) return { id: 'member-sender' }
            if (sql.includes('SELECT name FROM race_areas')) return { name: '海面B' }
            if (sql.includes('COUNT(*) AS target_count')) {
              return { target_count: 2, delivered_count: 2, read_count: 0, acknowledged_count: 0 }
            }
            throw new Error(`Unexpected first query: ${sql}`)
          },
          async all() {
            if (sql.includes('SELECT DISTINCT member.id')) {
              return { results: [{ id: 'member-b1' }, { id: 'member-b2' }] }
            }
            throw new Error(`Unexpected all query: ${sql}`)
          },
        }
        return statement
      },
      async batch() {
        return []
      },
    }
    const env = { DB: database } as unknown as AppEnv
    const access: EventAccess = {
      eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
      userId: 'user-1', memberId: 'member-sender', displayName: 'PRO',
      role: 'pro', assignment: 'PRO', isOwner: false,
    }

    const result = await persistRealtimeOperation(env, access, {
      id: 'message-1',
      type: 'message',
      raceId: 'race-2',
      clientTime: '2026-07-18T02:00:00.000Z',
      payload: {
        body: '海面BはAPを掲揚してください',
        priority: 'confirm',
        targetType: 'area',
        targetId: 'area-b',
      },
    }) as {
      channel: string
      target: { type: string; id: string; label: string }
      recipientMemberIds: string[]
      receipts: { targetCount: number }
    }

    expect(result.channel).toBe('area:area-b')
    expect(result.target).toEqual({ type: 'area', id: 'area-b', label: '海面B・全運営' })
    expect(result.recipientMemberIds).toEqual(['member-b1', 'member-b2'])
    expect(result.receipts.targetCount).toBe(2)
    const recipientQuery = prepared.find((item) => item.sql.includes('SELECT DISTINCT member.id'))
    expect(recipientQuery?.values).toEqual(['event-1', 'member-sender', 'event-1', 'area-b', 'area-b', 'area-b'])
    expect(prepared.filter((item) => item.sql.includes('INSERT INTO message_receipts'))).toHaveLength(2)
  })
})
