import type { CourseMark, LeadingPassageObservation, LeadingPassageVisit } from './domain'

export interface LatestPassageSummary {
  markId: string
  markLabel: string
  lapNumber: number
  passedAt: string
  adopted: boolean
  hasConflict: boolean
}

export function passageVisitKey(raceId: string, markId: string, lapNumber = 1): string {
  return `${raceId}:${markId}:${lapNumber}`
}

function passageSpread(observations: readonly LeadingPassageObservation[]): number {
  const times = observations
    .filter((observation) => observation.status === 'active')
    .map((observation) => Date.parse(observation.passedAt))
    .filter(Number.isFinite)
  return times.length > 1 ? Math.max(...times) - Math.min(...times) : 0
}

export function mergePassageObservation(
  current: LeadingPassageVisit | undefined,
  raceId: string,
  markId: string,
  lapNumber: number,
  observation: LeadingPassageObservation,
): LeadingPassageVisit {
  const observations = current?.observations.some((candidate) => candidate.id === observation.id)
    ? current.observations.map((candidate) => candidate.id === observation.id ? observation : candidate)
    : [...(current?.observations ?? []), observation]
  const spreadMilliseconds = passageSpread(observations)
  return {
    raceId,
    markId,
    lapNumber,
    observations,
    adoptedObservationId: current?.adoptedObservationId,
    adoptedAt: current?.adoptedAt,
    spreadMilliseconds,
    hasConflict: spreadMilliseconds > 2_000,
  }
}

export function adoptPassageObservation(
  current: LeadingPassageVisit,
  observationId: string,
  adoptedAt: string,
): LeadingPassageVisit {
  return { ...current, adoptedObservationId: observationId, adoptedAt }
}

export function latestPassageSummary(
  visits: Readonly<Record<string, LeadingPassageVisit>>,
  marks: readonly CourseMark[],
  raceId: string,
): LatestPassageSummary | undefined {
  const summaries = Object.values(visits).flatMap((visit) => {
    if (visit.raceId !== raceId) return []
    const active = visit.observations.filter((observation) => observation.status === 'active')
    const adopted = active.find((observation) => observation.id === visit.adoptedObservationId)
    const observation = adopted ?? active.reduce<LeadingPassageObservation | undefined>((latest, candidate) => (
      !latest || Date.parse(candidate.passedAt) > Date.parse(latest.passedAt) ? candidate : latest
    ), undefined)
    if (!observation || !Number.isFinite(Date.parse(observation.passedAt))) return []
    return [{
      markId: visit.markId,
      markLabel: marks.find((mark) => mark.id === visit.markId)?.shortLabel ?? 'マーク',
      lapNumber: visit.lapNumber,
      passedAt: observation.passedAt,
      adopted: Boolean(adopted),
      hasConflict: visit.hasConflict,
    }]
  })
  return summaries.reduce<LatestPassageSummary | undefined>((latest, candidate) => (
    !latest || Date.parse(candidate.passedAt) > Date.parse(latest.passedAt) ? candidate : latest
  ), undefined)
}
