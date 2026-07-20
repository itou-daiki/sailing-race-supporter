export type OperationMode = 'team' | 'solo'

export interface OperationModeOption {
  value: OperationMode
  label: string
  shortLabel: string
  description: string
}

export const OPERATION_MODE_OPTIONS: readonly OperationModeOption[] = [
  {
    value: 'team',
    label: '通常運営（複数メンバー）',
    shortLabel: '通常運営',
    description: 'マーク艇、本部船、プロテスト艇などで担当を分けます。',
  },
  {
    value: 'solo',
    label: 'ワンオペ（1人で兼務）',
    shortLabel: 'ワンオペ',
    description: '管理者1人を全運営担当にし、兼務向けの画面と確認項目で開始します。',
  },
] as const

export function normalizeOperationMode(value: unknown): OperationMode {
  return value === 'solo' ? 'solo' : 'team'
}

export function operationModeOption(value: OperationMode): OperationModeOption {
  return OPERATION_MODE_OPTIONS.find((option) => option.value === value) ?? OPERATION_MODE_OPTIONS[0]
}
