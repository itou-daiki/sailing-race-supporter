import { describe, expect, it } from 'vitest'
import { canManuallyRescheduleRace, shiftIncompleteTaskDueTimes } from '../shared/schedule'

describe('race schedule', () => {
  it('moves every incomplete task by the warning-time difference', () => {
    expect(shiftIncompleteTaskDueTimes(
      '2026-07-18T01:00:00.000Z',
      '2026-07-18T01:12:00.000Z',
      [
        { id: 'ready', dueAt: '2026-07-18T00:30:00.000Z', status: 'waiting' },
        { id: 'audio', dueAt: '2026-07-18T00:55:00.000Z', status: 'doing' },
      ],
    )).toEqual([
      { taskId: 'ready', dueAt: '2026-07-18T00:42:00.000Z' },
      { taskId: 'audio', dueAt: '2026-07-18T01:07:00.000Z' },
    ])
  })

  it('does not rewrite completed tasks', () => {
    expect(shiftIncompleteTaskDueTimes(
      '2026-07-18T01:00:00.000Z',
      '2026-07-18T01:10:00.000Z',
      [{ id: 'done', dueAt: '2026-07-18T00:45:00.000Z', status: 'done' }],
    )).toEqual([])
  })

  it('only permits manual changes before a start sequence begins', () => {
    expect(canManuallyRescheduleRace('planning')).toBe(true)
    expect(canManuallyRescheduleRace('setup')).toBe(true)
    expect(canManuallyRescheduleRace('start-sequence')).toBe(false)
    expect(canManuallyRescheduleRace('finalized')).toBe(false)
  })
})
