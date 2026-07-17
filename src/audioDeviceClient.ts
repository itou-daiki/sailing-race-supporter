import { useCallback, useEffect, useMemo, useState } from 'react'

interface OfficialAudioDevice {
  raceId: string
  deviceId: string
  deviceLabel: string
  memberId: string
  memberName: string
  readiness: {
    audioTested: boolean
    volumeConfirmed: boolean
    speakerConfirmed: boolean
    clockOffsetMs: number
  }
  claimedAt: string
  readyAt: string
  lastSeenAt: string
}

interface AudioDeviceResponse {
  device: OfficialAudioDevice | null
  error?: string
}

export interface OfficialAudioState {
  raceId: string
  status: 'loading' | 'available' | 'mine' | 'other'
  device?: OfficialAudioDevice
  networkAvailable: boolean
  error?: string
}

const DEVICE_ID_KEY = 'srs-official-audio-device-id'

function localDeviceId(): string {
  const stored = window.localStorage.getItem(DEVICE_ID_KEY)
  if (stored) return stored
  const created = crypto.randomUUID()
  window.localStorage.setItem(DEVICE_ID_KEY, created)
  return created
}

function localDeviceLabel(deviceId: string): string {
  const agent = navigator.userAgent
  const kind = /iPad/u.test(agent) ? 'iPad' : /iPhone/u.test(agent) ? 'iPhone' : /Android/u.test(agent) ? 'Android' : /Mac/u.test(agent) ? 'Mac' : 'Web端末'
  return `${kind} ${deviceId.slice(0, 4).toUpperCase()}`
}

async function request(
  eventSlug: string,
  raceId: string,
  init?: RequestInit,
): Promise<AudioDeviceResponse> {
  const response = await fetch(
    `/api/events/${encodeURIComponent(eventSlug)}/races/${encodeURIComponent(raceId)}/official-audio-device`,
    {
      ...init,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...init?.headers },
    },
  )
  const body = await response.json() as AudioDeviceResponse
  if (!response.ok) throw new Error(body.error ?? `公式音響端末APIエラー (${response.status})`)
  return body
}

export function useOfficialAudioDevice(options: {
  eventSlug: string
  raceId: string
  enabled: boolean
  serverOffsetMs: number
}) {
  const deviceId = useMemo(localDeviceId, [])
  const deviceLabel = useMemo(() => localDeviceLabel(deviceId), [deviceId])
  const [state, setState] = useState<OfficialAudioState>({
    raceId: options.raceId,
    status: 'loading',
    networkAvailable: navigator.onLine,
  })

  const apply = useCallback((raceId: string, device: OfficialAudioDevice | null) => {
    setState({
      raceId,
      status: !device ? 'available' : device.deviceId === deviceId ? 'mine' : 'other',
      device: device ?? undefined,
      networkAvailable: true,
    })
  }, [deviceId])

  useEffect(() => {
    if (!options.enabled) return
    let active = true
    const tick = async () => {
      try {
        const current = await request(options.eventSlug, options.raceId)
        if (!active) return
        if (current.device?.deviceId === deviceId) {
          const heartbeat = await request(options.eventSlug, options.raceId, {
            method: 'POST', body: JSON.stringify({ action: 'heartbeat', deviceId }),
          })
          if (active) apply(options.raceId, heartbeat.device)
        } else {
          apply(options.raceId, current.device)
        }
      } catch (reason) {
        if (!active) return
        setState((current) => current.status === 'mine' && current.raceId === options.raceId
          ? { ...current, networkAvailable: false, error: reason instanceof Error ? reason.message : '同期できません' }
          : { raceId: options.raceId, status: 'loading', networkAvailable: false, error: reason instanceof Error ? reason.message : '同期できません' })
      }
    }
    void tick()
    const interval = window.setInterval(() => void tick(), 15_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [apply, deviceId, options.enabled, options.eventSlug, options.raceId])

  const claim = useCallback(async (force = false) => {
    const result = await request(options.eventSlug, options.raceId, {
      method: 'POST',
      body: JSON.stringify({
        action: 'claim', deviceId, deviceLabel, force,
        readiness: {
          audioTested: true,
          volumeConfirmed: true,
          speakerConfirmed: true,
          clockOffsetMs: Math.round(options.serverOffsetMs),
        },
      }),
    })
    apply(options.raceId, result.device)
  }, [apply, deviceId, deviceLabel, options.eventSlug, options.raceId, options.serverOffsetMs])

  const release = useCallback(async () => {
    const result = await request(options.eventSlug, options.raceId, {
      method: 'POST', body: JSON.stringify({ action: 'release', deviceId }),
    })
    apply(options.raceId, result.device)
  }, [apply, deviceId, options.eventSlug, options.raceId])

  const visibleState: OfficialAudioState = state.raceId === options.raceId
    ? state
    : { raceId: options.raceId, status: 'loading', networkAvailable: navigator.onLine }
  return { state: visibleState, claim, release }
}
