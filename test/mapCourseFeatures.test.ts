import { describe, expect, it } from 'vitest'
import type { CourseMark } from '../src/domain'
import { buildCourseFeatures } from '../src/mapCourseFeatures'

describe('course map geometry', () => {
  it('routes through a gate center once instead of drawing a false leg across both sides', () => {
    const marks: CourseMark[] = [
      { id: 'm1', label: '1マーク', shortLabel: '1', target: [139.46, 35.29], status: 'planned' },
      { id: 'm3s', label: '下ゲート 3S', shortLabel: '3S', target: [139.459, 35.28], status: 'planned', isGate: true, gateSide: 'S' },
      { id: 'm3p', label: '下ゲート 3P', shortLabel: '3P', target: [139.461, 35.28], status: 'planned', isGate: true, gateSide: 'P' },
      { id: 'finish', label: 'フィニッシュ', shortLabel: 'F', target: [139.46, 35.279], status: 'planned' },
    ]

    const features = buildCourseFeatures(marks)
    expect(features.course.features[0].geometry.coordinates).toEqual([
      [139.46, 35.29],
      [139.46, 35.28],
      [139.46, 35.279],
    ])
    expect(features.gates.features).toHaveLength(1)
    expect(features.gates.features[0].geometry.coordinates).toEqual([
      [139.459, 35.28],
      [139.461, 35.28],
    ])
  })
})
