import type { EventAccess } from './authorization.js'
import type { AppEnv } from './index.js'
import { appendAuditEvent } from './audit.js'
import { verifyOfficialAudioDeviceExecution } from './audioDevices.js'
import { signalDefinition, signalFlagDescription } from '../src/signals.js'
import type { RaceSignalAction } from '../src/domain.js'
import { canManuallyRescheduleRace, shiftIncompleteTaskDueTimes } from '../shared/schedule.js'
import { geodesicDistanceMetres } from '../shared/geo.js'

export interface RealtimeOperation {
  id: string
  type: 'presence' | 'position' | 'wind' | 'current' | 'mark' | 'leading-passage' | 'finish' | 'task' | 'message' | 'signal' | 'signal-audio' | 'schedule' | 'course' | 'assignment' | 'finalize'
  raceId?: string
  payload: unknown
  clientTime?: string
}

function objectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Response('Object payload required', { status: 400 })
  }
  return payload as Record<string, unknown>
}

function stringValue(value: unknown, field: string, maxLength = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new Response(`Invalid ${field}`, { status: 400 })
  }
  return value.trim()
}

function optionalString(value: unknown, maxLength = 500): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > maxLength) throw new Response('Invalid text value', { status: 400 })
  return value
}

function finiteNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Response(`Invalid ${field}`, { status: 400 })
  }
  return value
}

function optionalNumber(value: unknown, field: string, minimum: number, maximum: number): number | null {
  if (value == null) return null
  return finiteNumber(value, field, minimum, maximum)
}

function isoTime(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Response('Invalid timestamp', { status: 400 })
  return parsed.toISOString()
}

function position(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Response('Invalid position', { status: 400 })
  return [
    finiteNumber(value[0], 'longitude', -180, 180),
    finiteNumber(value[1], 'latitude', -85, 85),
  ]
}

async function requireRace(env: AppEnv, access: EventAccess, raceId: string | undefined): Promise<string> {
  if (!raceId) throw new Response('Race required', { status: 400 })
  const race = await env.DB.prepare(
    'SELECT id FROM races WHERE id = ? AND regatta_id = ? LIMIT 1',
  ).bind(raceId, access.eventId).first<{ id: string }>()
  if (!race) throw new Response('Race not found', { status: 404 })
  return race.id
}

async function persistCourseRefresh(
  env: AppEnv,
  access: EventAccess,
  operation: RealtimeOperation,
): Promise<Record<string, unknown>> {
  const raceId = await requireRace(env, access, operation.raceId)
  const payload = objectPayload(operation.payload)
  const latest = await env.DB.prepare(
    `SELECT id, revision, course_code, created_at
     FROM course_revisions WHERE race_id = ? ORDER BY revision DESC LIMIT 1`,
  ).bind(raceId).first<{ id: string; revision: number; course_code: string; created_at: string }>()
  if (!latest) throw new Response('Course revision not found', { status: 404 })
  if (payload.revisionId != null && payload.revisionId !== latest.id) {
    throw new Response('Course revision is no longer current', { status: 409 })
  }
  return {
    action: 'refresh',
    revisionId: latest.id,
    revision: latest.revision,
    courseCode: latest.course_code,
    changedBy: access.displayName,
    changedAt: latest.created_at,
  }
}

async function requireMemberId(env: AppEnv, access: EventAccess): Promise<string> {
  const member = await env.DB.prepare(
    `SELECT id FROM event_members
     WHERE id = ? AND regatta_id = ? AND status = 'active' LIMIT 1`,
  ).bind(access.memberId, access.eventId).first<{ id: string }>()
  if (!member) throw new Response('Active event member required', { status: 403 })
  return member.id
}

export async function authorizeCommitteeBoat(
  env: AppEnv,
  access: EventAccess,
  committeeBoatId: string,
): Promise<void> {
  const boat = await env.DB.prepare(
    `SELECT id, name, call_sign FROM committee_boats
     WHERE id = ? AND regatta_id = ? AND status = 'active' LIMIT 1`,
  ).bind(committeeBoatId, access.eventId).first<{ id: string; name: string; call_sign: string | null }>()
  if (!boat) throw new Response('Operating boat not found', { status: 404 })
  if (access.isOwner || access.role === 'pro' || access.role === 'ro') return

  const scoped = await env.DB.prepare(
    `SELECT 1 AS allowed FROM event_member_scopes
     WHERE event_member_id = ? AND committee_boat_id = ? LIMIT 1`,
  ).bind(access.memberId, committeeBoatId).first<{ allowed: number }>()
  if (scoped) return
  throw new Response('Operating boat assignment required', { status: 403 })
}

async function persistPosition(
  env: AppEnv,
  access: EventAccess,
  operation: RealtimeOperation,
  samplePosition: boolean,
  skipCommitteeBoatAuthorization: boolean,
): Promise<Record<string, unknown>> {
  const payload = objectPayload(operation.payload)
  const committeeBoatId = stringValue(payload.committeeBoatId, 'committeeBoatId')
  if (!skipCommitteeBoatAuthorization) await authorizeCommitteeBoat(env, access, committeeBoatId)
  const coordinates = position(payload.position)
  const speedKnots = optionalNumber(payload.speedKnots, 'speedKnots', 0, 80)
  const courseDegrees = optionalNumber(payload.courseDegrees, 'courseDegrees', 0, 360)
  const accuracyMetres = optionalNumber(payload.accuracyMetres, 'accuracyMetres', 0, 10_000)
  const sampledAt = isoTime(operation.clientTime, new Date().toISOString())
  if (samplePosition) {
    await env.DB.prepare(
      `INSERT INTO position_samples
       (id, regatta_id, race_id, committee_boat_id, lng, lat, accuracy_metres,
        speed_knots, course_degrees, sampled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      operation.id,
      access.eventId,
      operation.raceId ?? null,
      committeeBoatId,
      coordinates[0],
      coordinates[1],
      accuracyMetres,
      speedKnots,
      courseDegrees,
      sampledAt,
    ).run()
  }
  return {
    committeeBoatId,
    position: coordinates,
    speedKnots,
    courseDegrees,
    accuracyMetres,
    sampledAt,
    lastSampledAt: samplePosition ? sampledAt : null,
  }
}

async function persistWind(env: AppEnv, access: EventAccess, operation: RealtimeOperation): Promise<Record<string, unknown>> {
  const payload = objectPayload(operation.payload)
  const directionDegrees = finiteNumber(payload.directionDegrees, 'directionDegrees', 0, 360)
  const speedKnots = finiteNumber(payload.speedKnots, 'speedKnots', 0, 100)
  const gustKnots = optionalNumber(payload.gustKnots, 'gustKnots', 0, 120)
  const observedAt = isoTime(payload.observedAt ?? operation.clientTime, new Date().toISOString())
  const coordinates = payload.position == null ? null : position(payload.position)
  const committeeBoatId = typeof payload.committeeBoatId === 'string' ? payload.committeeBoatId : null
  if (committeeBoatId) await authorizeCommitteeBoat(env, access, committeeBoatId)
  const memberId = await requireMemberId(env, access)
  await env.DB.prepare(
    `INSERT INTO wind_observations
     (id, regatta_id, race_id, committee_boat_id, member_id, direction_degrees,
      speed_knots, gust_knots, averaging_seconds, lng, lat, observed_at, source, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    operation.id,
    access.eventId,
    operation.raceId ?? null,
    committeeBoatId,
    memberId,
    directionDegrees,
    speedKnots,
    gustKnots,
    optionalNumber(payload.averagingSeconds, 'averagingSeconds', 0, 3_600),
    coordinates?.[0] ?? null,
    coordinates?.[1] ?? null,
    observedAt,
    access.displayName,
    payload.confidence === 'high' || payload.confidence === 'medium' ? payload.confidence : 'low',
  ).run()
  return {
    directionDegrees,
    speedKnots,
    gustKnots,
    observedAt,
    position: coordinates,
    source: access.displayName,
    confidence: payload.confidence === 'high' || payload.confidence === 'medium' ? payload.confidence : 'low',
  }
}

async function persistCurrent(env: AppEnv, access: EventAccess, operation: RealtimeOperation): Promise<Record<string, unknown>> {
  const payload = objectPayload(operation.payload)
  // Current direction is the true bearing the water flows toward (set).
  const directionDegrees = finiteNumber(payload.directionDegrees, 'directionDegrees', 0, 360)
  const speedKnots = finiteNumber(payload.speedKnots, 'speedKnots', 0, 20)
  const observedAt = isoTime(payload.observedAt ?? operation.clientTime, new Date().toISOString())
  const coordinates = payload.position == null ? null : position(payload.position)
  const committeeBoatId = typeof payload.committeeBoatId === 'string' ? payload.committeeBoatId : null
  if (committeeBoatId) await authorizeCommitteeBoat(env, access, committeeBoatId)
  const memberId = await requireMemberId(env, access)
  const confidence = payload.confidence === 'high' || payload.confidence === 'medium' ? payload.confidence : 'low'
  await env.DB.prepare(
    `INSERT INTO current_observations
     (id, regatta_id, race_id, committee_boat_id, member_id, direction_degrees,
      speed_knots, lng, lat, observed_at, source, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    operation.id,
    access.eventId,
    operation.raceId ?? null,
    committeeBoatId,
    memberId,
    directionDegrees,
    speedKnots,
    coordinates?.[0] ?? null,
    coordinates?.[1] ?? null,
    observedAt,
    access.displayName,
    confidence,
  ).run()
  return {
    directionDegrees,
    speedKnots,
    observedAt,
    position: coordinates,
    source: access.displayName,
    confidence,
  }
}

async function markForRace(
  env: AppEnv,
  access: EventAccess,
  raceId: string,
  markId: string,
): Promise<{ markId: string; nodeId: string; label: string; target: readonly [number, number] }> {
  const mark = await env.DB.prepare(
    `SELECT m.id AS mark_id, m.label, cn.id AS node_id, cn.target_lng, cn.target_lat
     FROM marks m
     JOIN course_nodes cn ON cn.mark_id = m.id
     JOIN course_revisions cr ON cr.id = cn.course_revision_id
     WHERE m.id = ? AND m.regatta_id = ? AND cr.race_id = ?
       AND cr.revision = (SELECT MAX(latest.revision) FROM course_revisions latest WHERE latest.race_id = cr.race_id)
     LIMIT 1`,
  ).bind(markId, access.eventId, raceId).first<{
    mark_id: string; node_id: string; label: string; target_lng: number; target_lat: number
  }>()
  if (!mark) throw new Response('Mark is not part of the active course', { status: 404 })

  if (!access.isOwner && !['pro', 'ro', 'course-setter'].includes(access.role)) {
    const scoped = await env.DB.prepare(
      `SELECT 1 AS allowed FROM event_member_scopes
       WHERE event_member_id = ? AND mark_id = ? LIMIT 1`,
    ).bind(access.memberId, markId).first<{ allowed: number }>()
    if (!scoped) throw new Response('Mark assignment required', { status: 403 })
  }
  return { markId: mark.mark_id, nodeId: mark.node_id, label: mark.label, target: [mark.target_lng, mark.target_lat] }
}

async function persistMark(env: AppEnv, access: EventAccess, operation: RealtimeOperation): Promise<Record<string, unknown>> {
  const raceId = await requireRace(env, access, operation.raceId)
  const race = await env.DB.prepare(
    'SELECT status FROM races WHERE id = ? AND regatta_id = ? LIMIT 1',
  ).bind(raceId, access.eventId).first<{ status: string }>()
  if (race?.status === 'finalized') {
    throw new Response('Finalized race marks require a post-finalization revision', { status: 409 })
  }
  const payload = objectPayload(operation.payload)
  const markId = stringValue(payload.markId, 'markId')
  const mark = await markForRace(env, access, raceId, markId)
  const coordinates = position(payload.actual)
  const memberId = await requireMemberId(env, access)
  const committeeBoatId = typeof payload.committeeBoatId === 'string' ? payload.committeeBoatId : null
  if (committeeBoatId) await authorizeCommitteeBoat(env, access, committeeBoatId)
  const eventTypes: Record<string, string> = {
    planned: 'assigned',
    'en-route': 'en-route',
    deployed: 'dropped',
    dropped: 'dropped',
    confirmed: 'confirmed',
    moved: 'moved',
    recovered: 'recovered',
  }
  const eventType = eventTypes[String(payload.status ?? 'deployed')]
  if (!eventType) throw new Response('Invalid mark state', { status: 400 })
  const sequence = await env.DB.prepare(
    'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM mark_events WHERE race_id = ?',
  ).bind(raceId).first<{ sequence: number }>()
  const clientTime = isoTime(payload.recordedAt ?? operation.clientTime, new Date().toISOString())
  const serverTime = new Date().toISOString()
  const accuracyMetres = optionalNumber(payload.accuracyMetres, 'accuracyMetres', 0, 10_000)
  const positionSource = payload.positionSource === 'handheld-gps-manual' ? 'handheld-gps-manual' : 'device-geolocation'
  const coordinateEntryMode = positionSource === 'handheld-gps-manual'
    ? stringValue(payload.coordinateEntryMode, 'coordinateEntryMode')
    : null
  if (coordinateEntryMode && !['dmm-tail-4', 'decimal-tail-4', 'decimal-full'].includes(coordinateEntryMode)) {
    throw new Response('Invalid coordinateEntryMode', { status: 400 })
  }
  const coordinateDatum = payload.coordinateDatum == null
    ? 'WGS84'
    : stringValue(payload.coordinateDatum, 'coordinateDatum', 16).replaceAll(' ', '').toUpperCase()
  if (coordinateDatum !== 'WGS84') throw new Response('Only WGS 84 coordinates are supported', { status: 400 })
  const positionNote = optionalString(payload.note, 120)
  const targetDifferenceMetres = Math.round(geodesicDistanceMetres(mark.target, coordinates) * 100) / 100
  await env.DB.prepare(
    `INSERT INTO mark_events
     (id, race_id, mark_id, event_type, lng, lat, accuracy_metres, member_id,
      committee_boat_id, client_time, server_time, sequence, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    operation.id,
    raceId,
    markId,
    eventType,
    coordinates[0],
    coordinates[1],
    accuracyMetres,
    memberId,
    committeeBoatId,
    clientTime,
    serverTime,
    sequence?.sequence ?? 1,
    JSON.stringify({
      source: positionSource,
      coordinateEntryMode,
      coordinateDatum,
      note: positionNote,
      originalStatus: payload.status ?? 'deployed',
      targetDifferenceMetres,
    }),
  ).run()
  return {
    markId,
    actual: coordinates,
    status: eventType === 'dropped' || eventType === 'moved' ? 'deployed' : eventType,
    recordedAt: clientTime,
    committeeBoatId,
    accuracyMetres,
    positionSource,
    coordinateEntryMode,
    coordinateDatum,
    note: positionNote,
    targetDifferenceMetres,
  }
}

async function persistLeadingPassage(env: AppEnv, access: EventAccess, operation: RealtimeOperation): Promise<Record<string, unknown>> {
  const raceId = await requireRace(env, access, operation.raceId)
  const payload = objectPayload(operation.payload)
  const memberId = await requireMemberId(env, access)
  const action = payload.action === 'adopt' ? 'adopt' : 'observe'

  if (action === 'adopt') {
    if (!access.isOwner && !['pro', 'ro', 'timekeeper', 'record-keeper', 'signal-boat'].includes(access.role)) {
      throw new Response('Passage adoption requires a record-keeper role', { status: 403 })
    }
    const observationId = stringValue(payload.observationId, 'observationId')
    const observation = await env.DB.prepare(
      `SELECT observation.id, observation.course_node_id, observation.lap_number,
              observation.passed_at, node.mark_id
       FROM leading_passage_observations observation
       JOIN races race ON race.id = observation.race_id
       JOIN course_nodes node ON node.id = observation.course_node_id
       WHERE observation.id = ? AND observation.race_id = ?
         AND race.regatta_id = ? AND observation.status = 'active'
       LIMIT 1`,
    ).bind(observationId, raceId, access.eventId).first<{
      id: string; course_node_id: string; lap_number: number; passed_at: string; mark_id: string
    }>()
    if (!observation) throw new Response('Passage observation not found', { status: 404 })
    const latest = await env.DB.prepare(
      `SELECT id, revision FROM leading_passage_adoptions
       WHERE race_id = ? AND course_node_id = ? AND lap_number = ?
       ORDER BY revision DESC LIMIT 1`,
    ).bind(raceId, observation.course_node_id, observation.lap_number).first<{ id: string; revision: number }>()
    const adoptedAt = new Date().toISOString()
    const adoptionId = operation.id
    const reason = optionalString(payload.reason, 500) ?? (latest ? '採用記録の追記訂正' : '記録担当者による採用')
    await env.DB.prepare(
      `INSERT INTO leading_passage_adoptions
       (id, race_id, course_node_id, lap_number, observation_id, adopted_by,
        adopted_at, revision, reason, supersedes_adoption_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      adoptionId,
      raceId,
      observation.course_node_id,
      observation.lap_number,
      observation.id,
      memberId,
      adoptedAt,
      (latest?.revision ?? 0) + 1,
      reason,
      latest?.id ?? null,
      adoptedAt,
    ).run()
    return {
      action: 'adopt',
      adoptionId,
      observationId,
      markId: observation.mark_id,
      lapNumber: observation.lap_number,
      passedAt: observation.passed_at,
      adoptedAt,
      adoptedBy: access.displayName,
      revision: (latest?.revision ?? 0) + 1,
      reason,
    }
  }

  const markId = stringValue(payload.markId, 'markId')
  const mark = await markForRace(env, access, raceId, markId)
  const passedAt = isoTime(payload.passedAt ?? operation.clientTime, new Date().toISOString())
  const lapNumber = Math.trunc(finiteNumber(payload.lapNumber ?? 1, 'lapNumber', 1, 100))
  const committeeBoatId = typeof payload.committeeBoatId === 'string' ? payload.committeeBoatId : null
  if (committeeBoatId) await authorizeCommitteeBoat(env, access, committeeBoatId)
  const receivedAt = new Date().toISOString()
  const syncQuality = ['good', 'fair', 'poor', 'offline'].includes(String(payload.syncQuality))
    ? String(payload.syncQuality)
    : 'unknown'
  await env.DB.prepare(
    `INSERT INTO leading_passage_observations
     (id, race_id, course_node_id, lap_number, passed_at, recorded_by,
      committee_boat_id, device_id, received_at, clock_offset_ms, sync_quality,
      gps_accuracy_metres, was_offline, sail_number, note, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).bind(
    operation.id,
    raceId,
    mark.nodeId,
    lapNumber,
    passedAt,
    memberId,
    committeeBoatId,
    optionalString(payload.deviceId, 160),
    receivedAt,
    optionalNumber(payload.clockOffsetMs, 'clockOffsetMs', -86_400_000, 86_400_000),
    syncQuality,
    optionalNumber(payload.gpsAccuracyMetres, 'gpsAccuracyMetres', 0, 10_000),
    payload.wasOffline === true ? 1 : 0,
    optionalString(payload.sailNumber, 80),
    optionalString(payload.note),
    receivedAt,
  ).run()
  return {
    action: 'observe',
    markId,
    lapNumber,
    observation: {
      id: operation.id,
      passedAt,
      recordedBy: access.displayName,
      syncQuality,
      wasOffline: payload.wasOffline === true,
      sailNumber: optionalString(payload.sailNumber, 80),
      note: optionalString(payload.note),
      status: 'active',
    },
  }
}

async function persistFinish(env: AppEnv, access: EventAccess, operation: RealtimeOperation): Promise<Record<string, unknown>> {
  const raceId = await requireRace(env, access, operation.raceId)
  const payload = objectPayload(operation.payload)
  const memberId = await requireMemberId(env, access)
  const action = payload.action === 'adopt' ? 'adopt' : 'observe'
  const race = await env.DB.prepare(
    'SELECT status FROM races WHERE id = ? AND regatta_id = ? LIMIT 1',
  ).bind(raceId, access.eventId).first<{ status: string }>()
  const editableRace = race?.status === 'racing' || race?.status === 'provisional'
  if (!editableRace && !(access.isOwner && race?.status === 'finalized')) {
    throw new Response('Finish observations require a race in progress', { status: 409 })
  }

  if (action === 'adopt') {
    if (!access.isOwner && !['pro', 'ro', 'timekeeper', 'record-keeper', 'signal-boat'].includes(access.role)) {
      throw new Response('Finish adoption requires a record-keeper role', { status: 403 })
    }
    const observationId = stringValue(payload.observationId, 'observationId')
    const observation = await env.DB.prepare(
      `SELECT observation.id, observation.finish_position, observation.finished_at
       FROM finish_observations observation
       JOIN races race ON race.id = observation.race_id
       WHERE observation.id = ? AND observation.race_id = ?
         AND race.regatta_id = ? AND observation.status = 'active'
       LIMIT 1`,
    ).bind(observationId, raceId, access.eventId).first<{
      id: string; finish_position: number; finished_at: string
    }>()
    if (!observation) throw new Response('Finish observation not found', { status: 404 })
    const latest = await env.DB.prepare(
      `SELECT id, revision FROM finish_adoptions
       WHERE race_id = ? AND finish_position = ?
       ORDER BY revision DESC LIMIT 1`,
    ).bind(raceId, observation.finish_position).first<{ id: string; revision: number }>()
    const adoptedAt = new Date().toISOString()
    const reason = optionalString(payload.reason, 500) ?? (latest ? '採用記録の追記訂正' : '記録担当者による採用')
    await env.DB.prepare(
      `INSERT INTO finish_adoptions
       (id, race_id, finish_position, observation_id, adopted_by,
        adopted_at, revision, reason, supersedes_adoption_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      operation.id,
      raceId,
      observation.finish_position,
      observation.id,
      memberId,
      adoptedAt,
      (latest?.revision ?? 0) + 1,
      reason,
      latest?.id ?? null,
      adoptedAt,
    ).run()
    return {
      action: 'adopt',
      adoptionId: operation.id,
      observationId,
      finishPosition: observation.finish_position,
      finishedAt: observation.finished_at,
      adoptedAt,
      adoptedBy: access.displayName,
      revision: (latest?.revision ?? 0) + 1,
      reason,
    }
  }

  const finishPosition = finiteNumber(payload.finishPosition ?? 1, 'finishPosition', 1, 1_000)
  if (!Number.isInteger(finishPosition)) throw new Response('Finish position must be an integer', { status: 400 })
  const finishedAt = isoTime(payload.finishedAt ?? operation.clientTime, new Date().toISOString())
  const committeeBoatId = typeof payload.committeeBoatId === 'string' ? payload.committeeBoatId : null
  if (committeeBoatId) await authorizeCommitteeBoat(env, access, committeeBoatId)
  const receivedAt = new Date().toISOString()
  const syncQuality = ['good', 'fair', 'poor', 'offline'].includes(String(payload.syncQuality))
    ? String(payload.syncQuality)
    : 'unknown'
  const sailNumber = optionalString(payload.sailNumber, 80)
  const note = optionalString(payload.note, 500)
  await env.DB.prepare(
    `INSERT INTO finish_observations
     (id, race_id, finish_position, finished_at, recorded_by, committee_boat_id,
      device_id, received_at, clock_offset_ms, sync_quality, was_offline,
      sail_number, note, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).bind(
    operation.id,
    raceId,
    finishPosition,
    finishedAt,
    memberId,
    committeeBoatId,
    optionalString(payload.deviceId, 160),
    receivedAt,
    optionalNumber(payload.clockOffsetMs, 'clockOffsetMs', -86_400_000, 86_400_000),
    syncQuality,
    payload.wasOffline === true ? 1 : 0,
    sailNumber,
    note,
    receivedAt,
  ).run()
  return {
    action: 'observe',
    finishPosition,
    observation: {
      id: operation.id,
      finishPosition,
      finishedAt,
      recordedBy: access.displayName,
      syncQuality,
      wasOffline: payload.wasOffline === true,
      sailNumber: sailNumber ?? undefined,
      note: note ?? undefined,
      status: 'active',
    },
  }
}

type MessageTargetType = 'event' | 'area' | 'race' | 'boat' | 'mark' | 'role' | 'member'

interface ResolvedMessageTarget {
  type: MessageTargetType
  id: string | null
  label: string
  channelKey: string
  recipientIds: string[]
}

function messageRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    owner: '大会管理者', pro: 'PRO', ro: 'RO', 'course-setter': 'コースセッター',
    'signal-boat': 'シグナルボート', 'mark-boat': 'マークボート', 'safety-boat': '安全ボート',
    timekeeper: 'タイムキーパー', 'record-keeper': '記録員', jury: 'ジュリー', protest: 'プロテスト', viewer: '閲覧者',
  }
  return labels[role] ?? role
}

async function messageReceiptSummary(env: AppEnv, messageId: string): Promise<{
  targetCount: number; deliveredCount: number; readCount: number; acknowledgedCount: number
}> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS target_count,
            SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered_count,
            SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read_count,
            SUM(CASE WHEN acknowledged_at IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged_count
     FROM message_receipts WHERE message_id = ?`,
  ).bind(messageId).first<{
    target_count: number; delivered_count: number | null; read_count: number | null; acknowledged_count: number | null
  }>()
  return {
    targetCount: row?.target_count ?? 0,
    deliveredCount: row?.delivered_count ?? 0,
    readCount: row?.read_count ?? 0,
    acknowledgedCount: row?.acknowledged_count ?? 0,
  }
}

async function resolveMessageTarget(
  env: AppEnv,
  access: EventAccess,
  operation: RealtimeOperation,
  payload: Record<string, unknown>,
  senderMemberId: string,
): Promise<ResolvedMessageTarget> {
  const type = ['event', 'area', 'race', 'boat', 'mark', 'role', 'member'].includes(String(payload.targetType))
    ? String(payload.targetType) as MessageTargetType
    : operation.raceId ? 'race' : 'event'
  const requestedId = typeof payload.targetId === 'string' && payload.targetId.trim()
    ? payload.targetId.trim().slice(0, 160)
    : null
  let id = requestedId
  let label = '大会全体'
  let channelKey = 'event'
  let rows: { id: string }[]

  if (type === 'event') {
    rows = (await env.DB.prepare(
      `SELECT id FROM event_members
       WHERE regatta_id = ? AND status = 'active' AND id <> ? ORDER BY id`,
    ).bind(access.eventId, senderMemberId).all<{ id: string }>()).results
  } else if (type === 'area') {
    if (!id) throw new Response('Race area message target required', { status: 400 })
    const area = await env.DB.prepare(
      'SELECT name FROM race_areas WHERE id = ? AND regatta_id = ? LIMIT 1',
    ).bind(id, access.eventId).first<{ name: string }>()
    if (!area) throw new Response('Race area not found', { status: 404 })
    label = `${area.name}・全運営`
    channelKey = `area:${id}`
    rows = (await env.DB.prepare(
      `SELECT DISTINCT member.id
       FROM event_members member
       WHERE member.regatta_id = ? AND member.status = 'active' AND member.id <> ?
         AND (
           member.role IN ('owner', 'pro', 'ro')
           OR (SELECT COUNT(*) FROM race_areas WHERE regatta_id = ?) = 1
           OR EXISTS (
             SELECT 1 FROM event_member_scopes scope
             WHERE scope.event_member_id = member.id AND scope.race_area_id = ?
           )
           OR EXISTS (
             SELECT 1 FROM event_member_scopes scope
             JOIN marks mark ON mark.id = scope.mark_id
             WHERE scope.event_member_id = member.id AND mark.race_area_id = ?
           )
           OR EXISTS (
             SELECT 1 FROM event_member_scopes scope
             JOIN boat_assignments assignment ON assignment.committee_boat_id = scope.committee_boat_id
             JOIN races race ON race.id = assignment.race_id
             WHERE scope.event_member_id = member.id AND race.race_area_id = ?
           )
         )
       ORDER BY member.id`,
    ).bind(access.eventId, senderMemberId, access.eventId, id, id, id).all<{ id: string }>()).results
  } else if (type === 'race') {
    id = requestedId ?? operation.raceId ?? null
    if (!id) throw new Response('Race message target required', { status: 400 })
    if (operation.raceId && id !== operation.raceId) throw new Response('Message target race mismatch', { status: 400 })
    const race = await env.DB.prepare(
      'SELECT race_number FROM races WHERE id = ? AND regatta_id = ? LIMIT 1',
    ).bind(id, access.eventId).first<{ race_number: string }>()
    if (!race) throw new Response('Message race not found', { status: 404 })
    label = `${race.race_number}・全運営`
    channelKey = `race:${id}`
    rows = (await env.DB.prepare(
      `SELECT id FROM event_members
       WHERE regatta_id = ? AND status = 'active' AND id <> ? ORDER BY id`,
    ).bind(access.eventId, senderMemberId).all<{ id: string }>()).results
  } else if (type === 'boat') {
    if (!id) throw new Response('Operating boat message target required', { status: 400 })
    const boat = await env.DB.prepare(
      'SELECT name, call_sign FROM committee_boats WHERE id = ? AND regatta_id = ? LIMIT 1',
    ).bind(id, access.eventId).first<{ name: string; call_sign: string | null }>()
    if (!boat) throw new Response('Operating boat not found', { status: 404 })
    label = boat.call_sign ?? boat.name
    channelKey = `boat:${id}`
    rows = (await env.DB.prepare(
      `SELECT DISTINCT member.id
       FROM event_members member
       LEFT JOIN event_member_scopes scope
         ON scope.event_member_id = member.id AND scope.committee_boat_id = ?
       WHERE member.regatta_id = ? AND member.status = 'active' AND member.id <> ?
         AND (scope.id IS NOT NULL OR member.assignment = ? OR member.assignment = ?)
       ORDER BY member.id`,
    ).bind(id, access.eventId, senderMemberId, boat.name, boat.call_sign ?? '').all<{ id: string }>()).results
  } else if (type === 'mark') {
    if (!id) throw new Response('Mark message target required', { status: 400 })
    const mark = await env.DB.prepare(
      'SELECT label FROM marks WHERE id = ? AND regatta_id = ? LIMIT 1',
    ).bind(id, access.eventId).first<{ label: string }>()
    if (!mark) throw new Response('Mark not found', { status: 404 })
    label = mark.label
    channelKey = `mark:${id}`
    const assignmentPrefix = mark.label.includes('ゲート')
      ? mark.label.replace(/\s+\d+[SP]?$/u, '')
      : mark.label.replace('マーク', '')
    rows = (await env.DB.prepare(
      `SELECT DISTINCT member.id
       FROM event_members member
       LEFT JOIN event_member_scopes scope
         ON scope.event_member_id = member.id AND scope.mark_id = ?
       WHERE member.regatta_id = ? AND member.status = 'active' AND member.id <> ?
         AND (scope.id IS NOT NULL OR member.assignment = ? OR member.assignment LIKE ?)
       ORDER BY member.id`,
    ).bind(id, access.eventId, senderMemberId, mark.label, `${assignmentPrefix}%`).all<{ id: string }>()).results
  } else if (type === 'role') {
    if (!id) throw new Response('Role message target required', { status: 400 })
    label = `${messageRoleLabel(id)}担当`
    channelKey = `role:${id}`
    rows = (await env.DB.prepare(
      `SELECT id FROM event_members
       WHERE regatta_id = ? AND status = 'active' AND id <> ? AND role = ? ORDER BY id`,
    ).bind(access.eventId, senderMemberId, id).all<{ id: string }>()).results
  } else {
    if (!id) throw new Response('Member message target required', { status: 400 })
    const member = await env.DB.prepare(
      `SELECT id, display_name FROM event_members
       WHERE id = ? AND regatta_id = ? AND status = 'active' LIMIT 1`,
    ).bind(id, access.eventId).first<{ id: string; display_name: string }>()
    if (!member) throw new Response('Message member not found', { status: 404 })
    label = member.display_name
    channelKey = `member:${id}`
    rows = member.id === senderMemberId ? [] : [{ id: member.id }]
  }

  return { type, id, label, channelKey, recipientIds: rows.map((row) => row.id) }
}

async function persistMessage(env: AppEnv, access: EventAccess, operation: RealtimeOperation): Promise<Record<string, unknown>> {
  const payload = objectPayload(operation.payload)
  const memberId = await requireMemberId(env, access)
  if (payload.action === 'acknowledge' || payload.action === 'read') {
    const messageId = stringValue(payload.messageId, 'messageId')
    const receipt = await env.DB.prepare(
      `SELECT receipt.message_id FROM message_receipts receipt
       JOIN messages message ON message.id = receipt.message_id
       WHERE receipt.message_id = ? AND receipt.member_id = ? AND message.regatta_id = ? LIMIT 1`,
    ).bind(messageId, memberId, access.eventId).first<{ message_id: string }>()
    if (!receipt) throw new Response('Message receipt not found for this member', { status: 403 })
    const now = new Date().toISOString()
    const acknowledge = payload.action === 'acknowledge'
    await env.DB.prepare(
      `UPDATE message_receipts
       SET read_at = COALESCE(read_at, ?),
           acknowledged_at = CASE WHEN ? = 1 THEN COALESCE(acknowledged_at, ?) ELSE acknowledged_at END
       WHERE message_id = ? AND member_id = ?`,
    ).bind(now, acknowledge ? 1 : 0, now, messageId, memberId).run()
    return {
      action: payload.action,
      messageId,
      memberId,
      readAt: now,
      acknowledgedAt: acknowledge ? now : null,
      receipts: await messageReceiptSummary(env, messageId),
    }
  }

  const body = stringValue(payload.body, 'message body', 1_000)
  const priority = payload.priority === 'urgent' || payload.priority === 'confirm' ? payload.priority : 'normal'
  const target = await resolveMessageTarget(env, access, operation, payload, memberId)
  const sentAt = isoTime(operation.clientTime, new Date().toISOString())
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages
       (id, regatta_id, race_id, channel_key, sender_member_id, priority, body, corrects_message_id, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      operation.id,
      access.eventId,
      operation.raceId ?? null,
      target.channelKey,
      memberId,
      priority,
      body,
      typeof payload.correctsMessageId === 'string' ? payload.correctsMessageId : null,
      sentAt,
    ),
    env.DB.prepare(
      `INSERT INTO message_targets (message_id, target_type, target_id, label, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(operation.id, target.type, target.id, target.label, sentAt),
    ...target.recipientIds.map((recipientId) => env.DB.prepare(
      `INSERT INTO message_receipts (message_id, member_id, delivered_at)
       VALUES (?, ?, ?)`,
    ).bind(operation.id, recipientId, sentAt)),
  ])
  return {
    body,
    priority,
    channel: target.channelKey,
    sender: access.displayName,
    senderMemberId: memberId,
    sentAt,
    target: { type: target.type, id: target.id, label: target.label },
    receipts: await messageReceiptSummary(env, operation.id),
    recipientMemberIds: target.recipientIds,
  }
}

type RaceScheduleSource = 'manual' | 'postponement' | 'recall' | 'restart'

interface ScheduleChange {
  previousWarningAt: string
  warningAt: string
  reason: string
  source: RaceScheduleSource
  revision: number
  shiftedTasks: Array<{ taskId: string; dueAt: string }>
  shiftedTaskCount: number
  changedBy: string
  changedAt: string
}

async function prepareRaceSchedule(
  env: AppEnv,
  access: EventAccess,
  input: {
    id: string
    raceId: string
    warningAt: string
    reason: string
    source: RaceScheduleSource
    memberId: string
    targetStatus?: 'start-sequence'
    manual?: boolean
    changedAt?: string
  },
): Promise<{ change: ScheduleChange; statements: D1PreparedStatement[] }> {
  const race = await env.DB.prepare(
    `SELECT id, status, warning_at,
            COALESCE((SELECT MAX(revision) FROM race_schedule_events WHERE race_id = races.id), 0) AS schedule_revision
     FROM races WHERE id = ? AND regatta_id = ? LIMIT 1`,
  ).bind(input.raceId, access.eventId).first<{ id: string; status: string; warning_at: string; schedule_revision: number }>()
  if (!race) throw new Response('Race not found', { status: 404 })
  if (input.manual && !canManuallyRescheduleRace(race.status)) {
    throw new Response('Postpone before changing a running start schedule', { status: 409 })
  }
  if (!input.manual && race.status !== 'setup') {
    throw new Response('Race must be held before setting the next warning', { status: 409 })
  }
  const previousWarningAt = isoTime(race.warning_at, race.warning_at)
  const warningAt = isoTime(input.warningAt, '')
  const changedAt = input.changedAt ?? new Date().toISOString()
  if (Date.parse(warningAt) - Date.parse(changedAt) < 30_000) {
    throw new Response('Warning time must be at least 30 seconds in the future', { status: 400 })
  }
  if (warningAt === previousWarningAt) throw new Response('Warning time is unchanged', { status: 409 })
  const taskRows = (await env.DB.prepare(
    `SELECT id, due_at, status FROM operational_tasks
     WHERE race_id = ? AND due_at IS NOT NULL`,
  ).bind(input.raceId).all<{ id: string; due_at: string; status: string }>()).results
  const shiftedTasks = shiftIncompleteTaskDueTimes(
    previousWarningAt,
    warningAt,
    taskRows.map((task) => ({ id: task.id, dueAt: task.due_at, status: task.status })),
  )
  const revision = race.schedule_revision + 1
  const statements = [
    env.DB.prepare(
      `INSERT INTO race_schedule_events
       (id, race_id, previous_warning_at, warning_at, reason, source, member_id, revision, shifted_task_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.id,
      input.raceId,
      previousWarningAt,
      warningAt,
      input.reason,
      input.source,
      input.memberId,
      revision,
      shiftedTasks.length,
      changedAt,
    ),
    env.DB.prepare(
      `UPDATE races SET warning_at = ?, status = COALESCE(?, status), updated_at = ?
       WHERE id = ? AND regatta_id = ?`,
    ).bind(warningAt, input.targetStatus ?? null, changedAt, input.raceId, access.eventId),
    ...shiftedTasks.map((task) => env.DB.prepare(
      'UPDATE operational_tasks SET due_at = ? WHERE id = ? AND race_id = ?',
    ).bind(task.dueAt, task.taskId, input.raceId)),
  ]
  return { change: {
    previousWarningAt,
    warningAt,
    reason: input.reason,
    source: input.source,
    revision,
    shiftedTasks,
    shiftedTaskCount: shiftedTasks.length,
    changedBy: access.displayName,
    changedAt,
  }, statements }
}

async function persistSchedule(env: AppEnv, access: EventAccess, operation: RealtimeOperation): Promise<ScheduleChange> {
  const raceId = await requireRace(env, access, operation.raceId)
  const payload = objectPayload(operation.payload)
  const warningAt = isoTime(stringValue(payload.warningAt, 'warningAt'), '')
  const reason = stringValue(payload.reason, 'schedule reason', 500)
  const memberId = await requireMemberId(env, access)
  const prepared = await prepareRaceSchedule(env, access, {
    id: operation.id,
    raceId,
    warningAt,
    reason,
    source: 'manual',
    memberId,
    manual: true,
  })
  await env.DB.batch(prepared.statements)
  return prepared.change
}

async function persistSignal(env: AppEnv, access: EventAccess, operation: RealtimeOperation): Promise<Record<string, unknown>> {
  const raceId = await requireRace(env, access, operation.raceId)
  const payload = objectPayload(operation.payload)
  const actionValue = stringValue(payload.action, 'signal action', 60)
  const allowedActions = new Set<RaceSignalAction>([
    'warning', 'preparatory', 'one-minute', 'start',
    'postpone', 'postpone-h', 'postpone-a', 'resume',
    'individual-recall', 'individual-recall-clear', 'general-recall', 'general-recall-clear',
    'shorten', 'course-change', 'mark-missing', 'search-rescue',
    'abandon', 'abandon-h', 'abandon-a', 'abandon-clear',
  ])
  if (!allowedActions.has(actionValue as RaceSignalAction)) throw new Response('Invalid signal action', { status: 400 })
  const action = actionValue as RaceSignalAction
  const definition = signalDefinition(action)
  const visualExecutedAt = isoTime(payload.visualExecutedAt ?? payload.executedAt ?? operation.clientTime, new Date().toISOString())
  const executedAt = visualExecutedAt
  const scheduledAt = typeof payload.scheduledAt === 'string' ? isoTime(payload.scheduledAt, visualExecutedAt) : null
  const warningAt = typeof payload.warningAt === 'string' ? isoTime(payload.warningAt, executedAt) : null
  if (['resume', 'general-recall-clear', 'abandon-clear'].includes(action) && !warningAt) {
    throw new Response('Next warning time required', { status: 400 })
  }
  const reason = optionalString(payload.reason, 500)
  const targetSailNumbers = optionalString(payload.targetSailNumbers, 200)
  const finishAt = optionalString(payload.finishAt, 200)
  if (action === 'shorten' && !finishAt) throw new Response('Shortened finish location required', { status: 400 })
  if (action === 'course-change' && !access.isOwner && !['pro', 'ro'].includes(access.role)) {
    throw new Response('Course change signal requires PRO or RO', { status: 403 })
  }
  if (['course-change', 'mark-missing'].includes(action)) {
    const race = await env.DB.prepare(
      'SELECT status FROM races WHERE id = ? AND regatta_id = ? LIMIT 1',
    ).bind(raceId, access.eventId).first<{ status: string }>()
    if (race?.status !== 'racing') throw new Response('Course and missing-mark signals require a race in progress', { status: 409 })
  }
  const markLabel = async (markId: string): Promise<string> => {
    const mark = await env.DB.prepare(
      `SELECT mark.label FROM marks mark
       JOIN course_nodes node ON node.mark_id = mark.id
       JOIN course_revisions revision ON revision.id = node.course_revision_id
       WHERE mark.id = ? AND mark.regatta_id = ? AND revision.race_id = ?
         AND revision.revision = (
           SELECT MAX(candidate.revision) FROM course_revisions candidate WHERE candidate.race_id = revision.race_id
         )
       LIMIT 1`,
    ).bind(markId, access.eventId, raceId).first<{ label: string }>()
    if (!mark) throw new Response('Signal mark is not part of the active course', { status: 404 })
    return mark.label
  }
  const changeFromMarkId = action === 'course-change' ? stringValue(payload.changeFromMarkId, 'changeFromMarkId') : null
  const targetMarkId = ['course-change', 'mark-missing'].includes(action) ? stringValue(payload.targetMarkId, 'targetMarkId') : null
  const changeFromMarkLabel = changeFromMarkId ? await markLabel(changeFromMarkId) : null
  const targetMarkLabel = targetMarkId ? await markLabel(targetMarkId) : null
  const newBearing = action === 'course-change' ? optionalNumber(payload.newBearing, 'newBearing', 0, 359) : null
  if (newBearing != null && !Number.isInteger(newBearing)) {
    throw new Response('Course change bearing must be a whole degree', { status: 400 })
  }
  const directionChange = action === 'course-change' && ['port', 'starboard'].includes(String(payload.directionChange))
    ? String(payload.directionChange) as 'port' | 'starboard'
    : null
  const lengthChange = action === 'course-change' && ['increase', 'decrease'].includes(String(payload.lengthChange))
    ? String(payload.lengthChange) as 'increase' | 'decrease'
    : null
  if (action === 'course-change' && newBearing == null && !directionChange && !lengthChange) {
    throw new Response('Course change requires a bearing, direction or length change', { status: 400 })
  }
  const replacementObject = action === 'mark-missing'
    ? stringValue(payload.replacementObject, 'replacementObject', 200)
    : null
  const communicationChannel = action === 'search-rescue'
    ? stringValue(payload.communicationChannel, 'communicationChannel', 80)
    : null
  const safetyInstructions = action === 'search-rescue'
    ? stringValue(payload.safetyInstructions, 'safetyInstructions', 500)
    : null
  if (['course-change', 'mark-missing', 'search-rescue'].includes(action) && !reason) {
    throw new Response('Signal decision reason required', { status: 400 })
  }
  const requestedSoundAt = typeof payload.soundExecutedAt === 'string'
    ? isoTime(payload.soundExecutedAt, visualExecutedAt)
    : null
  const requestedDeviceId = optionalString(payload.officialAudioDeviceId, 120)
  const requestedDeviceSecret = optionalString(payload.officialAudioDeviceSecret, 200)
  const soundExecutionCloseToVisual = requestedSoundAt
    ? Math.abs(Date.parse(requestedSoundAt) - Date.parse(visualExecutedAt)) <= 90_000
    : false
  const validOfficialAudio = definition.soundCount > 0 && requestedSoundAt && requestedDeviceId && requestedDeviceSecret && soundExecutionCloseToVisual
    ? await verifyOfficialAudioDeviceExecution(
        env, raceId, access.memberId, requestedDeviceId, requestedDeviceSecret, requestedSoundAt,
      )
    : false
  const soundExecutedAt = validOfficialAudio ? requestedSoundAt : null
  const soundStatus = definition.soundCount === 0 ? 'not-required' : validOfficialAudio ? 'played' : 'pending'
  const memberId = await requireMemberId(env, access)
  const schedulePlan = warningAt && ['resume', 'general-recall-clear', 'abandon-clear'].includes(action)
    ? await prepareRaceSchedule(env, access, {
        id: `${operation.id}:schedule`,
        raceId,
        warningAt,
        reason: reason ?? definition.label,
        source: action === 'resume' ? 'postponement' : action === 'general-recall-clear' ? 'recall' : 'restart',
        memberId,
        targetStatus: 'start-sequence',
        changedAt: executedAt,
      })
    : undefined
  const scheduleChange = schedulePlan?.change
  const publicPayload = { ...payload }
  delete publicPayload.officialAudioDeviceSecret
  const normalizedPayload = {
    ...publicPayload,
    action,
    label: definition.label,
    flag: action === 'preparatory' && typeof payload.flag === 'string' && payload.flag.trim()
      ? payload.flag.trim().slice(0, 120)
      : signalFlagDescription(action, {
          newBearing: newBearing ?? undefined,
          directionChange: directionChange ?? undefined,
          lengthChange: lengthChange ?? undefined,
          targetMarkLabel: targetMarkLabel ?? undefined,
          communicationChannel: communicationChannel ?? undefined,
        }),
    sound: definition.sound,
    soundCount: definition.soundCount,
    executedAt,
    scheduledAt: scheduledAt ?? undefined,
    visualExecutedAt,
    soundExecutedAt: soundExecutedAt ?? undefined,
    soundStatus,
    officialAudioDeviceId: validOfficialAudio ? requestedDeviceId : undefined,
    warningAt: warningAt ?? undefined,
    schedule: scheduleChange,
    reason: reason ?? undefined,
    targetSailNumbers: targetSailNumbers ?? undefined,
    finishAt: finishAt ?? undefined,
    changeFromMarkId: changeFromMarkId ?? undefined,
    changeFromMarkLabel: changeFromMarkLabel ?? undefined,
    targetMarkId: targetMarkId ?? undefined,
    targetMarkLabel: targetMarkLabel ?? undefined,
    newBearing: newBearing ?? undefined,
    directionChange: directionChange ?? undefined,
    lengthChange: lengthChange ?? undefined,
    replacementObject: replacementObject ?? undefined,
    communicationChannel: communicationChannel ?? undefined,
    safetyInstructions: safetyInstructions ?? undefined,
    actor: access.displayName,
  }
  const signalInsert = env.DB.prepare(
    `INSERT INTO signal_events
     (id, race_id, signal_type, scheduled_at, executed_at, official_device_id,
      member_id, payload_json, visual_executed_at, sound_executed_at, sound_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    operation.id,
    raceId,
    action,
    scheduledAt,
    executedAt,
    validOfficialAudio ? requestedDeviceId : null,
    memberId,
    JSON.stringify(normalizedPayload),
    visualExecutedAt,
    soundExecutedAt,
    soundStatus,
  )
  if (schedulePlan) await env.DB.batch([...schedulePlan.statements, signalInsert])
  else await signalInsert.run()
  if (['warning', 'preparatory', 'one-minute'].includes(action)) {
    await env.DB.prepare(
      `UPDATE races SET status = 'start-sequence', updated_at = ?
       WHERE id = ? AND regatta_id = ?`,
    ).bind(executedAt, raceId, access.eventId).run()
  } else if (['start', 'individual-recall', 'individual-recall-clear', 'shorten', 'course-change', 'mark-missing'].includes(action)) {
    await env.DB.prepare(
      `UPDATE races SET status = 'racing', updated_at = ?
       WHERE id = ? AND regatta_id = ?`,
    ).bind(executedAt, raceId, access.eventId).run()
  } else if (['postpone', 'postpone-h', 'postpone-a', 'general-recall', 'abandon', 'abandon-h', 'abandon-a'].includes(action)) {
    await env.DB.prepare(
      `UPDATE races SET status = 'setup', updated_at = ?
       WHERE id = ? AND regatta_id = ?`,
    ).bind(executedAt, raceId, access.eventId).run()
  }
  await appendAuditEvent(env, {
    access,
    raceId,
    action: `signal.${action}`,
    entityType: 'signal',
    entityId: operation.id,
    after: normalizedPayload,
    reason: reason ?? definition.label,
    clientTime: operation.clientTime,
  })
  return normalizedPayload
}

async function persistSignalAudio(env: AppEnv, access: EventAccess, operation: RealtimeOperation): Promise<Record<string, unknown>> {
  const raceId = await requireRace(env, access, operation.raceId)
  const payload = objectPayload(operation.payload)
  const signalId = stringValue(payload.signalId, 'signalId')
  const deviceId = stringValue(payload.deviceId, 'deviceId')
  const deviceSecret = stringValue(payload.deviceSecret, 'deviceSecret', 200)
  const soundExecutedAt = isoTime(payload.soundExecutedAt ?? operation.clientTime, new Date().toISOString())
  const signal = await env.DB.prepare(
    `SELECT id, executed_at, sound_executed_at, sound_status, payload_json
     FROM signal_events WHERE id = ? AND race_id = ? LIMIT 1`,
  ).bind(signalId, raceId).first<{
    id: string
    executed_at: string
    sound_executed_at: string | null
    sound_status: string
    payload_json: string
  }>()
  if (!signal) throw new Response('Signal event not found', { status: 404 })
  let signalPayload: Record<string, unknown>
  try {
    signalPayload = JSON.parse(signal.payload_json) as Record<string, unknown>
  } catch {
    throw new Response('Signal payload is invalid', { status: 409 })
  }
  if (Number(signalPayload.soundCount ?? 0) < 1) throw new Response('Signal has no sound execution', { status: 409 })
  if (Math.abs(Date.parse(soundExecutedAt) - Date.parse(signal.executed_at)) > 90_000) {
    throw new Response('Sound execution time is outside the signal window', { status: 409 })
  }
  if (!await verifyOfficialAudioDeviceExecution(env, raceId, access.memberId, deviceId, deviceSecret, soundExecutedAt)) {
    throw new Response('Official audio device required', { status: 403 })
  }
  if (signal.sound_executed_at) {
    return {
      signalId,
      soundExecutedAt: signal.sound_executed_at,
      soundStatus: signal.sound_status,
      officialAudioDeviceId: signalPayload.officialAudioDeviceId ?? null,
      duplicate: true,
    }
  }
  const normalizedPayload = {
    ...signalPayload,
    soundExecutedAt,
    soundStatus: 'played',
    officialAudioDeviceId: deviceId,
  }
  await env.DB.prepare(
    `UPDATE signal_events
     SET sound_executed_at = ?, sound_status = 'played', official_device_id = ?, payload_json = ?
     WHERE id = ? AND race_id = ? AND sound_executed_at IS NULL`,
  ).bind(soundExecutedAt, deviceId, JSON.stringify(normalizedPayload), signalId, raceId).run()
  return { signalId, soundExecutedAt, soundStatus: 'played', officialAudioDeviceId: deviceId, duplicate: false }
}

async function persistTask(env: AppEnv, access: EventAccess, operation: RealtimeOperation): Promise<Record<string, unknown>> {
  const raceId = await requireRace(env, access, operation.raceId)
  const payload = objectPayload(operation.payload)
  const taskId = stringValue(payload.taskId, 'taskId')
  const status = String(payload.status)
  if (!['blocked', 'waiting', 'doing', 'done'].includes(status)) throw new Response('Invalid task status', { status: 400 })
  const task = await env.DB.prepare(
    'SELECT id, revision FROM operational_tasks WHERE id = ? AND race_id = ? LIMIT 1',
  ).bind(taskId, raceId).first<{ id: string; revision: number }>()
  if (!task) throw new Response('Task not found', { status: 404 })
  const memberId = await requireMemberId(env, access)
  const serverTime = new Date().toISOString()
  const clientTime = operation.clientTime ? isoTime(operation.clientTime, serverTime) : null
  const revision = task.revision + 1
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE operational_tasks
       SET status = ?, completed_at = CASE WHEN ? = 'done' THEN ? ELSE NULL END, revision = ?
       WHERE id = ? AND race_id = ?`,
    ).bind(status, status, serverTime, revision, taskId, raceId),
    env.DB.prepare(
      `INSERT INTO operational_task_events
       (id, task_id, race_id, status, member_id, revision, client_time, server_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(operation.id, taskId, raceId, status, memberId, revision, clientTime, serverTime),
  ])
  return { taskId, status, revision, changedBy: access.displayName, changedAt: serverTime }
}

async function persistAssignment(env: AppEnv, access: EventAccess, operation: RealtimeOperation): Promise<Record<string, unknown>> {
  if (!access.isOwner) throw new Response('Event owner required', { status: 403 })
  const payload = objectPayload(operation.payload)
  const memberId = stringValue(payload.memberId, 'memberId', 160)
  const assignment = stringValue(payload.assignment, 'assignment', 100)
  const requestedAreaId = optionalString(payload.raceAreaId, 160)
  const committeeBoatId = optionalString(payload.committeeBoatId, 160)
  const markId = optionalString(payload.markId, 160)
  const member = await env.DB.prepare(
    `SELECT id, display_name, role, assignment FROM event_members
     WHERE id = ? AND regatta_id = ? AND status = 'active' LIMIT 1`,
  ).bind(memberId, access.eventId).first<{
    id: string; display_name: string; role: string; assignment: string
  }>()
  if (!member) throw new Response('Active event member not found', { status: 404 })
  if (member.role === 'owner') throw new Response('Event owner assignment cannot be changed here', { status: 409 })

  let raceAreaId = requestedAreaId
  if (raceAreaId) {
    const area = await env.DB.prepare(
      'SELECT id FROM race_areas WHERE id = ? AND regatta_id = ? LIMIT 1',
    ).bind(raceAreaId, access.eventId).first()
    if (!area) throw new Response('Race area not found', { status: 404 })
  }
  if (committeeBoatId) {
    const boat = await env.DB.prepare(
      'SELECT id FROM committee_boats WHERE id = ? AND regatta_id = ? AND status = \'active\' LIMIT 1',
    ).bind(committeeBoatId, access.eventId).first()
    if (!boat) throw new Response('Operating boat not found', { status: 404 })
  }
  if (markId) {
    const mark = await env.DB.prepare(
      'SELECT id, race_area_id FROM marks WHERE id = ? AND regatta_id = ? LIMIT 1',
    ).bind(markId, access.eventId).first<{ id: string; race_area_id: string }>()
    if (!mark) throw new Response('Mark not found', { status: 404 })
    if (raceAreaId && mark.race_area_id !== raceAreaId) throw new Response('Mark is outside the selected race area', { status: 409 })
    raceAreaId ??= mark.race_area_id
  }

  const existingScopes = (await env.DB.prepare(
    `SELECT race_area_id, race_id, committee_boat_id, mark_id, permission
     FROM event_member_scopes WHERE event_member_id = ? ORDER BY created_at, id`,
  ).bind(memberId).all()).results
  const changedAt = new Date().toISOString()
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      'UPDATE event_members SET assignment = ? WHERE id = ? AND regatta_id = ?',
    ).bind(assignment, memberId, access.eventId),
    env.DB.prepare('DELETE FROM event_member_scopes WHERE event_member_id = ?').bind(memberId),
  ]
  if (raceAreaId || committeeBoatId || markId) {
    statements.push(env.DB.prepare(
      `INSERT INTO event_member_scopes
       (id, event_member_id, race_area_id, committee_boat_id, mark_id, permission, created_at)
       VALUES (?, ?, ?, ?, ?, 'operate', ?)`,
    ).bind(crypto.randomUUID(), memberId, raceAreaId, committeeBoatId, markId, changedAt))
  }
  await env.DB.batch(statements)
  const after = { assignment, raceAreaId, committeeBoatId, markId }
  await appendAuditEvent(env, {
    access,
    action: 'member.assignment.update',
    entityType: 'event_member',
    entityId: memberId,
    before: { assignment: member.assignment, scopes: existingScopes },
    after,
    reason: optionalString(payload.reason, 300) ?? '大会中の担当変更',
    clientTime: operation.clientTime,
  })
  return {
    memberId,
    displayName: member.display_name,
    role: member.role,
    ...after,
    changedBy: access.displayName,
    changedAt,
  }
}

export async function persistRealtimeOperation(
  env: AppEnv,
  access: EventAccess,
  operation: RealtimeOperation,
  options: { samplePosition?: boolean; skipCommitteeBoatAuthorization?: boolean } = {},
): Promise<unknown> {
  switch (operation.type) {
    case 'presence': return operation.payload
    case 'position': return persistPosition(
      env,
      access,
      operation,
      options.samplePosition ?? false,
      'skipCommitteeBoatAuthorization' in options && options.skipCommitteeBoatAuthorization === true,
    )
    case 'wind': return persistWind(env, access, operation)
    case 'current': return persistCurrent(env, access, operation)
    case 'mark': return persistMark(env, access, operation)
    case 'leading-passage': return persistLeadingPassage(env, access, operation)
    case 'finish': return persistFinish(env, access, operation)
    case 'message': return persistMessage(env, access, operation)
    case 'signal': return persistSignal(env, access, operation)
    case 'signal-audio': return persistSignalAudio(env, access, operation)
    case 'schedule': return persistSchedule(env, access, operation)
    case 'course': return persistCourseRefresh(env, access, operation)
    case 'assignment': return persistAssignment(env, access, operation)
    case 'task': return persistTask(env, access, operation)
    case 'finalize': throw new Response('Finalize uses the finalization workflow', { status: 400 })
  }
}
