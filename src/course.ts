import { CLASS_PROFILES, type LngLat, type SailingClass } from './domain'

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

export type CourseTemplate = 'O2' | 'I2' | 'L2' | 'L3' | 'W2' | 'トライアングル'

export interface CoursePlanNode {
  key: string
  label: string
  nodeType: 'single' | 'gate' | 'start' | 'offset'
  target: LngLat
}

export interface CoursePlanInput {
  center: LngLat
  windDirection: number
  totalLengthMetres: number
  courseCode: CourseTemplate
  lowerGate: boolean
  upperGate: boolean
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
  if (courseCode === 'L3') return 6
  return 4
}

export function generateCoursePlan(input: CoursePlanInput): CoursePlanNode[] {
  const wind = ((input.windDirection % 360) + 360) % 360
  const leg = Math.min(3_000, Math.max(250, input.totalLengthMetres / courseLegDivisor(input.courseCode)))
  const gateWidth = input.gateWidthMetres ?? Math.min(180, Math.max(70, leg * 0.12))
  const lineLength = input.startLineLengthMetres ?? Math.min(600, Math.max(180, leg * 0.35))
  const upwind = destinationPoint(input.center, leg, wind)
  let lowerRoundingCenter = destinationPoint(input.center, Math.min(160, leg * 0.14), wind)
  const nodes: CoursePlanNode[] = [
    { key: 'start-pin', label: 'スタート・ピン', nodeType: 'start', target: destinationPoint(input.center, lineLength / 2, wind - 90) },
    { key: 'start-rc', label: 'シグナルボート', nodeType: 'start', target: destinationPoint(input.center, lineLength / 2, wind + 90) },
  ]

  if (input.upperGate) {
    nodes.push(
      { key: 'mark-1s', label: '上ゲート 1S', nodeType: 'gate', target: destinationPoint(upwind, gateWidth / 2, wind - 90) },
      { key: 'mark-1p', label: '上ゲート 1P', nodeType: 'gate', target: destinationPoint(upwind, gateWidth / 2, wind + 90) },
    )
  } else {
    nodes.push({ key: 'mark-1', label: '1マーク', nodeType: 'single', target: upwind })
  }

  if (input.courseCode === 'O2' || input.courseCode === 'I2') {
    const reachAngle = input.courseCode === 'O2' ? 120 : -120
    const offset = destinationPoint(upwind, Math.min(200, leg * 0.18), wind + 90)
    nodes.push({ key: 'mark-1a', label: 'オフセット 1A', nodeType: 'offset', target: offset })
    nodes.push({
      key: 'mark-2',
      label: '2マーク',
      nodeType: 'single',
      target: destinationPoint(offset, leg * 0.67, wind + reachAngle),
    })
  } else if (input.courseCode === 'トライアングル') {
    const mark2 = destinationPoint(upwind, leg * 0.86, wind + 120)
    nodes.push({ key: 'mark-2', label: '2マーク', nodeType: 'single', target: mark2 })
    lowerRoundingCenter = destinationPoint(mark2, leg * 0.86, wind + 240)
  }

  if (input.lowerGate) {
    nodes.push(
      { key: 'mark-3s', label: '下ゲート 3S', nodeType: 'gate', target: destinationPoint(lowerRoundingCenter, gateWidth / 2, wind - 90) },
      { key: 'mark-3p', label: '下ゲート 3P', nodeType: 'gate', target: destinationPoint(lowerRoundingCenter, gateWidth / 2, wind + 90) },
    )
  } else {
    nodes.push({ key: 'mark-3', label: '3マーク', nodeType: 'single', target: lowerRoundingCenter })
  }
  return nodes
}
