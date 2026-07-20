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

function windSpeedFactor(windKnots: number): number {
  if (windKnots <= 3) return 0.58
  if (windKnots <= 6) return 0.58 + ((windKnots - 3) / 3) * 0.28
  if (windKnots <= 10) return 0.86 + ((windKnots - 6) / 4) * 0.24
  if (windKnots <= 16) return 1.1 + ((windKnots - 10) / 6) * 0.12
  return 1.22
}

export function recommendedCourseLength(
  className: SupportedSailingClass,
  windKnots: number,
  targetMinutes?: number,
): { nauticalMiles: number; kilometres: number; confidence: 'low' } {
  const profile = CLASS_PERFORMANCE_PROFILES.find((item) => item.className === className)
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
