import signingKeyConfiguration from '../config/backup-signing-keys.json' with { type: 'json' }

export interface BackupSignature {
  algorithm: 'Ed25519'
  keyId: string
  value: string
}

interface SignableBackup {
  format: string
  schemaVersion: number
  createdAt: string
  createdBy: string
  scope: string
  event: { id: string; slug: string; name: string }
  manifest: {
    dataHash: string
    eventSequence: number
    eventHashRoot: string | null
    counts: Record<string, number>
    signature?: BackupSignature
  }
}

export const BACKUP_SIGNING_KEY_ID = signingKeyConfiguration.activeKeyId
export const BACKUP_SIGNING_PUBLIC_KEYS: Readonly<Record<string, string>> = signingKeyConfiguration.publicKeys

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

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function backupSignaturePayload(backup: SignableBackup): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonical({
    format: backup.format,
    schemaVersion: backup.schemaVersion,
    createdAt: backup.createdAt,
    createdBy: backup.createdBy,
    scope: backup.scope,
    event: backup.event,
    manifest: {
      dataHash: backup.manifest.dataHash,
      eventSequence: backup.manifest.eventSequence,
      eventHashRoot: backup.manifest.eventHashRoot,
      counts: backup.manifest.counts,
    },
  })))
  return new Uint8Array([...encoded])
}

export async function signBackup(
  backup: SignableBackup,
  privateKeyBase64Url: string,
): Promise<BackupSignature> {
  if (!BACKUP_SIGNING_KEY_ID || !BACKUP_SIGNING_PUBLIC_KEYS[BACKUP_SIGNING_KEY_ID]) {
    throw new Error('バックアップ署名の公開鍵設定がありません')
  }
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64Url(privateKeyBase64Url),
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('Ed25519', privateKey, backupSignaturePayload(backup))
  return {
    algorithm: 'Ed25519',
    keyId: BACKUP_SIGNING_KEY_ID,
    value: base64Url(new Uint8Array(signature)),
  }
}

export async function verifyBackupSignature(
  backup: SignableBackup,
  trustedPublicKeys: Readonly<Record<string, string>> = BACKUP_SIGNING_PUBLIC_KEYS,
): Promise<boolean> {
  const signature = backup.manifest.signature
  if (!signature || signature.algorithm !== 'Ed25519') return false
  const publicKeyValue = trustedPublicKeys[signature.keyId]
  if (!publicKeyValue) return false
  try {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      fromBase64Url(publicKeyValue),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    return crypto.subtle.verify(
      'Ed25519',
      publicKey,
      fromBase64Url(signature.value),
      backupSignaturePayload(backup),
    )
  } catch {
    return false
  }
}
