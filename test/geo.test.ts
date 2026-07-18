import { describe, expect, it } from 'vitest'
import { geodesicDistanceMetres } from '../shared/geo'

describe('geodesic distance', () => {
  it('returns zero for identical mark positions', () => {
    expect(geodesicDistanceMetres([139.4661, 35.2948], [139.4661, 35.2948])).toBe(0)
  })

  it('computes a stable metre distance for a nearby drop position', () => {
    expect(geodesicDistanceMetres([139.4661, 35.2948], [139.46638, 35.29455])).toBeCloseTo(37.7, 0)
  })
})
