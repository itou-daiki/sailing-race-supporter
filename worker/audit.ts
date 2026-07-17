import type { EventAccess } from './authorization.js'
import type { AppEnv } from './index.js'
import { sha256Base64Url } from './security.js'

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

function canonical(value: unknown): unknown {
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

export async function finalizeRace(
  env: AppEnv,
  access: EventAccess,
  raceId: string,
  reason: string,
): Promise<{ revision: number; finalizedAt: string; stateHash: string; alreadyFinalized: boolean }> {
  const race = await env.DB.prepare(
    `SELECT id, race_number, class_name, course_code, target_minutes, warning_at,
            status, finalized_revision, finalized_at
     FROM races WHERE id = ? AND regatta_id = ? LIMIT 1`,
  ).bind(raceId, access.eventId).first<Record<string, unknown>>()
  if (!race) throw new Response('Race not found', { status: 404 })
  if (race.status === 'finalized') {
    return {
      revision: Number(race.finalized_revision ?? 1),
      finalizedAt: String(race.finalized_at),
      stateHash: '',
      alreadyFinalized: true,
    }
  }

  const previous = await env.DB.prepare(
    'SELECT COALESCE(MAX(revision), 0) AS revision FROM race_finalizations WHERE race_id = ?',
  ).bind(raceId).first<{ revision: number }>()
  const revision = (previous?.revision ?? 0) + 1
  const finalizedAt = new Date().toISOString()
  const stateHash = await sha256Base64Url(JSON.stringify(canonical(race)))
  const finalizationId = crypto.randomUUID()

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE races
       SET status = 'finalized', finalized_revision = ?, finalized_at = ?, finalized_by = ?, updated_at = ?
       WHERE id = ? AND regatta_id = ? AND status <> 'finalized'`,
    ).bind(revision, finalizedAt, access.userId, finalizedAt, raceId, access.eventId),
    env.DB.prepare(
      `INSERT INTO race_finalizations
       (id, race_id, revision, state_hash, reason, finalized_by, finalized_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(finalizationId, raceId, revision, stateHash, reason, access.userId, finalizedAt),
  ])

  await appendAuditEvent(env, {
    access,
    raceId,
    action: 'race.finalize',
    entityType: 'race',
    entityId: raceId,
    before: race,
    after: { ...race, status: 'finalized', finalized_revision: revision, finalized_at: finalizedAt },
    reason,
  })
  return { revision, finalizedAt, stateHash, alreadyFinalized: false }
}
