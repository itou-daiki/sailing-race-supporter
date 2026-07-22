import { geodesicMidpoint } from './geo.js'

const EARTH_RADIUS_METRES = 6_371_008.8
const toRadians = (degrees: number) => (degrees * Math.PI) / 180
const toDegrees = (radians: number) => (radians * 180) / Math.PI

export type CoursePosition = readonly [longitude: number, latitude: number]
export type CourseTemplate = 'O2' | 'I2' | 'L2' | 'L3' | 'W2' | 'T2' | 'トライアングル'

export interface CoursePlanNode {
  key: string
  label: string
  nodeType: 'single' | 'gate' | 'start' | 'offset'
  target: CoursePosition
}

export interface CoursePlanInput {
  center: CoursePosition
  startLine?: { pin: CoursePosition; signal: CoursePosition }
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

export function destinationPoint(origin: CoursePosition, distance: number, bearingDegreesValue: number): CoursePosition {
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

export function courseLegDivisor(courseCode: CourseTemplate, className?: string): number {
  // These ratios follow the actual generated route. They convert the estimated
  // start-to-finish sailing distance into the first windward-leg length.
  if (courseCode === 'O2') return className === 'スナイプ' ? 4.58 : 5.03
  if (courseCode === 'I2') return 5.03
  if (courseCode === 'L2') return 3.82
  if (courseCode === 'L3') return 5.64
  if (courseCode === 'W2') return 4.22
  if (courseCode === 'T2') return 5.44
  return 2.86
}

export function recommendedStartLineLength(totalLengthMetres: number, courseCode: CourseTemplate, className?: string): number {
  const leg = totalLengthMetres / courseLegDivisor(courseCode, className)
  return Math.min(600, Math.max(180, leg * 0.35))
}

export function generateCoursePlan(input: CoursePlanInput): CoursePlanNode[] {
  const wind = ((input.windDirection % 360) + 360) % 360
  const center = input.startLine ? geodesicMidpoint(input.startLine.pin, input.startLine.signal) : input.center
  const leg = Math.min(3_000, Math.max(250, input.totalLengthMetres / courseLegDivisor(input.courseCode, input.className)))
  const gateWidth = input.gateWidthMetres ?? Math.min(180, Math.max(70, leg * 0.12))
  const lineLength = input.startLineLengthMetres ?? Math.min(600, Math.max(180, leg * 0.35))
  const upwind = destinationPoint(center, leg, wind)
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
    roundingCenter: CoursePosition,
  ) => {
    if (input.lowerGate) {
      nodes.push(
        { key: `${key}s`, label: `${label}S`, nodeType: 'gate', target: destinationPoint(roundingCenter, gateWidth / 2, wind - 90) },
        { key: `${key}p`, label: `${label}P`, nodeType: 'gate', target: destinationPoint(roundingCenter, gateWidth / 2, wind + 90) },
      )
    } else {
      nodes.push({ key, label: key === 'mark-3' ? '3マーク' : '4マーク', nodeType: 'single', target: roundingCenter })
    }
  }

  if (isSnipe && input.courseCode === 'W2') {
    const offset = destinationPoint(upwind, Math.min(200, leg * 0.18), wind - 90)
    nodes.push({ key: 'mark-1a', label: 'オフセット 1A', nodeType: 'offset', target: offset })
  } else if (!isSnipe && input.courseCode === 'O2') {
    const mark2 = destinationPoint(upwind, leg * 0.67, wind - 120)
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
    const mark2 = destinationPoint(upwind, leg * 0.67, wind - 120)
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
    const mark2 = destinationPoint(upwind, leg * 0.86, wind - 120)
    if (input.secondGate) {
      nodes.push(
        { key: 'mark-2s', label: '中ゲート 2S', nodeType: 'gate', target: destinationPoint(mark2, gateWidth / 2, wind - 90) },
        { key: 'mark-2p', label: '中ゲート 2P', nodeType: 'gate', target: destinationPoint(mark2, gateWidth / 2, wind + 90) },
      )
    } else {
      nodes.push({ key: 'mark-2', label: '2マーク', nodeType: 'single', target: mark2 })
    }
    lowerRoundingCenter = destinationPoint(mark2, leg * 0.86, wind + 120)
  }

  pushGateOrSingle('mark-3', '下ゲート 3', lowerRoundingCenter)
  return nodes
}
