import { describe, expect, it } from 'vitest'
import type { EventLogResponse } from '../src/logClient'
import { buildPrintableEventLogHtml } from '../src/logReport'

const report: EventLogResponse = {
  format: 'srs-event-log',
  schemaVersion: 1,
  createdAt: '2026-07-18T02:03:04.000Z',
  createdBy: 'Sailing Race Supporter / Created by Dit-Lab.（Daiki ITO）',
  event: { id: 'event-1', slug: 'summer-regatta', name: '夏季大会' },
  raceId: 'race-1',
  entries: [
    {
      id: 'audit-1',
      raceId: 'race-1',
      raceNumber: '1R',
      sequence: 42,
      occurredAt: '2026-07-18T01:02:03.000Z',
      category: 'audit',
      title: 'race.finalized',
      actor: '大会管理者',
      detail: '1Rを確定',
      eventHash: 'hash-value-for-verification',
    },
    {
      id: 'message-1',
      raceId: 'race-1',
      raceNumber: '1R',
      sequence: null,
      occurredAt: '2026-07-18T01:01:00.000Z',
      category: 'message',
      title: '<img src=x onerror="alert(1)">',
      actor: '1マーク',
      detail: 'マーク設置完了',
      eventHash: null,
    },
  ],
}

describe('printable event log report', () => {
  it('includes the required brand, selected race, export metadata, and audit hash', () => {
    const html = buildPrintableEventLogHtml(report, {
      eventSlug: 'summer-regatta',
      eventName: 'fallback name',
      raceId: 'race-1',
      raceLabel: '1R',
    })

    expect(html).toContain('Sailing Race Supporter')
    expect(html).toContain('Created by Dit-Lab.（Daiki ITO）')
    expect(html).toContain('夏季大会 ／ 1R')
    expect(html).toContain('srs-event-log v1')
    expect(html).toContain('2件（最大2,500件）')
    expect(html).toContain('hash-value-for-verification')
    expect(html).toContain('PDFとして保存・印刷')
    expect(html).toContain('@page { size: A4 portrait;')
  })

  it('escapes log values before placing them in the standalone print document', () => {
    const html = buildPrintableEventLogHtml(report, {
      eventSlug: 'summer-regatta',
      eventName: '夏季大会',
      raceId: 'race-1',
      raceLabel: '1R',
    })

    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })
})
