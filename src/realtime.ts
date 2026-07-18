import { useCallback, useEffect, useRef, useState } from 'react'
import {
  countQueuedOperations,
  listQueuedOperations,
  queueOperation,
  removeQueuedOperation,
  type QueuedOperation,
} from './offlineStore'
import type { RuntimeBudgetStatus } from '../shared/freeTierBudget'

export type RealtimeStatus = 'connecting' | 'live' | 'offline'

export type OperationType =
  | 'presence'
  | 'position'
  | 'wind'
  | 'current'
  | 'mark'
  | 'leading-passage'
  | 'finish'
  | 'task'
  | 'message'
  | 'signal'
  | 'signal-audio'
  | 'schedule'
  | 'course'
  | 'assignment'
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

interface RoomErrorEnvelope {
  type: 'error'
  code: string
  id?: string
  operation?: OperationType
}

interface PendingConfirmation {
  resolve: (event: SequencedOperation) => void
  reject: (error: RealtimeOperationError) => void
  timeout: number
}

const OPERATION_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  RECENT_AUTHENTICATION_REQUIRED: '確定前にパスキーで本人確認してください',
  AUTHENTICATION_REQUIRED: '認証が失効しました。パスキーでログインし直してください',
  FORBIDDEN: 'この担当には操作権限がありません',
  RACE_NOT_FOUND: '対象レースが見つかりません',
  RACE_FINALIZED: 'このレースはすでに確定されています',
  RACE_REQUIRED: '対象レースを指定してください',
  LIVE_CONNECTION_REQUIRED: 'リアルタイム接続を確認してから実行してください',
  CONNECTION_CLOSED: '確認中に接続が切れました。状態を確認してから再試行してください',
  CONFIRMATION_TIMEOUT: 'サーバーの確定応答を確認できませんでした。再読み込みして状態を確認してください',
  PERSISTENCE_FAILED: 'サーバーへ記録できませんでした',
  HTTP_403: 'この操作はサーバーで拒否されました',
  HTTP_400: '確認入力をサーバーで検証できませんでした',
  HTTP_409: '状態が変更されたため操作を完了できませんでした',
}

export class RealtimeOperationError extends Error {
  constructor(readonly code: string, readonly operationId?: string) {
    super(OPERATION_ERROR_MESSAGES[code] ?? `リアルタイム操作に失敗しました（${code}）`)
    this.name = 'RealtimeOperationError'
  }
}

interface UseRealtimeOptions {
  eventId: string
  memberId: string
  connectionKey?: string
  enabled?: boolean
  onEvent?: (event: SequencedOperation) => void
  onOperationError?: (error: RealtimeOperationError, operation?: OperationType) => void
}

export function useEventRoom({ eventId, memberId, connectionKey = '', enabled = true, onEvent, onOperationError }: UseRealtimeOptions) {
  const [status, setStatus] = useState<RealtimeStatus>(enabled ? 'connecting' : 'offline')
  const [pendingCount, setPendingCount] = useState(0)
  const [lastSequence, setLastSequence] = useState(0)
  const [serverOffsetMs, setServerOffsetMs] = useState(0)
  const [budgetStatus, setBudgetStatus] = useState<RuntimeBudgetStatus>()
  const [connectedKey, setConnectedKey] = useState('')
  const socketRef = useRef<WebSocket | undefined>(undefined)
  const eventHandlerRef = useRef(onEvent)
  const errorHandlerRef = useRef(onOperationError)
  const pendingConfirmationsRef = useRef(new Map<string, PendingConfirmation>())

  useEffect(() => {
    eventHandlerRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    errorHandlerRef.current = onOperationError
  }, [onOperationError])

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
      setConnectedKey('')
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(
        `${protocol}//${window.location.host}/api/events/${encodeURIComponent(eventId)}/room?member=${encodeURIComponent(memberId)}`,
      )
      socketRef.current = socket
      socket.addEventListener('open', () => {
        setStatus('live')
        setConnectedKey(connectionKey)
        void flush()
      })
      socket.addEventListener('message', (message) => {
        if (typeof message.data !== 'string') return
        try {
          const envelope = JSON.parse(message.data) as {
            type?: RoomEnvelope['type'] | RoomErrorEnvelope['type'] | 'snapshot' | 'ack' | 'budget'
            event?: SequencedOperation
            code?: string
            id?: string
            operation?: OperationType
            sequence?: number
            serverTime?: string
            budget?: RuntimeBudgetStatus
          }
          if (envelope.budget) setBudgetStatus(envelope.budget)
          const serverTime = envelope.type === 'event' ? envelope.event?.serverTime : envelope.serverTime
          if (serverTime) {
            const measuredOffset = Date.parse(serverTime) - Date.now()
            if (Number.isFinite(measuredOffset)) setServerOffsetMs((current) => current === 0 ? measuredOffset : current * 0.75 + measuredOffset * 0.25)
          }
          if (envelope.type === 'event' && envelope.event) {
            setLastSequence(envelope.event.sequence)
            void removeQueuedOperation(envelope.event.id).then(refreshPendingCount)
            eventHandlerRef.current?.(envelope.event)
            const confirmation = pendingConfirmationsRef.current.get(envelope.event.id)
            if (confirmation) {
              window.clearTimeout(confirmation.timeout)
              pendingConfirmationsRef.current.delete(envelope.event.id)
              confirmation.resolve(envelope.event)
            }
          } else if (envelope.type === 'error' && envelope.code && envelope.id) {
            const confirmation = pendingConfirmationsRef.current.get(envelope.id)
            const operationError = new RealtimeOperationError(envelope.code, envelope.id)
            if (confirmation) {
              window.clearTimeout(confirmation.timeout)
              pendingConfirmationsRef.current.delete(envelope.id)
              confirmation.reject(operationError)
            } else {
              void removeQueuedOperation(envelope.id).then(refreshPendingCount)
              errorHandlerRef.current?.(operationError, envelope.operation)
            }
          } else if (envelope.type === 'ack' && envelope.id) {
            void removeQueuedOperation(envelope.id).then(refreshPendingCount)
            if (typeof envelope.sequence === 'number') setLastSequence(envelope.sequence)
          } else if (typeof envelope.sequence === 'number') {
            setLastSequence(envelope.sequence)
          }
        } catch {
          // Malformed frames are ignored; the server remains authoritative.
        }
      })
      socket.addEventListener('close', (event) => {
        setStatus('offline')
        setConnectedKey('')
        if (event.code === 4003) {
          errorHandlerRef.current?.(new RealtimeOperationError('AUTHENTICATION_REQUIRED'))
        }
        for (const [id, confirmation] of pendingConfirmationsRef.current) {
          window.clearTimeout(confirmation.timeout)
          confirmation.reject(new RealtimeOperationError('CONNECTION_CLOSED', id))
        }
        pendingConfirmationsRef.current.clear()
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
  }, [connectionKey, enabled, eventId, memberId, refreshPendingCount, transmit])

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

  const sendConfirmed = useCallback((
    type: OperationType,
    payload: unknown,
    raceId?: string,
    timeoutMs = 12_000,
  ): Promise<SequencedOperation> => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RealtimeOperationError('LIVE_CONNECTION_REQUIRED'))
    }
    const operation: QueuedOperation = {
      id: crypto.randomUUID(),
      eventId,
      raceId,
      type,
      payload,
      clientTime: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
    }

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingConfirmationsRef.current.delete(operation.id)
        reject(new RealtimeOperationError('CONFIRMATION_TIMEOUT', operation.id))
      }, timeoutMs)
      pendingConfirmationsRef.current.set(operation.id, { resolve, reject, timeout })
      if (!transmit(operation)) {
        window.clearTimeout(timeout)
        pendingConfirmationsRef.current.delete(operation.id)
        reject(new RealtimeOperationError('LIVE_CONNECTION_REQUIRED', operation.id))
      }
    })
  }, [eventId, transmit])

  return {
    status: enabled ? status : 'offline' as RealtimeStatus,
    pendingCount,
    lastSequence,
    serverOffsetMs,
    budgetStatus,
    connectedKey,
    send,
    sendConfirmed,
  }
}
