import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createRaceReminders,
  findDueRaceReminder,
  raceReminderKey,
} from '../shared/reminders'

const ENABLED_KEY = 'srs-race-device-assist-enabled'
const DELIVERED_KEY = 'srs-race-reminders-v1'
const MAX_DELIVERED_KEYS = 200

type NotificationSupport = NotificationPermission | 'unsupported'

interface RaceDeviceAssistInput {
  eventSlug: string
  eventName: string
  raceId: string
  raceNumber: string
  className: string
  warningAt: string
  serverOffsetMs: number
  remindersPaused: boolean
}

interface RaceDeviceAssistState {
  enabled: boolean
  notificationPermission: NotificationSupport
  wakeLockActive: boolean
  label: string
  status: string
  toggle: () => Promise<void>
}

function loadEnabled(): boolean {
  return window.localStorage.getItem(ENABLED_KEY) === 'true'
}

function notificationPermission(): NotificationSupport {
  return 'Notification' in window ? Notification.permission : 'unsupported'
}

function readDeliveredKeys(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(DELIVERED_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function rememberDeliveredKeys(keys: readonly string[]) {
  const merged = [...new Set([...readDeliveredKeys(), ...keys])].slice(-MAX_DELIVERED_KEYS)
  window.localStorage.setItem(DELIVERED_KEY, JSON.stringify(merged))
}

async function showRaceReminder(title: string, body: string, url: string, tag: string): Promise<void> {
  if (navigator.vibrate && navigator.userActivation?.hasBeenActive) {
    navigator.vibrate([180, 80, 180])
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return

  try {
    const registration = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration()
      : undefined
    if (registration?.active) {
      registration.active.postMessage({
        type: 'SHOW_RACE_REMINDER',
        notification: { title, body, url, tag },
      })
      return
    }

    const notification = new Notification(title, { body, tag })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
  } catch {
    // Some mobile browsers grant Service Worker notifications but reject the
    // window Notification constructor. The visible timer remains authoritative.
  }
}

export function useRaceDeviceAssist(input: RaceDeviceAssistInput): RaceDeviceAssistState {
  const [enabled, setEnabled] = useState(loadEnabled)
  const [permission, setPermission] = useState<NotificationSupport>(notificationPermission)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const wakeLockRef = useRef<WakeLockSentinel | undefined>(undefined)

  const reminders = useMemo(() => createRaceReminders(
    input.warningAt,
    input.raceNumber,
    input.className,
  ), [input.className, input.raceNumber, input.warningAt])

  const releaseWakeLock = useCallback(async () => {
    const wakeLock = wakeLockRef.current
    wakeLockRef.current = undefined
    if (wakeLock) await wakeLock.release().catch(() => undefined)
    setWakeLockActive(false)
  }, [])

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return false
    try {
      await releaseWakeLock()
      const wakeLock = await navigator.wakeLock.request('screen')
      wakeLockRef.current = wakeLock
      setWakeLockActive(true)
      wakeLock.addEventListener('release', () => {
        if (wakeLockRef.current === wakeLock) wakeLockRef.current = undefined
        setWakeLockActive(false)
      }, { once: true })
      return true
    } catch {
      setWakeLockActive(false)
      return false
    }
  }, [releaseWakeLock])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      setPermission(notificationPermission())
      if (enabled) void requestWakeLock()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [enabled, requestWakeLock])

  useEffect(() => {
    if (!enabled || document.visibilityState !== 'visible') return
    const timeout = window.setTimeout(() => void requestWakeLock(), 0)
    return () => window.clearTimeout(timeout)
  }, [enabled, requestWakeLock])

  useEffect(() => () => {
    const wakeLock = wakeLockRef.current
    wakeLockRef.current = undefined
    if (wakeLock) void wakeLock.release()
  }, [])

  useEffect(() => {
    if (!enabled || input.remindersPaused) return

    const check = () => {
      const deliveredKeys = new Set(readDeliveredKeys())
      const deliveredMinutes = new Set(reminders
        .filter((item) => deliveredKeys.has(raceReminderKey(
          input.eventSlug,
          input.raceId,
          input.warningAt,
          item.minutesBeforeWarning,
        )))
        .map((item) => item.minutesBeforeWarning))
      const due = findDueRaceReminder(reminders, Date.now() + input.serverOffsetMs, deliveredMinutes)
      if (!due.reminder) return

      const keys = due.consumedMinutes.map((minutes) => raceReminderKey(
        input.eventSlug,
        input.raceId,
        input.warningAt,
        minutes,
      ))
      rememberDeliveredKeys(keys)
      void showRaceReminder(
        due.reminder.title,
        `${input.eventName}・${due.reminder.body}`,
        `${window.location.origin}/e/${encodeURIComponent(input.eventSlug)}`,
        raceReminderKey(input.eventSlug, input.raceId, input.warningAt, due.reminder.minutesBeforeWarning),
      )
    }

    check()
    const interval = window.setInterval(check, 5_000)
    return () => window.clearInterval(interval)
  }, [enabled, input.eventName, input.eventSlug, input.raceId, input.remindersPaused, input.serverOffsetMs, input.warningAt, reminders])

  const toggle = useCallback(async () => {
    if (enabled) {
      setEnabled(false)
      window.localStorage.setItem(ENABLED_KEY, 'false')
      await releaseWakeLock()
      return
    }

    let nextPermission = notificationPermission()
    if (nextPermission === 'default') {
      nextPermission = await Notification.requestPermission()
    }
    setPermission(nextPermission)
    setEnabled(true)
    window.localStorage.setItem(ENABLED_KEY, 'true')
  }, [enabled, releaseWakeLock])

  const notificationStatus = permission === 'granted'
    ? '通知ON'
    : permission === 'denied' ? '通知は端末設定で拒否中'
    : permission === 'unsupported' ? '通知非対応'
    : '通知許可待ち'
  const wakeStatus = 'wakeLock' in navigator
    ? wakeLockActive ? '画面維持中' : '画面維持待ち'
    : '画面維持非対応'

  return {
    enabled,
    notificationPermission: permission,
    wakeLockActive,
    label: enabled ? '運営モードをOFF' : '通知・画面維持をON',
    status: enabled
      ? `${notificationStatus}・${wakeStatus}${input.remindersPaused ? '・リマインド保留' : ''}`
      : '端末リマインドOFF',
    toggle,
  }
}
