import type { CoursePresetCode } from '../shared/coursePresets'
import type { LngLat, SailingClass } from './domain'
import { isValidCustomFinishDistanceMetres } from '../shared/finishDistance'

export interface SharedCoursePayload {
  version: 1
  className: SailingClass
  courseCode: CoursePresetCode
  signalBoatPosition: LngLat
  windDirection: number
  windSpeed: number
  lowerGate: boolean
  finishLineMode: 'separate' | 'shared-rc'
  finishDistanceMetres?: number
  targetLengthMetres: number
  targetMinutes: number
  distanceBasis: 'target-time' | 'wind-standard'
  marks: Record<string, LngLat>
}

const SAILING_CLASSES = new Set<SailingClass>(['OP', 'ILCA 4', 'ILCA 6', 'ILCA 7', '420', '470', 'スナイプ'])
const COURSE_CODES = new Set<CoursePresetCode>(['O2', 'I2', 'L2', 'L3', 'W2', 'T2', 'トライアングル'])

function validPosition(value: unknown): value is LngLat {
  return Array.isArray(value)
    && value.length === 2
    && value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
    && value[0] >= -180
    && value[0] <= 180
    && value[1] >= -85
    && value[1] <= 85
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
}

export function encodeSharedCourse(payload: SharedCoursePayload): string {
  return encodeBase64Url(JSON.stringify(payload))
}

export function decodeSharedCourse(encoded: string): SharedCoursePayload | undefined {
  try {
    const value = JSON.parse(decodeBase64Url(encoded)) as Partial<SharedCoursePayload>
    if (
      value.version !== 1
      || !value.className || !SAILING_CLASSES.has(value.className)
      || !value.courseCode || !COURSE_CODES.has(value.courseCode)
      || !validPosition(value.signalBoatPosition)
      || typeof value.windDirection !== 'number' || value.windDirection < 0 || value.windDirection >= 360
      || typeof value.windSpeed !== 'number' || value.windSpeed <= 0 || value.windSpeed > 80
      || typeof value.lowerGate !== 'boolean'
      || (value.finishLineMode !== 'separate' && value.finishLineMode !== 'shared-rc')
      || (value.finishDistanceMetres !== undefined && !isValidCustomFinishDistanceMetres(value.finishDistanceMetres))
      || typeof value.targetLengthMetres !== 'number' || value.targetLengthMetres < 500 || value.targetLengthMetres > 100_000
      || typeof value.targetMinutes !== 'number' || value.targetMinutes < 15 || value.targetMinutes > 180
      || (value.distanceBasis !== 'target-time' && value.distanceBasis !== 'wind-standard')
      || !value.marks || typeof value.marks !== 'object'
      || !Object.values(value.marks).every(validPosition)
    ) return undefined
    return value as SharedCoursePayload
  } catch {
    return undefined
  }
}

export function sharedCourseFromHash(hash: string): SharedCoursePayload | undefined {
  const encoded = new URLSearchParams(hash.replace(/^#/u, '')).get('course')
  return encoded ? decodeSharedCourse(encoded) : undefined
}

export function buildSharedCourseUrl(baseUrl: string, payload: SharedCoursePayload): string {
  const url = new URL(baseUrl)
  url.hash = new URLSearchParams({ course: encodeSharedCourse(payload) }).toString()
  return url.toString()
}
