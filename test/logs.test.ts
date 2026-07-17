import { describe, expect, it } from 'vitest'
import { eventLogsToCsv, type EventLogEntry } from '../worker/logs'

describe('event log CSV export', () => {
  it('includes the immutable hash and protects spreadsheet formula cells', () => {
    const entry: EventLogEntry = {
      id: 'log-1',
      raceId: 'race-1',
      raceNumber: '1R',
      sequence: 12,
      occurredAt: '2026-07-18T00:00:00.000Z',
      category: 'message',
      title: '=HYPERLINK("https://invalid.example")',
      actor: '+operator',
      detail: '運営連絡',
      eventHash: 'hash-value',
    }

    const csv = eventLogsToCsv([entry])
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('"\'=HYPERLINK(""https://invalid.example"")"')
    expect(csv).toContain('"\'+operator"')
    expect(csv).toContain('"hash-value"')
  })
})
