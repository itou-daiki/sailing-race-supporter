import { describe, expect, it } from 'vitest'
import { bearingDegrees, distanceMetres, estimateEtaSeconds, generateCoursePlan, headingDifferenceDegrees, midpoint, recommendedCourseLength } from '../src/course'

describe('course calculations', () => {
  it('calculates a short geodesic distance', () => {
    const distance = distanceMetres([139.46, 35.28], [139.461, 35.28])
    expect(distance).toBeGreaterThan(89)
    expect(distance).toBeLessThan(93)
  })

  it('returns a northward bearing', () => {
    expect(bearingDegrees([139.46, 35.28], [139.46, 35.29])).toBeCloseTo(0, 4)
  })

  it('calculates the signed shortest turn and omits low-speed ETA', () => {
    expect(headingDifferenceDegrees(350, 10)).toBe(20)
    expect(headingDifferenceDegrees(10, 350)).toBe(-20)
    expect(estimateEtaSeconds(926, 5)).toBeCloseTo(360, 0)
    expect(estimateEtaSeconds(100, 0.2)).toBeUndefined()
  })

  it('calculates a gate center without creating racing-yacht telemetry', () => {
    expect(midpoint([139.46, 35.28], [139.462, 35.282])).toEqual([139.461, 35.281])
  })

  it('uses the selected class target time without measuring racing yacht speed', () => {
    const shortRace = recommendedCourseLength('470', 8, 45)
    const longRace = recommendedCourseLength('470', 8, 50)
    expect(longRace.nauticalMiles).toBeGreaterThan(shortRace.nauticalMiles)
    expect(longRace.confidence).toBe('low')
  })

  it('creates separate upper and lower gate marks around the wind axis', () => {
    const plan = generateCoursePlan({
      center: [139.46, 35.28],
      windDirection: 350,
      totalLengthMetres: 5_000,
      courseCode: 'O2',
      lowerGate: true,
      upperGate: true,
    })
    expect(plan.map((node) => node.key)).toEqual(expect.arrayContaining(['mark-1s', 'mark-1p', 'mark-3s', 'mark-3p']))
    const upper = plan.filter((node) => node.key === 'mark-1s' || node.key === 'mark-1p')
    expect(distanceMetres(upper[0].target, upper[1].target)).toBeGreaterThan(65)
  })

  it('omits trapezoid reach marks from a windward-leeward course', () => {
    const plan = generateCoursePlan({
      center: [139.46, 35.28],
      windDirection: 0,
      totalLengthMetres: 4_000,
      courseCode: 'W2',
      lowerGate: false,
      upperGate: false,
    })
    expect(plan.some((node) => node.key === 'mark-2')).toBe(false)
    expect(plan.some((node) => node.key === 'mark-3')).toBe(true)
  })
})
