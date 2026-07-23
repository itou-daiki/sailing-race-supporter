import type { FinishLineMode } from './courseGeometry.js'

export type FinishDistanceMode = 'world-sailing-standard' | 'custom'

export const METRES_PER_NAUTICAL_MILE = 1_852
export const WORLD_SAILING_TRAPEZOID_FINISH_DISTANCE_NM = 0.15
export const WORLD_SAILING_TRAPEZOID_FINISH_DISTANCE_METRES =
  WORLD_SAILING_TRAPEZOID_FINISH_DISTANCE_NM * METRES_PER_NAUTICAL_MILE
export const MIN_CUSTOM_FINISH_DISTANCE_NM = 0.05
export const MAX_CUSTOM_FINISH_DISTANCE_NM = 0.5
export const MIN_CUSTOM_FINISH_DISTANCE_METRES = MIN_CUSTOM_FINISH_DISTANCE_NM * METRES_PER_NAUTICAL_MILE
export const MAX_CUSTOM_FINISH_DISTANCE_METRES = MAX_CUSTOM_FINISH_DISTANCE_NM * METRES_PER_NAUTICAL_MILE

export function supportsTrapezoidFinishDistance(courseCode: string, className?: string): boolean {
  return className !== 'スナイプ' && (courseCode === 'O2' || courseCode === 'I2')
}

export function isValidCustomFinishDistanceMetres(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= MIN_CUSTOM_FINISH_DISTANCE_METRES
    && value <= MAX_CUSTOM_FINISH_DISTANCE_METRES
}

export function resolveFinishDistanceMetres(
  courseCode: string,
  className: string | undefined,
  finishLineMode: FinishLineMode,
  requestedDistanceMetres?: number,
): number | undefined {
  if (finishLineMode !== 'separate' || !supportsTrapezoidFinishDistance(courseCode, className)) return undefined
  return isValidCustomFinishDistanceMetres(requestedDistanceMetres)
    ? requestedDistanceMetres
    : WORLD_SAILING_TRAPEZOID_FINISH_DISTANCE_METRES
}

export function finishDistanceMode(distanceMetres?: number): FinishDistanceMode {
  return isValidCustomFinishDistanceMetres(distanceMetres)
    && Math.abs(distanceMetres - WORLD_SAILING_TRAPEZOID_FINISH_DISTANCE_METRES) >= 0.5
    ? 'custom'
    : 'world-sailing-standard'
}

export function nauticalMilesToMetres(nauticalMiles: number): number {
  return nauticalMiles * METRES_PER_NAUTICAL_MILE
}

export function metresToNauticalMiles(metres: number): number {
  return metres / METRES_PER_NAUTICAL_MILE
}
