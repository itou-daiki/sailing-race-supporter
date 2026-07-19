import { describe, expect, it } from 'vitest'
import type { CourseMark, WindObservation } from '../src/domain'
import { assignWindReadingsToMarks, formatWindSpeedDual, knotsToMetresPerSecond } from '../src/markWind'

const marks: CourseMark[] = [
  { id: 'm1', label: '1マーク', shortLabel: '1', target: [131.522, 33.288], status: 'planned', assignedBoatId: 'boat-1' },
  { id: 'm2', label: '2マーク', shortLabel: '2', target: [131.532, 33.282], status: 'planned' },
]

function wind(overrides: Partial<WindObservation>): WindObservation {
  return {
    directionDegrees: 350,
    speedKnots: 8.4,
    gustKnots: 9,
    observedAt: '2026-07-20T00:00:00.000Z',
    source: 'マークボート',
    trend: 'steady',
    ...overrides,
  }
}

describe('mark wind readings', () => {
  it('shows knots and metres per second from one canonical conversion', () => {
    expect(knotsToMetresPerSecond(10)).toBeCloseTo(5.14444, 5)
    expect(formatWindSpeedDual(8.4)).toBe('8.4 kt / 4.3 m/s')
  })

  it('prefers the latest reading from the assigned mark boat', () => {
    const readings = assignWindReadingsToMarks(marks, [
      wind({ committeeBoatId: 'boat-1', speedKnots: 7, observedAt: '2026-07-20T00:01:00.000Z' }),
      wind({ committeeBoatId: 'boat-1', speedKnots: 8, observedAt: '2026-07-20T00:02:00.000Z' }),
    ])
    expect(readings.get('m1')?.observation.speedKnots).toBe(8)
    expect(readings.get('m1')?.association).toBe('assigned-boat')
  })

  it('uses a nearby positioned observation when no boat assignment exists', () => {
    const readings = assignWindReadingsToMarks(marks, [
      wind({ committeeBoatId: 'boat-2', position: [131.5321, 33.2821] }),
    ])
    expect(readings.get('m2')?.association).toBe('nearest-observation')
  })
})
