import { describe, expect, it } from 'vitest'
import { buildSharedCourseUrl, decodeSharedCourse, encodeSharedCourse, sharedCourseFromHash, type SharedCoursePayload } from '../src/courseShare'

const payload: SharedCoursePayload = {
  version: 1,
  className: '470',
  courseCode: 'O2',
  signalBoatPosition: [131.5221959, 33.2786648],
  windDirection: 350,
  windSpeed: 8.5,
  lowerGate: true,
  finishLineMode: 'shared-rc',
  targetLengthMetres: 5_400,
  targetMinutes: 50,
  distanceBasis: 'target-time',
  marks: {
    RC: [131.5221959, 33.2786648],
    '3P': [131.516, 33.275],
    F: [131.5221, 33.2782],
  },
}

describe('course-only sharing', () => {
  it('round-trips all configured mark coordinates without an event record', () => {
    expect(decodeSharedCourse(encodeSharedCourse(payload))).toEqual(payload)
  })

  it('loads the course from a share URL fragment', () => {
    const url = buildSharedCourseUrl('https://sailing-race-supporter.dit-lab.workers.dev/', payload)
    expect(sharedCourseFromHash(new URL(url).hash)).toEqual(payload)
  })

  it('round-trips an optional custom finish distance while accepting old links without it', () => {
    const custom = { ...payload, finishLineMode: 'separate' as const, finishDistanceMetres: 0.25 * 1_852 }
    expect(decodeSharedCourse(encodeSharedCourse(custom))).toEqual(custom)
    expect(decodeSharedCourse(encodeSharedCourse(payload))).toEqual(payload)
  })

  it('rejects malformed or out-of-range shared data', () => {
    expect(decodeSharedCourse('not-base64')).toBeUndefined()
    expect(decodeSharedCourse(encodeSharedCourse({ ...payload, windDirection: 400 }))).toBeUndefined()
    expect(decodeSharedCourse(encodeSharedCourse({ ...payload, finishDistanceMetres: 20 }))).toBeUndefined()
  })
})
