import type { Feature, FeatureCollection, LineString, Point } from 'geojson'
import { midpoint } from './course'
import type { CourseMark, LngLat } from './domain'

export interface GatePair {
  key: string
  starboard: CourseMark
  port: CourseMark
  positions: readonly [LngLat, LngLat]
  actual: boolean
  center: LngLat
}

export function findGatePairs(marks: readonly CourseMark[]): GatePair[] {
  const groups = new Map<string, { starboard?: CourseMark; port?: CourseMark }>()
  marks.filter((mark) => mark.isGate && mark.gateSide).forEach((mark) => {
    const key = mark.label.replace(/[SP]$/u, '').trim()
    const group = groups.get(key) ?? {}
    if (mark.gateSide === 'S') group.starboard = mark
    if (mark.gateSide === 'P') group.port = mark
    groups.set(key, group)
  })
  return [...groups.entries()].flatMap(([key, group]) => {
    if (!group.starboard || !group.port) return []
    const actual = Boolean(group.starboard.actual && group.port.actual)
    const positions = [
      actual ? group.starboard.actual as LngLat : group.starboard.target,
      actual ? group.port.actual as LngLat : group.port.target,
    ] as const
    return [{ key, starboard: group.starboard, port: group.port, positions, actual, center: midpoint(positions[0], positions[1]) }]
  })
}

export function buildCourseFeatures(marks: readonly CourseMark[], route?: readonly string[]): {
  points: FeatureCollection<Point>
  targetLinks: FeatureCollection<LineString>
  course: FeatureCollection<LineString>
  gates: FeatureCollection<LineString>
} {
  const gates = findGatePairs(marks)
  const pointFeatures: Feature<Point>[] = marks.flatMap((mark) => {
    const points: Feature<Point>[] = [{
      type: 'Feature',
      id: `${mark.id}-target`,
      properties: { markId: mark.id, kind: 'target', label: mark.shortLabel },
      geometry: { type: 'Point', coordinates: [...mark.target] },
    }]
    if (mark.actual) points.push({
      type: 'Feature',
      id: `${mark.id}-actual`,
      properties: { markId: mark.id, kind: 'actual', label: mark.shortLabel },
      geometry: { type: 'Point', coordinates: [...mark.actual] },
    })
    if (mark.verificationPosition) points.push({
      type: 'Feature',
      id: `${mark.id}-verification`,
      properties: { markId: mark.id, kind: 'verification', label: `${mark.shortLabel}確認` },
      geometry: { type: 'Point', coordinates: [...mark.verificationPosition] },
    })
    if (mark.recoveryPosition) points.push({
      type: 'Feature',
      id: `${mark.id}-recovery`,
      properties: { markId: mark.id, kind: 'recovery', label: `${mark.shortLabel}回収` },
      geometry: { type: 'Point', coordinates: [...mark.recoveryPosition] },
    })
    return points
  })
  gates.forEach((gate) => pointFeatures.push({
    type: 'Feature',
    id: `gate-center-${gate.key}`,
    properties: { kind: 'gate-center', label: `${gate.key}中央`, actual: gate.actual },
    geometry: { type: 'Point', coordinates: [...gate.center] },
  }))
  const points: FeatureCollection<Point> = { type: 'FeatureCollection', features: pointFeatures }
  const targetLinks: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: marks.filter((mark) => mark.actual).map((mark) => ({
      type: 'Feature' as const,
      properties: { markId: mark.id },
      geometry: {
        type: 'LineString' as const,
        coordinates: [[...mark.target], [...(mark.actual ?? mark.target)]],
      },
    })),
  }

  const gateByMark = new Map<string, GatePair>()
  gates.forEach((gate) => {
    gateByMark.set(gate.starboard.id, gate)
    gateByMark.set(gate.port.id, gate)
  })
  const includedGates = new Set<string>()
  const physicalOrder = marks.flatMap((mark) => {
    const gate = gateByMark.get(mark.id)
    if (!gate) return [[...(mark.actual ?? mark.target)]]
    if (includedGates.has(gate.key)) return []
    includedGates.add(gate.key)
    return [[...gate.center]]
  })
  const startMarks = marks.filter((mark) => mark.shortLabel === 'PIN' || mark.shortLabel === 'RC')
  const startCenter = startMarks.length === 2
    ? midpoint(startMarks[0].actual ?? startMarks[0].target, startMarks[1].actual ?? startMarks[1].target)
    : undefined
  const routeOrder = route?.flatMap((point) => {
    if (point === 'Start' || point === 'Finish') return startCenter ? [[...startCenter]] : []
    const exact = marks.find((mark) => mark.shortLabel === point)
    if (exact) return [[...(exact.actual ?? exact.target)]]
    const gateNumber = point.match(/^(\d+)[SP]?\/(?:\1)?[SP]$/u)?.[1]
      ?? point.match(/^(\d+)[SP]?$/u)?.[1]
    if (!gateNumber) return []
    const gate = gates.find((candidate) => (
      candidate.starboard.shortLabel.startsWith(gateNumber) && candidate.port.shortLabel.startsWith(gateNumber)
    ))
    if (gate) return [[...gate.center]]
    const single = marks.find((mark) => mark.shortLabel === gateNumber)
    return single ? [[...(single.actual ?? single.target)]] : []
  })
  const ordered = routeOrder && routeOrder.length > 1 ? routeOrder : physicalOrder
  const course: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: ordered.length > 1 ? [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: ordered },
    }] : [],
  }
  const gateLines: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: gates.map((gate) => ({
      type: 'Feature',
      properties: { key: gate.key, actual: gate.actual },
      geometry: { type: 'LineString', coordinates: gate.positions.map((position) => [...position]) },
    })),
  }
  return { points, targetLinks, course, gates: gateLines }
}
