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
