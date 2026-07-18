import { describe, expect, it } from 'vitest'
import type { EventAccess } from '../worker/authorization'
import type { AppEnv } from '../worker/index'
import { authorizeCommitteeBoat, persistRealtimeOperation } from '../worker/operations'

function access(isOwner: boolean): EventAccess {
  return {
    eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
    userId: isOwner ? 'owner-1' : 'user-1', memberId: isOwner ? 'owner-member' : 'member-1',
    displayName: isOwner ? '大会管理者' : '担当者', role: isOwner ? 'owner' : 'mark-boat',
    assignment: isOwner ? '大会管理者' : '1マーク', isOwner,
  }
}

describe('member assignment changes', () => {
  it('replaces scopes, derives the area from the mark, and appends before/after audit evidence', async () => {
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
            if (sql.includes('SELECT id, display_name, role, assignment')) {
              return { id: 'member-2', display_name: '佐藤', role: 'mark-boat', assignment: '1マーク' }
            }
            if (sql.includes('SELECT id FROM committee_boats')) return { id: 'boat-2' }
            if (sql.includes('SELECT id, race_area_id FROM marks')) return { id: 'mark-2', race_area_id: 'area-b' }
            if (sql.includes('FROM audit_events')) return { sequence: 7, event_hash: 'previous-hash' }
            throw new Error(`Unexpected first query: ${sql}`)
          },
          async all() {
            if (sql.includes('FROM event_member_scopes')) {
              return { results: [{ race_area_id: 'area-a', committee_boat_id: 'boat-1', mark_id: 'mark-1' }] }
            }
            throw new Error(`Unexpected all query: ${sql}`)
          },
          async run() {
            return { success: true }
          },
        }
        return statement
      },
      async batch() {
        return []
      },
    }

    const result = await persistRealtimeOperation({ DB: database } as unknown as AppEnv, access(true), {
      id: 'assignment-operation-1',
      type: 'assignment',
      clientTime: '2026-07-18T03:00:00.000Z',
      payload: {
        memberId: 'member-2', assignment: '2マーク', committeeBoatId: 'boat-2', markId: 'mark-2',
        reason: '2Rのマーク担当を交代',
      },
    }) as { memberId: string; assignment: string; raceAreaId: string; markId: string }

    expect(result).toMatchObject({ memberId: 'member-2', assignment: '2マーク', raceAreaId: 'area-b', markId: 'mark-2' })
    expect(prepared.find((item) => item.sql.includes('UPDATE event_members'))?.values).toEqual(['2マーク', 'member-2', 'event-1'])
    expect(prepared.find((item) => item.sql.includes('DELETE FROM event_member_scopes'))?.values).toEqual(['member-2'])
    expect(prepared.find((item) => item.sql.includes('INSERT INTO event_member_scopes'))?.values.slice(1, 5)).toEqual([
      'member-2', 'area-b', 'boat-2', 'mark-2',
    ])
    const auditInsert = prepared.find((item) => item.sql.includes('INSERT INTO audit_events'))
    expect(auditInsert?.values[6]).toBe('member.assignment.update')
    expect(auditInsert?.values[8]).toBe('member-2')
    expect(auditInsert?.values[11]).toBe('2Rのマーク担当を交代')
  })

  it('rejects a non-owner before reading member data', async () => {
    await expect(persistRealtimeOperation({ DB: {} } as AppEnv, access(false), {
      id: 'assignment-operation-2', type: 'assignment', payload: { memberId: 'member-2', assignment: '2マーク' },
    })).rejects.toMatchObject({ status: 403 })
  })

  it('does not trust a stale assignment label after the scope was removed', async () => {
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          async first() {
            if (sql.includes('FROM committee_boats')) return { id: 'boat-1', name: 'マークボートA', call_sign: '1マーク' }
            if (sql.includes('FROM event_member_scopes')) return null
            throw new Error(`Unexpected first query: ${sql}`)
          },
        }
        return statement
      },
    }
    await expect(authorizeCommitteeBoat(
      { DB: database } as unknown as AppEnv,
      access(false),
      'boat-1',
    )).rejects.toMatchObject({ status: 403 })
  })
})
