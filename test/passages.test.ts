import { describe, expect, it } from 'vitest'
import { adoptPassageObservation, latestPassageSummary, mergePassageObservation, passageVisitKey } from '../src/passages'

describe('leading passage observations', () => {
  it('keeps every observer and warns when observations differ by more than two seconds', () => {
    const first = mergePassageObservation(undefined, 'race-1', 'mark-1', 1, {
      id: 'first', passedAt: '2026-07-18T01:00:00.000Z', recordedBy: 'A',
      syncQuality: 'good', wasOffline: false, status: 'active',
    })
    const second = mergePassageObservation(first, 'race-1', 'mark-1', 1, {
      id: 'second', passedAt: '2026-07-18T01:00:02.001Z', recordedBy: 'B',
      syncQuality: 'offline', wasOffline: true, status: 'active',
    })
    expect(second.observations).toHaveLength(2)
    expect(second.spreadMilliseconds).toBe(2_001)
    expect(second.hasConflict).toBe(true)
  })

  it('adopts one immutable observation without discarding the others', () => {
    const visit = mergePassageObservation(undefined, 'race-1', 'mark-1', 2, {
      id: 'first', passedAt: '2026-07-18T01:00:00.000Z', recordedBy: 'A',
      syncQuality: 'good', wasOffline: false, status: 'active',
    })
    const adopted = adoptPassageObservation(visit, 'first', '2026-07-18T01:01:00.000Z')
    expect(adopted.adoptedObservationId).toBe('first')
    expect(adopted.observations).toHaveLength(1)
    expect(passageVisitKey('race-1', 'mark-1', 2)).toBe('race-1:mark-1:2')
  })

  it('summarizes the newest passage for the active race and prefers its adopted observation', () => {
    const first = mergePassageObservation(undefined, 'race-1', 'mark-1', 1, {
      id: 'early', passedAt: '2026-07-18T01:00:00.000Z', recordedBy: 'A',
      syncQuality: 'good', wasOffline: false, status: 'active',
    })
    const conflicting = mergePassageObservation(first, 'race-1', 'mark-1', 1, {
      id: 'late', passedAt: '2026-07-18T01:00:03.000Z', recordedBy: 'B',
      syncQuality: 'good', wasOffline: false, status: 'active',
    })
    const adopted = adoptPassageObservation(conflicting, 'early', '2026-07-18T01:01:00.000Z')
    const summary = latestPassageSummary({ visit: adopted }, [{
      id: 'mark-1', label: '1マーク', shortLabel: '1', target: [139, 35], status: 'confirmed',
    }], 'race-1')
    expect(summary).toMatchObject({
      markId: 'mark-1', markLabel: '1', passedAt: '2026-07-18T01:00:00.000Z', adopted: true, hasConflict: true,
    })
    expect(latestPassageSummary({ visit: adopted }, [], 'race-2')).toBeUndefined()
  })
})
