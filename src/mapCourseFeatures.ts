import type { Feature, FeatureCollection, LineString, Point } from 'geojson'
import { bearingDegrees, distanceMetres, midpoint } from './course'
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
  courseSegments: FeatureCollection<LineString>
  gates: FeatureCollection<LineString>
  startLine: FeatureCollection<LineString>
  finishLine: FeatureCollection<LineString>
  legLabels: FeatureCollection<Point>
  turnLabels: FeatureCollection<Point>
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
  const pinMark = startMarks.find((mark) => mark.shortLabel === 'PIN')
  const signalMark = startMarks.find((mark) => mark.shortLabel === 'RC')
  const startCenter = startMarks.length === 2
    ? midpoint(startMarks[0].actual ?? startMarks[0].target, startMarks[1].actual ?? startMarks[1].target)
    : undefined
  const startLine: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: pinMark && signalMark ? [{
      type: 'Feature',
      properties: { kind: 'start-line', pin: pinMark.id, signal: signalMark.id },
      geometry: {
        type: 'LineString',
        coordinates: [
          [...(pinMark.actual ?? pinMark.target)],
          [...(signalMark.actual ?? signalMark.target)],
        ],
      },
    }] : [],
  }
  const finishBoatMark = marks.find((mark) => mark.shortLabel === 'FIN' || mark.label === 'フィニッシュ艇')
  const finishMark = marks.find((mark) => mark.shortLabel === 'F' || mark.label === 'フィニッシュマーク')
  const finishBoatPosition = finishBoatMark ? finishBoatMark.actual ?? finishBoatMark.target : undefined
  const finishMarkPosition = finishMark ? finishMark.actual ?? finishMark.target : undefined
  const finishCenter = finishBoatPosition && finishMarkPosition
    ? midpoint(finishBoatPosition, finishMarkPosition)
    : finishMarkPosition && signalMark
      ? midpoint(finishMarkPosition, signalMark.actual ?? signalMark.target)
      : finishBoatPosition ?? finishMarkPosition
  const finishLine: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: finishBoatMark && finishMark && finishBoatPosition && finishMarkPosition ? [{
      type: 'Feature',
      properties: { kind: 'finish-line', mark: finishMark.id, boat: finishBoatMark.id, shared: false },
      geometry: {
        type: 'LineString',
        coordinates: [[...finishMarkPosition], [...finishBoatPosition]],
      },
    }] : finishMark && finishMarkPosition && signalMark ? [{
      type: 'Feature',
      properties: { kind: 'finish-line', mark: finishMark.id, boat: signalMark.id, shared: true },
      geometry: {
        type: 'LineString',
        coordinates: [
          [...finishMarkPosition],
          [...(signalMark.actual ?? signalMark.target)],
        ],
      },
    }] : [],
  }
  const routeOrder = route?.flatMap((point) => {
    if (point === 'Start') return startCenter ? [[...startCenter]] : []
    if (point === 'Finish') return finishCenter ? [[...finishCenter]] : startCenter ? [[...startCenter]] : []
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
  const orderedSource = routeOrder && routeOrder.length > 1 ? routeOrder : physicalOrder
  const ordered: LngLat[] = orderedSource.map((position) => [position[0], position[1]])
  const coordinateKey = (position: readonly number[]) => `${position[0].toFixed(7)},${position[1].toFixed(7)}`
  const segmentKey = (from: readonly number[], to: readonly number[]) => (
    [coordinateKey(from), coordinateKey(to)].sort().join('|')
  )
  const formatLegDistance = (metres: number) => (
    metres < 1_000
      ? `${Math.round(metres)} m · ${(metres / 1_852).toFixed(2)} NM`
      : `${(metres / 1_000).toFixed(2)} km · ${(metres / 1_852).toFixed(2)} NM`
  )
  const formatCompactLegDistance = (metres: number) => (
    metres < 1_000
      ? `${Math.round(metres)} m`
      : `${(metres / 1_000).toFixed(2)} km`
  )
  const includedLegs = new Set<string>()
  const segmentOccurrences = new Map<string, number>()
  for (let index = 1; index < ordered.length; index += 1) {
    const key = segmentKey(ordered[index - 1], ordered[index])
    segmentOccurrences.set(key, (segmentOccurrences.get(key) ?? 0) + 1)
  }
  const segmentIndexes = new Map<string, number>()
  const courseSegmentFeatures: Feature<LineString>[] = []
  const legLabelFeatures: Feature<Point>[] = []
  for (let index = 1; index < ordered.length; index += 1) {
    const from = ordered[index - 1]
    const to = ordered[index]
    const key = segmentKey(from, to)
    const metres = distanceMetres(from, to)
    const repeatCount = segmentOccurrences.get(key) ?? 1
    const repeatIndex = segmentIndexes.get(key) ?? 0
    segmentIndexes.set(key, repeatIndex + 1)
    const canonicalStart = [coordinateKey(from), coordinateKey(to)].sort()[0]
    const directionFactor = coordinateKey(from) === canonicalStart ? 1 : -1
    const canonicalOffset = (repeatIndex - (repeatCount - 1) / 2) * 9
    const offset = canonicalOffset === 0 ? 0 : canonicalOffset * directionFactor
    if (metres >= 1) courseSegmentFeatures.push({
      type: 'Feature',
      properties: {
        kind: 'course-segment',
        offset,
        textOffset: [0, offset / 12],
        repeatCount,
        repeatIndex: repeatIndex + 1,
      },
      geometry: { type: 'LineString', coordinates: [[...from], [...to]] },
    })
    if (includedLegs.has(key) || metres < 1) continue
    includedLegs.add(key)
    legLabelFeatures.push({
      type: 'Feature',
      properties: {
        kind: 'leg-distance',
        label: formatLegDistance(metres),
        compactLabel: formatCompactLegDistance(metres),
        metres: Math.round(metres),
      },
      geometry: { type: 'Point', coordinates: [...midpoint(from, to)] },
    })
  }
  const includedTurns = new Set<string>()
  const turnLabelFeatures: Feature<Point>[] = []
  for (let index = 1; index < ordered.length - 1; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    const next = ordered[index + 1]
    if (coordinateKey(previous) === coordinateKey(next)) continue
    const incomingRay = bearingDegrees(current, previous)
    const outgoingRay = bearingDegrees(current, next)
    const angle = Math.abs(((outgoingRay - incomingRay + 540) % 360) - 180)
    if (angle < 5 || angle > 175) continue
    const key = [segmentKey(current, previous), segmentKey(current, next)].sort().join('>')
    if (includedTurns.has(key)) continue
    includedTurns.add(key)
    turnLabelFeatures.push({
      type: 'Feature',
      properties: { kind: 'turn-angle', label: `∠${Math.round(angle)}°`, angle: Math.round(angle) },
      geometry: { type: 'Point', coordinates: [...current] },
    })
  }
  const course: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: ordered.length > 1 ? [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: ordered.map((position) => [...position]) },
    }] : [],
  }
  const courseSegments: FeatureCollection<LineString> = { type: 'FeatureCollection', features: courseSegmentFeatures }
  const gateLines: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: gates.map((gate) => ({
      type: 'Feature',
      properties: { key: gate.key, actual: gate.actual },
      geometry: { type: 'LineString', coordinates: gate.positions.map((position) => [...position]) },
    })),
  }
  const legLabels: FeatureCollection<Point> = { type: 'FeatureCollection', features: legLabelFeatures }
  const turnLabels: FeatureCollection<Point> = { type: 'FeatureCollection', features: turnLabelFeatures }
  return { points, targetLinks, course, courseSegments, gates: gateLines, startLine, finishLine, legLabels, turnLabels }
}
