import { distanceMetres } from './course'
import type { CourseMark, WindObservation } from './domain'

export interface MarkWindReading {
  observation: WindObservation
  association: 'explicit-mark' | 'assigned-boat' | 'nearest-observation'
}

const NEAREST_OBSERVATION_LIMIT_METRES = 2_500

export function knotsToMetresPerSecond(knots: number): number {
  return knots * 0.514444
}

export function formatWindSpeedDual(knots: number): string {
  return `${knots.toFixed(1)} kt / ${knotsToMetresPerSecond(knots).toFixed(1)} m/s`
}

function latestObservations(observations: readonly WindObservation[]): WindObservation[] {
  const latest = new Map<string, WindObservation>()
  observations.forEach((observation, index) => {
    const key = observation.markId
      ? `mark:${observation.markId}`
      : observation.committeeBoatId ?? `source:${observation.source}:${index}`
    const existing = latest.get(key)
    if (!existing || Date.parse(observation.observedAt) > Date.parse(existing.observedAt)) latest.set(key, observation)
  })
  return [...latest.values()]
}

export function assignWindReadingsToMarks(
  marks: readonly CourseMark[],
  observations: readonly WindObservation[],
): ReadonlyMap<string, MarkWindReading> {
  const readings = new Map<string, MarkWindReading>()
  const latest = latestObservations(observations)

  latest.forEach((observation) => {
    if (!observation.markId || !marks.some((mark) => mark.id === observation.markId)) return
    readings.set(observation.markId, { observation, association: 'explicit-mark' })
  })

  marks.forEach((mark) => {
    if (readings.has(mark.id)) return
    if (!mark.assignedBoatId) return
    const direct = latest.find((observation) => !observation.markId && observation.committeeBoatId === mark.assignedBoatId)
    if (direct) readings.set(mark.id, { observation: direct, association: 'assigned-boat' })
  })

  latest.forEach((observation) => {
    if (observation.markId) return
    if (!observation.position) return
    if (marks.some((mark) => mark.assignedBoatId === observation.committeeBoatId)) return
    const nearest = marks
      .filter((mark) => !readings.has(mark.id))
      .map((mark) => ({ mark, distance: distanceMetres(mark.actual ?? mark.target, observation.position!) }))
      .sort((left, right) => left.distance - right.distance)[0]
    if (nearest && nearest.distance <= NEAREST_OBSERVATION_LIMIT_METRES) {
      readings.set(nearest.mark.id, { observation, association: 'nearest-observation' })
    }
  })

  return readings
}
