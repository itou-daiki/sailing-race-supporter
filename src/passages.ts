import type { LeadingPassageObservation, LeadingPassageVisit } from './domain'

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
