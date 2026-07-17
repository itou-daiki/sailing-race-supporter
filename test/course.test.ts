import { describe, expect, it } from 'vitest'
import { bearingDegrees, distanceMetres, recommendedCourseLength } from '../src/course'

describe('course calculations', () => {
  it('calculates a short geodesic distance', () => {
    const distance = distanceMetres([139.46, 35.28], [139.461, 35.28])
    expect(distance).toBeGreaterThan(89)
    expect(distance).toBeLessThan(93)
  })

  it('returns a northward bearing', () => {
    expect(bearingDegrees([139.46, 35.28], [139.46, 35.29])).toBeCloseTo(0, 4)
  })

  it('uses the selected class target time without measuring racing yacht speed', () => {
    const shortRace = recommendedCourseLength('470', 8, 45)
    const longRace = recommendedCourseLength('470', 8, 50)
    expect(longRace.nauticalMiles).toBeGreaterThan(shortRace.nauticalMiles)
    expect(longRace.confidence).toBe('low')
  })
})
