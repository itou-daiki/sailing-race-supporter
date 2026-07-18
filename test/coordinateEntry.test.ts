import { describe, expect, it } from 'vitest'
import {
  decimalMinuteTailParts,
  decimalTailParts,
  positionFromDecimalMinuteTails,
  positionFromDecimalTails,
  positionFromFullDecimal,
} from '../src/coordinateEntry'

describe('handheld GPS coordinate entry', () => {
  it('replaces only the final four decimal digits using the current mark as a safe prefix', () => {
    expect(decimalTailParts(35.2948)).toEqual({ prefix: '35.29', tail: '4800' })
    expect(decimalTailParts(139.4661)).toEqual({ prefix: '139.46', tail: '6100' })
    expect(positionFromDecimalTails([139.4661, 35.2948], '4825', '6138')).toEqual([139.466138, 35.294825])
  })

  it('keeps the hemisphere sign when replacing a coordinate tail', () => {
    expect(positionFromDecimalTails([-123.456789, -34.567891], '7901', '6801')).toEqual([-123.456801, -34.567901])
  })

  it('supports the degree and decimal-minute format commonly shown by handheld GPS units', () => {
    expect(decimalMinuteTailParts(35.29455, 'latitude')).toEqual({
      hemisphere: 'N', prefix: 'N 35°17.', tail: '6730',
    })
    expect(decimalMinuteTailParts(139.46638, 'longitude')).toEqual({
      hemisphere: 'E', prefix: 'E 139°27.', tail: '9828',
    })
    const position = positionFromDecimalMinuteTails([139.46638, 35.29455], '6735', '9835')
    expect(position[0]).toBeCloseTo(139.466391667, 9)
    expect(position[1]).toBeCloseTo(35.294558333, 9)
  })

  it('keeps southern and western hemispheres in degree-minute mode', () => {
    expect(decimalMinuteTailParts(-34.567901, 'latitude')).toEqual({
      hemisphere: 'S', prefix: 'S 34°34.', tail: '0741',
    })
    expect(decimalMinuteTailParts(-123.456801, 'longitude')).toEqual({
      hemisphere: 'W', prefix: 'W 123°27.', tail: '4081',
    })
    const position = positionFromDecimalMinuteTails([-123.456801, -34.567901], '0741', '4081')
    expect(position[0]).toBeCloseTo(-123.456801667, 9)
    expect(position[1]).toBeCloseTo(-34.567901667, 9)
  })

  it('accepts full decimal degrees and rejects malformed handheld readings', () => {
    expect(positionFromFullDecimal('35.294825', '139.466138')).toEqual([139.466138, 35.294825])
    expect(() => positionFromDecimalTails([139.4661, 35.2948], '48A5', '6138')).toThrow('半角数字')
    expect(() => positionFromDecimalMinuteTails([139.4661, 35.2948], '48A5', '6138')).toThrow('半角数字')
    expect(() => positionFromFullDecimal('', '')).toThrow('10進度')
    expect(() => positionFromFullDecimal('北緯35度', '139.466')).toThrow('10進度')
  })
})
