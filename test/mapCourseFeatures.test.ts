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

  it('keeps the deployed position while showing verification and recovery as separate map points', () => {
    const mark: CourseMark = {
      id: 'm1',
      label: '1マーク',
      shortLabel: '1',
      target: [139.46, 35.29],
      actual: [139.4602, 35.2901],
      verificationPosition: [139.46021, 35.29011],
      recoveryPosition: [139.461, 35.291],
      status: 'recovered',
    }

    const features = buildCourseFeatures([mark, {
      id: 'finish', label: 'フィニッシュ', shortLabel: 'F', target: [139.46, 35.28], status: 'planned',
    }])
    expect(features.points.features.map((feature) => feature.properties?.kind)).toEqual([
      'target', 'actual', 'verification', 'recovery', 'target',
    ])
    expect(features.course.features[0].geometry.coordinates[0]).toEqual([139.4602, 35.2901])
    expect(features.targetLinks.features[0].geometry.coordinates).toEqual([
      [139.46, 35.29],
      [139.4602, 35.2901],
    ])
  })

  it('draws an O2 trapezoid in sailing order without connecting the physical-mark list order', () => {
    const marks: CourseMark[] = [
      { id: 'm1', label: '1マーク', shortLabel: '1', target: [131.522, 33.29], status: 'planned' },
      { id: 'm2', label: '2マーク', shortLabel: '2', target: [131.532, 33.285], status: 'planned' },
      { id: 'm3s', label: '下ゲート 3S', shortLabel: '3S', target: [131.521, 33.28], status: 'planned', isGate: true, gateSide: 'S' },
      { id: 'm3p', label: '下ゲート 3P', shortLabel: '3P', target: [131.523, 33.28], status: 'planned', isGate: true, gateSide: 'P' },
      { id: 'pin', label: 'スタート・ピン', shortLabel: 'PIN', target: [131.520, 33.278], status: 'planned' },
      { id: 'rc', label: 'シグナルボート', shortLabel: 'RC', target: [131.524, 33.278], status: 'planned' },
    ]

    const features = buildCourseFeatures(marks, ['Start', '1', '2', '3S/3P', '2', '3P', 'Finish'])
    expect(features.startLine.features[0].geometry.coordinates).toEqual([
      [131.520, 33.278],
      [131.524, 33.278],
    ])
    expect(features.finishLine.features[0].properties?.shared).toBe(true)
    expect(features.finishLine.features[0].geometry.coordinates).toEqual(features.startLine.features[0].geometry.coordinates)
    expect(features.course.features[0].geometry.coordinates).toEqual([
      [131.522, 33.278],
      [131.522, 33.29],
      [131.532, 33.285],
      [131.522, 33.28],
      [131.532, 33.285],
      [131.523, 33.28],
      [131.522, 33.278],
    ])
  })

  it('draws a separately placed finish line and routes to its midpoint', () => {
    const marks: CourseMark[] = [
      { id: 'pin', label: 'スタート・ピン', shortLabel: 'PIN', target: [131.520, 33.278], status: 'planned' },
      { id: 'rc', label: 'シグナルボート', shortLabel: 'RC', target: [131.524, 33.278], status: 'planned' },
      { id: 'm1', label: '1マーク', shortLabel: '1', target: [131.522, 33.29], status: 'planned' },
      { id: 'f', label: 'フィニッシュマーク', shortLabel: 'F', target: [131.526, 33.280], status: 'planned' },
      { id: 'fin', label: 'フィニッシュ艇', shortLabel: 'FIN', target: [131.526, 33.282], status: 'planned' },
    ]

    const features = buildCourseFeatures(marks, ['Start', '1', 'Finish'])
    expect(features.finishLine.features[0].properties?.shared).toBe(false)
    expect(features.finishLine.features[0].geometry.coordinates).toEqual([
      [131.526, 33.280],
      [131.526, 33.282],
    ])
    expect(features.course.features[0].geometry.coordinates.at(-1)).toEqual([131.526, 33.281])
  })

  it('uses the single lower mark when a gate route is previewed with the gate disabled', () => {
    const marks: CourseMark[] = [
      { id: 'm1', label: '1マーク', shortLabel: '1', target: [131.522, 33.29], status: 'planned' },
      { id: 'm2', label: '2マーク', shortLabel: '2', target: [131.532, 33.285], status: 'planned' },
      { id: 'm3', label: '3マーク', shortLabel: '3', target: [131.522, 33.28], status: 'planned' },
      { id: 'pin', label: 'スタート・ピン', shortLabel: 'PIN', target: [131.520, 33.278], status: 'planned' },
      { id: 'rc', label: 'シグナルボート', shortLabel: 'RC', target: [131.524, 33.278], status: 'planned' },
    ]

    const features = buildCourseFeatures(marks, ['Start', '1', '2', '3S/3P', '2', '3P', 'Finish'])
    expect(features.course.features[0].geometry.coordinates).toEqual([
      [131.522, 33.278],
      [131.522, 33.29],
      [131.532, 33.285],
      [131.522, 33.28],
      [131.532, 33.285],
      [131.522, 33.28],
      [131.522, 33.278],
    ])
    expect(features.gates.features).toHaveLength(0)
  })
})
