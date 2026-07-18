export interface TrueBearingFormatOptions {
  decimals?: number
  padInteger?: number
}

export function formatTrueBearing(
  degrees: number,
  options: TrueBearingFormatOptions = {},
): string {
  if (!Number.isFinite(degrees)) return '—'
  const decimals = Math.min(3, Math.max(0, Math.trunc(options.decimals ?? 0)))
  const factor = 10 ** decimals
  const normalized = ((degrees % 360) + 360) % 360
  const rounded = Math.round(normalized * factor) / factor
  const display = rounded >= 360 ? 0 : rounded
  const [integer, fraction] = display.toFixed(decimals).split('.')
  const paddedInteger = integer.padStart(Math.max(0, options.padInteger ?? 0), '0')
  return `${paddedInteger}${fraction === undefined ? '' : `.${fraction}`}°T`
}
