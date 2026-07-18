import { describe, expect, it } from 'vitest'
import type { EventAccess } from '../worker/authorization'
import { assignRaceToArea } from '../worker/areas'
import type { AppEnv } from '../worker/index'

describe('multi-area race operations', () => {
  it('moves a planning race by appending a course revision mapped to the destination marks', async () => {
    const prepared: Array<{ sql: string; values: unknown[] }> = []
    let batchSize = 0
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
            if (sql.includes('FROM races race JOIN race_areas')) {
              return {
                id: 'race-2', race_number: '2R', race_area_id: 'area-a', status: 'planning',
                area_name: '海面A', center_lng: 139, center_lat: 35,
              }
            }
            if (sql.includes('FROM race_areas WHERE id')) {
              return { id: 'area-b', name: '海面B', center_lng: 140, center_lat: 36 }
            }
            if (sql.includes('AS event_count')) return { event_count: 0 }
            if (sql.includes('FROM course_revisions')) {
              return {
                id: 'course-v1', revision: 1, course_code: 'O2', wind_direction: 350,
                wind_speed: 8, target_length_metres: 3_000,
                gate_config_json: '{"lower":true,"upper":false,"second":false}',
              }
            }
            if (sql.includes('FROM audit_events')) return { sequence: 4, event_hash: 'audit-head' }
            throw new Error(`Unexpected first query: ${sql}`)
          },
          async all() {
            if (sql.includes('FROM course_nodes')) {
              return { results: [
                { node_order: 1, label: 'スタート・ピン', node_type: 'start', rounding: null, target_lng: 139.1, target_lat: 35.1 },
                { node_order: 2, label: '1マーク', node_type: 'single', rounding: 'port', target_lng: 139.2, target_lat: 35.2 },
                { node_order: 3, label: 'シグナルボート', node_type: 'start', rounding: null, target_lng: 139.3, target_lat: 35.3 },
              ] }
            }
            if (sql.includes('SELECT id, label FROM marks')) {
              return { results: [
                { id: 'b-pin', label: 'スタート・ピン' },
                { id: 'b-one', label: '1マーク' },
                { id: 'b-rc', label: 'シグナルボート' },
              ] }
            }
            throw new Error(`Unexpected all query: ${sql}`)
          },
          async run() {
            return { success: true }
          },
        }
        return statement
      },
      async batch(statements: unknown[]) {
        batchSize = statements.length
        return []
      },
    }
    const access: EventAccess = {
      eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
      userId: 'owner-1', memberId: 'owner:owner-1', displayName: '大会管理者',
      role: 'owner', assignment: '大会管理者', isOwner: true,
    }

    const response = await assignRaceToArea(
      { DB: database } as unknown as AppEnv,
      access,
      'race-2',
      'area-b',
    )
    const result = await response.json() as { revisionId: string; revision: number; raceAreaId: string; areaName: string }

    expect(result).toMatchObject({ revision: 2, raceAreaId: 'area-b', areaName: '海面B' })
    expect(batchSize).toBe(6)
    expect(prepared.find((item) => item.sql.includes("UPDATE course_revisions SET status"))?.values).toEqual(['course-v1', 'race-2'])
    expect(prepared.find((item) => item.sql.includes('UPDATE races SET race_area_id'))?.values).toEqual([
      'area-b', expect.any(String), 'race-2', 'event-1',
    ])
    const copiedNodes = prepared.filter((item) => item.sql.includes('INSERT INTO course_nodes'))
    expect(copiedNodes).toHaveLength(3)
    expect(copiedNodes[0].values.slice(2)).toEqual([
      'b-pin', 1, 'スタート・ピン', 'start', null, 140.1, 36.1,
    ])
    expect(copiedNodes[1].values.slice(2)).toEqual([
      'b-one', 2, '1マーク', 'single', 'port', 140.2, 36.2,
    ])
    const auditInsert = prepared.find((item) => item.sql.includes('INSERT INTO audit_events'))
    expect(auditInsert?.values[6]).toBe('race-area.assign')
    expect(auditInsert?.values[8]).toBe('race-2')
    expect(auditInsert?.values[11]).toBe('2Rを海面Bへ移動')
  })

  it('rejects area changes once race operations have started', async () => {
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          async first() {
            if (sql.includes('FROM races race JOIN race_areas')) {
              return {
                id: 'race-2', race_number: '2R', race_area_id: 'area-a', status: 'setup',
                area_name: '海面A', center_lng: 139, center_lat: 35,
              }
            }
            throw new Error(`Unexpected query after race status guard: ${sql}`)
          },
        }
        return statement
      },
    }
    const access: EventAccess = {
      eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
      userId: 'owner-1', memberId: 'owner:owner-1', displayName: '大会管理者',
      role: 'owner', assignment: '大会管理者', isOwner: true,
    }
    const response = await assignRaceToArea(
      { DB: database } as unknown as AppEnv,
      access,
      'race-2',
      'area-b',
    )
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('開始する前') })
  })
})
