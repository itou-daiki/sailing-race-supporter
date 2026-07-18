import { describe, expect, it } from 'vitest'
import { createMemberRecoveryQrPayload, parseMemberRecoveryQrPayload } from '../src/memberRecoveryCard'

describe('member recovery QR card', () => {
  it('round-trips the event, member and one-time secret without adding position data', () => {
    const encoded = createMemberRecoveryQrPayload('enoshima-2026', 'member-1', 'abcdefghijklmnopqrstuvwxyz123456')
    expect(parseMemberRecoveryQrPayload(encoded)).toEqual({
      format: 'srs-member-recovery',
      version: 1,
      eventSlug: 'enoshima-2026',
      memberId: 'member-1',
      secret: 'abcdefghijklmnopqrstuvwxyz123456',
    })
    expect(encoded).not.toContain('latitude')
    expect(encoded).not.toContain('longitude')
  })

  it('rejects unrelated, unsupported, and weakened QR payloads', () => {
    expect(() => parseMemberRecoveryQrPayload('https://example.com')).toThrow('参加復元QRではありません')
    expect(() => parseMemberRecoveryQrPayload(JSON.stringify({ format: 'srs-member-recovery', version: 2 }))).toThrow('対応していない')
    expect(() => parseMemberRecoveryQrPayload(JSON.stringify({
      format: 'srs-member-recovery', version: 1, eventSlug: 'event', memberId: 'member', secret: 'short',
    }))).toThrow('短すぎます')
  })
})
