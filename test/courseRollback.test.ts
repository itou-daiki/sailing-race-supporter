import { describe, expect, it } from 'vitest'
import { can, type EventAccess } from '../worker/authorization'
import { rollbackCourseRevision } from '../worker/courses'
import type { AppEnv } from '../worker/index'
import { persistRealtimeOperation } from '../worker/operations'

describe('course revision rollback', () => {
  it('copies an old course into a new append-only revision and audits the source version', async () => {
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
            if (sql.includes('FROM course_revisions WHERE race_id = ? AND revision = ?')) {
              return {
                id: 'course-v2', revision: 2, course_code: 'L2', wind_direction: 215,
                wind_speed: 10.5, target_length_metres: 4_800,
                gate_config_json: '{"lower":true,"upper":false,"second":false}',
              }
            }
            if (sql.includes('COALESCE(MAX(revision)')) return { revision: 4 }
            if (sql.includes('FROM audit_events')) return { sequence: 8, event_hash: 'audit-head' }
            throw new Error(`Unexpected first query: ${sql}`)
          },
          async all() {
            if (sql.includes('FROM course_nodes')) {
              return { results: [
                { mark_id: 'start', node_order: 1, label: 'スタート・ピン', node_type: 'start', rounding: null, target_lng: 139.4, target_lat: 35.2 },
                { mark_id: 'one', node_order: 2, label: '1マーク', node_type: 'single', rounding: 'port', target_lng: 139.41, target_lat: 35.21 },
                { mark_id: 'finish', node_order: 3, label: 'シグナルボート', node_type: 'start', rounding: null, target_lng: 139.4, target_lat: 35.2 },
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

    const response = await rollbackCourseRevision(
      { DB: database } as unknown as AppEnv,
      access,
      'race-1',
      2,
    )
    const body = await response.json() as {
      revisionId: string; revision: number; sourceRevision: number; courseCode: string
    }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ revision: 5, sourceRevision: 2, courseCode: 'L2' })
    expect(batchSize).toBe(6)
    expect(prepared.find((item) => item.sql.includes("SET status = 'superseded'"))?.values).toEqual(['race-1', 4])
    expect(prepared.find((item) => item.sql.includes('INSERT INTO course_revisions'))?.values).toEqual([
      body.revisionId, 'race-1', 5, 'L2', 215, 10.5, 4_800,
      '{"lower":true,"upper":false,"second":false}', 2, 'owner-1', expect.any(String),
    ])
    expect(prepared.find((item) => item.sql.includes('UPDATE races SET course_code'))?.values).toEqual([
      'L2', expect.any(String), 'race-1', 'event-1',
    ])
    expect(prepared.filter((item) => item.sql.includes('INSERT INTO course_nodes'))).toHaveLength(3)
    const auditInsert = prepared.find((item) => item.sql.includes('INSERT INTO audit_events'))
    expect(auditInsert?.values[6]).toBe('course.revision.rollback')
    expect(auditInsert?.values[8]).toBe(body.revisionId)
    expect(auditInsert?.values[11]).toBe('コース第2版を新しい第5版として復元')
  })

  it('allows course setters to announce the authoritative latest revision', async () => {
    const access: EventAccess = {
      eventId: 'event-1', eventSlug: 'summer', eventName: 'Summer Regatta',
      userId: 'setter-1', memberId: 'member-setter', displayName: 'コースセッター',
      role: 'course-setter', assignment: 'コースセッター', isOwner: false,
    }
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          async first() {
            if (sql.includes('SELECT id FROM races')) return { id: 'race-1' }
            if (sql.includes('FROM course_revisions')) {
              return { id: 'course-v5', revision: 5, course_code: 'L2', created_at: '2026-07-18T05:00:00.000Z' }
            }
            throw new Error(`Unexpected first query: ${sql}`)
          },
        }
        return statement
      },
    }

    expect(can(access, 'course')).toBe(true)
    expect(can({ ...access, role: 'mark-boat' }, 'course')).toBe(false)
    await expect(persistRealtimeOperation(
      { DB: database } as unknown as AppEnv,
      access,
      { id: 'course-refresh-1', type: 'course', raceId: 'race-1', payload: { revisionId: 'course-v5' } },
    )).resolves.toMatchObject({
      action: 'refresh', revisionId: 'course-v5', revision: 5, courseCode: 'L2', changedBy: 'コースセッター',
    })
  })

  it('records a rollback after finalization as a new linked finalization version', async () => {
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
            if (sql.includes('FROM course_revisions WHERE race_id = ? AND revision = ?')) {
              return {
                id: 'course-v1', revision: 1, course_code: 'O2', wind_direction: 220,
                wind_speed: 9, target_length_metres: 4_500, gate_config_json: '{}',
              }
            }
            if (sql.includes('COALESCE(MAX(revision)')) return { revision: 3 }
            if (sql.includes('FROM races WHERE id')) {
              return {
                id: 'race-1', race_number: '1R', class_name: '470', course_code: 'L2',
                target_minutes: 50, warning_at: '2026-07-18T01:00:00.000Z', status: 'finalized',
                finalized_revision: 3, finalized_at: '2026-07-18T03:00:00.000Z',
              }
            }
            if (sql.includes('FROM race_finalizations')) return { id: 'final-v3', revision: 3, state_hash: 'state-v3' }
            if (sql.includes('FROM audit_events')) return { sequence: 11, event_hash: 'audit-head' }
            throw new Error(`Unexpected first query: ${sql}`)
          },
          async all() {
            if (sql.includes('FROM course_nodes')) {
              return { results: [
                { mark_id: 'pin', node_order: 1, label: 'スタート・ピン', node_type: 'start', rounding: null, target_lng: 139.4, target_lat: 35.2 },
                { mark_id: 'one', node_order: 2, label: '1マーク', node_type: 'single', rounding: 'port', target_lng: 139.41, target_lat: 35.21 },
                { mark_id: 'rc', node_order: 3, label: 'シグナルボート', node_type: 'start', rounding: null, target_lng: 139.4, target_lat: 35.2 },
              ] }
            }
            throw new Error(`Unexpected all query: ${sql}`)
          },
          async run() { return { success: true } },
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

    const response = await rollbackCourseRevision(
      { DB: database } as unknown as AppEnv,
      access,
      'race-1',
      1,
      true,
    )
    const body = await response.json() as {
      revisionId: string; revision: number; finalizedRevision: number; stateHash: string
    }

    expect(body.revision).toBe(4)
    expect(body.finalizedRevision).toBe(4)
    expect(body.stateHash).toEqual(expect.any(String))
    expect(batchSize).toBe(9)
    expect(prepared.find((item) => item.sql.includes('INSERT INTO race_finalizations'))?.values).toEqual([
      expect.any(String), 'race-1', 4, body.stateHash,
      'コース第1版を新しい第4版として復元', 'owner-1', expect.any(String), 'final-v3',
    ])
    const correction = prepared.find((item) => item.sql.includes('INSERT INTO post_finalization_revisions'))
    expect(JSON.parse(String(correction?.values[3]))).toMatchObject({
      courseCode: 'O2', courseRevisionId: body.revisionId, courseRevision: 4, sourceCourseRevision: 1,
    })
    expect(prepared.find((item) => item.sql.includes('UPDATE races SET finalized_revision'))?.values).toEqual([
      4, expect.any(String), 'owner-1', expect.any(String), 'race-1', 'event-1',
    ])
    const auditInsert = prepared.find((item) => item.sql.includes('INSERT INTO audit_events'))
    expect(auditInsert?.values[6]).toBe('race.post-finalization-revision')
    expect(auditInsert?.values[8]).toBe('race-1')
  })
})
