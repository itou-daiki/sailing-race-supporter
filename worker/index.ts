import { DurableObject } from 'cloudflare:workers'
import { FINALIZATION_AUTH_MAX_AGE_MINUTES } from '../shared/finalization.js'
import {
  DURABLE_OBJECT_POSITION_SNAPSHOT_MS,
  estimateRegattaFreeTierUsage,
  ROOM_SEQUENCE_ALLOCATION_SIZE,
  STANDARD_REGATTA_LOAD,
} from '../shared/freeTierBudget.js'
import { handleAuthRequest } from './auth.js'
import { handleAudioDeviceRequest } from './audioDevices.js'
import { can, eventAccess, requirePermission, type EventAccess } from './authorization.js'
import { appendAuditEvent, finalizeRace } from './audit.js'
import { handleBackupRequest } from './backups.js'
import { handleCourseRequest } from './courses.js'
import { handleEventCollectionRequest } from './events.js'
import { json } from './http.js'
import { handleInviteRequest } from './invites.js'
import { handleLogRequest } from './logs.js'
import { authorizeCommitteeBoat, persistRealtimeOperation } from './operations.js'
import { handleRevisionRequest } from './revisions.js'
import { requireSession } from './security.js'
import { handleSettingsRequest } from './settings.js'
import { runDailyRetention } from './retention.js'

export interface AppEnv {
  ASSETS: Fetcher
  DB: D1Database
  EVENT_ROOMS: DurableObjectNamespace<EventRoom>
  BACKUP_SIGNING_PRIVATE_KEY: string
}

interface ClientAttachment {
  eventId: string
  eventSlug: string
  userId: string
  memberId: string
  displayName: string
  role: string
  assignment: string
  isOwner: boolean
  joinedAt: string
  sessionTokenHash: string
}

interface RoomMessage {
  id: string
  type: 'presence' | 'position' | 'wind' | 'current' | 'mark' | 'leading-passage' | 'finish' | 'task' | 'message' | 'signal' | 'signal-audio' | 'finalize'
  raceId?: string
  memberId?: string
  payload: unknown
  clientTime?: string
}

interface SequencedMessage extends RoomMessage {
  sequence: number
  serverTime: string
}

interface PositionPersistenceSchedule {
  sampledAt: number
  snapshottedAt: number
}

const ROOM_MESSAGE_TYPES = new Set<RoomMessage['type']>([
  'presence',
  'position',
  'wind',
  'current',
  'mark',
  'leading-passage',
  'finish',
  'task',
  'message',
  'signal',
  'signal-audio',
  'finalize',
])

function isRoomMessage(value: unknown): value is RoomMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RoomMessage>
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 8 &&
    typeof candidate.type === 'string' &&
    ROOM_MESSAGE_TYPES.has(candidate.type as RoomMessage['type']) &&
    'payload' in candidate
  )
}

export class EventRoom extends DurableObject<AppEnv> {
  private sequence = 0
  private sequenceAllocationEnd = 0
  private readonly positionAuthorization = new Map<string, number>()
  private readonly positionPersistenceSchedule = new Map<string, PositionPersistenceSchedule>()
  private readonly socketMessageQueues = new WeakMap<WebSocket, Promise<void>>()

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_events (
        sequence INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        race_id TEXT,
        member_id TEXT,
        payload_json TEXT NOT NULL,
        client_time TEXT,
        server_time TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_room_events_race_sequence
        ON room_events (race_id, sequence);
      CREATE TABLE IF NOT EXISTS current_positions (
        committee_boat_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        client_time TEXT,
        server_time TEXT NOT NULL,
        last_sampled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS room_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    const rows = [...this.ctx.storage.sql.exec<{ sequence: number }>(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM room_events',
    )]
    const positionRows = [...this.ctx.storage.sql.exec<{ sequence: number }>(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM current_positions',
    )]
    const allocationRows = [...this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM room_meta WHERE key = 'sequence-allocation-end' LIMIT 1",
    )]
    const allocationEnd = Number(allocationRows[0]?.value ?? 0)
    this.sequence = Math.max(
      rows[0]?.sequence ?? 0,
      positionRows[0]?.sequence ?? 0,
      Number.isFinite(allocationEnd) ? allocationEnd : 0,
    )
    this.sequenceAllocationEnd = this.sequence
  }

  private nextSequence(): number {
    if (this.sequence >= this.sequenceAllocationEnd) {
      this.sequenceAllocationEnd = this.sequence + ROOM_SEQUENCE_ALLOCATION_SIZE
      this.ctx.storage.sql.exec(
        `INSERT INTO room_meta (key, value) VALUES ('sequence-allocation-end', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(this.sequenceAllocationEnd),
      )
    }
    this.sequence += 1
    return this.sequence
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const eventId = request.headers.get('x-srs-event-id')
      const eventSlug = request.headers.get('x-srs-event-slug')
      const userId = request.headers.get('x-srs-user-id')
      const memberId = request.headers.get('x-srs-member-id')
      const role = request.headers.get('x-srs-role')
      const sessionTokenHash = request.headers.get('x-srs-session-token-hash')
      if (!eventId || !eventSlug || !userId || !memberId || !role || !sessionTokenHash) {
        return json({ error: 'Missing authenticated event context' }, { status: 403 })
      }
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      const encodedDisplayName = request.headers.get('x-srs-display-name') ?? ''
      const encodedAssignment = request.headers.get('x-srs-assignment') ?? ''
      const attachment: ClientAttachment = {
        eventId,
        eventSlug,
        userId,
        memberId,
        displayName: decodeURIComponent(encodedDisplayName),
        role,
        assignment: decodeURIComponent(encodedAssignment),
        isOwner: request.headers.get('x-srs-owner') === '1',
        joinedAt: new Date().toISOString(),
        sessionTokenHash,
      }

      this.ctx.acceptWebSocket(server)
      server.serializeAttachment(attachment)
      server.send(JSON.stringify({
        type: 'snapshot',
        sequence: this.sequence,
        members: this.ctx.getWebSockets().length,
        serverTime: new Date().toISOString(),
      }))
      this.broadcast({
        type: 'presence',
        sequence: this.sequence,
        memberId,
        state: 'joined',
        members: this.ctx.getWebSockets().length,
      }, server)

      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname.endsWith('/snapshot')) {
      const raceId = url.searchParams.get('race')
      const rows = raceId
        ? [...this.ctx.storage.sql.exec(
            'SELECT * FROM room_events WHERE race_id = ? ORDER BY sequence DESC LIMIT 200',
            raceId,
          )]
        : [...this.ctx.storage.sql.exec(
            'SELECT * FROM room_events ORDER BY sequence DESC LIMIT 200',
          )]
      const positions = [...this.ctx.storage.sql.exec(
        'SELECT * FROM current_positions ORDER BY committee_boat_id',
      )]
      return json({ sequence: this.sequence, events: rows.reverse(), positions })
    }

    return json({ error: 'Not found' }, { status: 404 })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const previous = this.socketMessageQueues.get(socket) ?? Promise.resolve()
    const queued = previous
      .catch(() => undefined)
      .then(() => this.processWebSocketMessage(socket, message))
    this.socketMessageQueues.set(socket, queued)
    return queued.finally(() => {
      if (this.socketMessageQueues.get(socket) === queued) {
        this.socketMessageQueues.delete(socket)
      }
    })
  }

  private async processWebSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 16_384) {
      socket.send(JSON.stringify({ type: 'error', code: 'INVALID_FRAME' }))
      return
    }

    let parsed: unknown
    let persistPositionSnapshot = false
    let positionPersistenceReservation: {
      committeeBoatId: string
      current: PositionPersistenceSchedule
      previous?: PositionPersistenceSchedule
    } | undefined
    try {
      parsed = JSON.parse(message)
    } catch {
      socket.send(JSON.stringify({ type: 'error', code: 'INVALID_JSON' }))
      return
    }

    if (!isRoomMessage(parsed)) {
      socket.send(JSON.stringify({ type: 'error', code: 'INVALID_MESSAGE' }))
      return
    }

    const attachment = socket.deserializeAttachment() as ClientAttachment | null
    if (!attachment) {
      socket.send(JSON.stringify({ type: 'error', code: 'AUTHENTICATION_REQUIRED', id: parsed.id }))
      return
    }
    const access = this.accessFromAttachment(attachment)
    const permission = parsed.type === 'presence' ? 'view' : parsed.type === 'signal-audio' ? 'signal' : parsed.type
    if (!can(access, permission)) {
      socket.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', id: parsed.id, operation: parsed.type }))
      return
    }

    if (parsed.raceId) {
      const race = await this.env.DB.prepare(
        'SELECT status FROM races WHERE id = ? AND regatta_id = ? LIMIT 1',
      ).bind(parsed.raceId, attachment.eventId).first<{ status: string }>()
      if (!race) {
        socket.send(JSON.stringify({ type: 'error', code: 'RACE_NOT_FOUND', id: parsed.id }))
        return
      }
      const mutatesFinalizedState = new Set<RoomMessage['type']>([
        'wind', 'current', 'mark', 'leading-passage', 'finish', 'task', 'signal',
      ])
      const messageAction = parsed.type === 'message' && parsed.payload && typeof parsed.payload === 'object'
        ? String((parsed.payload as { action?: unknown }).action ?? 'send')
        : ''
      const messageReceiptOnly = parsed.type === 'message' && ['read', 'acknowledge'].includes(messageAction)
      const finalizedMutation = mutatesFinalizedState.has(parsed.type) || parsed.type === 'message' && !messageReceiptOnly
      const ownerAppendOnlyRevision = access.isOwner && ['leading-passage', 'finish', 'message'].includes(parsed.type)
      if (race.status === 'finalized' && finalizedMutation && !ownerAppendOnlyRevision) {
        socket.send(JSON.stringify({ type: 'error', code: 'RACE_FINALIZED', id: parsed.id }))
        return
      }
    }

    const duplicate = parsed.type === 'position' ? undefined : [...this.ctx.storage.sql.exec<{ sequence: number }>(
      'SELECT sequence FROM room_events WHERE event_id = ? LIMIT 1',
      parsed.id,
    )][0]
    if (duplicate) {
      socket.send(JSON.stringify({ type: 'ack', id: parsed.id, sequence: duplicate.sequence }))
      return
    }

    try {
      if (parsed.type === 'finalize') {
        if (!parsed.raceId) {
          socket.send(JSON.stringify({ type: 'error', code: 'RACE_REQUIRED', id: parsed.id }))
          return
        }
        const currentAccess = await eventAccess(
          this.env,
          attachment.eventId,
          attachment.userId,
          attachment.displayName,
        )
        if (
          !currentAccess ||
          currentAccess.memberId !== attachment.memberId ||
          !can(currentAccess, 'finalize')
        ) {
          socket.send(JSON.stringify({
            type: 'error',
            code: 'FORBIDDEN',
            id: parsed.id,
            operation: parsed.type,
          }))
          return
        }
        const authenticatedSession = await this.env.DB.prepare(
          `SELECT created_at FROM auth_sessions
           WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?
           LIMIT 1`,
        ).bind(
          attachment.sessionTokenHash,
          attachment.userId,
          new Date().toISOString(),
        ).first<{ created_at: string }>()
        const authenticatedAt = Date.parse(authenticatedSession?.created_at ?? '')
        if (
          !Number.isFinite(authenticatedAt) ||
          Date.now() - authenticatedAt > FINALIZATION_AUTH_MAX_AGE_MINUTES * 60_000
        ) {
          socket.send(JSON.stringify({
            type: 'error',
            code: 'RECENT_AUTHENTICATION_REQUIRED',
            id: parsed.id,
            operation: parsed.type,
          }))
          return
        }
        const payload = parsed.payload as { reason?: string; confirmationPhrase?: string }
        const finalizationReason = payload.reason?.trim() || '権限者による確定'
        const finalization = await finalizeRace(
          this.env,
          currentAccess,
          parsed.raceId,
          finalizationReason,
          payload.confirmationPhrase ?? '',
        )
        parsed.payload = { reason: finalizationReason, ...finalization }
      } else {
        let samplePosition = false
        if (parsed.type === 'position') {
          const payload = parsed.payload as { committeeBoatId?: unknown }
          if (typeof payload?.committeeBoatId === 'string') {
            const current = [...this.ctx.storage.sql.exec<{ last_sampled_at: string | null; server_time: string }>(
              'SELECT last_sampled_at, server_time FROM current_positions WHERE committee_boat_id = ? LIMIT 1',
              payload.committeeBoatId,
            )][0]
            const now = Date.now()
            const scheduled = this.positionPersistenceSchedule.get(payload.committeeBoatId)
            const storedSampledAt = Date.parse(current?.last_sampled_at ?? '')
            const storedSnapshotAt = Date.parse(current?.server_time ?? '')
            const lastSampledAt = Math.max(
              Number.isFinite(storedSampledAt) ? storedSampledAt : 0,
              scheduled?.sampledAt ?? 0,
            )
            const lastSnapshotAt = Math.max(
              Number.isFinite(storedSnapshotAt) ? storedSnapshotAt : 0,
              scheduled?.snapshottedAt ?? 0,
            )
            samplePosition = now - lastSampledAt >= 60_000
            persistPositionSnapshot = samplePosition || now - lastSnapshotAt >= DURABLE_OBJECT_POSITION_SNAPSHOT_MS
            if (samplePosition || persistPositionSnapshot) {
              const reservation = {
                sampledAt: samplePosition ? now : lastSampledAt,
                snapshottedAt: persistPositionSnapshot ? now : lastSnapshotAt,
              }
              positionPersistenceReservation = {
                committeeBoatId: payload.committeeBoatId,
                current: reservation,
                previous: scheduled,
              }
              // Reserve synchronously before the first await below. Durable Object handlers may
              // interleave at awaits, so later live frames must observe this reservation.
              this.positionPersistenceSchedule.set(payload.committeeBoatId, reservation)
            }
            const authorizationKey = `${access.memberId}:${payload.committeeBoatId}`
            const authorizationExpiresAt = this.positionAuthorization.get(authorizationKey) ?? 0
            if (authorizationExpiresAt <= Date.now()) {
              await authorizeCommitteeBoat(this.env, access, payload.committeeBoatId)
              this.positionAuthorization.set(authorizationKey, Date.now() + 30_000)
            }
          }
        }
        parsed.payload = await persistRealtimeOperation(this.env, access, parsed, {
          samplePosition,
          skipCommitteeBoatAuthorization: parsed.type === 'position',
        })
        if (parsed.type !== 'position' && parsed.type !== 'presence') {
          await appendAuditEvent(this.env, {
            access,
            raceId: parsed.raceId,
            action: `realtime.${parsed.type}`,
            entityType: parsed.type,
            entityId: parsed.id,
            after: parsed.payload,
            clientTime: parsed.clientTime,
          })
        }
      }
    } catch (error) {
      if (
        positionPersistenceReservation &&
        this.positionPersistenceSchedule.get(positionPersistenceReservation.committeeBoatId) === positionPersistenceReservation.current
      ) {
        if (positionPersistenceReservation.previous) {
          this.positionPersistenceSchedule.set(
            positionPersistenceReservation.committeeBoatId,
            positionPersistenceReservation.previous,
          )
        } else {
          this.positionPersistenceSchedule.delete(positionPersistenceReservation.committeeBoatId)
        }
      }
      socket.send(JSON.stringify({
        type: 'error',
        code: error instanceof Response ? `HTTP_${error.status}` : 'PERSISTENCE_FAILED',
        id: parsed.id,
        operation: parsed.type,
      }))
      return
    }

    const sequenced: SequencedMessage = {
      ...parsed,
      memberId: attachment.memberId,
      sequence: this.nextSequence(),
      serverTime: new Date().toISOString(),
    }

    if (sequenced.type === 'position' && persistPositionSnapshot) {
      const payload = sequenced.payload as { committeeBoatId?: string; lastSampledAt?: string | null }
      if (payload.committeeBoatId) {
        this.ctx.storage.sql.exec(
          `INSERT INTO current_positions
           (committee_boat_id, sequence, event_id, member_id, payload_json, client_time, server_time, last_sampled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(committee_boat_id) DO UPDATE SET
             sequence = excluded.sequence,
             event_id = excluded.event_id,
             member_id = excluded.member_id,
             payload_json = excluded.payload_json,
             client_time = excluded.client_time,
             server_time = excluded.server_time,
             last_sampled_at = COALESCE(excluded.last_sampled_at, current_positions.last_sampled_at)`,
          payload.committeeBoatId,
          sequenced.sequence,
          sequenced.id,
          sequenced.memberId ?? attachment.memberId,
          JSON.stringify(sequenced.payload),
          sequenced.clientTime ?? null,
          sequenced.serverTime,
          payload.lastSampledAt ?? null,
        )
      }
    } else if (sequenced.type !== 'position') {
      this.ctx.storage.sql.exec(
        `INSERT INTO room_events
         (sequence, event_id, type, race_id, member_id, payload_json, client_time, server_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        sequenced.sequence,
        sequenced.id,
        sequenced.type,
        sequenced.raceId ?? null,
        sequenced.memberId ?? null,
        JSON.stringify(sequenced.payload),
        sequenced.clientTime ?? null,
        sequenced.serverTime,
      )
    }

    if (sequenced.type === 'message' && (sequenced.payload as { body?: unknown }).body) {
      const messagePayload = sequenced.payload as { recipientMemberIds?: string[]; senderMemberId?: string }
      this.broadcastMessage(
        { type: 'event', event: sequenced },
        new Set(messagePayload.recipientMemberIds ?? []),
        messagePayload.senderMemberId ?? attachment.memberId,
      )
    } else {
      this.broadcast({ type: 'event', event: sequenced })
    }
  }

  webSocketClose(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as ClientAttachment | null
    this.broadcast({
      type: 'presence',
      sequence: this.sequence,
      memberId: attachment?.memberId,
      state: 'left',
      members: this.ctx.getWebSockets().length,
    })
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, 'WebSocket error')
  }

  private broadcast(data: unknown, except?: WebSocket): void {
    const encoded = JSON.stringify(data)
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except) socket.send(encoded)
    }
  }

  private broadcastMessage(data: unknown, recipients: ReadonlySet<string>, senderMemberId: string): void {
    const encoded = JSON.stringify(data)
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ClientAttachment | null
      if (attachment?.isOwner || attachment?.memberId === senderMemberId || recipients.has(attachment?.memberId ?? '')) {
        socket.send(encoded)
      }
    }
  }

  private accessFromAttachment(attachment: ClientAttachment): EventAccess {
    return {
      eventId: attachment.eventId,
      eventSlug: attachment.eventSlug,
      eventName: '',
      userId: attachment.userId,
      memberId: attachment.memberId,
      displayName: attachment.displayName,
      role: attachment.role,
      assignment: attachment.assignment,
      isOwner: attachment.isOwner,
    }
  }
}

async function loadEventBootstrap(env: AppEnv, eventId: string, access: EventAccess): Promise<Response> {
  try {
    const regatta = await env.DB.prepare(
      'SELECT id, slug, name, starts_on, ends_on, status FROM regattas WHERE id = ? OR slug = ? LIMIT 1',
    ).bind(eventId, eventId).first()
    if (!regatta) return json({ error: 'Event not found' }, { status: 404 })

    const races = await env.DB.prepare(
      'SELECT id, race_number, class_name, course_code, status, warning_at, target_minutes FROM races WHERE regatta_id = ? ORDER BY race_order',
    ).bind(regatta.id).all()

    const signalEvents = await env.DB.prepare(
      `SELECT signal.id, signal.race_id, signal.signal_type, signal.scheduled_at,
              signal.executed_at, signal.visual_executed_at, signal.sound_executed_at,
              signal.sound_status, signal.official_device_id, signal.payload_json,
              member.display_name AS actor
       FROM signal_events signal
       LEFT JOIN event_members member ON member.id = signal.member_id
       WHERE signal.race_id IN (SELECT id FROM races WHERE regatta_id = ?)
         AND signal.id = (
           SELECT latest.id FROM signal_events latest
           WHERE latest.race_id = signal.race_id
           ORDER BY latest.executed_at DESC, latest.rowid DESC LIMIT 1
         )
       ORDER BY signal.race_id`,
    ).bind(regatta.id).all()

    const raceAreas = await env.DB.prepare(
      'SELECT id, name, center_lng, center_lat FROM race_areas WHERE regatta_id = ? ORDER BY name',
    ).bind(regatta.id).all()

    const courseNodes = await env.DB.prepare(
      `SELECT
         cr.race_id, cr.revision, cn.id AS node_id, cn.mark_id, cn.node_order,
         cn.label, cn.node_type, cn.target_lng, cn.target_lat, m.mark_type
       FROM course_revisions cr
       JOIN course_nodes cn ON cn.course_revision_id = cr.id
       LEFT JOIN marks m ON m.id = cn.mark_id
       WHERE cr.race_id IN (SELECT id FROM races WHERE regatta_id = ?)
         AND cr.revision = (
           SELECT MAX(latest.revision) FROM course_revisions latest WHERE latest.race_id = cr.race_id
         )
       ORDER BY cr.race_id, cn.node_order`,
    ).bind(regatta.id).all()

    const markEvents = await env.DB.prepare(
      `SELECT me.race_id, me.mark_id, me.event_type, me.lng, me.lat,
              me.accuracy_metres, me.client_time, me.server_time, me.sequence
       FROM mark_events me
       JOIN races race ON race.id = me.race_id
       WHERE race.regatta_id = ?
       ORDER BY me.race_id, me.mark_id, me.sequence`,
    ).bind(regatta.id).all()

    const boats = await env.DB.prepare(
      `SELECT cb.id, cb.name, cb.role, cb.call_sign, cb.status,
              ps.lng, ps.lat, ps.accuracy_metres, ps.speed_knots,
              ps.course_degrees, ps.sampled_at
       FROM committee_boats cb
       LEFT JOIN position_samples ps ON ps.id = (
         SELECT latest.id FROM position_samples latest
         WHERE latest.committee_boat_id = cb.id
         ORDER BY latest.sampled_at DESC LIMIT 1
       )
       WHERE cb.regatta_id = ?
       ORDER BY cb.name`,
    ).bind(regatta.id).all()

    const wind = await env.DB.prepare(
      `SELECT direction_degrees, speed_knots, gust_knots, lng, lat, observed_at, source, confidence
       FROM wind_observations WHERE regatta_id = ?
       ORDER BY observed_at DESC LIMIT 1`,
    ).bind(regatta.id).first()

    const current = await env.DB.prepare(
      `SELECT direction_degrees, speed_knots, lng, lat, observed_at, source, confidence
       FROM current_observations WHERE regatta_id = ?
       ORDER BY observed_at DESC LIMIT 1`,
    ).bind(regatta.id).first()

    const messages = await env.DB.prepare(
      `SELECT msg.id, msg.race_id, msg.channel_key, msg.priority, msg.body, msg.sent_at,
              msg.sender_member_id, member.display_name AS sender,
              target.target_type, target.target_id, target.label AS target_label,
              (SELECT COUNT(*) FROM message_receipts receipt WHERE receipt.message_id = msg.id) AS target_count,
              (SELECT COUNT(*) FROM message_receipts receipt WHERE receipt.message_id = msg.id AND receipt.delivered_at IS NOT NULL) AS delivered_count,
              (SELECT COUNT(*) FROM message_receipts receipt WHERE receipt.message_id = msg.id AND receipt.read_at IS NOT NULL) AS read_count,
              (SELECT COUNT(*) FROM message_receipts receipt WHERE receipt.message_id = msg.id AND receipt.acknowledged_at IS NOT NULL) AS acknowledged_count,
              own.message_id AS own_receipt_message_id,
              own.read_at AS own_read_at, own.acknowledged_at AS own_acknowledged_at
       FROM messages msg
       JOIN event_members member ON member.id = msg.sender_member_id
       LEFT JOIN message_targets target ON target.message_id = msg.id
       LEFT JOIN message_receipts own ON own.message_id = msg.id AND own.member_id = ?
       WHERE msg.regatta_id = ? AND msg.deleted_at IS NULL
         AND (msg.sender_member_id = ? OR own.message_id IS NOT NULL OR ? = 1)
       ORDER BY msg.sent_at DESC LIMIT 100`,
    ).bind(access.memberId, regatta.id, access.memberId, access.isOwner ? 1 : 0).all()

    const tasks = await env.DB.prepare(
      `SELECT task.id, task.race_id, task.title, task.status, task.priority, task.due_at,
              COALESCE(member.display_name, boat.name, '未割当') AS owner
       FROM operational_tasks task
       JOIN races race ON race.id = task.race_id
       LEFT JOIN event_members member ON member.id = task.assignee_member_id
       LEFT JOIN committee_boats boat ON boat.id = task.assignee_boat_id
       WHERE race.regatta_id = ?
       ORDER BY race.race_order, task.priority, task.title`,
    ).bind(regatta.id).all()

    const leadingPassages = await env.DB.prepare(
      `SELECT observation.id, observation.race_id, node.mark_id, observation.lap_number,
              observation.passed_at, observation.sync_quality, observation.was_offline,
              observation.sail_number, observation.note, observation.status,
              member.display_name AS recorded_by,
              adoption.observation_id AS adopted_observation_id,
              adoption.adopted_at, adoption.revision AS adoption_revision
       FROM leading_passage_observations observation
       JOIN races race ON race.id = observation.race_id
       JOIN course_nodes node ON node.id = observation.course_node_id
       JOIN event_members member ON member.id = observation.recorded_by
       LEFT JOIN leading_passage_adoptions adoption ON adoption.id = (
         SELECT latest.id FROM leading_passage_adoptions latest
         WHERE latest.race_id = observation.race_id
           AND latest.course_node_id = observation.course_node_id
           AND latest.lap_number = observation.lap_number
         ORDER BY latest.revision DESC LIMIT 1
       )
       WHERE race.regatta_id = ?
       ORDER BY observation.passed_at`,
    ).bind(regatta.id).all()

    const finishes = await env.DB.prepare(
      `SELECT observation.id, observation.race_id, observation.finish_position,
              observation.finished_at, observation.sync_quality, observation.was_offline,
              observation.sail_number, observation.note, observation.status,
              member.display_name AS recorded_by,
              adoption.observation_id AS adopted_observation_id,
              adoption.adopted_at, adoption.revision AS adoption_revision
       FROM finish_observations observation
       JOIN races race ON race.id = observation.race_id
       JOIN event_members member ON member.id = observation.recorded_by
       LEFT JOIN finish_adoptions adoption ON adoption.id = (
         SELECT latest.id FROM finish_adoptions latest
         WHERE latest.race_id = observation.race_id
           AND latest.finish_position = observation.finish_position
         ORDER BY latest.revision DESC LIMIT 1
       )
       WHERE race.regatta_id = ?
       ORDER BY observation.finished_at`,
    ).bind(regatta.id).all()

    const memberCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM event_members
       WHERE regatta_id = ? AND status = 'active'`,
    ).bind(regatta.id).first<{ count: number }>()

    const availableMarks = await env.DB.prepare(
      'SELECT id, label, mark_type FROM marks WHERE regatta_id = ? ORDER BY label',
    ).bind(regatta.id).all()

    const availableMembers = await env.DB.prepare(
      `SELECT id, display_name, role, assignment
       FROM event_members WHERE regatta_id = ? AND status = 'active'
       ORDER BY role, display_name`,
    ).bind(regatta.id).all()

    const raceCorrections = await env.DB.prepare(
      `SELECT revision.race_id, revision.revision, revision.patch_json, revision.reason,
              revision.state_hash, revision.created_at
       FROM post_finalization_revisions revision
       WHERE revision.race_id IN (SELECT id FROM races WHERE regatta_id = ?)
         AND revision.revision = (
           SELECT MAX(latest.revision) FROM post_finalization_revisions latest
           WHERE latest.race_id = revision.race_id
         )`,
    ).bind(regatta.id).all()

    return json({
      access: {
        memberId: access.memberId,
        displayName: access.displayName,
        role: access.role,
        assignment: access.assignment,
        isOwner: access.isOwner,
      },
      regatta,
      races: races.results,
      signalEvents: signalEvents.results,
      raceAreas: raceAreas.results,
      courseNodes: courseNodes.results,
      markEvents: markEvents.results,
      boats: boats.results,
      wind,
      current,
      messages: messages.results,
      tasks: tasks.results,
      leadingPassages: leadingPassages.results,
      finishes: finishes.results,
      memberCount: memberCount?.count ?? 0,
      availableMarks: availableMarks.results,
      availableMembers: availableMembers.results,
      raceCorrections: raceCorrections.results,
    })
  } catch (error) {
    return json({
      mode: 'demo',
      reason: 'D1 schema has not been initialized',
      detail: error instanceof Error ? error.message : 'Unknown D1 error',
    })
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url)

      if (url.pathname === '/api/health') {
        const freeTierDesignEstimate = estimateRegattaFreeTierUsage(STANDARD_REGATTA_LOAD)
        return json({
          service: 'Sailing Race Supporter',
          version: '0.3.0',
          status: 'ok',
          serverTime: new Date().toISOString(),
          freeTierDesignEstimate: {
            maxPercent: Math.round(freeTierDesignEstimate.maxPercent * 10) / 10,
            stage: freeTierDesignEstimate.stage,
            limitingMetric: freeTierDesignEstimate.limitingMetric.key,
          },
        })
      }

      const authResponse = await handleAuthRequest(request, env)
      if (authResponse) return authResponse

      const audioDeviceResponse = await handleAudioDeviceRequest(request, env)
      if (audioDeviceResponse) return audioDeviceResponse

      const eventCollectionResponse = await handleEventCollectionRequest(request, env)
      if (eventCollectionResponse) return eventCollectionResponse

      const inviteResponse = await handleInviteRequest(request, env)
      if (inviteResponse) return inviteResponse

      const logResponse = await handleLogRequest(request, env)
      if (logResponse) return logResponse

      const backupResponse = await handleBackupRequest(request, env)
      if (backupResponse) return backupResponse

      const revisionResponse = await handleRevisionRequest(request, env)
      if (revisionResponse) return revisionResponse

      const courseResponse = await handleCourseRequest(request, env)
      if (courseResponse) return courseResponse

      const settingsResponse = await handleSettingsRequest(request, env)
      if (settingsResponse) return settingsResponse

      const roomMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/room(?:\/snapshot)?$/)
      if (roomMatch) {
        if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
          const origin = request.headers.get('origin')
          if (origin !== url.origin) {
            return json({ error: 'Invalid WebSocket origin' }, { status: 403 })
          }
        }
        const session = await requireSession(request, env)
        const eventId = decodeURIComponent(roomMatch[1])
        const access = await eventAccess(env, eventId, session.userId, session.displayName)
        if (!access) return json({ error: 'Event access denied' }, { status: 403 })
        requirePermission(access, 'view')
        const stub = env.EVENT_ROOMS.getByName(access.eventId)
        const headers = new Headers(request.headers)
        headers.set('x-srs-user-id', access.userId)
        headers.set('x-srs-member-id', access.memberId)
        headers.set('x-srs-display-name', encodeURIComponent(access.displayName))
        headers.set('x-srs-role', access.role)
        headers.set('x-srs-assignment', encodeURIComponent(access.assignment))
        headers.set('x-srs-owner', access.isOwner ? '1' : '0')
        headers.set('x-srs-event-id', access.eventId)
        headers.set('x-srs-event-slug', access.eventSlug)
        headers.set('x-srs-session-token-hash', session.tokenHash)
        return stub.fetch(new Request(request, { headers }))
      }

      const bootstrapMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/bootstrap$/)
      if (request.method === 'GET' && bootstrapMatch) {
        const session = await requireSession(request, env)
        const eventId = decodeURIComponent(bootstrapMatch[1])
        const access = await eventAccess(env, eventId, session.userId, session.displayName)
        if (!access) return json({ error: 'Event access denied' }, { status: 403 })
        requirePermission(access, 'view')
        return loadEventBootstrap(env, eventId, access)
      }

      if (url.pathname.startsWith('/api/')) {
        return json({ error: 'Not found' }, { status: 404 })
      }

      return env.ASSETS.fetch(request)
    } catch (error) {
      if (error instanceof Response) return error
      console.error('Unhandled request error', error)
      return json({ error: 'Internal server error' }, { status: 500 })
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runDailyRetention(env))
  },
} satisfies ExportedHandler<AppEnv>
