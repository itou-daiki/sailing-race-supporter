import { CLASS_PROFILES, type LngLat, type SailingClass } from './domain'
import { geodesicMidpoint } from '../shared/geo'

const EARTH_RADIUS_METRES = 6_371_008.8

const toRadians = (degrees: number) => (degrees * Math.PI) / 180
const toDegrees = (radians: number) => (radians * 180) / Math.PI

export function distanceMetres(from: LngLat, to: LngLat): number {
  const lat1 = toRadians(from[1])
  const lat2 = toRadians(to[1])
  const deltaLat = lat2 - lat1
  const deltaLng = toRadians(to[0] - from[0])
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2

  return 2 * EARTH_RADIUS_METRES * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function bearingDegrees(from: LngLat, to: LngLat): number {
  const lat1 = toRadians(from[1])
  const lat2 = toRadians(to[1])
  const deltaLng = toRadians(to[0] - from[0])
  const y = Math.sin(deltaLng) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng)

  return (toDegrees(Math.atan2(y, x)) + 360) % 360
}

export function headingDifferenceDegrees(courseDegrees: number, targetBearingDegrees: number): number {
  return ((targetBearingDegrees - courseDegrees + 540) % 360) - 180
}

export function estimateEtaSeconds(distance: number, speedKnots: number): number | undefined {
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(speedKnots) || speedKnots < 0.5) return undefined
  return distance / (speedKnots * 0.514444)
}

export function midpoint(from: LngLat, to: LngLat): LngLat {
  return [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
}

function windSpeedFactor(windKnots: number): number {
  if (windKnots <= 3) return 0.58
  if (windKnots <= 6) return 0.58 + ((windKnots - 3) / 3) * 0.28
  if (windKnots <= 10) return 0.86 + ((windKnots - 6) / 4) * 0.24
  if (windKnots <= 16) return 1.1 + ((windKnots - 10) / 6) * 0.12
  return 1.22
}

export function recommendedCourseLength(
  className: SailingClass,
  windKnots: number,
  targetMinutes?: number,
): { nauticalMiles: number; kilometres: number; confidence: 'low' } {
  const profile = CLASS_PROFILES.find((item) => item.className === className)
  if (!profile) throw new Error(`Unsupported sailing class: ${className}`)

  const factor = windSpeedFactor(windKnots)
  const weightedSpeed =
    profile.upwindKnotsAt8 * 0.45 * factor +
    profile.downwindKnotsAt8 * 0.35 * factor +
    profile.reachKnotsAt8 * 0.2 * factor
  const durationHours = (targetMinutes ?? profile.targetMinutes) / 60
  const nauticalMiles = weightedSpeed * durationHours

  return {
    nauticalMiles,
    kilometres: nauticalMiles * 1.852,
    confidence: 'low',
  }
}

export function formatDistance(metres: number): string {
  if (metres < 1_000) return `${Math.round(metres)} m`
  return `${(metres / 1_000).toFixed(2)} km`
}

export type CourseTemplate = 'O2' | 'I2' | 'L2' | 'L3' | 'W2' | 'T2' | 'トライアングル'

export interface CoursePlanNode {
  key: string
  label: string
  nodeType: 'single' | 'gate' | 'start' | 'offset'
  target: LngLat
}

export interface CoursePlanInput {
  center: LngLat
  startLine?: {
    pin: LngLat
    signal: LngLat
  }
  windDirection: number
  totalLengthMetres: number
  courseCode: CourseTemplate
  className?: string
  lowerGate: boolean
  upperGate: boolean
  secondGate?: boolean
  gateWidthMetres?: number
  startLineLengthMetres?: number
}

export function destinationPoint(origin: LngLat, distance: number, bearingDegreesValue: number): LngLat {
  const angularDistance = distance / EARTH_RADIUS_METRES
  const bearing = toRadians(bearingDegreesValue)
  const latitude = toRadians(origin[1])
  const longitude = toRadians(origin[0])
  const targetLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
    Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  )
  const targetLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(targetLatitude),
  )
  return [toDegrees(targetLongitude), toDegrees(targetLatitude)]
}

function courseLegDivisor(courseCode: CourseTemplate): number {
  if (courseCode === 'O2' || courseCode === 'I2') return 5.4
  if (courseCode === 'トライアングル') return 4.2
  if (courseCode === 'T2') return 6
  if (courseCode === 'L3') return 6
  return 4
}

export function generateCoursePlan(input: CoursePlanInput): CoursePlanNode[] {
  const wind = ((input.windDirection % 360) + 360) % 360
  const center = input.startLine ? geodesicMidpoint(input.startLine.pin, input.startLine.signal) : input.center
  const leg = Math.min(3_000, Math.max(250, input.totalLengthMetres / courseLegDivisor(input.courseCode)))
  const gateWidth = input.gateWidthMetres ?? Math.min(180, Math.max(70, leg * 0.12))
  const lineLength = input.startLineLengthMetres ?? Math.min(600, Math.max(180, leg * 0.35))
  const upwind = destinationPoint(center, leg, wind)
  // World Sailing's trapezoid is formed by two parallel windward/leeward loops.
  // Keep the inner leeward gate just to windward of the start, then place mark 3
  // the same downwind distance from mark 2. Putting mark 3 on the start/mark-1
  // axis collapses the course into a triangle on the map.
  const innerGateOffset = Math.min(110, Math.max(70, leg * 0.09))
  const innerGateCenter = destinationPoint(center, innerGateOffset, wind)
  const trapezoidRunLength = leg - innerGateOffset
  let lowerRoundingCenter = innerGateCenter
  const isSnipe = input.className === 'スナイプ'
  const nodes: CoursePlanNode[] = [
    { key: 'start-pin', label: 'スタート・ピン', nodeType: 'start', target: input.startLine?.pin ?? destinationPoint(center, lineLength / 2, wind - 90) },
    { key: 'start-rc', label: 'シグナルボート', nodeType: 'start', target: input.startLine?.signal ?? destinationPoint(center, lineLength / 2, wind + 90) },
  ]

  if (input.upperGate) {
    nodes.push(
      { key: 'mark-1s', label: '上ゲート 1S', nodeType: 'gate', target: destinationPoint(upwind, gateWidth / 2, wind - 90) },
      { key: 'mark-1p', label: '上ゲート 1P', nodeType: 'gate', target: destinationPoint(upwind, gateWidth / 2, wind + 90) },
    )
  } else {
    nodes.push({ key: 'mark-1', label: '1マーク', nodeType: 'single', target: upwind })
  }

  const pushGateOrSingle = (
    key: 'mark-3' | 'mark-4',
    label: '下ゲート 3' | '内側ゲート 4',
    center: LngLat,
  ) => {
    if (input.lowerGate) {
      nodes.push(
        { key: `${key}s`, label: `${label}S`, nodeType: 'gate', target: destinationPoint(center, gateWidth / 2, wind - 90) },
        { key: `${key}p`, label: `${label}P`, nodeType: 'gate', target: destinationPoint(center, gateWidth / 2, wind + 90) },
      )
    } else {
      nodes.push({ key, label: key === 'mark-3' ? '3マーク' : '4マーク', nodeType: 'single', target: center })
    }
  }

  if (isSnipe && input.courseCode === 'W2') {
    const offset = destinationPoint(upwind, Math.min(200, leg * 0.18), wind - 90)
    nodes.push({ key: 'mark-1a', label: 'オフセット 1A', nodeType: 'offset', target: offset })
  } else if (!isSnipe && input.courseCode === 'O2') {
    const mark2 = destinationPoint(upwind, leg * 0.67, wind + 120)
    lowerRoundingCenter = destinationPoint(mark2, trapezoidRunLength, wind + 180)
    if (input.secondGate) {
      nodes.push(
        { key: 'mark-2s', label: '中ゲート 2S', nodeType: 'gate', target: destinationPoint(mark2, gateWidth / 2, wind - 90) },
        { key: 'mark-2p', label: '中ゲート 2P', nodeType: 'gate', target: destinationPoint(mark2, gateWidth / 2, wind + 90) },
      )
    } else {
      nodes.push({ key: 'mark-2', label: '2マーク', nodeType: 'single', target: mark2 })
    }
  } else if (!isSnipe && input.courseCode === 'I2') {
    pushGateOrSingle('mark-4', '内側ゲート 4', innerGateCenter)
    // Inner and outer loops share the same reaching mark 2 and outer mark 3.
    const mark2 = destinationPoint(upwind, leg * 0.67, wind + 120)
    lowerRoundingCenter = destinationPoint(mark2, trapezoidRunLength, wind + 180)
    if (input.secondGate) {
      nodes.push(
        { key: 'mark-2s', label: '中ゲート 2S', nodeType: 'gate', target: destinationPoint(mark2, gateWidth / 2, wind - 90) },
        { key: 'mark-2p', label: '中ゲート 2P', nodeType: 'gate', target: destinationPoint(mark2, gateWidth / 2, wind + 90) },
      )
    } else {
      nodes.push({ key: 'mark-2', label: '2マーク', nodeType: 'single', target: mark2 })
    }
    nodes.push({ key: 'mark-3p', label: '下ゲート 3P', nodeType: 'single', target: destinationPoint(lowerRoundingCenter, gateWidth / 2, wind + 90) })
    return nodes
  } else if (!isSnipe && (input.courseCode === 'L2' || input.courseCode === 'L3')) {
    pushGateOrSingle('mark-4', '内側ゲート 4', innerGateCenter)
    return nodes
  } else if ((isSnipe && (input.courseCode === 'O2' || input.courseCode === 'T2')) || input.courseCode === 'トライアングル') {
    const mark2 = destinationPoint(upwind, leg * 0.86, wind + 120)
    if (input.secondGate) {
      nodes.push(
        { key: 'mark-2s', label: '中ゲート 2S', nodeType: 'gate', target: destinationPoint(mark2, gateWidth / 2, wind - 90) },
        { key: 'mark-2p', label: '中ゲート 2P', nodeType: 'gate', target: destinationPoint(mark2, gateWidth / 2, wind + 90) },
      )
    } else {
      nodes.push({ key: 'mark-2', label: '2マーク', nodeType: 'single', target: mark2 })
    }
    lowerRoundingCenter = destinationPoint(mark2, leg * 0.86, wind + 240)
  }

  pushGateOrSingle('mark-3', '下ゲート 3', lowerRoundingCenter)
  return nodes
}
