import { describe, expect, it } from 'vitest'
import type { FinishObservation } from '../src/domain'
import { adoptFinishObservation, finishRecordKey, mergeFinishObservation } from '../src/finishes'

function observation(id: string, finishedAt: string): FinishObservation {
  return {
    id,
    finishPosition: 1,
    finishedAt,
    recordedBy: 'タイムキーパー',
    syncQuality: 'good',
    wasOffline: false,
    status: 'active',
  }
}

describe('first finish observations', () => {
  it('keeps every observation and raises a conflict above two seconds', () => {
    const first = mergeFinishObservation(undefined, 'race-1', 1, observation('a', '2026-07-18T01:00:00.000Z'))
    const second = mergeFinishObservation(first, 'race-1', 1, observation('b', '2026-07-18T01:00:02.500Z'))
    expect(second.observations).toHaveLength(2)
    expect(second.spreadMilliseconds).toBe(2_500)
    expect(second.hasConflict).toBe(true)
  })

  it('adopts one observation without deleting alternatives', () => {
    const record = mergeFinishObservation(undefined, 'race-1', 1, observation('a', '2026-07-18T01:00:00.000Z'))
    const adopted = adoptFinishObservation(record, 'a', '2026-07-18T01:00:10.000Z')
    expect(finishRecordKey('race-1')).toBe('race-1:1')
    expect(adopted.adoptedObservationId).toBe('a')
    expect(adopted.observations).toHaveLength(1)
  })
})
