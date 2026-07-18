import { verifyBackupSignature, type BackupSignature } from '../shared/backupSignature'

export interface ServerBackup {
  format: 'srs-server-backup'
  schemaVersion: 1 | 2
  createdAt: string
  createdBy: string
  scope: 'records'
  event: { id: string; slug: string; name: string }
  manifest: {
    dataHash: string
    eventSequence: number
    eventHashRoot: string | null
    counts: Record<string, number>
    signature?: BackupSignature
  }
  data: Record<string, unknown[]>
}

export interface EncryptedBackup {
  format: 'srs-encrypted-backup'
  version: 1
  createdAt: string
  createdBy: string
  event: { id: string; slug: string; name: string }
  encryption: {
    algorithm: 'AES-GCM-256'
    kdf: 'PBKDF2-SHA-256'
    iterations: number
    salt: string
    iv: string
  }
  plaintextHash: string
  ciphertext: string
}

export interface BackupPayload {
  server: ServerBackup
  local?: unknown
}

export interface BackupRestorePreviewItem {
  raceId: string
  raceNumber: string
  status: string
  action: 'restore' | 'skip-finalized' | 'skip-unchanged' | 'skip-no-source'
  sourceRevisionId: string | null
  sourceRevision: number | null
  sourceCourseCode: string | null
  sourceNodeCount: number
  currentRevision: number
  currentCourseCode: string | null
  createdRevision: number | null
  differences: string[]
}

export interface BackupRestorePreview {
  generatedAt: string
  stateHash: string
  backupHash: string
  backupCreatedAt: string
  backupSequence: number
  items: BackupRestorePreviewItem[]
  restorableCount: number
  finalizedSkippedCount: number
  unchangedSkippedCount: number
  noSourceCount: number
}

export interface BackupRestoreReport {
  format: 'srs-restore-report'
  schemaVersion: 1
  createdAt: string
  createdBy: string
  event: ServerBackup['event']
  restoreId: string
  reason: string
  source: {
    backupCreatedAt: string
    dataHash: string
    eventSequence: number
    signatureKeyId: string | null
  }
  result: {
    restored: Array<{ raceId: string; raceNumber: string; sourceRevision: number; revision: number; differences: string[] }>
    finalizedSkipped: string[]
    unchangedSkipped: string[]
    noSourceSkipped: string[]
  }
  audit: { sequence: number; eventHash: string }
}

export interface BackupVerificationReport {
  valid: boolean
  event: ServerBackup['event']
  createdAt: string
  schemaVersion: number
  totalRecords: number
  sectionCount: number
  auditEventCount: number
  auditSequence: number
  checks: {
    eventIdentity: boolean
    dataHash: boolean
    sectionCounts: boolean
    auditChain: boolean
    auditRoot: boolean
    serverSignature: boolean
  }
  issues: string[]
}

const PBKDF2_ITERATIONS = 250_000

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function digest(value: Uint8Array<ArrayBuffer>): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', value)))
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, entry]) => [entryKey, canonical(entry)]),
    )
  }
  return value
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

export async function backupDataHash(data: ServerBackup['data']): Promise<string> {
  return sha256Base64Url(JSON.stringify(canonical(data)))
}

function nullable(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function auditHash(row: Record<string, unknown>): Promise<string> {
  return sha256Base64Url(JSON.stringify(canonical({
    id: String(row.id),
    regattaId: String(row.regatta_id),
    raceId: nullable(row.race_id),
    sequence: Number(row.sequence),
    actorUserId: nullable(row.actor_user_id),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    beforeHash: nullable(row.before_hash),
    afterHash: nullable(row.after_hash),
    reason: nullable(row.reason),
    clientTime: nullable(row.client_time),
    serverTime: String(row.server_time),
    previousHash: nullable(row.previous_event_hash),
  })))
}

export async function verifyServerBackup(
  backup: ServerBackup,
  trustedPublicKeys?: Readonly<Record<string, string>>,
): Promise<BackupVerificationReport> {
  const issues: string[] = []
  const sectionEntries = Object.entries(backup.data)
  const actualCounts = Object.fromEntries(sectionEntries.map(([name, values]) => [name, Array.isArray(values) ? values.length : -1]))
  const eventRow = Array.isArray(backup.data.regattas) && backup.data.regattas.length === 1
    ? backup.data.regattas[0] as Record<string, unknown>
    : undefined
  const eventIdentity = Boolean(
    eventRow && eventRow.id === backup.event.id && eventRow.slug === backup.event.slug && eventRow.name === backup.event.name,
  )
  if (!eventIdentity) issues.push('大会ID・固定URL・大会名がバックアップ本体と一致しません')

  const calculatedDataHash = await backupDataHash(backup.data)
  const dataHash = calculatedDataHash === backup.manifest.dataHash
  if (!dataHash) issues.push('大会データ全体のSHA-256が一致しません')

  const manifestSections = new Set(Object.keys(backup.manifest.counts))
  const dataSections = new Set(Object.keys(actualCounts))
  const sectionCounts = [...new Set([...manifestSections, ...dataSections])].every((name) => (
    manifestSections.has(name) && dataSections.has(name) && backup.manifest.counts[name] === actualCounts[name]
  ))
  if (!sectionCounts) issues.push('マニフェストのセクション件数と実データ件数が一致しません')

  const rawAuditRows = Array.isArray(backup.data.auditEvents) ? backup.data.auditEvents : []
  const auditRows = rawAuditRows.every(isRecord)
    ? rawAuditRows.slice().sort((left, right) => Number(left.sequence) - Number(right.sequence))
    : []
  const calculatedAuditHashes = await Promise.all(auditRows.map(auditHash))
  let auditChain = rawAuditRows.length === auditRows.length
  let previousHash: string | null = null
  let previousSequence = 0
  for (let index = 0; index < auditRows.length; index += 1) {
    const row = auditRows[index]
    const sequence = Number(row.sequence)
    if (
      !Number.isInteger(sequence) ||
      sequence !== previousSequence + 1 ||
      nullable(row.previous_event_hash) !== previousHash ||
      typeof row.event_hash !== 'string' ||
      calculatedAuditHashes[index] !== row.event_hash
    ) {
      auditChain = false
      break
    }
    previousSequence = sequence
    previousHash = String(row.event_hash)
  }
  if (!auditChain) issues.push('監査ログの連番・直前ハッシュ・自己ハッシュの連鎖が一致しません')
  const auditRoot = previousSequence === backup.manifest.eventSequence && previousHash === backup.manifest.eventHashRoot
  if (!auditRoot) issues.push('監査ログの最終連番またはハッシュルートがマニフェストと一致しません')
  const serverSignature = backup.schemaVersion === 2 && await verifyBackupSignature(backup, trustedPublicKeys)
  if (!serverSignature) issues.push(backup.schemaVersion === 1
    ? '旧形式にはサーバー署名がないため、大会へ復元できません'
    : 'Ed25519サーバー署名が不正か、信頼済み公開鍵を確認できません')

  return {
    valid: issues.length === 0,
    event: backup.event,
    createdAt: backup.createdAt,
    schemaVersion: backup.schemaVersion,
    totalRecords: Object.values(actualCounts).reduce((sum, count) => sum + Math.max(0, count), 0),
    sectionCount: sectionEntries.length,
    auditEventCount: auditRows.length,
    auditSequence: previousSequence,
    checks: { eventIdentity, dataHash, sectionCounts, auditChain, auditRoot, serverSignature },
    issues,
  }
}

async function key(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptBackup(payload: BackupPayload, passphrase: string): Promise<EncryptedBackup> {
  if (passphrase.length < 10) throw new Error('パスフレーズは10文字以上にしてください')
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encryptionKey = await key(passphrase, salt, PBKDF2_ITERATIONS)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, plaintext))
  return {
    format: 'srs-encrypted-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    createdBy: 'Sailing Race Supporter / Created by Dit-Lab.（Daiki ITO）',
    event: payload.server.event,
    encryption: {
      algorithm: 'AES-GCM-256',
      kdf: 'PBKDF2-SHA-256',
      iterations: PBKDF2_ITERATIONS,
      salt: base64(salt),
      iv: base64(iv),
    },
    plaintextHash: await digest(plaintext),
    ciphertext: base64(ciphertext),
  }
}

export async function decryptBackup(encrypted: EncryptedBackup, passphrase: string): Promise<BackupPayload> {
  if (
    !isRecord(encrypted) ||
    encrypted.format !== 'srs-encrypted-backup' ||
    encrypted.version !== 1 ||
    !isRecord(encrypted.event) ||
    !isRecord(encrypted.encryption) ||
    encrypted.encryption.algorithm !== 'AES-GCM-256' ||
    encrypted.encryption.kdf !== 'PBKDF2-SHA-256' ||
    typeof encrypted.encryption.iterations !== 'number' ||
    encrypted.encryption.iterations < 100_000 ||
    encrypted.encryption.iterations > 1_000_000 ||
    typeof encrypted.encryption.salt !== 'string' ||
    typeof encrypted.encryption.iv !== 'string' ||
    typeof encrypted.plaintextHash !== 'string' ||
    typeof encrypted.ciphertext !== 'string'
  ) throw new Error('対応していないバックアップ形式です')
  let plaintext: Uint8Array<ArrayBuffer>
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(encrypted.encryption.iv) },
      await key(passphrase, fromBase64(encrypted.encryption.salt), encrypted.encryption.iterations),
      fromBase64(encrypted.ciphertext),
    ))
  } catch {
    throw new Error('パスフレーズが違うか、バックアップが破損しています')
  }
  if (await digest(plaintext) !== encrypted.plaintextHash) throw new Error('復号後のハッシュが一致しません')
  let payload: BackupPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext)) as BackupPayload
  } catch {
    throw new Error('復号内容が正しいJSONではありません')
  }
  if (
    !isRecord(payload) ||
    !isRecord(payload.server) ||
    payload.server.format !== 'srs-server-backup' ||
    ![1, 2].includes(payload.server.schemaVersion) ||
    payload.server.scope !== 'records' ||
    typeof payload.server.createdAt !== 'string' ||
    Number.isNaN(Date.parse(payload.server.createdAt)) ||
    !isRecord(payload.server.event) ||
    typeof payload.server.event.id !== 'string' ||
    typeof payload.server.event.slug !== 'string' ||
    typeof payload.server.event.name !== 'string' ||
    !isRecord(payload.server.manifest) ||
    typeof payload.server.manifest.dataHash !== 'string' ||
    !Number.isInteger(payload.server.manifest.eventSequence) ||
    payload.server.manifest.eventSequence < 0 ||
    !(payload.server.manifest.eventHashRoot === null || typeof payload.server.manifest.eventHashRoot === 'string') ||
    !(payload.server.manifest.signature === undefined || isRecord(payload.server.manifest.signature)) ||
    !isRecord(payload.server.manifest.counts) ||
    !isRecord(payload.server.data)
  ) {
    throw new Error('バックアップ内容の形式を確認できません')
  }
  if (
    encrypted.event.id !== payload.server.event.id ||
    encrypted.event.slug !== payload.server.event.slug ||
    encrypted.event.name !== payload.server.event.name
  ) throw new Error('暗号化ヘッダーとバックアップ内の大会情報が一致しません')
  return payload
}

async function apiJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init.headers },
  })
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `バックアップAPIエラー (${response.status})`)
  return body
}

export async function requestServerBackup(eventSlug: string): Promise<ServerBackup> {
  return (await apiJson<{ backup: ServerBackup }>(
    `/api/events/${encodeURIComponent(eventSlug)}/backups/export`,
    { method: 'POST', body: '{}' },
  )).backup
}

export async function requestBackupRestorePreview(
  eventSlug: string,
  backup: ServerBackup,
): Promise<BackupRestorePreview> {
  return (await apiJson<{ preview: BackupRestorePreview }>(
    `/api/events/${encodeURIComponent(eventSlug)}/backups/restore-preview`,
    { method: 'POST', body: JSON.stringify({ backup }) },
  )).preview
}

export async function restoreServerBackup(
  eventSlug: string,
  backup: ServerBackup,
  reason: string,
  previewStateHash: string,
): Promise<{
  restored: Array<{ raceId: string; raceNumber: string; sourceRevision: number; revision: number; differences: string[] }>
  finalizedSkipped: string[]
  unchangedSkipped: string[]
  noSourceSkipped: string[]
  restoreId: string
  report: BackupRestoreReport
}> {
  return apiJson(`/api/events/${encodeURIComponent(eventSlug)}/backups/restore`, {
    method: 'POST',
    body: JSON.stringify({ backup, reason, previewStateHash }),
  })
}
