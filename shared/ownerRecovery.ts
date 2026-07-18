const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const RECOVERY_SYMBOL_COUNT = 40
const RECOVERY_PREFIX = 'SRSO'

export function generateOwnerRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_SYMBOL_COUNT))
  const symbols = Array.from(bytes, (value) => RECOVERY_ALPHABET[value % RECOVERY_ALPHABET.length])
  return formatOwnerRecoveryCode(`${RECOVERY_PREFIX}${symbols.join('')}`)
}

export function normalizeOwnerRecoveryCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/gu, '')
}

export function formatOwnerRecoveryCode(value: string): string {
  const normalized = normalizeOwnerRecoveryCode(value)
  if (!normalized.startsWith(RECOVERY_PREFIX)) return normalized
  const payload = normalized.slice(RECOVERY_PREFIX.length)
  return `${RECOVERY_PREFIX}-${payload.match(/.{1,5}/gu)?.join('-') ?? ''}`
}

export function isOwnerRecoveryCode(value: string): boolean {
  const normalized = normalizeOwnerRecoveryCode(value)
  if (!normalized.startsWith(RECOVERY_PREFIX) || normalized.length !== RECOVERY_PREFIX.length + RECOVERY_SYMBOL_COUNT) return false
  return [...normalized.slice(RECOVERY_PREFIX.length)].every((character) => RECOVERY_ALPHABET.includes(character))
}
