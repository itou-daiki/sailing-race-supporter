import { describe, expect, it } from 'vitest'
import { normalizeBoatMotion } from '../src/boatMotion'

describe('operating boat motion display', () => {
  it('clears stale SOG and COG when the browser cannot measure movement', () => {
    expect(normalizeBoatMotion({ speedKnots: null, courseDegrees: null })).toEqual({
      speedKnots: 0,
      courseDegrees: undefined,
      accuracyMetres: undefined,
    })
  })

  it('suppresses unstable low-speed COG but keeps a valid moving course', () => {
    expect(normalizeBoatMotion({ speedKnots: 0.8, courseDegrees: 270 }).courseDegrees).toBeUndefined()
    expect(normalizeBoatMotion({ speedKnots: 4.2, courseDegrees: 370, accuracyMetres: 3.4 })).toEqual({
      speedKnots: 4.2,
      courseDegrees: 10,
      accuracyMetres: 3.4,
    })
  })
})
