import { describe, expect, it } from 'vitest'
import {
  canClearRaceSignal,
  clearActionFor,
  isRaceSignalHeld,
  isTerminalRaceSignal,
  makeRaceSignalEvent,
  nextWarningAfterFlagRemoval,
  signalDefinition,
  signalFlagDescription,
} from '../src/signals'

describe('race signal rules', () => {
  it('uses the official sound patterns for race-control signals', () => {
    expect(signalDefinition('postpone').soundCount).toBe(2)
    expect(signalDefinition('individual-recall').soundCount).toBe(1)
    expect(signalDefinition('general-recall').soundCount).toBe(2)
    expect(signalDefinition('shorten').soundCount).toBe(2)
    expect(signalDefinition('abandon').soundCount).toBe(3)
    expect(signalDefinition('course-change').sound).toContain('反復')
    expect(signalDefinition('mark-missing').sound).toContain('反復')
    expect(signalDefinition('search-rescue').soundCount).toBe(1)
  })

  it('schedules a warning one minute after AP, First Substitute or N removal', () => {
    expect(nextWarningAfterFlagRemoval('2026-07-18T00:00:00.000Z')).toBe('2026-07-18T00:01:00.000Z')
  })

  it('distinguishes restartable holds from terminal over-H and over-A signals', () => {
    const postponed = makeRaceSignalEvent('event-postpone', 'postpone', '2026-07-18T00:00:00.000Z')
    const noMoreToday = makeRaceSignalEvent('event-a', 'postpone-a', '2026-07-18T00:00:00.000Z')
    expect(isRaceSignalHeld(postponed)).toBe(true)
    expect(canClearRaceSignal(postponed)).toBe(true)
    expect(clearActionFor(postponed)).toBe('resume')
    expect(isTerminalRaceSignal(noMoreToday)).toBe(true)
    expect(canClearRaceSignal(noMoreToday)).toBe(false)
  })

  it('uses a dedicated clear action for general recall and abandonment', () => {
    const recall = makeRaceSignalEvent('event-recall', 'general-recall', '2026-07-18T00:00:00.000Z')
    const abandon = makeRaceSignalEvent('event-abandon', 'abandon', '2026-07-18T00:00:00.000Z')
    expect(clearActionFor(recall)).toBe('general-recall-clear')
    expect(clearActionFor(abandon)).toBe('abandon-clear')
  })

  it('keeps planned, visual and official sound execution times separate', () => {
    const signal = makeRaceSignalEvent('event-start', 'start', '2026-07-18T00:05:00.120Z', {
      scheduledAt: '2026-07-18T00:05:00.000Z',
      visualExecutedAt: '2026-07-18T00:05:00.120Z',
      soundExecutedAt: '2026-07-18T00:05:00.180Z',
      soundStatus: 'played',
      officialAudioDeviceId: 'device-signal-boat',
    })
    expect(signal.scheduledAt).toBe('2026-07-18T00:05:00.000Z')
    expect(signal.visualExecutedAt).toBe('2026-07-18T00:05:00.120Z')
    expect(signal.soundExecutedAt).toBe('2026-07-18T00:05:00.180Z')
    expect(signal.soundStatus).toBe('played')
    expect(signal.officialAudioDeviceId).toBe('device-signal-boat')
  })

  it('describes RRS 33 course-change displays without losing direction or distance', () => {
    expect(signalFlagDescription('course-change', {
      newBearing: 15,
      directionChange: 'starboard',
      lengthChange: 'increase',
    })).toBe('C旗 掲揚・新方位 015°・緑三角・右へ変更・距離 +')
    expect(signalFlagDescription('mark-missing', { targetMarkLabel: '1マーク' })).toBe('M旗 掲揚・1マークを代替')
    expect(signalFlagDescription('search-rescue', { communicationChannel: 'VHF 72' })).toBe('V旗 掲揚・VHF 72を聴取')
  })
})
