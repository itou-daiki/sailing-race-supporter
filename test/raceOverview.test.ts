import { describe, expect, it } from 'vitest'
import type { RaceDefinition } from '../src/domain'
import { raceTabOverview } from '../src/raceOverview'

const race: RaceDefinition = {
  id: 'race-2', number: '2R', className: '470', courseCode: 'O2', status: 'setup',
  warningAt: '2026-07-18T01:00:00.000Z', targetMinutes: 50, marks: [],
}

describe('race tab overview', () => {
  it('shows a synchronized start countdown as the race approaches', () => {
    expect(raceTabOverview(race, Date.parse('2026-07-18T00:55:30.000Z'))).toMatchObject({
      shortLabel: '−09:30', tone: 'scheduled', needsAttention: true,
    })
  })

  it('keeps held and racing races visible after another race is selected', () => {
    expect(raceTabOverview({
      ...race,
      latestSignal: {
        id: 'signal-ap', action: 'postpone', label: '延期', flag: 'AP旗 掲揚', sound: '短音2回',
        soundCount: 2, executedAt: race.warningAt, visualExecutedAt: race.warningAt, soundStatus: 'played',
      },
    }, Date.parse(race.warningAt))).toMatchObject({ shortLabel: 'HOLD', tone: 'held', needsAttention: true })
    expect(raceTabOverview({ ...race, status: 'racing' }, Date.parse(race.warningAt))).toMatchObject({
      shortLabel: '競技中', tone: 'live', needsAttention: true,
    })
  })

  it('distinguishes finalized races from invalid schedules', () => {
    expect(raceTabOverview({ ...race, status: 'finalized' }, Date.parse(race.warningAt))).toMatchObject({
      shortLabel: '確定', tone: 'complete', needsAttention: false,
    })
    expect(raceTabOverview({ ...race, warningAt: 'invalid' }, Date.parse(race.warningAt)).shortLabel).toBe('時刻未定')
  })
})
