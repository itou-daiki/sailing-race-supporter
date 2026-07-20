import { describe, expect, it } from 'vitest'
import { coursePresetForClass, coursePresetsForClass, normalizeCoursePresetCode } from '../shared/coursePresets'

describe('class-aware course presets', () => {
  it('explains standard dinghy course codes with their rounding order', () => {
    const presets = coursePresetsForClass('470')
    expect(presets.map((preset) => preset.code)).toEqual(['O2', 'I2', 'L2', 'L3', 'トライアングル'])
    expect(coursePresetForClass('470', 'O2')).toMatchObject({
      name: 'トラペゾイド・アウターループ',
      shortName: 'アウター',
      optionLabel: 'トラペゾイド（O2）— アウター・風上レグ2回',
      codeMeaning: 'O = Outer（アウター）／2 = 風上レグ2回',
      route: ['Start', '1', '2', '3S/3P', '2', '3P', 'Finish'],
      initialMarkKeys: ['start-pin', 'start-rc', 'mark-1', 'mark-2', 'mark-3s', 'mark-3p'],
    })
  })

  it('distinguishes the outer and inner trapezoid loops without calling them two full laps', () => {
    expect(coursePresetForClass('470', 'O2')).toMatchObject({
      description: expect.stringContaining('1→2→3の外側ループ'),
      route: ['Start', '1', '2', '3S/3P', '2', '3P', 'Finish'],
    })
    expect(coursePresetForClass('470', 'I2')).toMatchObject({
      name: 'トラペゾイド・インナーループ',
      description: expect.stringContaining('1→4→1の内側ループ'),
      route: ['Start', '1', '4S/4P', '1', '2', '3P', 'Finish'],
    })
  })

  it('uses the distinct SCIRA meanings for Snipe W2, O2, and T2', () => {
    const presets = coursePresetsForClass('スナイプ')
    expect(presets.map((preset) => preset.code)).toEqual(['W2', 'O2', 'T2'])
    expect(coursePresetForClass('スナイプ', 'O2').name).toBe('オリンピック・2周')
    expect(coursePresetForClass('スナイプ', 'T2').route).toEqual(['Start', '1', '2', '3', '1', '2', '3', 'Finish'])
    expect(coursePresetForClass('スナイプ', 'W2').initialMarkKeys).toEqual([
      'start-pin', 'start-rc', 'mark-1', 'mark-1a', 'mark-3s', 'mark-3p',
    ])
  })

  it('migrates legacy triangle values when switching between Snipe and other classes', () => {
    expect(normalizeCoursePresetCode('スナイプ', 'トライアングル')).toBe('T2')
    expect(normalizeCoursePresetCode('470', 'T2')).toBe('トライアングル')
    expect(normalizeCoursePresetCode('スナイプ', 'L3')).toBe('W2')
  })
})
