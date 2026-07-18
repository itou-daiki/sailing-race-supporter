import 'fake-indexeddb/auto'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEventRoom } from '../src/realtime'
import { runtimeBudgetStatus } from '../shared/freeTierBudget'

class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  private listeners = new Map<string, Array<(event: { data?: string; code?: number }) => void>>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: { data?: string; code?: number }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(value: string) {
    this.sent.push(value)
  }

  close() {
    this.readyState = 3
  }

  emit(type: string, event: { data?: string; code?: number } = {}) {
    this.listeners.get(type)?.forEach((listener) => listener(event))
  }
}

describe('realtime operation rejection', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    FakeWebSocket.instances = []
  })

  it('replays missed room state and reconnects from the latest sequence', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onEvent = vi.fn()
    const onResyncRequired = vi.fn()
    const { result, unmount } = renderHook(() => useEventRoom({
      eventId: 'replay-test-event',
      memberId: 'member-1',
      onEvent,
      onResyncRequired,
    }))
    const socket = FakeWebSocket.instances[0]
    expect(socket.url).toContain('since=0')

    act(() => socket.emit('open'))
    act(() => socket.emit('message', {
      data: JSON.stringify({
        type: 'snapshot',
        sequence: 8,
        serverTime: new Date().toISOString(),
        resyncRequired: true,
        events: [{
          id: 'replayed-wind', type: 'wind', raceId: 'race-1', sequence: 7,
          serverTime: '2026-07-18T10:00:07.000Z', payload: { directionDegrees: 345, speedKnots: 9.2 },
        }],
        positions: [{
          id: 'position-snapshot', type: 'position', sequence: 6,
          serverTime: '2026-07-18T10:00:06.000Z', payload: { committeeBoatId: 'boat-1', position: [139.76, 35.25] },
        }],
      }),
    }))

    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(['position', 'wind'])
    expect(onResyncRequired).toHaveBeenCalledOnce()
    expect(result.current.lastSequence).toBe(8)

    act(() => socket.emit('close', { code: 1006 }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1].url).toContain('since=8')
    unmount()
  })

  it('reports an unconfirmed server rejection so optimistic state can be reconciled', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onOperationError = vi.fn()
    const { result, unmount } = renderHook(() => useEventRoom({
      eventId: 'rejection-test-event',
      memberId: 'member-1',
      onOperationError,
    }))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.emit('open'))

    let operationId = ''
    await act(async () => {
      operationId = await result.current.send('mark', { markId: 'mark-1' }, 'race-1')
    })
    expect(socket.sent.some((value) => JSON.parse(value).id === operationId)).toBe(true)

    act(() => socket.emit('message', {
      data: JSON.stringify({ type: 'error', code: 'FORBIDDEN', id: operationId, operation: 'mark' }),
    }))

    await waitFor(() => expect(onOperationError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'FORBIDDEN', operationId }),
      'mark',
    ))
    await waitFor(() => expect(result.current.pendingCount).toBe(0))
    unmount()
  })

  it('applies room budget telemetry and removes a throttled position from the outbox', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const { result, unmount } = renderHook(() => useEventRoom({
      eventId: 'budget-test-event',
      memberId: 'member-1',
    }))
    const socket = FakeWebSocket.instances[0]
    act(() => socket.emit('open'))
    const budget = runtimeBudgetStatus('2026-07-18', 70_000)
    act(() => socket.emit('message', {
      data: JSON.stringify({ type: 'snapshot', sequence: 100, serverTime: new Date().toISOString(), budget }),
    }))
    await waitFor(() => expect(result.current.budgetStatus?.stage).toBe('warning'))

    let operationId = ''
    await act(async () => {
      operationId = await result.current.send('position', { committeeBoatId: 'boat-1', position: [139, 35] }, 'race-1')
    })
    await waitFor(() => expect(result.current.pendingCount).toBe(1))
    act(() => socket.emit('message', {
      data: JSON.stringify({
        type: 'ack', id: operationId, sequence: 100, serverTime: new Date().toISOString(), throttled: true, budget,
      }),
    }))
    await waitFor(() => expect(result.current.pendingCount).toBe(0))
    expect(result.current.budgetStatus?.policy.preservesOperationalEvents).toBe(true)
    unmount()
  })
})
