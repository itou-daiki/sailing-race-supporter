import { DurableObject } from 'cloudflare:workers'

export interface AppEnv {
  ASSETS: Fetcher
  DB: D1Database
  EVENT_ROOMS: DurableObjectNamespace<EventRoom>
  FILES: R2Bucket
}

interface ClientAttachment {
  memberId: string
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

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

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

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...init.headers },
  })
}

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
    `)
    const rows = [...this.ctx.storage.sql.exec<{ sequence: number }>(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM room_events',
    )]
    this.sequence = rows[0]?.sequence ?? 0
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      const memberId = url.searchParams.get('member') ?? crypto.randomUUID()
      const attachment: ClientAttachment = { memberId, joinedAt: new Date().toISOString() }

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
      return json({ sequence: this.sequence, events: rows.reverse() })
    }

    return json({ error: 'Not found' }, { status: 404 })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
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

    const duplicate = [...this.ctx.storage.sql.exec<{ sequence: number }>(
      'SELECT sequence FROM room_events WHERE event_id = ? LIMIT 1',
      parsed.id,
    )][0]
    if (duplicate) {
      socket.send(JSON.stringify({ type: 'ack', id: parsed.id, sequence: duplicate.sequence }))
      return
    }

    const attachment = socket.deserializeAttachment() as ClientAttachment | null
    const sequenced: SequencedMessage = {
      ...parsed,
      memberId: parsed.memberId ?? attachment?.memberId,
      sequence: ++this.sequence,
      serverTime: new Date().toISOString(),
    }

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
}

async function loadEventBootstrap(env: AppEnv, eventId: string): Promise<Response> {
  try {
    const regatta = await env.DB.prepare(
      'SELECT id, slug, name, starts_on, ends_on, status FROM regattas WHERE id = ? OR slug = ? LIMIT 1',
    ).bind(eventId, eventId).first()
    if (!regatta) return json({ error: 'Event not found' }, { status: 404 })

    const races = await env.DB.prepare(
      'SELECT id, race_number, class_name, course_code, status, warning_at, target_minutes FROM races WHERE regatta_id = ? ORDER BY race_order',
    ).bind(regatta.id).all()

    return json({ regatta, races: races.results })
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
    const url = new URL(request.url)

    if (url.pathname === '/api/health') {
      return json({
        service: 'Sailing Race Supporter',
        version: '0.1.0',
        status: 'ok',
        serverTime: new Date().toISOString(),
      })
    }

    const roomMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/room(?:\/snapshot)?$/)
    if (roomMatch) {
      const eventId = decodeURIComponent(roomMatch[1])
      const stub = env.EVENT_ROOMS.getByName(eventId)
      return stub.fetch(request)
    }

    const bootstrapMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/bootstrap$/)
    if (request.method === 'GET' && bootstrapMatch) {
      return loadEventBootstrap(env, decodeURIComponent(bootstrapMatch[1]))
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, { status: 404 })
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<AppEnv>
