export function shortCourseMarkLabel(label: string): string {
  if (label === 'スタート・ピン') return 'PIN'
  if (label === 'シグナルボート') return 'RC'
  if (label === 'フィニッシュ艇') return 'FIN'
  if (label === 'フィニッシュマーク') return 'F'
  return label
    .replace('オフセット ', '')
    .replace('下ゲート ', '')
    .replace('内側ゲート ', '')
    .replace('中ゲート ', '')
    .replace('上ゲート ', '')
    .replace('マーク', '')
    .trim()
}
