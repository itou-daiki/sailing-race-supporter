import { describe, expect, it } from 'vitest'
import { bearingDegrees, distanceMetres, estimateEtaSeconds, firstLegLengthMetresFromTotal, generateCoursePlan, headingDifferenceDegrees, midpoint, recommendedCourseLength } from '../src/course'
import { DEMO_RACES } from '../src/domain'

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
    expect(longRace.kilometres).toBeCloseTo(longRace.firstLegKilometres * 4.4 + 0.15 * 1.852, 6)
    expect(longRace.legSpeedsKnots.closeHauledVmg).toBeCloseTo(5.1, 6)
    expect(longRace.legSpeedsKnots.reach).toBeCloseTo(7.3, 6)
    expect(longRace.legSpeedsKnots.downwindVmg).toBeCloseTo(6.6, 6)
    expect(
      longRace.legDistanceShare.closeHauled + longRace.legDistanceShare.reach + longRace.legDistanceShare.downwind,
    ).toBeCloseTo(1, 6)
  })

  it('uses the real point-of-sail mix for reach-heavy and windward-leeward routes', () => {
    const triangle = recommendedCourseLength('スナイプ', 8, undefined, 'T2')
    const windwardLeeward = recommendedCourseLength('スナイプ', 8, undefined, 'W2')

    expect(triangle.legDistanceShare.reach).toBeGreaterThan(0.6)
    expect(windwardLeeward.legDistanceShare.reach).toBeLessThan(0.1)
    expect(triangle.kilometres).toBeCloseTo(triangle.firstLegKilometres * 5.3 + 0.05 * 1.852, 6)
    expect(windwardLeeward.kilometres).toBeCloseTo(windwardLeeward.firstLegKilometres * 4.13 + 0.05 * 1.852, 6)
  })

  it('keeps a decided start line and recommends marks from its midpoint', () => {
    const pin = [131.5201, 33.2781] as const
    const signal = [131.5231, 33.2781] as const
    const plan = generateCoursePlan({
      center: [131.5, 33.2],
      startLine: { pin, signal },
      windDirection: 0,
      totalLengthMetres: 5_400,
      courseCode: 'O2',
      className: '470',
      lowerGate: true,
      upperGate: false,
    })

    expect(plan.find((node) => node.key === 'start-pin')?.target).toEqual(pin)
    expect(plan.find((node) => node.key === 'start-rc')?.target).toEqual(signal)
    const mark1 = plan.find((node) => node.key === 'mark-1')
    expect(mark1).toBeDefined()
    expect(bearingDegrees(midpoint(pin, signal), mark1!.target)).toBeCloseTo(0, 1)
    expect(distanceMetres(midpoint(pin, signal), mark1!.target)).toBeCloseTo(
      firstLegLengthMetresFromTotal(5_400, 'O2', '470'),
      -1,
    )
  })

  it('creates a separate O2 finish line square to the final reach', () => {
    const plan = generateCoursePlan({
      center: [131.5221959, 33.2786648],
      windDirection: 0,
      windSpeed: 8,
      totalLengthMetres: 5_400,
      courseCode: 'O2',
      className: '470',
      lowerGate: true,
      upperGate: false,
      finishLineMode: 'separate',
    })
    const finalRoundingMark = plan.find((node) => node.key === 'mark-3p')!
    const finishMark = plan.find((node) => node.key === 'finish-mark')!
    const finishBoat = plan.find((node) => node.key === 'finish-boat')!
    const finishCenter = midpoint(finishMark.target, finishBoat.target)

    expect(distanceMetres(finalRoundingMark.target, finishCenter)).toBeCloseTo(0.15 * 1_852, 0)
    expect(distanceMetres(finishMark.target, finishBoat.target)).toBeCloseTo(50, 0)
    expect(bearingDegrees(finalRoundingMark.target, finishCenter)).toBeCloseTo(135, 1)
    expect(Math.abs(headingDifferenceDegrees(
      bearingDegrees(finalRoundingMark.target, finishCenter),
      bearingDegrees(finishMark.target, finishBoat.target),
    ))).toBeCloseTo(90, 1)
  })

  it('reuses RC as the finish boat and puts one F mark 50 metres downwind', () => {
    const plan = generateCoursePlan({
      center: [131.5221959, 33.2786648],
      windDirection: 0,
      totalLengthMetres: 5_400,
      courseCode: 'O2',
      className: '470',
      lowerGate: true,
      upperGate: false,
      finishLineMode: 'shared-rc',
    })

    const signalBoat = plan.find((node) => node.key === 'start-rc')!
    const finishMark = plan.find((node) => node.key === 'finish-mark')!

    expect(plan.some((node) => node.key === 'finish-boat')).toBe(false)
    expect(distanceMetres(signalBoat.target, finishMark.target)).toBeCloseTo(50, 0)
    expect(bearingDegrees(signalBoat.target, finishMark.target)).toBeCloseTo(180, 1)
  })

  it('places the O2 lower gate below mark 2 so the map forms an outer trapezoid', () => {
    const start = [131.5221959, 33.2786648] as const
    const plan = generateCoursePlan({
      center: start,
      windDirection: 0,
      totalLengthMetres: 5_400,
      courseCode: 'O2',
      className: '470',
      lowerGate: true,
      upperGate: false,
    })
    const mark1 = plan.find((node) => node.key === 'mark-1')!
    const mark2 = plan.find((node) => node.key === 'mark-2')!
    const startPin = plan.find((node) => node.key === 'start-pin')!
    const startRc = plan.find((node) => node.key === 'start-rc')!
    const gateMarks = plan.filter((node) => node.key === 'mark-3s' || node.key === 'mark-3p')
    const gateCenter = midpoint(gateMarks[0].target, gateMarks[1].target)

    expect(bearingDegrees(mark1.target, mark2.target)).toBeCloseTo(240, 1)
    expect(bearingDegrees(startPin.target, startRc.target)).toBeCloseTo(90, 1)
    expect(bearingDegrees(mark2.target, gateCenter)).toBeCloseTo(180, 1)
    expect(distanceMetres(mark2.target, gateCenter)).toBeGreaterThan(850)
    expect(distanceMetres(start, gateCenter)).toBeGreaterThan(500)
  })

  it('keeps the default Beppu demo as the same O2 trapezoid shown after refresh', () => {
    const marks = DEMO_RACES[0].marks
    const start = midpoint(marks.find((mark) => mark.shortLabel === 'PIN')!.target, marks.find((mark) => mark.shortLabel === 'RC')!.target)
    const mark2 = marks.find((mark) => mark.shortLabel === '2')!
    const gateCenter = midpoint(marks.find((mark) => mark.shortLabel === '3S')!.target, marks.find((mark) => mark.shortLabel === '3P')!.target)

    expect(start[0]).toBeCloseTo(131.5221959, 5)
    expect(start[1]).toBeCloseTo(33.2786648, 5)
    expect(bearingDegrees(mark2.target, gateCenter)).toBeCloseTo(170, 1)
    expect(distanceMetres(start, gateCenter)).toBeGreaterThan(500)
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

  it('can switch the second rounding point between a single mark and a gate', () => {
    const plan = generateCoursePlan({
      center: [139.46, 35.28],
      windDirection: 15,
      totalLengthMetres: 5_000,
      courseCode: 'トライアングル',
      lowerGate: false,
      upperGate: false,
      secondGate: true,
    })
    expect(plan.some((node) => node.key === 'mark-2')).toBe(false)
    expect(plan.filter((node) => node.key === 'mark-2s' || node.key === 'mark-2p')).toHaveLength(2)
    expect(plan.filter((node) => node.nodeType === 'gate')).toHaveLength(2)
  })

  it('uses the Snipe T2 code for triangle geometry', () => {
    const plan = generateCoursePlan({
      center: [139.46, 35.28],
      windDirection: 20,
      totalLengthMetres: 6_000,
      courseCode: 'T2',
      className: 'スナイプ',
      lowerGate: false,
      upperGate: false,
    })
    expect(plan.some((node) => node.key === 'mark-2')).toBe(true)
    expect(plan.some((node) => node.key === 'mark-3')).toBe(true)
  })

  it('uses the inner 4S/4P gate and single 3P rounding for I2', () => {
    const plan = generateCoursePlan({
      center: [131.5221959, 33.2786648],
      windDirection: 350,
      totalLengthMetres: 5_000,
      courseCode: 'I2',
      className: '470',
      lowerGate: true,
      upperGate: false,
    })
    expect(plan.map((node) => node.key)).toEqual(expect.arrayContaining(['mark-4s', 'mark-4p', 'mark-2', 'mark-3p']))
    expect(plan.find((node) => node.key === 'mark-3p')?.nodeType).toBe('single')
    expect(plan.some((node) => node.key === 'mark-1a')).toBe(false)

    const mark1 = plan.find((node) => node.key === 'mark-1')!
    const mark2 = plan.find((node) => node.key === 'mark-2')!
    const mark3 = plan.find((node) => node.key === 'mark-3p')!
    const finishMark = plan.find((node) => node.key === 'finish-mark')!
    const finishBoat = plan.find((node) => node.key === 'finish-boat')!
    const finishCenter = midpoint(finishMark.target, finishBoat.target)
    const outer = generateCoursePlan({
      center: [131.5221959, 33.2786648],
      windDirection: 350,
      totalLengthMetres: 5_000,
      courseCode: 'O2',
      className: '470',
      lowerGate: true,
      upperGate: false,
    })
    expect(bearingDegrees(mark1.target, mark2.target)).toBeCloseTo(230, 1)
    expect(mark2.target).toEqual(outer.find((node) => node.key === 'mark-2')!.target)
    expect(mark3.target).toEqual(outer.find((node) => node.key === 'mark-3p')!.target)
    expect(distanceMetres(mark3.target, finishCenter)).toBeCloseTo(0.15 * 1_852, 0)
    expect(bearingDegrees(mark3.target, finishCenter)).toBeCloseTo(125, 1)
    expect(Math.abs(headingDifferenceDegrees(
      bearingDegrees(mark3.target, finishCenter),
      bearingDegrees(finishMark.target, finishBoat.target),
    ))).toBeCloseTo(90, 1)
  })

  it('uses mark 2 instead of mark 4 for the windward-leeward lower gate', () => {
    const plan = generateCoursePlan({
      center: [131.5221959, 33.2786648],
      windDirection: 350,
      totalLengthMetres: 5_000,
      courseCode: 'L2',
      className: '470',
      lowerGate: true,
      upperGate: false,
    })

    expect(plan.map((node) => node.key)).toEqual(expect.arrayContaining(['mark-1', 'mark-2s', 'mark-2p']))
    expect(plan.some((node) => node.key === 'mark-4s' || node.key === 'mark-4p')).toBe(false)
  })

  it('distinguishes Snipe W2 and O2 physical marks', () => {
    const common = {
      center: [131.5221959, 33.2786648] as [number, number],
      windDirection: 10,
      totalLengthMetres: 6_000,
      className: 'スナイプ',
      lowerGate: true,
      upperGate: false,
    }
    const w2 = generateCoursePlan({ ...common, courseCode: 'W2' })
    const o2 = generateCoursePlan({ ...common, courseCode: 'O2', lowerGate: false })
    expect(w2.some((node) => node.key === 'mark-1a')).toBe(true)
    expect(w2.some((node) => node.key === 'mark-2')).toBe(false)
    expect(o2.some((node) => node.key === 'mark-1a')).toBe(false)
    expect(o2.some((node) => node.key === 'mark-2')).toBe(true)
  })
})
