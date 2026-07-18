export type EventLogCategory = 'audit' | 'mark' | 'wind' | 'current' | 'signal' | 'schedule' | 'passage' | 'finish' | 'task' | 'message' | 'position'

export interface EventLogEntry {
  id: string
  raceId: string | null
  raceNumber: string | null
  sequence: number | null
  occurredAt: string
  category: EventLogCategory
  title: string
  actor: string
  detail: string
  eventHash: string | null
}

export interface EventLogResponse {
  format: 'srs-event-log'
  schemaVersion: number
  createdAt: string
  createdBy?: string
  event?: {
    id: string
    slug: string
    name: string
  }
  raceId?: string | null
  entries: EventLogEntry[]
}

function endpoint(eventSlug: string, raceId: string | null, extra: Record<string, string> = {}): string {
  const parameters = new URLSearchParams(extra)
  if (raceId) parameters.set('raceId', raceId)
  return `/api/events/${encodeURIComponent(eventSlug)}/logs?${parameters}`
}

export async function loadEventLogs(eventSlug: string, raceId: string | null): Promise<EventLogResponse> {
  const response = await fetch(endpoint(eventSlug, raceId, { limit: '300' }), { credentials: 'same-origin' })
  const body = await response.json() as EventLogResponse & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `ログを取得できません (${response.status})`)
  return body
}

export async function loadEventLogExport(eventSlug: string, raceId: string | null): Promise<EventLogResponse> {
  const response = await fetch(endpoint(eventSlug, raceId, { format: 'json', download: '1' }), { credentials: 'same-origin' })
  const body = await response.json() as EventLogResponse & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `ログレポートを作成できません (${response.status})`)
  return body
}

export async function downloadEventLog(eventSlug: string, raceId: string | null, format: 'json' | 'csv'): Promise<void> {
  const response = await fetch(endpoint(eventSlug, raceId, { format, download: '1' }), { credentials: 'same-origin' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `ログを書き出せません (${response.status})`)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${eventSlug}-${raceId ? 'race' : 'event'}-log.${format}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
