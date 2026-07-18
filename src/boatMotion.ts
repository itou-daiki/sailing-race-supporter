export interface BoatMotionSample {
  speedKnots?: number | null
  courseDegrees?: number | null
  accuracyMetres?: number | null
}

export interface NormalizedBoatMotion {
  speedKnots: number
  courseDegrees?: number
  accuracyMetres?: number
}

/**
 * Browser geolocation reports COG (direction of movement), not bow heading.
 * Suppress it at low speed where course values are unstable or stale.
 */
export function normalizeBoatMotion(sample: BoatMotionSample): NormalizedBoatMotion {
  const speedKnots = typeof sample.speedKnots === 'number' && Number.isFinite(sample.speedKnots)
    ? Math.max(0, sample.speedKnots)
    : 0
  const courseDegrees = speedKnots >= 1 && typeof sample.courseDegrees === 'number' && Number.isFinite(sample.courseDegrees)
    ? ((sample.courseDegrees % 360) + 360) % 360
    : undefined
  const accuracyMetres = typeof sample.accuracyMetres === 'number' && Number.isFinite(sample.accuracyMetres)
    ? Math.max(0, sample.accuracyMetres)
    : undefined
  return { speedKnots, courseDegrees, accuracyMetres }
}
