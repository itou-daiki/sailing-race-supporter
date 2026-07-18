import { describe, expect, it } from 'vitest'
import { formatTrueBearing } from '../shared/trueBearing'

describe('true bearing display', () => {
  it('always appends the true-bearing designator', () => {
    expect(formatTrueBearing(350)).toBe('350°T')
    expect(formatTrueBearing(15, { padInteger: 3 })).toBe('015°T')
    expect(formatTrueBearing(185.4, { decimals: 1 })).toBe('185.4°T')
  })

  it('normalizes values at north and safely handles unavailable readings', () => {
    expect(formatTrueBearing(360, { padInteger: 3 })).toBe('000°T')
    expect(formatTrueBearing(-1)).toBe('359°T')
    expect(formatTrueBearing(Number.NaN)).toBe('—')
  })
})
