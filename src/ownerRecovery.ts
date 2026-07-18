import type { OwnerRecoveryKit } from './authClient'
import { isOwnerRecoveryCode } from '../shared/ownerRecovery'

const PBKDF2_ITERATIONS = 310_000
const MAX_RECOVERY_CIPHERTEXT_LENGTH = 16_384

export interface EncryptedOwnerRecoveryKit {
  format: 'srs-owner-recovery'
  schemaVersion: 1
  eventSlug: string
  recoveryId: string
  issuedAt: string
  encryption: {
    algorithm: 'AES-GCM'
    kdf: 'PBKDF2-SHA-256'
    iterations: number
    salt: string
    iv: string
  }
  ciphertext: string
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error('復旧ファイルの暗号化データ形式が正しくありません')
  }
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptOwnerRecoveryKit(
  kit: OwnerRecoveryKit,
  passphrase: string,
): Promise<EncryptedOwnerRecoveryKit> {
  if (passphrase.length < 10) throw new Error('暗号化パスフレーズは10文字以上にしてください')
  if (!isOwnerRecoveryCode(kit.recoveryCode)) throw new Error('オーナー復旧コードの形式が正しくありません')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS)
  const plaintext = new TextEncoder().encode(JSON.stringify(kit))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return {
    format: 'srs-owner-recovery',
    schemaVersion: 1,
    eventSlug: kit.eventSlug,
    recoveryId: kit.recoveryId,
    issuedAt: kit.issuedAt,
    encryption: {
      algorithm: 'AES-GCM',
      kdf: 'PBKDF2-SHA-256',
      iterations: PBKDF2_ITERATIONS,
      salt: base64Url(salt),
      iv: base64Url(iv),
    },
    ciphertext: base64Url(new Uint8Array(ciphertext)),
  }
}

export async function decryptOwnerRecoveryKit(
  encrypted: EncryptedOwnerRecoveryKit,
  passphrase: string,
): Promise<OwnerRecoveryKit> {
  if (
    !encrypted || typeof encrypted !== 'object'
    || encrypted.format !== 'srs-owner-recovery'
    || encrypted.schemaVersion !== 1
  ) {
    throw new Error('Sailing Race Supporterのオーナー復旧ファイルではありません')
  }
  const encryption = encrypted.encryption
  if (
    !encryption
    || encryption.algorithm !== 'AES-GCM'
    || encryption.kdf !== 'PBKDF2-SHA-256'
    || encryption.iterations !== PBKDF2_ITERATIONS
    || typeof encryption.salt !== 'string'
    || typeof encryption.iv !== 'string'
    || typeof encrypted.ciphertext !== 'string'
    || encrypted.ciphertext.length > MAX_RECOVERY_CIPHERTEXT_LENGTH
    || typeof encrypted.eventSlug !== 'string'
    || typeof encrypted.recoveryId !== 'string'
  ) throw new Error('復旧ファイルの暗号化設定を確認できません')
  if (passphrase.length < 10) throw new Error('暗号化パスフレーズは10文字以上にしてください')
  try {
    const salt = fromBase64Url(encryption.salt)
    const iv = fromBase64Url(encryption.iv)
    if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new Error('Invalid owner recovery salt or IV')
    const key = await deriveKey(
      passphrase,
      salt,
      encryption.iterations,
    )
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      fromBase64Url(encrypted.ciphertext),
    )
    const kit = JSON.parse(new TextDecoder().decode(plaintext)) as OwnerRecoveryKit
    if (!kit || typeof kit !== 'object' ||
      kit.recoveryId !== encrypted.recoveryId ||
      kit.eventSlug !== encrypted.eventSlug ||
      !isOwnerRecoveryCode(kit.recoveryCode)
    ) throw new Error('復旧ファイルの識別情報が一致しません')
    return kit
  } catch (error) {
    if (error instanceof Error && error.message.includes('識別情報')) throw error
    throw new Error('復旧ファイルを復号できません。パスフレーズを確認してください', { cause: error })
  }
}

export function ownerRecoveryQrPayload(kit: OwnerRecoveryKit): string {
  return JSON.stringify({
    format: 'srs-owner-recovery-qr',
    event: kit.eventSlug,
    code: kit.recoveryCode,
  })
}
