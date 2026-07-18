import { describe, expect, it } from 'vitest'
import {
  isEncryptedBackupArchiveEnvelope,
  MAX_BACKUP_ARCHIVE_BYTES,
  MAX_BACKUP_ARCHIVE_BYTES_PER_EVENT,
  MAX_BACKUP_ARCHIVES_PER_EVENT,
  type EncryptedBackupArchiveEnvelope,
} from '../shared/backupArchive'

function validEnvelope(): EncryptedBackupArchiveEnvelope {
  return {
    format: 'srs-encrypted-backup',
    version: 1,
    createdAt: '2026-07-18T00:00:00.000Z',
    createdBy: 'Sailing Race Supporter / Created by Dit-Lab.（Daiki ITO）',
    event: { id: 'event-a', slug: 'event-a', name: '試験大会' },
    encryption: {
      algorithm: 'AES-GCM-256',
      kdf: 'PBKDF2-SHA-256',
      iterations: 250_000,
      salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
      iv: 'AAAAAAAAAAAAAAAA',
    },
    plaintextHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ciphertext: 'ZW5jcnlwdGVkLWJhY2t1cA==',
  }
}

describe('R2 encrypted backup archive envelope', () => {
  it('accepts the client-side AES-GCM backup format', () => {
    expect(isEncryptedBackupArchiveEnvelope(validEnvelope())).toBe(true)
  })

  it('rejects weakened KDF settings and malformed ciphertext', () => {
    expect(isEncryptedBackupArchiveEnvelope({
      ...validEnvelope(),
      encryption: { ...validEnvelope().encryption, iterations: 10_000 },
    })).toBe(false)
    expect(isEncryptedBackupArchiveEnvelope({ ...validEnvelope(), ciphertext: 'not base64!' })).toBe(false)
  })

  it('fixes the free-tier storage guardrails at 20 generations and 500 MiB per event', () => {
    expect(MAX_BACKUP_ARCHIVES_PER_EVENT).toBe(20)
    expect(MAX_BACKUP_ARCHIVE_BYTES).toBe(25 * 1_024 * 1_024)
    expect(MAX_BACKUP_ARCHIVE_BYTES_PER_EVENT).toBe(500 * 1_024 * 1_024)
  })
})
