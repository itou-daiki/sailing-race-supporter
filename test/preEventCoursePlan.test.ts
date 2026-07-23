import { describe, expect, it } from 'vitest'
import { distanceMetres, midpoint, recommendedCourseLength } from '../src/course'
import type { EventCreationPlan } from '../src/eventClient'
import { buildCourseFeatures } from '../src/mapCourseFeatures'
import { buildPreEventCourseMarks } from '../src/preEventCoursePlan'

function plan(overrides: Partial<EventCreationPlan> = {}): EventCreationPlan {
  const windSpeed = overrides.windSpeed ?? 8
  const className = overrides.className ?? '470'
  return {
    className,
    courseCode: 'O2',
    signalBoatPosition: [131.5221959, 33.2786648],
    windDirection: 350,
    windSpeed,
    lowerGate: true,
    targetLengthMetres: recommendedCourseLength(className, windSpeed).kilometres * 1_000,
    targetMinutes: 50,
    ...overrides,
  }
}

describe('pre-event course plan', () => {
  it('keeps the entered signal boat position and creates an O2 trapezoid with a lower gate', () => {
    const input = plan()
    const marks = buildPreEventCourseMarks(input)

    expect(marks.find((mark) => mark.shortLabel === 'RC')?.target).toEqual(input.signalBoatPosition)
    expect(marks.map((mark) => mark.shortLabel)).toEqual(expect.arrayContaining(['PIN', 'RC', '1', '2', '3S', '3P']))
  })

  it('replaces the lower gate with one numbered mark when the gate is disabled', () => {
    const marks = buildPreEventCourseMarks(plan({ lowerGate: false }))

    expect(marks.some((mark) => mark.shortLabel === '3')).toBe(true)
    expect(marks.some((mark) => mark.shortLabel === '3S' || mark.shortLabel === '3P')).toBe(false)
  })

  it('uses the selected course length to move the windward mark', () => {
    const shortPlan = plan({ targetLengthMetres: 4_000 })
    const longPlan = plan({ targetLengthMetres: 8_000 })
    const shortMark = buildPreEventCourseMarks(shortPlan).find((mark) => mark.shortLabel === '1')
    const longMark = buildPreEventCourseMarks(longPlan).find((mark) => mark.shortLabel === '1')

    expect(shortMark).toBeDefined()
    expect(longMark).toBeDefined()
    expect(distanceMetres(longPlan.signalBoatPosition, longMark!.target)).toBeGreaterThan(
      distanceMetres(shortPlan.signalBoatPosition, shortMark!.target) * 1.8,
    )
  })

  it('shows the O2 final leg as 0.15 NM from 3P to the finish-line midpoint', () => {
    const marks = buildPreEventCourseMarks(plan())
    const mark3p = marks.find((mark) => mark.shortLabel === '3P')!
    const finishMark = marks.find((mark) => mark.shortLabel === 'F')!
    const finishBoat = marks.find((mark) => mark.shortLabel === 'FIN')!
    const finishCenter = midpoint(finishMark.target, finishBoat.target)
    const features = buildCourseFeatures(marks, ['Start', '1', '2', '3S/3P', '2', '3P', 'Finish'])

    expect(distanceMetres(mark3p.target, finishCenter)).toBeCloseTo(0.15 * 1_852, 0)
    expect(features.legLabels.features.map((feature) => feature.properties?.label)).toContain('278 m · 0.15 NM')
  })

  it('uses RC and one F mark without a separate finish boat in shared practice mode', () => {
    const marks = buildPreEventCourseMarks(plan({ finishLineMode: 'shared-rc' }))

    expect(marks.some((mark) => mark.shortLabel === 'FIN')).toBe(false)
    expect(marks.map((mark) => mark.shortLabel)).toEqual(expect.arrayContaining(['PIN', 'RC', 'F']))
    expect(distanceMetres(
      marks.find((mark) => mark.shortLabel === 'RC')!.target,
      marks.find((mark) => mark.shortLabel === 'F')!.target,
    )).toBeCloseTo(50, 0)
  })
})
