import { describe, expect, it } from 'vitest'
import { geodesicDistanceMetres, geodesicMidpoint, trueBearingDegrees } from '../shared/geo'

describe('geodesic distance', () => {
  it('returns zero for identical mark positions', () => {
    expect(geodesicDistanceMetres([139.4661, 35.2948], [139.4661, 35.2948])).toBe(0)
  })

  it('computes a stable metre distance for a nearby drop position', () => {
    expect(geodesicDistanceMetres([139.4661, 35.2948], [139.46638, 35.29455])).toBeCloseTo(37.7, 0)
  })

  it('computes a true bearing and midpoint for a gate line', () => {
    expect(trueBearingDegrees([139, 35], [139.001, 35])).toBeCloseTo(90, 2)
    const center = geodesicMidpoint([139, 35], [139.001, 35])
    expect(center[0]).toBeCloseTo(139.0005, 7)
    expect(center[1]).toBeCloseTo(35, 7)
  })
})
