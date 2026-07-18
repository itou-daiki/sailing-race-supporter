export const RACE_REMINDER_MINUTES = [20, 10, 5, 1, 0] as const

export interface RaceReminder {
  minutesBeforeWarning: number
  scheduledAt: string
  title: string
  body: string
}

export interface DueRaceReminder {
  reminder?: RaceReminder
  consumedMinutes: readonly number[]
}

export function raceReminderKey(
  eventSlug: string,
  raceId: string,
  warningAt: string,
  minutesBeforeWarning: number,
): string {
  return [eventSlug, raceId, warningAt, minutesBeforeWarning].map(encodeURIComponent).join(':')
}

export function createRaceReminders(
  warningAt: string,
  raceNumber: string,
  className: string,
): readonly RaceReminder[] {
  const warningTime = Date.parse(warningAt)
  if (!Number.isFinite(warningTime)) return []

  return RACE_REMINDER_MINUTES.map((minutesBeforeWarning) => ({
    minutesBeforeWarning,
    scheduledAt: new Date(warningTime - minutesBeforeWarning * 60_000).toISOString(),
    title: minutesBeforeWarning === 0
      ? `${raceNumber} 予告信号予定時刻`
      : `${raceNumber} 予告信号まで${minutesBeforeWarning}分`,
    body: `${className}・予告 ${new Intl.DateTimeFormat('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(warningTime))}`,
  }))
}

/**
 * Returns at most one alert after a suspended/backgrounded page wakes up. Older
 * thresholds are consumed at the same time so operators never receive a burst.
 */
export function findDueRaceReminder(
  reminders: readonly RaceReminder[],
  now: number,
  deliveredMinutes: ReadonlySet<number>,
): DueRaceReminder {
  const warningAt = reminders.find((item) => item.minutesBeforeWarning === 0)?.scheduledAt
  const warningTime = warningAt ? Date.parse(warningAt) : Number.NaN
  if (!Number.isFinite(now) || !Number.isFinite(warningTime) || now > warningTime + 60_000) {
    return { consumedMinutes: [] }
  }

  const due = reminders.filter((item) => (
    !deliveredMinutes.has(item.minutesBeforeWarning) && Date.parse(item.scheduledAt) <= now
  ))
  if (!due.length) return { consumedMinutes: [] }

  return {
    reminder: due.reduce((latest, item) => (
      Date.parse(item.scheduledAt) > Date.parse(latest.scheduledAt) ? item : latest
    )),
    consumedMinutes: due.map((item) => item.minutesBeforeWarning),
  }
}
