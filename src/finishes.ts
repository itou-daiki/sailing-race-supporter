import type { FinishObservation, FinishRecord } from './domain'

export function finishRecordKey(raceId: string, finishPosition = 1): string {
  return `${raceId}:${finishPosition}`
}

function finishSpread(observations: readonly FinishObservation[]): number {
  const times = observations
    .filter((observation) => observation.status === 'active')
    .map((observation) => Date.parse(observation.finishedAt))
    .filter(Number.isFinite)
  return times.length > 1 ? Math.max(...times) - Math.min(...times) : 0
}

export function mergeFinishObservation(
  current: FinishRecord | undefined,
  raceId: string,
  finishPosition: number,
  observation: FinishObservation,
): FinishRecord {
  const observations = current?.observations.some((candidate) => candidate.id === observation.id)
    ? current.observations.map((candidate) => candidate.id === observation.id ? observation : candidate)
    : [...(current?.observations ?? []), observation]
  const spreadMilliseconds = finishSpread(observations)
  return {
    raceId,
    finishPosition,
    observations,
    adoptedObservationId: current?.adoptedObservationId,
    adoptedAt: current?.adoptedAt,
    spreadMilliseconds,
    hasConflict: spreadMilliseconds > 2_000,
  }
}

export function adoptFinishObservation(
  current: FinishRecord,
  observationId: string,
  adoptedAt: string,
): FinishRecord {
  return { ...current, adoptedObservationId: observationId, adoptedAt }
}
