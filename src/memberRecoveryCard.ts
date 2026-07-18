export interface MemberRecoveryQrPayload {
  format: 'srs-member-recovery'
  version: 1
  eventSlug: string
  memberId: string
  secret: string
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_DECODE_DIMENSION = 2_048

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`復元QRの${label}が不正です`)
  }
  return value.trim()
}

export function createMemberRecoveryQrPayload(
  eventSlug: string,
  memberId: string,
  secret: string,
): string {
  return JSON.stringify({
    format: 'srs-member-recovery',
    version: 1,
    eventSlug,
    memberId,
    secret,
  } satisfies MemberRecoveryQrPayload)
}

export function parseMemberRecoveryQrPayload(value: string): MemberRecoveryQrPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Sailing Race Supporterの参加復元QRではありません')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Sailing Race Supporterの参加復元QRではありません')
  }
  const record = parsed as Record<string, unknown>
  if (record.format !== 'srs-member-recovery' || record.version !== 1) {
    throw new Error('対応していない参加復元QRです')
  }
  const secret = requiredString(record.secret, '復元コード', 300)
  if (secret.length < 22) throw new Error('復元QRのコードが短すぎます')
  return {
    format: 'srs-member-recovery',
    version: 1,
    eventSlug: requiredString(record.eventSlug, '大会情報', 120),
    memberId: requiredString(record.memberId, 'メンバーID', 120),
    secret,
  }
}

async function drawImageFile(file: File, canvas: HTMLCanvasElement): Promise<void> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    try {
      const scale = Math.min(1, MAX_DECODE_DIMENSION / Math.max(bitmap.width, bitmap.height))
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('画像を読み取れません')
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      return
    } finally {
      bitmap.close()
    }
  }

  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('画像を読み取れません'))
    })
    const scale = Math.min(1, MAX_DECODE_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight))
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('画像を読み取れません')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function decodeMemberRecoveryQrImage(file: File): Promise<MemberRecoveryQrPayload> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('QR画像は15MB以下を選択してください')
  if (file.type && !file.type.startsWith('image/')) throw new Error('スクリーンショットなどの画像を選択してください')

  const canvas = document.createElement('canvas')
  await drawImageFile(file, canvas)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('画像を読み取れません')
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const { default: jsQR } = await import('jsqr')
  const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })
  if (!result?.data) throw new Error('画像内に参加復元QRが見つかりません')
  return parseMemberRecoveryQrPayload(result.data)
}
