import { describe, expect, it } from 'vitest'
import type { OwnerRecoveryKit } from '../src/authClient'
import { decryptOwnerRecoveryKit, encryptOwnerRecoveryKit, ownerRecoveryQrPayload } from '../src/ownerRecovery'

const kit: OwnerRecoveryKit = {
  recoveryId: 'recovery-1',
  eventId: 'event-1',
  eventSlug: 'summer-regatta-1',
  eventName: 'サマーレガッタ',
  ownerUserId: 'owner-1',
  issuedAt: '2026-07-18T00:00:00.000Z',
  recoveryCode: 'SRSO-23456-789AB-CDEFG-HJKLM-NPQRS-TUVWX-YZ234-56789',
}

describe('encrypted owner recovery kit', () => {
  it('round-trips without exposing the one-time code in the envelope', async () => {
    const encrypted = await encryptOwnerRecoveryKit(kit, 'long recovery passphrase')
    expect(JSON.stringify(encrypted)).not.toContain(kit.recoveryCode)
    expect(await decryptOwnerRecoveryKit(encrypted, 'long recovery passphrase')).toEqual(kit)
  })

  it('rejects a wrong passphrase and makes an offline QR payload', async () => {
    const encrypted = await encryptOwnerRecoveryKit(kit, 'long recovery passphrase')
    await expect(decryptOwnerRecoveryKit(encrypted, 'different passphrase')).rejects.toThrow('復号できません')
    expect(JSON.parse(ownerRecoveryQrPayload(kit))).toEqual({
      format: 'srs-owner-recovery-qr', event: kit.eventSlug, code: kit.recoveryCode,
    })
  })

  it('rejects manipulated KDF settings and malformed ciphertext before decryption', async () => {
    const encrypted = await encryptOwnerRecoveryKit(kit, 'long recovery passphrase')
    await expect(decryptOwnerRecoveryKit({
      ...encrypted,
      encryption: { ...encrypted.encryption, iterations: 1_000_000_000 },
    }, 'long recovery passphrase')).rejects.toThrow('暗号化設定')
    await expect(decryptOwnerRecoveryKit({
      ...encrypted,
      ciphertext: '*not-base64url*',
    }, 'long recovery passphrase')).rejects.toThrow('復号できません')
  })
})
