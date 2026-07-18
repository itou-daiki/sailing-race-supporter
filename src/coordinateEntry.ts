import type { LngLat } from './domain'

export interface DecimalTailParts {
  prefix: string
  tail: string
}

export function decimalTailParts(value: number): DecimalTailParts {
  if (!Number.isFinite(value)) throw new Error('基準座標が不正です')
  const sign = value < 0 ? '-' : ''
  const [degrees, decimals] = Math.abs(value).toFixed(6).split('.')
  return {
    prefix: `${sign}${degrees}.${decimals.slice(0, 2)}`,
    tail: decimals.slice(2),
  }
}

function coordinateFromTail(reference: number, tail: string, label: string): number {
  if (!/^\d{4}$/u.test(tail)) throw new Error(`${label}の末尾4桁を半角数字で入力してください`)
  const parts = decimalTailParts(reference)
  return Number(`${parts.prefix}${tail}`)
}

export function positionFromDecimalTails(
  reference: LngLat,
  latitudeTail: string,
  longitudeTail: string,
): LngLat {
  const latitude = coordinateFromTail(reference[1], latitudeTail, '緯度')
  const longitude = coordinateFromTail(reference[0], longitudeTail, '経度')
  if (latitude < -85 || latitude > 85 || longitude < -180 || longitude > 180) {
    throw new Error('入力座標が利用可能な範囲外です')
  }
  return [longitude, latitude]
}

export function positionFromFullDecimal(latitudeText: string, longitudeText: string): LngLat {
  const latitudeValue = latitudeText.trim()
  const longitudeValue = longitudeText.trim()
  if (!latitudeValue || !longitudeValue) throw new Error('緯度・経度を10進度で入力してください')
  const latitude = Number(latitudeValue)
  const longitude = Number(longitudeValue)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('緯度・経度を10進度で入力してください')
  }
  if (latitude < -85 || latitude > 85 || longitude < -180 || longitude > 180) {
    throw new Error('入力座標が利用可能な範囲外です')
  }
  return [longitude, latitude]
}
