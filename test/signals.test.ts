import { describe, expect, it } from 'vitest'
import {
  canClearRaceSignal,
  clearActionFor,
  isRaceSignalHeld,
  isTerminalRaceSignal,
  makeRaceSignalEvent,
  nextWarningAfterFlagRemoval,
  signalDefinition,
} from '../src/signals'

describe('race signal rules', () => {
  it('uses the official sound patterns for race-control signals', () => {
    expect(signalDefinition('postpone').soundCount).toBe(2)
    expect(signalDefinition('individual-recall').soundCount).toBe(1)
    expect(signalDefinition('general-recall').soundCount).toBe(2)
    expect(signalDefinition('shorten').soundCount).toBe(2)
    expect(signalDefinition('abandon').soundCount).toBe(3)
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
})
