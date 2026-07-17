import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  countQueuedOperations,
  exportLocalEventData,
  listQueuedOperations,
  queueOperation,
  removeQueuedOperation,
  resetOfflineStoreForTests,
  saveMemberProfile,
} from '../src/offlineStore'

describe('offline store', () => {
  beforeEach(async () => {
    resetOfflineStoreForTests()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('sailing-race-supporter')
      request.addEventListener('success', () => resolve())
      request.addEventListener('error', () => reject(request.error))
    })
  })

  it('queues operations in chronological order and removes acknowledgements', async () => {
    await queueOperation({
      id: 'second',
      eventId: 'event-a',
      type: 'mark',
      payload: { markId: '1' },
      clientTime: '2026-07-18T00:00:02Z',
      queuedAt: '2026-07-18T00:00:02Z',
    })
    await queueOperation({
      id: 'first',
      eventId: 'event-a',
      type: 'wind',
      payload: { speedKnots: 8 },
      clientTime: '2026-07-18T00:00:01Z',
      queuedAt: '2026-07-18T00:00:01Z',
    })

    expect((await listQueuedOperations('event-a')).map((item) => item.id)).toEqual(['first', 'second'])
    await removeQueuedOperation('first')
    expect(await countQueuedOperations('event-a')).toBe(1)
  })

  it('exports the local profile without server secrets', async () => {
    await saveMemberProfile({
      eventId: 'event-a',
      memberId: 'member-a',
      displayName: '伊藤 大輝',
      role: 'マークボート',
      assignment: '1マーク',
      savedAt: '2026-07-18T00:00:00Z',
    })
    const exported = JSON.parse(await exportLocalEventData('event-a'))
    expect(exported.format).toBe('srs-local-backup')
    expect(exported.profile.assignment).toBe('1マーク')
    expect(JSON.stringify(exported)).not.toContain('password')
  })
})
