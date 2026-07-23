import type {
  CommitteeBoat,
  CourseMark,
  CurrentObservation,
  FinishRecord,
  LeadingPassageVisit,
  OperationalMessage,
  OperationalTask,
  RaceDefinition,
  RaceSignalAction,
  RaceSignalEvent,
  SailingClass,
  WindObservation,
} from './domain'
import type { OwnerRecoveryKit } from './authClient'
import { makeRaceSignalEvent } from './signals'
import type { GateGeometry } from '../shared/gates'
import type { OperationMode } from '../shared/operationModes'
import type { FinishLineMode } from '../shared/courseGeometry'
import { isValidCustomFinishDistanceMetres } from '../shared/finishDistance'

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
  event: { id: string; slug: string; name: string; startsOn: string; endsOn: string; status: string; operationMode: OperationMode }
  access: EventAccessSummary
  races: RaceDefinition[]
  boats: CommitteeBoat[]
  messages: OperationalMessage[]
  tasks: OperationalTask[]
  leadingPassages: Record<string, LeadingPassageVisit>
  finishes: Record<string, FinishRecord>
  memberCount: number
  resources: EventResources
  wind?: WindObservation
  winds: WindObservation[]
  current?: CurrentObservation
  revisionDrafts: PostFinalizationRevisionDraft[]
}

export interface EventResources {
  areas: Array<{ id: string; name: string; centerLng?: number; centerLat?: number }>
  boats: Array<{ id: string; name: string; assignment: string; role: string }>
  marks: Array<{ id: string; label: string; raceAreaId?: string }>
  members: Array<{
    id: string
    displayName: string
    role: string
    assignment: string
    raceAreaId?: string
    committeeBoatId?: string
    markId?: string
  }>
}

export interface CourseRevisionSummary {
  id: string
  revision: number
  courseCode: string
  windDirection?: number
  windSpeed?: number
  targetLengthMetres?: number
  gateConfig: { lower?: boolean; upper?: boolean; second?: boolean; finishLineMode?: FinishLineMode; finishDistanceMetres?: number; gates?: GateGeometry[] }
  status: string
  basedOnRevision?: number
  createdBy?: string
  createdAt: string
  nodeCount: number
}

export interface PostFinalizationMarkPositionCorrection {
  eventId?: string
  markId: string
  label?: string
  actual: readonly [number, number]
  status?: 'confirmed'
  recordedAt: string
  committeeBoatId?: string
  accuracyMetres?: number
  positionSource: 'device-geolocation' | 'handheld-gps-manual'
  coordinateEntryMode?: 'dmm-tail-4' | 'decimal-tail-4' | 'decimal-full'
  coordinateDatum: 'WGS84'
  note?: string
  targetDifferenceMetres?: number
}

export interface PostFinalizationCorrections {
  courseCode?: string
  targetMinutes?: number
  warningAt?: string
  note?: string
  markPosition?: PostFinalizationMarkPositionCorrection
}

export interface PostFinalizationRevisionDraft {
  id: string
  raceId: string
  baseRevision: number
  reason: string
  corrections: PostFinalizationCorrections
  selectedItems: string[]
  status: 'draft'
  createdAt: string
  updatedAt: string
}

export interface CreateEventInput {
  name: string
  startsOn: string
  endsOn: string
  raceCount: number
  className: SailingClass
  courseCode: string
  firstWarningAt: string
  operationMode: OperationMode
  center?: { longitude: number; latitude: number }
  signalBoatPosition?: { longitude: number; latitude: number }
  windDirection?: number
  windSpeed?: number
  lowerGate?: boolean
  finishLineMode?: FinishLineMode
  finishDistanceMetres?: number
  targetLengthMetres?: number
  targetMinutes?: number
}

export interface EventCreationPlan {
  className: SailingClass
  courseCode: string
  signalBoatPosition: readonly [longitude: number, latitude: number]
  windDirection: number
  windSpeed: number
  lowerGate: boolean
  finishLineMode?: FinishLineMode
  finishDistanceMetres?: number
  targetLengthMetres: number
  targetMinutes: number
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

export interface RetentionHold {
  active: boolean
  until: string | null
  reason: string | null
  indefinite: boolean
  updatedAt?: string
}

export interface RetentionSettings {
  policy: RetentionPolicy
  updatedAt: string
  hold: RetentionHold
  latestRun: {
    id: string
    trigger_type: string
    status: string
    counts_json: string
    detail: string | null
    started_at: string
    completed_at: string | null
  } | null
  latestBackup: { created_at: string; data_hash: string; event_sequence: number } | null
}

export interface RetentionPreviewItem {
  key: keyof RetentionPolicy
  label: string
  expiresAt: string
  expired: boolean
  count: number
  operation: string
}

export interface RetentionPreview {
  eventId: string
  eventEndsOn: string
  generatedAt: string
  hold: RetentionHold
  lastBackupAt: string | null
  items: RetentionPreviewItem[]
  expiredCount: number
}

export interface BootstrapResponse {
  access: EventAccessSummary
  regatta: { id: string; slug: string; name: string; starts_on: string; ends_on: string; status: string; operation_mode: OperationMode }
  races: Array<{
    id: string; race_area_id: string; race_number: string; class_name: SailingClass; course_code: string
    status: RaceDefinition['status']; warning_at: string; target_minutes: number
    finalized_revision: number | null; finalized_at: string | null; course_config_json: string | null
  }>
  signalEvents: Array<{
    id: string; race_id: string; signal_type: RaceSignalAction; executed_at: string; scheduled_at: string | null
    visual_executed_at: string | null; sound_executed_at: string | null
    sound_status: RaceSignalEvent['soundStatus']; official_device_id: string | null
    payload_json: string; actor: string | null
  }>
  raceAreas: Array<{ id: string; name: string; center_lng: number | null; center_lat: number | null }>
  courseNodes: Array<{
    race_id: string; node_id: string; mark_id: string | null; node_order: number; label: string
    node_type: string; target_lng: number; target_lat: number; mark_type: string | null
  }>
  markEvents: Array<{
    race_id: string; mark_id: string; event_type: string; lng: number | null; lat: number | null
    accuracy_metres: number | null; committee_boat_id: string | null; client_time?: string; server_time?: string
    sequence: number; payload_json: string
  }>
  boats: Array<{
    id: string; name: string; role: string; call_sign: string | null; status: string
    lng: number | null; lat: number | null; accuracy_metres: number | null; speed_knots: number | null; course_degrees: number | null; sampled_at: string | null
  }>
  wind: {
    race_id: string | null; committee_boat_id: string | null; mark_id: string | null
    direction_degrees: number; speed_knots: number; gust_knots: number | null; lng: number | null; lat: number | null
    observed_at: string; source: string; confidence: WindObservation['confidence']
  } | null
  winds: Array<{
    race_id: string | null; committee_boat_id: string | null; mark_id: string | null
    direction_degrees: number; speed_knots: number; gust_knots: number | null; lng: number | null; lat: number | null
    observed_at: string; source: string; confidence: WindObservation['confidence']
  }>
  current: {
    direction_degrees: number; speed_knots: number; lng: number | null; lat: number | null
    observed_at: string; source: string; confidence: CurrentObservation['confidence']
  } | null
  messages: Array<{
    id: string; race_id: string | null; channel_key: string; priority: OperationalMessage['priority']
    body: string; sent_at: string; sender: string; sender_member_id: string
    target_type: 'event' | 'area' | 'race' | 'boat' | 'mark' | 'role' | 'member' | null
    target_id: string | null; target_label: string | null
    target_count: number; delivered_count: number; read_count: number; acknowledged_count: number
    own_receipt_message_id: string | null; own_read_at: string | null; own_acknowledged_at: string | null
  }>
  tasks: Array<{
    id: string; race_id: string; title: string; status: OperationalTask['status']
    priority: OperationalTask['priority']; due_at: string; owner: string; last_updated_at?: string | null
  }>
  leadingPassages: Array<{
    id: string; race_id: string; mark_id: string; lap_number: number; passed_at: string; recorded_by: string
    sync_quality: 'good' | 'fair' | 'poor' | 'offline' | 'unknown'; was_offline: number
    sail_number: string | null; note: string | null; status: 'active' | 'cancelled' | 'corrected'
    adopted_observation_id: string | null; adopted_at: string | null; adoption_revision: number | null
  }>
  finishes: Array<{
    id: string; race_id: string; finish_position: number; finished_at: string; recorded_by: string
    sync_quality: 'good' | 'fair' | 'poor' | 'offline' | 'unknown'; was_offline: number
    sail_number: string | null; note: string | null; status: 'active' | 'cancelled' | 'corrected'
    adopted_observation_id: string | null; adopted_at: string | null; adoption_revision: number | null
  }>
  memberCount: number
  raceCorrections: Array<{
    race_id: string; revision: number; patch_json: string; reason: string; state_hash: string; created_at: string
  }>
  activeRevisionDrafts?: Array<{
    id: string
    race_id: string
    base_revision: number
    reason: string
    corrections_json: string
    selected_items_json: string
    status: 'draft'
    created_at: string
    updated_at: string
  }>
  availableMarks: Array<{ id: string; label: string; mark_type: string; race_area_id: string }>
  availableMembers: Array<{
    id: string; display_name: string; role: string; assignment: string
    race_area_id: string | null; committee_boat_id: string | null; mark_id: string | null
  }>
}

export class EventApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'EventApiError'
  }
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) throw new EventApiError('大会サーバーへ接続できません')
  const body = await response.json() as T & { error?: string; code?: string }
  if (!response.ok) throw new EventApiError(body.error ?? `大会APIエラー (${response.status})`, body.code)
  return body
}

function shortLabel(label: string): string {
  if (label.includes('スタート・ピン')) return 'PIN'
  if (label.includes('シグナル')) return 'RC'
  return label
    .replace('オフセット ', '')
    .replace('下ゲート ', '')
    .replace('中ゲート ', '')
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

export type MarkBootstrapSource = Pick<BootstrapResponse, 'courseNodes' | 'markEvents'>

export function bootstrapMarks(response: MarkBootstrapSource, raceId: string): CourseMark[] {
  const latest = new Map<string, MarkBootstrapSource['markEvents'][number]>()
  const latestPlacement = new Map<string, MarkBootstrapSource['markEvents'][number]>()
  const latestVerification = new Map<string, MarkBootstrapSource['markEvents'][number]>()
  response.markEvents.filter((event) => event.race_id === raceId).forEach((event) => {
    const existing = latest.get(event.mark_id)
    if (!existing || event.sequence > existing.sequence) latest.set(event.mark_id, event)
    if (event.event_type === 'dropped' || event.event_type === 'moved') {
      const placement = latestPlacement.get(event.mark_id)
      if (!placement || event.sequence > placement.sequence) latestPlacement.set(event.mark_id, event)
    }
    if (event.event_type === 'confirmed') {
      const verification = latestVerification.get(event.mark_id)
      if (!verification || event.sequence > verification.sequence) latestVerification.set(event.mark_id, event)
    }
  })
  return response.courseNodes
    .filter((node) => node.race_id === raceId && node.mark_id)
    .sort((left, right) => left.node_order - right.node_order)
    .map((node) => {
      const event = latest.get(node.mark_id as string)
      const placement = latestPlacement.get(node.mark_id as string)
      const verification = latestVerification.get(node.mark_id as string)
      const hasActual = placement?.lng != null && placement.lat != null
      const hasVerification = verification?.lng != null && verification.lat != null
        && (!placement || verification.sequence > placement.sequence)
      const isPublishedRevision = (() => {
        try {
          const payload = JSON.parse(event?.payload_json ?? '{}') as { postFinalizationRevisionId?: unknown }
          return typeof payload.postFinalizationRevisionId === 'string'
        } catch {
          return false
        }
      })()
      const status: CourseMark['status'] = event?.event_type === 'recovered'
        ? 'recovered'
        : event?.event_type === 'confirmed' || isPublishedRevision
          ? 'confirmed'
          : hasActual ? 'deployed' : 'planned'
      return {
        id: node.mark_id as string,
        label: node.label,
        shortLabel: shortLabel(node.label),
        target: [node.target_lng, node.target_lat],
        actual: hasActual ? [placement.lng as number, placement.lat as number] : undefined,
        verificationPosition: hasVerification ? [verification.lng as number, verification.lat as number] : undefined,
        recoveryPosition: event?.event_type === 'recovered' && event.lng != null && event.lat != null
          ? [event.lng, event.lat]
          : undefined,
        status,
        lastUpdatedAt: event?.server_time ?? event?.client_time,
        assignedBoatId: placement?.committee_boat_id ?? undefined,
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

function bootstrapFinishes(rows: BootstrapResponse['finishes']): Record<string, FinishRecord> {
  const finishes: Record<string, FinishRecord> = {}
  for (const row of rows ?? []) {
    const key = `${row.race_id}:${row.finish_position}`
    const record = finishes[key] ?? {
      raceId: row.race_id,
      finishPosition: row.finish_position,
      observations: [],
      adoptedObservationId: row.adopted_observation_id ?? undefined,
      adoptedAt: row.adopted_at ?? undefined,
      spreadMilliseconds: 0,
      hasConflict: false,
    }
    record.observations.push({
      id: row.id,
      finishPosition: row.finish_position,
      finishedAt: row.finished_at,
      recordedBy: row.recorded_by,
      syncQuality: row.sync_quality ?? 'unknown',
      wasOffline: Boolean(row.was_offline),
      sailNumber: row.sail_number ?? undefined,
      note: row.note ?? undefined,
      status: row.status,
    })
    if (row.adopted_observation_id && row.adopted_at && (
      !record.adoptedAt || Date.parse(row.adopted_at) >= Date.parse(record.adoptedAt)
    )) {
      record.adoptedObservationId = row.adopted_observation_id
      record.adoptedAt = row.adopted_at
    }
    finishes[key] = record
  }
  for (const record of Object.values(finishes)) {
    const times = record.observations
      .filter((observation) => observation.status === 'active')
      .map((observation) => Date.parse(observation.finishedAt))
      .filter(Number.isFinite)
    record.spreadMilliseconds = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0
    record.hasConflict = record.spreadMilliseconds > 2_000
  }
  return finishes
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
      operationMode: response.regatta.operation_mode,
    },
    access: response.access,
    races: response.races.map((race) => {
      const latest = (response.raceCorrections ?? []).find((correction) => correction.race_id === race.id)
      let corrections: { courseCode?: string; warningAt?: string; targetMinutes?: number } = {}
      let courseConfig: { finishLineMode?: FinishLineMode; finishDistanceMetres?: number } = {}
      try {
        if (latest) corrections = JSON.parse(latest.patch_json) as typeof corrections
      } catch { /* Invalid historical patches do not replace the finalized base record. */ }
      try {
        if (race.course_config_json) courseConfig = JSON.parse(race.course_config_json) as typeof courseConfig
      } catch { /* Invalid historical course settings fall back to the separate finish. */ }
      const signalRow = (response.signalEvents ?? []).find((signal) => signal.race_id === race.id)
      let signalPayload: Record<string, unknown> = {}
      try {
        if (signalRow?.payload_json) signalPayload = JSON.parse(signalRow.payload_json) as Record<string, unknown>
      } catch { /* A malformed historical payload must not prevent event bootstrap. */ }
      const latestSignal = signalRow ? makeRaceSignalEvent(
        signalRow.id,
        signalRow.signal_type,
        signalRow.executed_at,
        {
          label: typeof signalPayload.label === 'string' ? signalPayload.label : undefined,
          flag: typeof signalPayload.flag === 'string' ? signalPayload.flag : undefined,
          sound: typeof signalPayload.sound === 'string' ? signalPayload.sound : undefined,
          soundCount: typeof signalPayload.soundCount === 'number' ? signalPayload.soundCount : undefined,
          scheduledAt: typeof signalPayload.scheduledAt === 'string' ? signalPayload.scheduledAt : signalRow.scheduled_at ?? undefined,
          visualExecutedAt: typeof signalPayload.visualExecutedAt === 'string' ? signalPayload.visualExecutedAt : signalRow.visual_executed_at ?? signalRow.executed_at,
          soundExecutedAt: typeof signalPayload.soundExecutedAt === 'string' ? signalPayload.soundExecutedAt : signalRow.sound_executed_at ?? undefined,
          soundStatus: typeof signalPayload.soundStatus === 'string' ? signalPayload.soundStatus as RaceSignalEvent['soundStatus'] : signalRow.sound_status ?? 'legacy',
          officialAudioDeviceId: typeof signalPayload.officialAudioDeviceId === 'string' ? signalPayload.officialAudioDeviceId : signalRow.official_device_id ?? undefined,
          warningAt: typeof signalPayload.warningAt === 'string' ? signalPayload.warningAt : undefined,
          reason: typeof signalPayload.reason === 'string' ? signalPayload.reason : undefined,
          targetSailNumbers: typeof signalPayload.targetSailNumbers === 'string' ? signalPayload.targetSailNumbers : undefined,
          finishAt: typeof signalPayload.finishAt === 'string' ? signalPayload.finishAt : undefined,
          changeFromMarkId: typeof signalPayload.changeFromMarkId === 'string' ? signalPayload.changeFromMarkId : undefined,
          changeFromMarkLabel: typeof signalPayload.changeFromMarkLabel === 'string' ? signalPayload.changeFromMarkLabel : undefined,
          targetMarkId: typeof signalPayload.targetMarkId === 'string' ? signalPayload.targetMarkId : undefined,
          targetMarkLabel: typeof signalPayload.targetMarkLabel === 'string' ? signalPayload.targetMarkLabel : undefined,
          newBearing: typeof signalPayload.newBearing === 'number' ? signalPayload.newBearing : undefined,
          directionChange: signalPayload.directionChange === 'port' || signalPayload.directionChange === 'starboard' ? signalPayload.directionChange : undefined,
          lengthChange: signalPayload.lengthChange === 'increase' || signalPayload.lengthChange === 'decrease' ? signalPayload.lengthChange : undefined,
          replacementObject: typeof signalPayload.replacementObject === 'string' ? signalPayload.replacementObject : undefined,
          communicationChannel: typeof signalPayload.communicationChannel === 'string' ? signalPayload.communicationChannel : undefined,
          safetyInstructions: typeof signalPayload.safetyInstructions === 'string' ? signalPayload.safetyInstructions : undefined,
          actor: signalRow.actor ?? undefined,
        },
      ) : undefined
      return {
        id: race.id,
        raceAreaId: race.race_area_id,
        raceAreaName: response.raceAreas.find((area) => area.id === race.race_area_id)?.name,
        number: race.race_number,
        className: race.class_name,
        courseCode: corrections.courseCode ?? race.course_code,
        finishLineMode: courseConfig.finishLineMode === 'shared-rc' ? 'shared-rc' : 'separate',
        finishDistanceMetres: isValidCustomFinishDistanceMetres(courseConfig.finishDistanceMetres)
          ? courseConfig.finishDistanceMetres
          : undefined,
        status: race.status,
        warningAt: corrections.warningAt ?? race.warning_at,
        targetMinutes: corrections.targetMinutes ?? race.target_minutes,
        finalizedRevision: race.finalized_revision ?? undefined,
        finalizedAt: race.finalized_at ?? undefined,
        marks: bootstrapMarks(response, race.id),
        latestSignal,
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
          accuracyMetres: boat.accuracy_metres ?? undefined,
          freshnessSeconds: boat.sampled_at ? Math.max(0, (Date.now() - Date.parse(boat.sampled_at)) / 1_000) : 9_999,
          isSelf,
          status: hasPosition && boat.status === 'active' ? 'stationed' : 'offline',
        }
      }),
    messages: response.messages.map((message) => ({
      id: message.id,
      raceId: message.race_id ?? undefined,
      sender: message.sender,
      senderMemberId: message.sender_member_id,
      channel: message.channel_key,
      text: message.body,
      sentAt: message.sent_at,
      priority: message.priority,
      target: {
        type: message.target_type ?? (message.race_id ? 'race' : 'event'),
        id: message.target_id ?? undefined,
        label: message.target_label ?? message.channel_key,
      },
      receipts: {
        targetCount: message.target_count ?? 0,
        deliveredCount: message.delivered_count ?? 0,
        readCount: message.read_count ?? 0,
        acknowledgedCount: message.acknowledged_count ?? 0,
      },
      ownReceipt: message.own_receipt_message_id
        ? message.own_acknowledged_at ? 'acknowledged' : message.own_read_at ? 'read' : 'unread'
        : undefined,
      acknowledgement: message.own_receipt_message_id
        ? message.own_acknowledged_at ? 'acknowledged' : 'pending'
        : undefined,
    })),
    tasks: (response.tasks ?? []).map((task) => ({
      id: task.id,
      raceId: task.race_id,
      title: task.title,
      owner: task.owner,
      status: task.status,
      dueLabel: `${formatClock(task.due_at)}まで`,
      dueAt: task.due_at,
      lastUpdatedAt: task.last_updated_at ?? undefined,
      priority: task.priority,
    })),
    leadingPassages: bootstrapLeadingPassages(response.leadingPassages ?? []),
    finishes: bootstrapFinishes(response.finishes ?? []),
    memberCount: response.memberCount ?? 0,
    resources: {
      areas: (response.raceAreas ?? []).map((area) => ({
        id: area.id,
        name: area.name,
        centerLng: area.center_lng ?? undefined,
        centerLat: area.center_lat ?? undefined,
      })),
      boats: response.boats.map((boat) => ({
        id: boat.id,
        name: boat.name,
        assignment: boat.call_sign ?? boat.name,
        role: boat.role,
      })),
      marks: (response.availableMarks ?? [...new Map(response.courseNodes
        .filter((node) => node.mark_id)
        .map((node) => [node.mark_id as string, { id: node.mark_id as string, label: node.label, mark_type: node.mark_type ?? 'rounding', race_area_id: undefined }])).values()])
        .map((mark) => ({ id: mark.id, label: mark.label, raceAreaId: mark.race_area_id })),
      members: (response.availableMembers ?? []).map((member) => ({
        id: member.id,
        displayName: member.display_name,
        role: member.role,
        assignment: member.assignment,
        raceAreaId: member.race_area_id ?? undefined,
        committeeBoatId: member.committee_boat_id ?? undefined,
        markId: member.mark_id ?? undefined,
      })),
    },
    wind: response.wind ? {
      directionDegrees: response.wind.direction_degrees,
      speedKnots: response.wind.speed_knots,
      gustKnots: response.wind.gust_knots ?? response.wind.speed_knots,
      observedAt: response.wind.observed_at,
      source: response.wind.source,
      trend: 'steady',
      confidence: response.wind.confidence,
      position: response.wind.lng != null && response.wind.lat != null
        ? [response.wind.lng, response.wind.lat]
        : undefined,
      raceId: response.wind.race_id ?? undefined,
      committeeBoatId: response.wind.committee_boat_id ?? undefined,
      markId: response.wind.mark_id ?? undefined,
    } : undefined,
    winds: (response.winds ?? []).map((wind) => ({
      directionDegrees: wind.direction_degrees,
      speedKnots: wind.speed_knots,
      gustKnots: wind.gust_knots ?? wind.speed_knots,
      observedAt: wind.observed_at,
      source: wind.source,
      trend: 'steady',
      confidence: wind.confidence,
      position: wind.lng != null && wind.lat != null ? [wind.lng, wind.lat] : undefined,
      raceId: wind.race_id ?? undefined,
      committeeBoatId: wind.committee_boat_id ?? undefined,
      markId: wind.mark_id ?? undefined,
    })),
    current: response.current ? {
      directionDegrees: response.current.direction_degrees,
      speedKnots: response.current.speed_knots,
      observedAt: response.current.observed_at,
      source: response.current.source,
      confidence: response.current.confidence,
      position: response.current.lng != null && response.current.lat != null
        ? [response.current.lng, response.current.lat]
        : undefined,
    } : undefined,
    revisionDrafts: (response.activeRevisionDrafts ?? []).flatMap((draft) => {
      try {
        return [{
          id: draft.id,
          raceId: draft.race_id,
          baseRevision: draft.base_revision,
          reason: draft.reason,
          corrections: JSON.parse(draft.corrections_json) as PostFinalizationCorrections,
          selectedItems: JSON.parse(draft.selected_items_json) as string[],
          status: draft.status,
          createdAt: draft.created_at,
          updatedAt: draft.updated_at,
        }]
      } catch {
        return []
      }
    }),
  }
}

export async function listEvents(): Promise<EventSummary[]> {
  return (await apiJson<{ events: EventSummary[] }>('/api/events', { method: 'GET', headers: {} })).events
}

export async function createEvent(input: CreateEventInput): Promise<{
  event: EventBootstrap['event']
  url: string
  ownerRecoveryKit: OwnerRecoveryKit | null
}> {
  return apiJson('/api/events', { method: 'POST', body: JSON.stringify(input) })
}

export async function confirmOwnerRecoveryKit(
  eventSlug: string,
  recoveryId: string,
): Promise<{ recoveryId: string; confirmedAt: string; ready: true }> {
  return apiJson(
    `/api/events/${encodeURIComponent(eventSlug)}/owner-recovery/${encodeURIComponent(recoveryId)}/confirm`,
    { method: 'POST', body: JSON.stringify({ saved: true }) },
  )
}

export async function createPostFinalizationRevisionDraft(
  eventSlug: string,
  raceId: string,
  reason: string,
  corrections: PostFinalizationCorrections,
): Promise<{ draft: PostFinalizationRevisionDraft }> {
  return apiJson(`/api/events/${encodeURIComponent(eventSlug)}/races/${encodeURIComponent(raceId)}/post-finalization-revisions/drafts`, {
    method: 'POST',
    body: JSON.stringify({ reason, corrections }),
  })
}

export async function publishPostFinalizationRevisionDraft(
  eventSlug: string,
  raceId: string,
  draftId: string,
  confirmationPhrase: string,
): Promise<{ revision: number; createdAt: string; stateHash: string; corrections: PostFinalizationCorrections; reason: string; draftId: string }> {
  return apiJson(
    `/api/events/${encodeURIComponent(eventSlug)}/races/${encodeURIComponent(raceId)}/post-finalization-revisions/drafts/${encodeURIComponent(draftId)}/publish`,
    { method: 'POST', body: JSON.stringify({ confirmationPhrase }) },
  )
}

export async function discardPostFinalizationRevisionDraft(
  eventSlug: string,
  raceId: string,
  draftId: string,
): Promise<{ id: string; status: 'discarded'; discardedAt: string }> {
  return apiJson(
    `/api/events/${encodeURIComponent(eventSlug)}/races/${encodeURIComponent(raceId)}/post-finalization-revisions/drafts/${encodeURIComponent(draftId)}`,
    { method: 'DELETE' },
  )
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
    secondGate?: boolean
    finishLineMode?: FinishLineMode
    finishDistanceMetres?: number
    nodes: Array<{ markId: string; label: string; nodeType: string; rounding?: string; target: readonly [number, number] }>
  },
): Promise<{ revisionId: string; revision: number; createdAt: string }> {
  return apiJson(`/api/events/${encodeURIComponent(eventSlug)}/races/${encodeURIComponent(raceId)}/course-revisions`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

interface CourseRevisionRow {
  id: string
  revision: number
  course_code: string
  wind_direction: number | null
  wind_speed: number | null
  target_length_metres: number | null
  gate_config_json: string
  status: string
  based_on_revision: number | null
  created_by: string | null
  created_at: string
  node_count: number
}

function parseGateConfig(value: string): CourseRevisionSummary['gateConfig'] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const config = parsed as CourseRevisionSummary['gateConfig']
    return {
      ...config,
      finishDistanceMetres: isValidCustomFinishDistanceMetres(config.finishDistanceMetres)
        ? config.finishDistanceMetres
        : undefined,
    }
  } catch {
    return {}
  }
}

export async function loadCourseRevisions(eventSlug: string, raceId: string): Promise<CourseRevisionSummary[]> {
  const response = await apiJson<{ revisions: CourseRevisionRow[] }>(
    `/api/events/${encodeURIComponent(eventSlug)}/races/${encodeURIComponent(raceId)}/course-revisions`,
    { method: 'GET', headers: {} },
  )
  return response.revisions.map((row) => ({
    id: row.id,
    revision: row.revision,
    courseCode: row.course_code,
    windDirection: row.wind_direction ?? undefined,
    windSpeed: row.wind_speed ?? undefined,
    targetLengthMetres: row.target_length_metres ?? undefined,
    gateConfig: parseGateConfig(row.gate_config_json),
    status: row.status,
    basedOnRevision: row.based_on_revision ?? undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    nodeCount: row.node_count,
  }))
}

export async function rollbackCourseRevision(
  eventSlug: string,
  raceId: string,
  revision: number,
): Promise<{ revisionId: string; revision: number; sourceRevision: number; courseCode: string; createdAt: string }> {
  return apiJson(
    `/api/events/${encodeURIComponent(eventSlug)}/races/${encodeURIComponent(raceId)}/course-revisions/${revision}/rollback`,
    { method: 'POST', body: JSON.stringify({}) },
  )
}

export async function createRaceArea(
  eventSlug: string,
  input: { name: string; center: { longitude: number; latitude: number } },
): Promise<{
  area: { id: string; name: string; centerLng: number; centerLat: number }
  markCount: number
  createdAt: string
}> {
  return apiJson(`/api/events/${encodeURIComponent(eventSlug)}/areas`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function assignRaceArea(
  eventSlug: string,
  raceId: string,
  raceAreaId: string,
): Promise<{
  raceId: string
  raceAreaId: string
  areaName: string
  revisionId?: string
  revision?: number
  createdAt?: string
  unchanged: boolean
}> {
  return apiJson(`/api/events/${encodeURIComponent(eventSlug)}/races/${encodeURIComponent(raceId)}/area`, {
    method: 'PATCH',
    body: JSON.stringify({ raceAreaId }),
  })
}

export async function loadRetentionSettings(eventSlug: string): Promise<RetentionSettings> {
  return apiJson<RetentionSettings>(
    `/api/events/${encodeURIComponent(eventSlug)}/settings/retention`,
    { method: 'GET', headers: {} },
  )
}

export async function saveRetentionPolicy(eventSlug: string, policy: RetentionPolicy): Promise<RetentionPolicy> {
  return (await apiJson<{ policy: RetentionPolicy }>(
    `/api/events/${encodeURIComponent(eventSlug)}/settings/retention`,
    { method: 'PATCH', body: JSON.stringify({ policy }) },
  )).policy
}

export async function saveRetentionHold(
  eventSlug: string,
  input: { active: boolean; until?: string | null; reason: string },
): Promise<RetentionHold> {
  return (await apiJson<{ hold: RetentionHold }>(
    `/api/events/${encodeURIComponent(eventSlug)}/settings/retention/hold`,
    { method: 'PATCH', body: JSON.stringify(input) },
  )).hold
}

export async function loadRetentionPreview(eventSlug: string): Promise<RetentionPreview> {
  return (await apiJson<{ preview: RetentionPreview }>(
    `/api/events/${encodeURIComponent(eventSlug)}/settings/retention/preview`,
    { method: 'GET', headers: {} },
  )).preview
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
