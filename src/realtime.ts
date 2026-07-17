import { useCallback, useEffect, useRef, useState } from 'react'
import {
  countQueuedOperations,
  listQueuedOperations,
  queueOperation,
  removeQueuedOperation,
  type QueuedOperation,
} from './offlineStore'

export type RealtimeStatus = 'connecting' | 'live' | 'offline'

export type OperationType =
  | 'presence'
  | 'position'
  | 'wind'
  | 'mark'
  | 'leading-passage'
  | 'task'
  | 'message'
  | 'signal'
  | 'finalize'

export interface SequencedOperation {
  id: string
  type: OperationType
  raceId?: string
  memberId?: string
  payload: unknown
  clientTime?: string
  sequence: number
  serverTime: string
}

interface RoomEnvelope {
  type: 'event'
  event: SequencedOperation
}

interface UseRealtimeOptions {
  eventId: string
  memberId: string
  enabled?: boolean
  onEvent?: (event: SequencedOperation) => void
}

export function useEventRoom({ eventId, memberId, enabled = true, onEvent }: UseRealtimeOptions) {
  const [status, setStatus] = useState<RealtimeStatus>(enabled ? 'connecting' : 'offline')
  const [pendingCount, setPendingCount] = useState(0)
  const [lastSequence, setLastSequence] = useState(0)
  const [serverOffsetMs, setServerOffsetMs] = useState(0)
  const socketRef = useRef<WebSocket | undefined>(undefined)
  const eventHandlerRef = useRef(onEvent)

  useEffect(() => {
    eventHandlerRef.current = onEvent
  }, [onEvent])

  const refreshPendingCount = useCallback(async () => {
    setPendingCount(await countQueuedOperations(eventId))
  }, [eventId])

  const transmit = useCallback((operation: QueuedOperation) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify({
      id: operation.id,
      type: operation.type,
      raceId: operation.raceId,
      memberId,
      payload: operation.payload,
      clientTime: operation.clientTime,
    }))
    return true
  }, [memberId])

  useEffect(() => {
    if (!enabled) return
    let socket: WebSocket | undefined
    let reconnectTimer: number | undefined
    let cancelled = false

    const flush = async () => {
      const operations = await listQueuedOperations(eventId)
      operations.forEach((operation) => transmit(operation))
      await refreshPendingCount()
    }

    const connect = () => {
      if (cancelled) return
      if (!navigator.onLine) {
        setStatus('offline')
        reconnectTimer = window.setTimeout(connect, 5_000)
        return
      }

      setStatus('connecting')
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(
        `${protocol}//${window.location.host}/api/events/${encodeURIComponent(eventId)}/room?member=${encodeURIComponent(memberId)}`,
      )
      socketRef.current = socket
      socket.addEventListener('open', () => {
        setStatus('live')
        void flush()
      })
      socket.addEventListener('message', (message) => {
        if (typeof message.data !== 'string') return
        try {
          const envelope = JSON.parse(message.data) as Partial<RoomEnvelope> & { sequence?: number; serverTime?: string }
          const serverTime = envelope.type === 'event' ? envelope.event?.serverTime : envelope.serverTime
          if (serverTime) {
            const measuredOffset = Date.parse(serverTime) - Date.now()
            if (Number.isFinite(measuredOffset)) setServerOffsetMs((current) => current === 0 ? measuredOffset : current * 0.75 + measuredOffset * 0.25)
          }
          if (envelope.type === 'event' && envelope.event) {
            setLastSequence(envelope.event.sequence)
            void removeQueuedOperation(envelope.event.id).then(refreshPendingCount)
            eventHandlerRef.current?.(envelope.event)
          } else if (typeof envelope.sequence === 'number') {
            setLastSequence(envelope.sequence)
          }
        } catch {
          // Malformed frames are ignored; the server remains authoritative.
        }
      })
      socket.addEventListener('close', () => {
        setStatus('offline')
        if (!cancelled) reconnectTimer = window.setTimeout(connect, 5_000)
      })
      socket.addEventListener('error', () => setStatus('offline'))
    }

    void countQueuedOperations(eventId).then(setPendingCount)
    connect()
    const online = () => {
      if (!socket || socket.readyState > WebSocket.OPEN) connect()
    }
    window.addEventListener('online', online)

    return () => {
      cancelled = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      window.removeEventListener('online', online)
      socket?.close()
      if (socketRef.current === socket) socketRef.current = undefined
    }
  }, [enabled, eventId, memberId, refreshPendingCount, transmit])

  const send = useCallback(async (
    type: OperationType,
    payload: unknown,
    raceId?: string,
  ): Promise<string> => {
    const operation: QueuedOperation = {
      id: crypto.randomUUID(),
      eventId,
      raceId,
      type,
      payload,
      clientTime: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
    }
    await queueOperation(operation)
    await refreshPendingCount()
    transmit(operation)
    return operation.id
  }, [eventId, refreshPendingCount, transmit])

  return { status: enabled ? status : 'offline' as RealtimeStatus, pendingCount, lastSequence, serverOffsetMs, send }
}
