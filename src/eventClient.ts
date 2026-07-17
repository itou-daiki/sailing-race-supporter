import type {
  CommitteeBoat,
  CourseMark,
  OperationalMessage,
  RaceDefinition,
  SailingClass,
} from './domain'

export interface EventSummary {
  id: string
  slug: string
  name: string
  starts_on: string
  ends_on: string
  status: string
  relationship: 'owner' | 'member'
  role: string
  assignment: string
}

export interface EventAccessSummary {
  memberId: string
  displayName: string
  role: string
  assignment: string
  isOwner: boolean
}

export interface EventBootstrap {
  event: { id: string; slug: string; name: string; startsOn: string; endsOn: string; status: string }
  access: EventAccessSummary
  races: RaceDefinition[]
  boats: CommitteeBoat[]
  messages: OperationalMessage[]
  resources: EventResources
  wind?: { directionDegrees: number; speedKnots: number; gustKnots: number; observedAt: string; source: string }
}

export interface EventResources {
  boats: Array<{ id: string; name: string; assignment: string; role: string }>
  marks: Array<{ id: string; label: string }>
}

export interface CreateEventInput {
  name: string
  startsOn: string
  endsOn: string
  raceCount: number
  className: SailingClass
  courseCode: string
  firstWarningAt: string
  center?: { longitude: number; latitude: number }
}

interface BootstrapResponse {
  access: EventAccessSummary
  regatta: { id: string; slug: string; name: string; starts_on: string; ends_on: string; status: string }
  races: Array<{
    id: string; race_number: string; class_name: SailingClass; course_code: string
    status: RaceDefinition['status']; warning_at: string; target_minutes: number
  }>
  courseNodes: Array<{
    race_id: string; node_id: string; mark_id: string | null; node_order: number; label: string
    node_type: string; target_lng: number; target_lat: number; mark_type: string | null
  }>
  markEvents: Array<{
    race_id: string; mark_id: string; event_type: string; lng: number | null; lat: number | null
    sequence: number
  }>
  boats: Array<{
    id: string; name: string; role: string; call_sign: string | null; status: string
    lng: number | null; lat: number | null; speed_knots: number | null; course_degrees: number | null; sampled_at: string | null
  }>
  wind: {
    direction_degrees: number; speed_knots: number; gust_knots: number | null; observed_at: string; source: string
  } | null
  messages: Array<{
    id: string; race_id: string | null; channel_key: string; priority: OperationalMessage['priority']
    body: string; sent_at: string; sender: string
  }>
}

class EventApiError extends Error {}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) throw new EventApiError('大会サーバーへ接続できません')
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new EventApiError(body.error ?? `大会APIエラー (${response.status})`)
  return body
}

function shortLabel(label: string): string {
  if (label.includes('スタート・ピン')) return 'PIN'
  if (label.includes('シグナル')) return 'RC'
  return label
    .replace('オフセット ', '')
    .replace('下ゲート ', '')
    .replace('上ゲート ', '')
    .replace('マーク', '')
    .trim()
}

function bootstrapMarks(response: BootstrapResponse, raceId: string): CourseMark[] {
  const latest = new Map<string, BootstrapResponse['markEvents'][number]>()
  response.markEvents.filter((event) => event.race_id === raceId).forEach((event) => {
    const existing = latest.get(event.mark_id)
    if (!existing || event.sequence > existing.sequence) latest.set(event.mark_id, event)
  })
  return response.courseNodes
    .filter((node) => node.race_id === raceId && node.mark_id)
    .sort((left, right) => left.node_order - right.node_order)
    .map((node) => {
      const event = latest.get(node.mark_id as string)
      const hasActual = event?.lng != null && event.lat != null
      const status: CourseMark['status'] = event?.event_type === 'confirmed'
        ? 'confirmed'
        : hasActual ? 'deployed' : 'planned'
      return {
        id: node.mark_id as string,
        label: node.label,
        shortLabel: shortLabel(node.label),
        target: [node.target_lng, node.target_lat],
        actual: hasActual ? [event.lng as number, event.lat as number] : undefined,
        status,
        isGate: node.node_type === 'gate',
        gateSide: node.label.endsWith('S') ? 'S' : node.label.endsWith('P') ? 'P' : undefined,
      }
    })
}

export async function loadEventBootstrap(eventReference: string): Promise<EventBootstrap> {
  const response = await apiJson<BootstrapResponse>(
    `/api/events/${encodeURIComponent(eventReference)}/bootstrap`,
    { method: 'GET', headers: {} },
  )
  return {
    event: {
      id: response.regatta.id,
      slug: response.regatta.slug,
      name: response.regatta.name,
      startsOn: response.regatta.starts_on,
      endsOn: response.regatta.ends_on,
      status: response.regatta.status,
    },
    access: response.access,
    races: response.races.map((race) => ({
      id: race.id,
      number: race.race_number,
      className: race.class_name,
      courseCode: race.course_code,
      status: race.status,
      warningAt: race.warning_at,
      targetMinutes: race.target_minutes,
      marks: bootstrapMarks(response, race.id),
    })),
    boats: response.boats
      .filter((boat) => boat.lng != null && boat.lat != null)
      .map((boat) => ({
        id: boat.id,
        name: boat.name,
        assignment: boat.call_sign ?? boat.role,
        position: [boat.lng as number, boat.lat as number],
        speedKnots: boat.speed_knots ?? 0,
        courseDegrees: boat.course_degrees ?? undefined,
        freshnessSeconds: boat.sampled_at ? Math.max(0, (Date.now() - Date.parse(boat.sampled_at)) / 1_000) : 9_999,
        isSelf: response.access.assignment === boat.call_sign || response.access.assignment === boat.name,
        status: boat.status === 'active' ? 'stationed' : 'offline',
      })),
    messages: response.messages.map((message) => ({
      id: message.id,
      sender: message.sender,
      channel: message.channel_key,
      text: message.body,
      sentAt: message.sent_at,
      priority: message.priority,
    })),
    resources: {
      boats: response.boats.map((boat) => ({
        id: boat.id,
        name: boat.name,
        assignment: boat.call_sign ?? boat.name,
        role: boat.role,
      })),
      marks: [...new Map(response.courseNodes
        .filter((node) => node.mark_id)
        .map((node) => [node.mark_id as string, { id: node.mark_id as string, label: node.label }])).values()],
    },
    wind: response.wind ? {
      directionDegrees: response.wind.direction_degrees,
      speedKnots: response.wind.speed_knots,
      gustKnots: response.wind.gust_knots ?? response.wind.speed_knots,
      observedAt: response.wind.observed_at,
      source: response.wind.source,
    } : undefined,
  }
}

export async function listEvents(): Promise<EventSummary[]> {
  return (await apiJson<{ events: EventSummary[] }>('/api/events', { method: 'GET', headers: {} })).events
}

export async function createEvent(input: CreateEventInput): Promise<{ event: EventBootstrap['event']; url: string }> {
  return apiJson('/api/events', { method: 'POST', body: JSON.stringify(input) })
}
