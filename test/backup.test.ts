import { describe, expect, it } from 'vitest'
import {
  backupDataHash,
  decryptBackup,
  encryptBackup,
  verifyServerBackup,
  type BackupPayload,
  type ServerBackup,
} from '../src/backup'

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

async function validServerBackup(): Promise<ServerBackup> {
  const data = {
    regattas: [{ id: 'event-a', slug: 'event-a', name: '試験大会' }],
    races: [{ id: 'race-a', race_number: '1R' }],
    auditEvents: [],
  }
  return {
    format: 'srs-server-backup',
    schemaVersion: 1,
    createdAt: '2026-07-18T00:00:00.000Z',
    createdBy: 'Sailing Race Supporter / Created by Dit-Lab.（Daiki ITO）',
    scope: 'records',
    event: { id: 'event-a', slug: 'event-a', name: '試験大会' },
    manifest: {
      dataHash: await backupDataHash(data),
      eventSequence: 0,
      eventHashRoot: null,
      counts: { regattas: 1, races: 1, auditEvents: 0 },
    },
    data,
  }
}

describe('server backup verification', () => {
  it('verifies the data hash, counts, event identity, and empty audit root', async () => {
    const backup = await validServerBackup()
    const report = await verifyServerBackup(backup)

    expect(report.valid).toBe(true)
    expect(report.totalRecords).toBe(2)
    expect(report.checks).toEqual({
      eventIdentity: true,
      dataHash: true,
      sectionCounts: true,
      auditChain: true,
      auditRoot: true,
    })
  })

  it('rejects data changed after the manifest hash was created', async () => {
    const backup = await validServerBackup()
    backup.data.races[0] = { id: 'race-a', race_number: '改竄' }

    const report = await verifyServerBackup(backup)
    expect(report.valid).toBe(false)
    expect(report.checks.dataHash).toBe(false)
    expect(report.issues).toContain('大会データ全体のSHA-256が一致しません')
  })

  it('rejects a manifest count mismatch independently of the data hash', async () => {
    const backup = await validServerBackup()
    backup.manifest.counts.races = 2

    const report = await verifyServerBackup(backup)
    expect(report.checks.dataHash).toBe(true)
    expect(report.checks.sectionCounts).toBe(false)
  })
})
