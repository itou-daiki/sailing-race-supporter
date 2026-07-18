export type RaceScheduleStatus = 'planning' | 'setup' | 'start-sequence' | 'racing' | 'provisional' | 'finalized'

export interface ScheduledTask {
  id: string
  dueAt: string
  status: string
}

export interface ShiftedTask {
  taskId: string
  dueAt: string
}

export function canManuallyRescheduleRace(status: RaceScheduleStatus | string): boolean {
  return status === 'planning' || status === 'setup'
}

export function shiftIncompleteTaskDueTimes(
  previousWarningAt: string,
  warningAt: string,
  tasks: readonly ScheduledTask[],
): ShiftedTask[] {
  const previous = Date.parse(previousWarningAt)
  const next = Date.parse(warningAt)
  if (!Number.isFinite(previous) || !Number.isFinite(next)) throw new Error('Invalid warning time')
  const delta = next - previous
  return tasks.flatMap((task) => {
    if (task.status === 'done') return []
    const dueAt = Date.parse(task.dueAt)
    if (!Number.isFinite(dueAt)) return []
    return [{ taskId: task.id, dueAt: new Date(dueAt + delta).toISOString() }]
  })
}
