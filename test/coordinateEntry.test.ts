import { describe, expect, it } from 'vitest'
import { decimalTailParts, positionFromDecimalTails, positionFromFullDecimal } from '../src/coordinateEntry'

describe('handheld GPS coordinate entry', () => {
  it('replaces only the final four decimal digits using the current mark as a safe prefix', () => {
    expect(decimalTailParts(35.2948)).toEqual({ prefix: '35.29', tail: '4800' })
    expect(decimalTailParts(139.4661)).toEqual({ prefix: '139.46', tail: '6100' })
    expect(positionFromDecimalTails([139.4661, 35.2948], '4825', '6138')).toEqual([139.466138, 35.294825])
  })

  it('keeps the hemisphere sign when replacing a coordinate tail', () => {
    expect(positionFromDecimalTails([-123.456789, -34.567891], '7901', '6801')).toEqual([-123.456801, -34.567901])
  })

  it('accepts full decimal degrees and rejects malformed handheld readings', () => {
    expect(positionFromFullDecimal('35.294825', '139.466138')).toEqual([139.466138, 35.294825])
    expect(() => positionFromDecimalTails([139.4661, 35.2948], '48A5', '6138')).toThrow('半角数字')
    expect(() => positionFromFullDecimal('', '')).toThrow('10進度')
    expect(() => positionFromFullDecimal('北緯35度', '139.466')).toThrow('10進度')
  })
})
