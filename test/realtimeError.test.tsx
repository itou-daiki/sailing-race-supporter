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
  private listeners = new Map<string, Array<(event: { data?: string }) => void>>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(value: string) {
    this.sent.push(value)
  }

  close() {
    this.readyState = 3
  }

  emit(type: string, event: { data?: string } = {}) {
    this.listeners.get(type)?.forEach((listener) => listener(event))
  }
}

describe('realtime operation rejection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeWebSocket.instances = []
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
