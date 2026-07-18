import { describe, expect, it } from 'vitest'
import {
  formatOwnerRecoveryCode,
  generateOwnerRecoveryCode,
  isOwnerRecoveryCode,
  normalizeOwnerRecoveryCode,
} from '../shared/ownerRecovery'

describe('owner recovery code', () => {
  it('generates a readable code with enough random symbols', () => {
    const code = generateOwnerRecoveryCode()
    expect(code).toMatch(/^SRSO(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}){8}$/u)
    expect(isOwnerRecoveryCode(code)).toBe(true)
  })

  it('accepts case and separator differences without changing the secret', () => {
    const compact = 'SRSO23456789ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    expect(normalizeOwnerRecoveryCode(formatOwnerRecoveryCode(compact).toLowerCase())).toBe(compact)
  })

  it('rejects ambiguous or short manual codes', () => {
    expect(isOwnerRecoveryCode('SRSO-OOOOO-IIIII-11111')).toBe(false)
    expect(isOwnerRecoveryCode('SRSO-23456')).toBe(false)
  })
})
