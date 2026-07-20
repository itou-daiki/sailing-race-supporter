import type { LngLat } from './domain'
export { recommendedCourseLength } from '../shared/classPerformance.js'
export {
  courseLegDivisor,
  destinationPoint,
  generateCoursePlan,
  recommendedStartLineLength,
} from '../shared/courseGeometry.js'
export type {
  CoursePlanInput,
  CoursePlanNode,
  CourseTemplate,
} from '../shared/courseGeometry.js'

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

export function formatDistance(metres: number): string {
  if (metres < 1_000) return `${Math.round(metres)} m`
  return `${(metres / 1_000).toFixed(2)} km`
}
