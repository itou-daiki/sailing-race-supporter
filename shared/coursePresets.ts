export type CoursePresetCode = 'O2' | 'I2' | 'L2' | 'L3' | 'W2' | 'T2' | 'トライアングル'

export interface CoursePreset {
  code: CoursePresetCode
  displayCode: string
  name: string
  optionLabel: string
  description: string
  codeMeaning: string
  route: readonly string[]
  initialMarkKeys: readonly string[]
  tags: readonly string[]
  sourceLabel: string
  recommended?: boolean
}

const WORLD_SAILING_PRESETS: readonly CoursePreset[] = [
  {
    code: 'O2',
    displayCode: 'O2',
    name: 'トラペゾイド外回り・2周',
    optionLabel: 'トラペゾイド（O2）— 外回り・2周',
    description: '外側のリーチマークを使う、標準的なトラペゾイドです。',
    codeMeaning: 'O = Outer（外回り）／2 = 2周仕様',
    route: ['Start', '1', '2', '3S/3P', '2', '3P', 'Finish'],
    initialMarkKeys: ['start-pin', 'start-rc', 'mark-1', 'mark-2', 'mark-3s', 'mark-3p'],
    tags: ['トラペゾイド', '外回り', '下ゲート'],
    sourceLabel: 'World Sailing標準例',
    recommended: true,
  },
  {
    code: 'I2',
    displayCode: 'I2',
    name: 'トラペゾイド内回り・2周',
    optionLabel: 'トラペゾイド（I2）— 内回り・2周',
    description: '内側の風上・風下レグを使うトラペゾイドです。',
    codeMeaning: 'I = Inner（内回り）／2 = 2周仕様',
    route: ['Start', '1', '4S/4P', '1', '2', '3P', 'Finish'],
    initialMarkKeys: ['start-pin', 'start-rc', 'mark-1', 'mark-4s', 'mark-4p', 'mark-2', 'mark-3p'],
    tags: ['トラペゾイド', '内回り', '内側ゲート'],
    sourceLabel: 'World Sailing標準例',
  },
  {
    code: 'L2',
    displayCode: 'L2',
    name: '風上／風下・2周',
    optionLabel: '風上／風下（L2）— 2周',
    description: '風上マークと風下ゲートを往復する、短めの上下コースです。',
    codeMeaning: 'L = Windward/Leeward／2 = 2周仕様',
    route: ['Start', '1', '4S/4P', '1', 'Finish'],
    initialMarkKeys: ['start-pin', 'start-rc', 'mark-1', 'mark-4s', 'mark-4p'],
    tags: ['風上／風下', '2周', '風下ゲート'],
    sourceLabel: 'World Sailing標準例',
  },
  {
    code: 'L3',
    displayCode: 'L3',
    name: '風上／風下・3周',
    optionLabel: '風上／風下（L3）— 3周',
    description: 'L2より風上・風下の往復を1回増やした長めの上下コースです。',
    codeMeaning: 'L = Windward/Leeward／3 = 3周仕様',
    route: ['Start', '1', '4S/4P', '1', '4S/4P', '1', 'Finish'],
    initialMarkKeys: ['start-pin', 'start-rc', 'mark-1', 'mark-4s', 'mark-4p'],
    tags: ['風上／風下', '3周', '風下ゲート'],
    sourceLabel: 'World Sailing標準例',
  },
  {
    code: 'トライアングル',
    displayCode: 'TRI',
    name: 'トライアングル',
    optionLabel: 'トライアングル（TRI）',
    description: '風上、サイド、風下の3点を回る基本的な三角コースです。',
    codeMeaning: 'TRI = Triangle（三角形）',
    route: ['Start', '1', '2', '3', 'Finish'],
    initialMarkKeys: ['start-pin', 'start-rc', 'mark-1', 'mark-2', 'mark-3'],
    tags: ['三角形', 'リーチレグ', '単周の初期案'],
    sourceLabel: '大会SIで回航数を確認',
  },
]

const SNIPE_PRESETS: readonly CoursePreset[] = [
  {
    code: 'W2',
    displayCode: 'W2',
    name: '風上／風下・2周',
    optionLabel: '風上／風下（W2）— 2周',
    description: 'オフセット1Aと風下ゲートを使う、スナイプの標準的な上下コースです。',
    codeMeaning: 'W = Windward/Leeward／2 = 2周',
    route: ['Start', '1', '1A', '3S/3P', '1', '1A', '3P', 'Finish'],
    initialMarkKeys: ['start-pin', 'start-rc', 'mark-1', 'mark-1a', 'mark-3s', 'mark-3p'],
    tags: ['スナイプ', '風上／風下', '6〜18kt目安'],
    sourceLabel: 'SCIRA Courses 2026',
    recommended: true,
  },
  {
    code: 'O2',
    displayCode: 'O2',
    name: 'オリンピック・2周',
    optionLabel: 'オリンピック（O2）— 2周',
    description: '三角形と風上・風下を組み合わせるスナイプ用コースです。',
    codeMeaning: 'O = Olympic／2 = 2回の風上レグ',
    route: ['Start', '1', '2', '3', '1', '3', 'Finish'],
    initialMarkKeys: ['start-pin', 'start-rc', 'mark-1', 'mark-2', 'mark-3'],
    tags: ['スナイプ', 'オリンピック', '15〜18kt目安'],
    sourceLabel: 'SCIRA Courses 2026',
  },
  {
    code: 'T2',
    displayCode: 'T2',
    name: 'トライアングル・2周',
    optionLabel: 'トライアングル（T2）— 2周',
    description: '同じ三角形を2回回る、強風向けのスナイプ用コースです。',
    codeMeaning: 'T = Triangle／2 = 三角形を2周',
    route: ['Start', '1', '2', '3', '1', '2', '3', 'Finish'],
    initialMarkKeys: ['start-pin', 'start-rc', 'mark-1', 'mark-2', 'mark-3'],
    tags: ['スナイプ', '三角形×2', '16〜23kt目安'],
    sourceLabel: 'SCIRA Courses 2026',
  },
]

export function coursePresetsForClass(className: string): readonly CoursePreset[] {
  return className === 'スナイプ' ? SNIPE_PRESETS : WORLD_SAILING_PRESETS
}

export function normalizeCoursePresetCode(className: string, courseCode: string): CoursePresetCode {
  const migratedCode = className === 'スナイプ' && courseCode === 'トライアングル'
    ? 'T2'
    : className !== 'スナイプ' && courseCode === 'T2'
      ? 'トライアングル'
      : courseCode
  const presets = coursePresetsForClass(className)
  return presets.some((preset) => preset.code === migratedCode)
    ? migratedCode as CoursePresetCode
    : presets.find((preset) => preset.recommended)?.code ?? presets[0].code
}

export function coursePresetForClass(className: string, courseCode: string): CoursePreset {
  const normalized = normalizeCoursePresetCode(className, courseCode)
  return coursePresetsForClass(className).find((preset) => preset.code === normalized)!
}
