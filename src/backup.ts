export interface ServerBackup {
  format: 'srs-server-backup'
  schemaVersion: 1
  createdAt: string
  createdBy: string
  scope: 'records'
  event: { id: string; slug: string; name: string }
  manifest: {
    dataHash: string
    eventSequence: number
    eventHashRoot: string | null
    counts: Record<string, number>
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
    encrypted.format !== 'srs-encrypted-backup' ||
    encrypted.version !== 1 ||
    encrypted.encryption.algorithm !== 'AES-GCM-256' ||
    encrypted.encryption.kdf !== 'PBKDF2-SHA-256' ||
    encrypted.encryption.iterations < 100_000
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
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as BackupPayload
  if (payload.server?.format !== 'srs-server-backup' || payload.server.schemaVersion !== 1) {
    throw new Error('バックアップ内容の形式を確認できません')
  }
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

export async function restoreServerBackup(
  eventSlug: string,
  backup: ServerBackup,
  reason: string,
): Promise<{ restored: Array<{ raceId: string; revision: number }>; finalizedSkipped: string[]; restoreId: string }> {
  return apiJson(`/api/events/${encodeURIComponent(eventSlug)}/backups/restore`, {
    method: 'POST',
    body: JSON.stringify({ backup, reason }),
  })
}
