import type { EventAccess } from './authorization.js'
import type { AppEnv } from './index.js'
import { sha256Base64Url } from './security.js'
import { isFinalizationPhraseValid } from '../shared/finalization.js'

interface AuditInput {
  access: EventAccess
  raceId?: string
  action: string
  entityType: string
  entityId: string
  before?: unknown
  after?: unknown
  reason?: string
  clientTime?: string
}

interface PreviousAudit {
  sequence: number
  event_hash: string
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

async function hashValue(value: unknown): Promise<string | null> {
  return value === undefined ? null : sha256Base64Url(JSON.stringify(canonical(value)))
}

export async function appendAuditEvent(env: AppEnv, input: AuditInput): Promise<{
  id: string
  sequence: number
  eventHash: string
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previous = await env.DB.prepare(
      `SELECT sequence, event_hash
       FROM audit_events WHERE regatta_id = ?
       ORDER BY sequence DESC LIMIT 1`,
    ).bind(input.access.eventId).first<PreviousAudit>()
    const sequence = (previous?.sequence ?? 0) + 1
    const serverTime = new Date().toISOString()
    const id = crypto.randomUUID()
    const beforeHash = await hashValue(input.before)
    const afterHash = await hashValue(input.after)
    const previousHash = previous?.event_hash ?? null
    const eventHash = await sha256Base64Url(JSON.stringify(canonical({
      id,
      regattaId: input.access.eventId,
      raceId: input.raceId ?? null,
      sequence,
      actorUserId: input.access.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeHash,
      afterHash,
      reason: input.reason ?? null,
      clientTime: input.clientTime ?? null,
      serverTime,
      previousHash,
    })))

    try {
      await env.DB.prepare(
        `INSERT INTO audit_events
         (id, regatta_id, race_id, sequence, actor_user_id, actor_member_id,
          action, entity_type, entity_id, before_hash, after_hash, reason,
          client_time, server_time, previous_event_hash, event_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        input.access.eventId,
        input.raceId ?? null,
        sequence,
        input.access.userId,
        input.access.memberId.startsWith('owner:') ? null : input.access.memberId,
        input.action,
        input.entityType,
        input.entityId,
        beforeHash,
        afterHash,
        input.reason ?? null,
        input.clientTime ?? null,
        serverTime,
        previousHash,
        eventHash,
      ).run()
      return { id, sequence, eventHash }
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
  throw new Error('Unable to append audit event')
}

/**
 * One-time secret workflows must still return their newly issued secret if the
 * append-only audit chain is temporarily unavailable. Their authoritative D1
 * state keeps the security timestamps; the failure is also sent to Worker logs.
 */
export async function appendAuditEventWithoutBlockingSecretDelivery(
  env: AppEnv,
  input: AuditInput,
): Promise<boolean> {
  try {
    await appendAuditEvent(env, input)
    return true
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'Audit append failed during one-time secret delivery',
      eventId: input.access.eventId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : String(error),
    }))
    return false
  }
}

export async function finalizeRace(
  env: AppEnv,
  access: EventAccess,
  raceId: string,
  reason: string,
  confirmationPhrase: string,
): Promise<{ revision: number; finalizedAt: string; stateHash: string; alreadyFinalized: boolean }> {
  const race = await env.DB.prepare(
    `SELECT id, race_number, class_name, course_code, target_minutes, warning_at,
            status, finalized_revision, finalized_at
     FROM races WHERE id = ? AND regatta_id = ? LIMIT 1`,
  ).bind(raceId, access.eventId).first<Record<string, unknown>>()
  if (!race) throw new Response('Race not found', { status: 404 })
  if (!isFinalizationPhraseValid(String(race.race_number), confirmationPhrase)) {
    throw new Response('Race confirmation phrase does not match', { status: 400 })
  }
  if (race.status === 'finalized') {
    const existing = await env.DB.prepare(
      'SELECT state_hash FROM race_finalizations WHERE race_id = ? ORDER BY revision DESC LIMIT 1',
    ).bind(raceId).first<{ state_hash: string }>()
    return {
      revision: Number(race.finalized_revision ?? 1),
      finalizedAt: String(race.finalized_at),
      stateHash: existing?.state_hash ?? '',
      alreadyFinalized: true,
    }
  }

  const previous = await env.DB.prepare(
    'SELECT COALESCE(MAX(revision), 0) AS revision FROM race_finalizations WHERE race_id = ?',
  ).bind(raceId).first<{ revision: number }>()
  const revision = (previous?.revision ?? 0) + 1
  const finalizedAt = new Date().toISOString()
  const finalRace = { ...race, status: 'finalized', finalized_revision: revision, finalized_at: finalizedAt }
  const [courseRevisions, courseNodes, markEvents, signalEvents, passageObservations,
    passageAdoptions, finishObservations, finishAdoptions, windObservations, currentObservations,
    operationalTasks, operationalTaskEvents, messages, auditHead] = await Promise.all([
    env.DB.prepare('SELECT * FROM course_revisions WHERE race_id = ? ORDER BY revision').bind(raceId).all(),
    env.DB.prepare(
      `SELECT node.* FROM course_nodes node
       JOIN course_revisions revision ON revision.id = node.course_revision_id
       WHERE revision.race_id = ? ORDER BY revision.revision, node.node_order`,
    ).bind(raceId).all(),
    env.DB.prepare('SELECT * FROM mark_events WHERE race_id = ? ORDER BY sequence').bind(raceId).all(),
    env.DB.prepare('SELECT * FROM signal_events WHERE race_id = ? ORDER BY executed_at, rowid').bind(raceId).all(),
    env.DB.prepare('SELECT * FROM leading_passage_observations WHERE race_id = ? ORDER BY passed_at, id').bind(raceId).all(),
    env.DB.prepare('SELECT * FROM leading_passage_adoptions WHERE race_id = ? ORDER BY lap_number, revision').bind(raceId).all(),
    env.DB.prepare('SELECT * FROM finish_observations WHERE race_id = ? ORDER BY finish_position, finished_at, id').bind(raceId).all(),
    env.DB.prepare('SELECT * FROM finish_adoptions WHERE race_id = ? ORDER BY finish_position, revision').bind(raceId).all(),
    env.DB.prepare('SELECT * FROM wind_observations WHERE race_id = ? ORDER BY observed_at, id').bind(raceId).all(),
    env.DB.prepare('SELECT * FROM current_observations WHERE race_id = ? ORDER BY observed_at, id').bind(raceId).all(),
    env.DB.prepare('SELECT * FROM operational_tasks WHERE race_id = ? ORDER BY id').bind(raceId).all(),
    env.DB.prepare('SELECT * FROM operational_task_events WHERE race_id = ? ORDER BY server_time, id').bind(raceId).all(),
    env.DB.prepare('SELECT * FROM messages WHERE race_id = ? ORDER BY sent_at, id').bind(raceId).all(),
    env.DB.prepare(
      'SELECT sequence, event_hash FROM audit_events WHERE regatta_id = ? ORDER BY sequence DESC LIMIT 1',
    ).bind(access.eventId).first<{ sequence: number; event_hash: string }>(),
  ])
  const snapshot = canonical({
    schemaVersion: 1,
    capturedAt: finalizedAt,
    race: finalRace,
    courseRevisions: courseRevisions.results,
    courseNodes: courseNodes.results,
    markEvents: markEvents.results,
    signalEvents: signalEvents.results,
    passageObservations: passageObservations.results,
    passageAdoptions: passageAdoptions.results,
    finishObservations: finishObservations.results,
    finishAdoptions: finishAdoptions.results,
    windObservations: windObservations.results,
    currentObservations: currentObservations.results,
    operationalTasks: operationalTasks.results,
    operationalTaskEvents: operationalTaskEvents.results,
    messages: messages.results,
    auditHead: auditHead ?? null,
  })
  const snapshotJson = JSON.stringify(snapshot)
  const stateHash = await sha256Base64Url(snapshotJson)
  const finalizationId = crypto.randomUUID()

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE races
       SET status = 'finalized', finalized_revision = ?, finalized_at = ?, finalized_by = ?, updated_at = ?
       WHERE id = ? AND regatta_id = ? AND status <> 'finalized'`,
    ).bind(revision, finalizedAt, access.userId, finalizedAt, raceId, access.eventId),
    env.DB.prepare(
      `INSERT INTO race_finalizations
       (id, race_id, revision, state_hash, reason, finalized_by, finalized_at, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(finalizationId, raceId, revision, stateHash, reason, access.userId, finalizedAt, snapshotJson),
  ])

  await appendAuditEvent(env, {
    access,
    raceId,
    action: 'race.finalize',
    entityType: 'race',
    entityId: raceId,
    before: race,
    after: finalRace,
    reason,
  })
  return { revision, finalizedAt, stateHash, alreadyFinalized: false }
}
