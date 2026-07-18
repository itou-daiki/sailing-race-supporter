export const MAX_BACKUP_ARCHIVE_BYTES = 25 * 1_024 * 1_024
export const MAX_BACKUP_ARCHIVES_PER_EVENT = 20
export const MAX_BACKUP_ARCHIVE_BYTES_PER_EVENT =
  MAX_BACKUP_ARCHIVE_BYTES * MAX_BACKUP_ARCHIVES_PER_EVENT

export interface EncryptedBackupArchiveEnvelope {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validBase64(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9+/_=-]+$/u.test(value)
}

export function isEncryptedBackupArchiveEnvelope(value: unknown): value is EncryptedBackupArchiveEnvelope {
  if (!isRecord(value) || !isRecord(value.event) || !isRecord(value.encryption)) return false
  return value.format === 'srs-encrypted-backup' &&
    value.version === 1 &&
    typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.createdBy === 'string' && value.createdBy.length <= 200 &&
    typeof value.event.id === 'string' && value.event.id.length > 0 &&
    typeof value.event.slug === 'string' && value.event.slug.length > 0 &&
    typeof value.event.name === 'string' && value.event.name.length > 0 &&
    value.encryption.algorithm === 'AES-GCM-256' &&
    value.encryption.kdf === 'PBKDF2-SHA-256' &&
    Number.isInteger(value.encryption.iterations) &&
    Number(value.encryption.iterations) >= 100_000 &&
    Number(value.encryption.iterations) <= 1_000_000 &&
    validBase64(value.encryption.salt, 256) &&
    validBase64(value.encryption.iv, 256) &&
    validBase64(value.plaintextHash, 256) &&
    validBase64(value.ciphertext, MAX_BACKUP_ARCHIVE_BYTES * 2)
}
