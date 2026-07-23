import { geodesicMidpoint } from './geo.js'

const EARTH_RADIUS_METRES = 6_371_008.8
const toRadians = (degrees: number) => (degrees * Math.PI) / 180
const toDegrees = (radians: number) => (radians * 180) / Math.PI

export type CoursePosition = readonly [longitude: number, latitude: number]
export type CourseTemplate = 'O2' | 'I2' | 'L2' | 'L3' | 'W2' | 'T2' | 'トライアングル'
export type FinishLineMode = 'separate' | 'shared-rc'

export interface CoursePlanNode {
  key: string
  label: string
  nodeType: 'single' | 'gate' | 'start' | 'offset' | 'finish'
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
  windSpeed?: number
  finishLineMode?: FinishLineMode
}

export interface CourseSailingDistanceModel {
  closeHauledLegs: number
  reachLegs: number
  downwindLegs: number
  fixedFinishDistanceMetres: number
  finishPointOfSail: 'reach' | 'downwind'
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

export function courseSailingDistanceModel(
  courseCode: CourseTemplate,
  className?: string,
  windSpeed = 8,
  finishLineMode: FinishLineMode = 'separate',
): CourseSailingDistanceModel {
  const standardLeewardFinish = windSpeed >= 12 ? 0.1 * 1_852 : 0.05 * 1_852
  if (courseCode === 'O2' && className !== 'スナイプ') {
    return finishLineMode === 'shared-rc'
      ? { closeHauledLegs: 1.91, reachLegs: 1.3, downwindLegs: 1.82, fixedFinishDistanceMetres: 0, finishPointOfSail: 'reach' }
      : { closeHauledLegs: 1.91, reachLegs: 0.67, downwindLegs: 1.82, fixedFinishDistanceMetres: 0.15 * 1_852, finishPointOfSail: 'reach' }
  }
  if (courseCode === 'I2') {
    return finishLineMode === 'shared-rc'
      ? { closeHauledLegs: 1.91, reachLegs: 1.3, downwindLegs: 1.82, fixedFinishDistanceMetres: 0, finishPointOfSail: 'reach' }
      : { closeHauledLegs: 1.91, reachLegs: 0.67, downwindLegs: 1.82, fixedFinishDistanceMetres: 0.15 * 1_852, finishPointOfSail: 'reach' }
  }
  if (courseCode === 'O2') {
    return { closeHauledLegs: 1.86, reachLegs: 1.72, downwindLegs: 0.86, fixedFinishDistanceMetres: standardLeewardFinish, finishPointOfSail: 'downwind' }
  }
  if (courseCode === 'L2') {
    return { closeHauledLegs: 1.91, reachLegs: 0, downwindLegs: 1.82, fixedFinishDistanceMetres: standardLeewardFinish, finishPointOfSail: 'downwind' }
  }
  if (courseCode === 'L3') {
    return { closeHauledLegs: 2.82, reachLegs: 0, downwindLegs: 2.73, fixedFinishDistanceMetres: standardLeewardFinish, finishPointOfSail: 'downwind' }
  }
  if (courseCode === 'W2') {
    return { closeHauledLegs: 1.91, reachLegs: 0.36, downwindLegs: 1.86, fixedFinishDistanceMetres: standardLeewardFinish, finishPointOfSail: 'downwind' }
  }
  if (courseCode === 'T2') {
    return { closeHauledLegs: 1.86, reachLegs: 3.44, downwindLegs: 0, fixedFinishDistanceMetres: standardLeewardFinish, finishPointOfSail: 'downwind' }
  }
  return { closeHauledLegs: 1, reachLegs: 1.72, downwindLegs: 0, fixedFinishDistanceMetres: standardLeewardFinish, finishPointOfSail: 'downwind' }
}

export function courseLegDivisor(courseCode: CourseTemplate, className?: string): number {
  const model = courseSailingDistanceModel(courseCode, className)
  return model.closeHauledLegs + model.reachLegs + model.downwindLegs
}

export function firstLegLengthMetresFromTotal(
  totalLengthMetres: number,
  courseCode: CourseTemplate,
  className?: string,
  windSpeed = 8,
  finishLineMode: FinishLineMode = 'separate',
): number {
  const model = courseSailingDistanceModel(courseCode, className, windSpeed, finishLineMode)
  const scaledLegs = model.closeHauledLegs + model.reachLegs + model.downwindLegs
  return Math.max(250, (totalLengthMetres - model.fixedFinishDistanceMetres) / scaledLegs)
}

export function recommendedStartLineLength(
  totalLengthMetres: number,
  courseCode: CourseTemplate,
  className?: string,
  windSpeed = 8,
  finishLineMode: FinishLineMode = 'separate',
): number {
  const leg = firstLegLengthMetresFromTotal(totalLengthMetres, courseCode, className, windSpeed, finishLineMode)
  return Math.min(600, Math.max(180, leg * 0.35))
}

export function generateCoursePlan(input: CoursePlanInput): CoursePlanNode[] {
  const wind = ((input.windDirection % 360) + 360) % 360
  const center = input.startLine ? geodesicMidpoint(input.startLine.pin, input.startLine.signal) : input.center
  const finishLineMode = input.finishLineMode ?? 'separate'
  const leg = Math.min(3_000, firstLegLengthMetresFromTotal(input.totalLengthMetres, input.courseCode, input.className, input.windSpeed, finishLineMode))
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
  const signalBoatTarget = nodes[1].target
  let finishLineAppended = false
  const appendFinishLine = (origin: CoursePosition, bearing: number, distance: number) => {
    if (finishLineAppended) return
    finishLineAppended = true
    if (finishLineMode === 'shared-rc') {
      nodes.push({
        key: 'finish-mark',
        label: 'フィニッシュマーク',
        nodeType: 'finish',
        target: destinationPoint(signalBoatTarget, 50, wind + 180),
      })
      return
    }
    const finishCenter = destinationPoint(origin, distance, bearing)
    const lineBearing = bearing + 90
    nodes.push(
      { key: 'finish-mark', label: 'フィニッシュマーク', nodeType: 'finish', target: destinationPoint(finishCenter, 25, lineBearing - 180) },
      { key: 'finish-boat', label: 'フィニッシュ艇', nodeType: 'finish', target: destinationPoint(finishCenter, 25, lineBearing) },
    )
  }
  const finishDistance = courseSailingDistanceModel(input.courseCode, input.className, input.windSpeed, finishLineMode).fixedFinishDistanceMetres

  if (input.upperGate) {
    nodes.push(
      { key: 'mark-1s', label: '上ゲート 1S', nodeType: 'gate', target: destinationPoint(upwind, gateWidth / 2, wind - 90) },
      { key: 'mark-1p', label: '上ゲート 1P', nodeType: 'gate', target: destinationPoint(upwind, gateWidth / 2, wind + 90) },
    )
  } else {
    nodes.push({ key: 'mark-1', label: '1マーク', nodeType: 'single', target: upwind })
  }

  const pushGateOrSingle = (
    key: 'mark-2' | 'mark-3' | 'mark-4',
    label: '下ゲート 2' | '下ゲート 3' | '内側ゲート 4',
    roundingCenter: CoursePosition,
  ) => {
    if (input.lowerGate) {
      nodes.push(
        { key: `${key}s`, label: `${label}S`, nodeType: 'gate', target: destinationPoint(roundingCenter, gateWidth / 2, wind - 90) },
        { key: `${key}p`, label: `${label}P`, nodeType: 'gate', target: destinationPoint(roundingCenter, gateWidth / 2, wind + 90) },
      )
    } else {
      nodes.push({ key, label: `${key.slice(-1)}マーク`, nodeType: 'single', target: roundingCenter })
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
    const mark3p = destinationPoint(lowerRoundingCenter, gateWidth / 2, wind + 90)
    nodes.push({ key: 'mark-3p', label: '下ゲート 3P', nodeType: 'single', target: mark3p })
    appendFinishLine(mark3p, wind + 135, finishDistance)
    return nodes
  } else if (!isSnipe && (input.courseCode === 'L2' || input.courseCode === 'L3')) {
    pushGateOrSingle('mark-2', '下ゲート 2', innerGateCenter)
    appendFinishLine(innerGateCenter, wind + 180, finishDistance)
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
  const finalRoundingPosition = !isSnipe && input.courseCode === 'O2' && input.lowerGate
    ? destinationPoint(lowerRoundingCenter, gateWidth / 2, wind + 90)
    : lowerRoundingCenter
  appendFinishLine(
    finalRoundingPosition,
    !isSnipe && input.courseCode === 'O2' ? wind + 135 : wind + 180,
    finishDistance,
  )
  return nodes
}
