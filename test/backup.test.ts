import { describe, expect, it } from 'vitest'
import {
  backupDataHash,
  decryptBackup,
  encryptBackup,
  verifyServerBackup,
  type BackupPayload,
  type ServerBackup,
} from '../src/backup'
import { backupSignaturePayload } from '../shared/backupSignature'

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

function base64Url(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64url')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)))
  return base64Url(await crypto.subtle.digest('SHA-256', bytes))
}

async function signServerBackup(backup: ServerBackup, keyId: string, privateKey: CryptoKey): Promise<void> {
  backup.manifest.signature = {
    algorithm: 'Ed25519',
    keyId,
    value: base64Url(await crypto.subtle.sign('Ed25519', privateKey, backupSignaturePayload(backup))),
  }
}

async function validServerBackup(): Promise<{
  backup: ServerBackup
  publicKeys: Record<string, string>
  privateKey: CryptoKey
  keyId: string
}> {
  const data = {
    regattas: [{ id: 'event-a', slug: 'event-a', name: '試験大会' }],
    races: [{ id: 'race-a', race_number: '1R' }],
    auditEvents: [],
  }
  const backup: ServerBackup = {
    format: 'srs-server-backup',
    schemaVersion: 2,
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
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const keyId = 'test-ed25519-key'
  await signServerBackup(backup, keyId, keyPair.privateKey)
  return {
    backup,
    publicKeys: { [keyId]: base64Url(await crypto.subtle.exportKey('raw', keyPair.publicKey)) },
    privateKey: keyPair.privateKey,
    keyId,
  }
}

describe('server backup verification', () => {
  it('verifies the data hash, counts, event identity, and empty audit root', async () => {
    const { backup, publicKeys } = await validServerBackup()
    const report = await verifyServerBackup(backup, publicKeys)

    expect(report.valid).toBe(true)
    expect(report.totalRecords).toBe(2)
    expect(report.checks).toEqual({
      eventIdentity: true,
      dataHash: true,
      sectionCounts: true,
      auditChain: true,
      auditRoot: true,
      serverSignature: true,
    })
  })

  it('verifies system-authored retention events with a null actor in the audit chain', async () => {
    const { backup, publicKeys, privateKey, keyId } = await validServerBackup()
    const audit = {
      id: 'audit-retention-1',
      regatta_id: 'event-a',
      race_id: null,
      sequence: 1,
      actor_user_id: null,
      actor_member_id: null,
      action: 'retention.run.completed',
      entity_type: 'retention_run',
      entity_id: 'retention-run-1',
      before_hash: null,
      after_hash: await hash({ status: 'completed', counts: { cloudBackups: 1 } }),
      reason: '保存期間処理を完了しました',
      client_time: null,
      server_time: '2026-07-18T10:00:01.000Z',
      previous_event_hash: null,
      event_hash: '',
    }
    audit.event_hash = await hash({
      id: audit.id,
      regattaId: audit.regatta_id,
      raceId: null,
      sequence: audit.sequence,
      actorUserId: null,
      action: audit.action,
      entityType: audit.entity_type,
      entityId: audit.entity_id,
      beforeHash: null,
      afterHash: audit.after_hash,
      reason: audit.reason,
      clientTime: null,
      serverTime: audit.server_time,
      previousHash: null,
    })
    backup.data.auditEvents = [audit]
    backup.manifest.counts.auditEvents = 1
    backup.manifest.eventSequence = 1
    backup.manifest.eventHashRoot = audit.event_hash
    backup.manifest.dataHash = await backupDataHash(backup.data)
    await signServerBackup(backup, keyId, privateKey)

    const report = await verifyServerBackup(backup, publicKeys)

    expect(report.valid).toBe(true)
    expect(report.auditEventCount).toBe(1)
    expect(report.auditSequence).toBe(1)
    expect(report.checks.auditChain).toBe(true)
    expect(report.checks.auditRoot).toBe(true)
  })

  it('rejects data changed after the manifest hash was created', async () => {
    const { backup, publicKeys } = await validServerBackup()
    backup.data.races[0] = { id: 'race-a', race_number: '改竄' }

    const report = await verifyServerBackup(backup, publicKeys)
    expect(report.valid).toBe(false)
    expect(report.checks.dataHash).toBe(false)
    expect(report.issues).toContain('大会データ全体のSHA-256が一致しません')
  })

  it('rejects a manifest count mismatch independently of the data hash', async () => {
    const { backup, publicKeys } = await validServerBackup()
    backup.manifest.counts.races = 2

    const report = await verifyServerBackup(backup, publicKeys)
    expect(report.checks.dataHash).toBe(true)
    expect(report.checks.sectionCounts).toBe(false)
    expect(report.checks.serverSignature).toBe(false)
  })

  it('rejects an unknown signing key before restore', async () => {
    const { backup } = await validServerBackup()
    const report = await verifyServerBackup(backup, {})

    expect(report.valid).toBe(false)
    expect(report.checks.serverSignature).toBe(false)
    expect(report.issues).toContain('Ed25519サーバー署名が不正か、信頼済み公開鍵を確認できません')
  })

  it('keeps unsigned version 1 backups diagnostic-only', async () => {
    const { backup } = await validServerBackup()
    backup.schemaVersion = 1
    delete backup.manifest.signature

    const report = await verifyServerBackup(backup)
    expect(report.valid).toBe(false)
    expect(report.checks.serverSignature).toBe(false)
    expect(report.issues).toContain('旧形式にはサーバー署名がないため、大会へ復元できません')
  })
})
