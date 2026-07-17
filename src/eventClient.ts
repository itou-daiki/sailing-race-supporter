import type {
  CommitteeBoat,
  CourseMark,
  LeadingPassageVisit,
  OperationalMessage,
  OperationalTask,
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
  tasks: OperationalTask[]
  leadingPassages: Record<string, LeadingPassageVisit>
  memberCount: number
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

export interface RetentionPolicy {
  finalizedRecordsDays: number
  observationsDays: number
  sampledPositionsDays: number
  localHighFrequencyTrackDays: number
  regularMessagesDays: number
  memberProfilesDays: number
  authSecretsAfterEventDays: number
  securityLogsDays: number
}

interface BootstrapResponse {
  access: EventAccessSummary
  regatta: { id: string; slug: string; name: string; starts_on: string; ends_on: string; status: string }
  races: Array<{
    id: string; race_number: string; class_name: SailingClass; course_code: string
    status: RaceDefinition['status']; warning_at: string; target_minutes: number
  }>
  raceAreas: Array<{ id: string; name: string; center_lng: number | null; center_lat: number | null }>
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
  tasks: Array<{
    id: string; race_id: string; title: string; status: OperationalTask['status']
    priority: OperationalTask['priority']; due_at: string; owner: string
  }>
  leadingPassages: Array<{
    id: string; race_id: string; mark_id: string; lap_number: number; passed_at: string; recorded_by: string
    sync_quality: 'good' | 'fair' | 'poor' | 'offline' | 'unknown'; was_offline: number
    sail_number: string | null; note: string | null; status: 'active' | 'cancelled' | 'corrected'
    adopted_observation_id: string | null; adopted_at: string | null; adoption_revision: number | null
  }>
  memberCount: number
  raceCorrections: Array<{
    race_id: string; revision: number; patch_json: string; reason: string; state_hash: string; created_at: string
  }>
  availableMarks: Array<{ id: string; label: string; mark_type: string }>
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

function formatClock(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
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

function bootstrapLeadingPassages(rows: BootstrapResponse['leadingPassages']): Record<string, LeadingPassageVisit> {
  const visits: Record<string, LeadingPassageVisit> = {}
  for (const row of rows ?? []) {
    const key = `${row.race_id}:${row.mark_id}:${row.lap_number}`
    const visit = visits[key] ?? {
      raceId: row.race_id,
      markId: row.mark_id,
      lapNumber: row.lap_number,
      observations: [],
      adoptedObservationId: row.adopted_observation_id ?? undefined,
      adoptedAt: row.adopted_at ?? undefined,
      spreadMilliseconds: 0,
      hasConflict: false,
    }
    visit.observations.push({
      id: row.id,
      passedAt: row.passed_at,
      recordedBy: row.recorded_by,
      syncQuality: row.sync_quality ?? 'unknown',
      wasOffline: Boolean(row.was_offline),
      sailNumber: row.sail_number ?? undefined,
      note: row.note ?? undefined,
      status: row.status,
    })
    if (row.adopted_observation_id && row.adopted_at && (
      !visit.adoptedAt || Date.parse(row.adopted_at) >= Date.parse(visit.adoptedAt)
    )) {
      visit.adoptedObservationId = row.adopted_observation_id
      visit.adoptedAt = row.adopted_at
    }
    visits[key] = visit
  }
  for (const visit of Object.values(visits)) {
    const times = visit.observations
      .filter((observation) => observation.status === 'active')
      .map((observation) => Date.parse(observation.passedAt))
      .filter(Number.isFinite)
    visit.spreadMilliseconds = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0
    visit.hasConflict = visit.spreadMilliseconds > 2_000
  }
  return visits
}

export async function loadEventBootstrap(eventReference: string): Promise<EventBootstrap> {
  const response = await apiJson<BootstrapResponse>(
    `/api/events/${encodeURIComponent(eventReference)}/bootstrap`,
    { method: 'GET', headers: {} },
  )
  const center = response.raceAreas?.find((area) => area.center_lng != null && area.center_lat != null)
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
    races: response.races.map((race) => {
      const latest = (response.raceCorrections ?? []).find((correction) => correction.race_id === race.id)
      let corrections: { courseCode?: string; warningAt?: string; targetMinutes?: number } = {}
      try {
        if (latest) corrections = JSON.parse(latest.patch_json) as typeof corrections
      } catch { /* Invalid historical patches do not replace the finalized base record. */ }
      return {
        id: race.id,
        number: race.race_number,
        className: race.class_name,
        courseCode: corrections.courseCode ?? race.course_code,
        status: race.status,
        warningAt: corrections.warningAt ?? race.warning_at,
        targetMinutes: corrections.targetMinutes ?? race.target_minutes,
        marks: bootstrapMarks(response, race.id),
      }
    }),
    boats: response.boats
      .filter((boat) => {
        const isSelf = response.access.assignment === boat.call_sign || response.access.assignment === boat.name
        return boat.lng != null && boat.lat != null || Boolean(isSelf && center)
      })
      .map((boat) => {
        const isSelf = response.access.assignment === boat.call_sign || response.access.assignment === boat.name
        const hasPosition = boat.lng != null && boat.lat != null
        return {
          id: boat.id,
          name: boat.name,
          assignment: isSelf ? `${boat.call_sign ?? boat.name}（自分）` : boat.call_sign ?? boat.role,
          position: hasPosition
            ? [boat.lng as number, boat.lat as number]
            : [center?.center_lng as number, center?.center_lat as number],
          speedKnots: boat.speed_knots ?? 0,
          courseDegrees: boat.course_degrees ?? undefined,
          freshnessSeconds: boat.sampled_at ? Math.max(0, (Date.now() - Date.parse(boat.sampled_at)) / 1_000) : 9_999,
          isSelf,
          status: hasPosition && boat.status === 'active' ? 'stationed' : 'offline',
        }
      }),
    messages: response.messages.map((message) => ({
      id: message.id,
      sender: message.sender,
      channel: message.channel_key,
      text: message.body,
      sentAt: message.sent_at,
      priority: message.priority,
    })),
    tasks: (response.tasks ?? []).map((task) => ({
      id: task.id,
      raceId: task.race_id,
      title: task.title,
      owner: task.owner,
      status: task.status,
      dueLabel: `${formatClock(task.due_at)}まで`,
      priority: task.priority,
    })),
    leadingPassages: bootstrapLeadingPassages(response.leadingPassages ?? []),
    memberCount: response.memberCount ?? 0,
    resources: {
      boats: response.boats.map((boat) => ({
        id: boat.id,
        name: boat.name,
        assignment: boat.call_sign ?? boat.name,
        role: boat.role,
      })),
      marks: (response.availableMarks ?? [...new Map(response.courseNodes
        .filter((node) => node.mark_id)
        .map((node) => [node.mark_id as string, { id: node.mark_id as string, label: node.label, mark_type: node.mark_type ?? 'rounding' }])).values()])
        .map((mark) => ({ id: mark.id, label: mark.label })),
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

export async function createPostFinalizationRevision(
  eventSlug: string,
  raceId: string,
  reason: string,
  corrections: { courseCode?: string; targetMinutes?: number; warningAt?: string; note?: string },
): Promise<{ revision: number; createdAt: string; stateHash: string; corrections: typeof corrections; reason: string }> {
  return apiJson(`/api/events/${encodeURIComponent(eventSlug)}/races/${encodeURIComponent(raceId)}/post-finalization-revisions`, {
    method: 'POST',
    body: JSON.stringify({ reason, corrections }),
  })
}

export async function saveCourseRevision(
  eventSlug: string,
  raceId: string,
  input: {
    courseCode: string
    windDirection: number
    windSpeed: number
    targetLengthMetres: number
    lowerGate: boolean
    upperGate: boolean
    nodes: Array<{ markId: string; label: string; nodeType: string; rounding?: string; target: readonly [number, number] }>
  },
): Promise<{ revisionId: string; revision: number; createdAt: string }> {
  return apiJson(`/api/events/${encodeURIComponent(eventSlug)}/races/${encodeURIComponent(raceId)}/course-revisions`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function loadRetentionPolicy(eventSlug: string): Promise<RetentionPolicy> {
  return (await apiJson<{ policy: RetentionPolicy }>(
    `/api/events/${encodeURIComponent(eventSlug)}/settings/retention`,
    { method: 'GET', headers: {} },
  )).policy
}

export async function saveRetentionPolicy(eventSlug: string, policy: RetentionPolicy): Promise<RetentionPolicy> {
  return (await apiJson<{ policy: RetentionPolicy }>(
    `/api/events/${encodeURIComponent(eventSlug)}/settings/retention`,
    { method: 'PATCH', body: JSON.stringify({ policy }) },
  )).policy
}

export interface RetentionRunReport {
  runId: string
  eventId: string
  status: 'completed' | 'skipped' | 'failed'
  counts: Record<string, number>
  detail: string
  startedAt: string
  completedAt: string
}

export async function runRetentionNow(eventSlug: string): Promise<RetentionRunReport> {
  return (await apiJson<{ report: RetentionRunReport }>(
    `/api/events/${encodeURIComponent(eventSlug)}/settings/retention/run`,
    { method: 'POST', body: '{}' },
  )).report
}
