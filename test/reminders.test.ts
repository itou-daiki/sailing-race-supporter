import { describe, expect, it } from 'vitest'
import {
  createRaceReminders,
  findDueRaceReminder,
  raceReminderKey,
} from '../shared/reminders'

describe('race reminders', () => {
  const warningAt = '2026-07-18T01:00:00.000Z'
  const reminders = createRaceReminders(warningAt, '2R', '470')

  it('creates 20, 10, 5, 1 minute and warning-time reminders', () => {
    expect(reminders.map((item) => item.minutesBeforeWarning)).toEqual([20, 10, 5, 1, 0])
    expect(reminders[0]).toMatchObject({
      scheduledAt: '2026-07-18T00:40:00.000Z',
      title: '2R 予告信号まで20分',
    })
    expect(reminders.at(-1)?.title).toBe('2R 予告信号予定時刻')
  })

  it('emits only the newest due reminder after a sleeping tab resumes', () => {
    const due = findDueRaceReminder(reminders, Date.parse('2026-07-18T00:55:30.000Z'), new Set())
    expect(due.reminder?.minutesBeforeWarning).toBe(5)
    expect(due.consumedMinutes).toEqual([20, 10, 5])
  })

  it('does not repeat delivered thresholds or alert long after warning', () => {
    expect(findDueRaceReminder(
      reminders,
      Date.parse('2026-07-18T00:59:10.000Z'),
      new Set([20, 10, 5]),
    ).reminder?.minutesBeforeWarning).toBe(1)
    expect(findDueRaceReminder(
      reminders,
      Date.parse('2026-07-18T01:01:01.000Z'),
      new Set(),
    ).reminder).toBeUndefined()
  })

  it('isolates delivery state by event, race, schedule, and threshold', () => {
    expect(raceReminderKey('summer cup', 'race/2', warningAt, 10)).toBe(
      'summer%20cup:race%2F2:2026-07-18T01%3A00%3A00.000Z:10',
    )
  })
})
