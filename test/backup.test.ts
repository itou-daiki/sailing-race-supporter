import { describe, expect, it } from 'vitest'
import { decryptBackup, encryptBackup, type BackupPayload } from '../src/backup'

const payload: BackupPayload = {
  server: {
    format: 'srs-server-backup',
    schemaVersion: 1,
    createdAt: '2026-07-18T00:00:00.000Z',
    createdBy: 'Sailing Race Supporter / Created by Dit-Lab.（Daiki ITO）',
    scope: 'records',
    event: { id: 'event-a', slug: 'event-a', name: '試験大会' },
    manifest: { dataHash: 'hash', eventSequence: 3, eventHashRoot: 'root', counts: { races: 2 } },
    data: { races: [{ id: 'race-a', race_number: '1R' }] },
  },
  local: { outbox: [] },
}

describe('encrypted backup', () => {
  it('round-trips through PBKDF2 and AES-GCM', async () => {
    const encrypted = await encryptBackup(payload, 'long-test-passphrase')
    expect(encrypted.ciphertext).not.toContain('試験大会')
    expect(encrypted.encryption.algorithm).toBe('AES-GCM-256')
    expect(await decryptBackup(encrypted, 'long-test-passphrase')).toEqual(payload)
  })

  it('rejects a wrong passphrase', async () => {
    const encrypted = await encryptBackup(payload, 'long-test-passphrase')
    await expect(decryptBackup(encrypted, 'different-passphrase')).rejects.toThrow('パスフレーズ')
  })
})
