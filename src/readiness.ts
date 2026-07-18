import type { OperationalTask } from './domain'

export type ReadinessState = 'unconfigured' | 'blocked' | 'incomplete' | 'ready'

export interface ReadinessSummary {
  state: ReadinessState
  completion: number
  required: readonly OperationalTask[]
  reference: readonly OperationalTask[]
  requiredDone: number
  referenceDone: number
  blockers: readonly OperationalTask[]
  remainingRequired: number
}

export function summarizeReadiness(tasks: readonly OperationalTask[]): ReadinessSummary {
  const required = tasks.filter((task) => task.priority === 'required')
  const reference = tasks.filter((task) => task.priority === 'reference')
  const requiredDone = required.filter((task) => task.status === 'done').length
  const referenceDone = reference.filter((task) => task.status === 'done').length
  const blockers = required.filter((task) => task.status === 'blocked')
  const remainingRequired = required.length - requiredDone
  const completion = required.length ? Math.round((requiredDone / required.length) * 100) : 0
  const state: ReadinessState = !required.length
    ? 'unconfigured'
    : blockers.length
      ? 'blocked'
      : remainingRequired
        ? 'incomplete'
        : 'ready'

  return {
    state,
    completion,
    required,
    reference,
    requiredDone,
    referenceDone,
    blockers,
    remainingRequired,
  }
}
