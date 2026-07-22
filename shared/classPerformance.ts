import { courseLegDivisor, type CourseTemplate } from './courseGeometry.js'

export type SupportedSailingClass =
  | 'OP'
  | 'ILCA 4'
  | 'ILCA 6'
  | 'ILCA 7'
  | '420'
  | '470'
  | 'スナイプ'

export interface ClassPerformanceProfile {
  className: SupportedSailingClass
  targetMinutes: number
  upwindKnotsAt8: number
  downwindKnotsAt8: number
  reachKnotsAt8: number
}

export const CLASS_PERFORMANCE_PROFILES: readonly ClassPerformanceProfile[] = [
  { className: 'OP', targetMinutes: 50, upwindKnotsAt8: 3.1, downwindKnotsAt8: 3.5, reachKnotsAt8: 4.0 },
  { className: 'ILCA 4', targetMinutes: 50, upwindKnotsAt8: 3.8, downwindKnotsAt8: 4.2, reachKnotsAt8: 4.8 },
  { className: 'ILCA 6', targetMinutes: 50, upwindKnotsAt8: 4.1, downwindKnotsAt8: 4.6, reachKnotsAt8: 5.2 },
  { className: 'ILCA 7', targetMinutes: 50, upwindKnotsAt8: 4.3, downwindKnotsAt8: 4.8, reachKnotsAt8: 5.4 },
  { className: '420', targetMinutes: 45, upwindKnotsAt8: 4.6, downwindKnotsAt8: 5.8, reachKnotsAt8: 6.4 },
  { className: '470', targetMinutes: 50, upwindKnotsAt8: 5.1, downwindKnotsAt8: 6.6, reachKnotsAt8: 7.3 },
  { className: 'スナイプ', targetMinutes: 60, upwindKnotsAt8: 4.3, downwindKnotsAt8: 4.8, reachKnotsAt8: 5.1 },
] as const

export interface CourseLengthRecommendation {
  /** Estimated distance sailed from start to finish. */
  nauticalMiles: number
  /** Estimated distance sailed from start to finish. */
  kilometres: number
  /** Recommended length of the first windward leg. */
  firstLegNauticalMiles: number
  /** Recommended length of the first windward leg. */
  firstLegKilometres: number
  estimatedAverageSpeedKnots: number
  /** Speeds used after applying the selected wind-speed correction. */
  legSpeedsKnots: {
    closeHauledVmg: number
    reach: number
    downwindVmg: number
  }
  /** Share of the generated route assigned to each point of sail. */
  legDistanceShare: {
    closeHauled: number
    reach: number
    downwind: number
  }
  confidence: 'low'
}

function windSpeedFactor(windKnots: number): number {
  if (windKnots <= 3) return 0.58
  if (windKnots <= 6) return 0.58 + ((windKnots - 3) / 3) * 0.28
  if (windKnots <= 8) return 0.86 + ((windKnots - 6) / 2) * 0.14
  if (windKnots <= 10) return 1 + ((windKnots - 8) / 2) * 0.1
  if (windKnots <= 16) return 1.1 + ((windKnots - 10) / 6) * 0.12
  return 1.22
}

export function recommendedCourseLength(
  className: SupportedSailingClass,
  windKnots: number,
  targetMinutes?: number,
  courseCode: CourseTemplate = className === 'スナイプ' ? 'W2' : 'O2',
): CourseLengthRecommendation {
  const profile = CLASS_PERFORMANCE_PROFILES.find((item) => item.className === className)
  if (!profile) throw new Error(`Unsupported sailing class: ${className}`)

  const factor = windSpeedFactor(windKnots)
  const legMix = courseCode === 'O2' && className === 'スナイプ'
    ? { upwind: 1.86 / 4.58, downwind: 1 / 4.58, reach: 1.72 / 4.58 }
    : courseCode === 'O2' || courseCode === 'I2'
      ? { upwind: 1.91 / 5.03, downwind: 1.82 / 5.03, reach: 1.3 / 5.03 }
      : courseCode === 'T2'
        ? { upwind: 1.86 / 5.44, downwind: 0.14 / 5.44, reach: 3.44 / 5.44 }
        : courseCode === 'トライアングル'
          ? { upwind: 1 / 2.86, downwind: 0.14 / 2.86, reach: 1.72 / 2.86 }
          : courseCode === 'W2'
            ? { upwind: 1.91 / 4.22, downwind: 1.95 / 4.22, reach: 0.36 / 4.22 }
            : { upwind: 0.5, downwind: 0.5, reach: 0 }
  const upwindSpeed = profile.upwindKnotsAt8 * factor
  const downwindSpeed = profile.downwindKnotsAt8 * factor
  const reachSpeed = profile.reachKnotsAt8 * factor
  // Race time is the sum of each leg's distance divided by speed, so the
  // course-average speed must be a weighted harmonic mean, not an arithmetic mean.
  const weightedSpeed = 1 / (
    legMix.upwind / upwindSpeed +
    legMix.downwind / downwindSpeed +
    (legMix.reach ? legMix.reach / reachSpeed : 0)
  )
  const durationHours = (targetMinutes ?? profile.targetMinutes) / 60
  const nauticalMiles = weightedSpeed * durationHours
  const firstLegNauticalMiles = nauticalMiles / courseLegDivisor(courseCode, className)

  return {
    nauticalMiles,
    kilometres: nauticalMiles * 1.852,
    firstLegNauticalMiles,
    firstLegKilometres: firstLegNauticalMiles * 1.852,
    estimatedAverageSpeedKnots: weightedSpeed,
    legSpeedsKnots: {
      closeHauledVmg: upwindSpeed,
      reach: reachSpeed,
      downwindVmg: downwindSpeed,
    },
    legDistanceShare: {
      closeHauled: legMix.upwind,
      reach: legMix.reach,
      downwind: legMix.downwind,
    },
    confidence: 'low',
  }
}
