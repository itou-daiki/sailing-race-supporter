import { DurableObject } from 'cloudflare:workers'
import { handleAuthRequest } from './auth.js'
import { can, eventAccess, requirePermission, type EventAccess } from './authorization.js'
import { appendAuditEvent, finalizeRace } from './audit.js'
import { handleEventCollectionRequest } from './events.js'
import { json } from './http.js'
import { handleInviteRequest } from './invites.js'
import { authorizeCommitteeBoat, persistRealtimeOperation } from './operations.js'
import { requireSession } from './security.js'

export interface AppEnv {
  ASSETS: Fetcher
  DB: D1Database
  EVENT_ROOMS: DurableObjectNamespace<EventRoom>
  FILES: R2Bucket
}

interface ClientAttachment {
  eventId: string
  eventSlug: string
  userId: string
  memberId: string
  displayName: string
  role: string
  isOwner: boolean
  joinedAt: string
}

interface RoomMessage {
  id: string
  type: 'presence' | 'position' | 'wind' | 'mark' | 'leading-passage' | 'task' | 'message' | 'signal' | 'finalize'
  raceId?: string
  memberId?: string
  payload: unknown
  clientTime?: string
}

interface SequencedMessage extends RoomMessage {
  sequence: number
  serverTime: string
}

const ROOM_MESSAGE_TYPES = new Set<RoomMessage['type']>([
  'presence',
  'position',
  'wind',
  'mark',
  'leading-passage',
  'task',
  'message',
  'signal',
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
  private readonly positionAuthorization = new Map<string, number>()

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
    `)
    const rows = [...this.ctx.storage.sql.exec<{ sequence: number }>(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM room_events',
    )]
    const positionRows = [...this.ctx.storage.sql.exec<{ sequence: number }>(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM current_positions',
    )]
    this.sequence = Math.max(rows[0]?.sequence ?? 0, positionRows[0]?.sequence ?? 0)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const eventId = request.headers.get('x-srs-event-id')
      const eventSlug = request.headers.get('x-srs-event-slug')
      const userId = request.headers.get('x-srs-user-id')
      const memberId = request.headers.get('x-srs-member-id')
      const role = request.headers.get('x-srs-role')
      if (!eventId || !eventSlug || !userId || !memberId || !role) {
        return json({ error: 'Missing authenticated event context' }, { status: 403 })
      }
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      const encodedDisplayName = request.headers.get('x-srs-display-name') ?? ''
      const attachment: ClientAttachment = {
        eventId,
        eventSlug,
        userId,
        memberId,
        displayName: decodeURIComponent(encodedDisplayName),
        role,
        isOwner: request.headers.get('x-srs-owner') === '1',
        joinedAt: new Date().toISOString(),
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

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 16_384) {
      socket.send(JSON.stringify({ type: 'error', code: 'INVALID_FRAME' }))
      return
    }

    let parsed: unknown
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
      socket.send(JSON.stringify({ type: 'error', code: 'AUTHENTICATION_REQUIRED' }))
      return
    }
    const access = this.accessFromAttachment(attachment)
    const permission = parsed.type === 'presence' ? 'view' : parsed.type
    if (!can(access, permission)) {
      socket.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', operation: parsed.type }))
      return
    }

    if (parsed.raceId) {
      const race = await this.env.DB.prepare(
        'SELECT status FROM races WHERE id = ? AND regatta_id = ? LIMIT 1',
      ).bind(parsed.raceId, attachment.eventId).first<{ status: string }>()
      if (!race) {
        socket.send(JSON.stringify({ type: 'error', code: 'RACE_NOT_FOUND' }))
        return
      }
      const mutatesFinalizedState = new Set<RoomMessage['type']>([
        'wind', 'mark', 'leading-passage', 'task', 'signal',
      ])
      if (race.status === 'finalized' && mutatesFinalizedState.has(parsed.type)) {
        socket.send(JSON.stringify({ type: 'error', code: 'RACE_FINALIZED' }))
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
          socket.send(JSON.stringify({ type: 'error', code: 'RACE_REQUIRED' }))
          return
        }
        const payload = parsed.payload as { reason?: string }
        const finalization = await finalizeRace(
          this.env,
          access,
          parsed.raceId,
          payload.reason?.trim() || '権限者による確定',
        )
        parsed.payload = { ...payload, ...finalization }
      } else {
        let samplePosition = false
        if (parsed.type === 'position') {
          const payload = parsed.payload as { committeeBoatId?: unknown }
          if (typeof payload?.committeeBoatId === 'string') {
            const current = [...this.ctx.storage.sql.exec<{ last_sampled_at: string | null }>(
              'SELECT last_sampled_at FROM current_positions WHERE committee_boat_id = ? LIMIT 1',
              payload.committeeBoatId,
            )][0]
            samplePosition = !current?.last_sampled_at || Date.now() - Date.parse(current.last_sampled_at) >= 60_000
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
      socket.send(JSON.stringify({
        type: 'error',
        code: error instanceof Response ? `HTTP_${error.status}` : 'PERSISTENCE_FAILED',
      }))
      return
    }

    const sequenced: SequencedMessage = {
      ...parsed,
      memberId: attachment.memberId,
      sequence: ++this.sequence,
      serverTime: new Date().toISOString(),
    }

    if (sequenced.type === 'position') {
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
    } else {
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

    this.broadcast({ type: 'event', event: sequenced })
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

  private accessFromAttachment(attachment: ClientAttachment): EventAccess {
    return {
      eventId: attachment.eventId,
      eventSlug: attachment.eventSlug,
      eventName: '',
      userId: attachment.userId,
      memberId: attachment.memberId,
      displayName: attachment.displayName,
      role: attachment.role,
      assignment: '',
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
      `SELECT direction_degrees, speed_knots, gust_knots, observed_at, source, confidence
       FROM wind_observations WHERE regatta_id = ?
       ORDER BY observed_at DESC LIMIT 1`,
    ).bind(regatta.id).first()

    const messages = await env.DB.prepare(
      `SELECT msg.id, msg.race_id, msg.channel_key, msg.priority, msg.body, msg.sent_at,
              member.display_name AS sender
       FROM messages msg
       JOIN event_members member ON member.id = msg.sender_member_id
       WHERE msg.regatta_id = ? AND msg.deleted_at IS NULL
       ORDER BY msg.sent_at DESC LIMIT 100`,
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
      courseNodes: courseNodes.results,
      markEvents: markEvents.results,
      boats: boats.results,
      wind,
      messages: messages.results,
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
        return json({
          service: 'Sailing Race Supporter',
          version: '0.2.0',
          status: 'ok',
          serverTime: new Date().toISOString(),
        })
      }

      const authResponse = await handleAuthRequest(request, env)
      if (authResponse) return authResponse

      const eventCollectionResponse = await handleEventCollectionRequest(request, env)
      if (eventCollectionResponse) return eventCollectionResponse

      const inviteResponse = await handleInviteRequest(request, env)
      if (inviteResponse) return inviteResponse

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
        headers.set('x-srs-owner', access.isOwner ? '1' : '0')
        headers.set('x-srs-event-id', access.eventId)
        headers.set('x-srs-event-slug', access.eventSlug)
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
} satisfies ExportedHandler<AppEnv>
