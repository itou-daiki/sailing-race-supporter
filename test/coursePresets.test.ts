import { describe, expect, it } from 'vitest'
import { coursePresetForClass, coursePresetsForClass, normalizeCoursePresetCode } from '../shared/coursePresets'

describe('class-aware course presets', () => {
  it('explains standard dinghy course codes with their rounding order', () => {
    const presets = coursePresetsForClass('470')
    expect(presets.map((preset) => preset.code)).toEqual(['O2', 'I2', 'L2', 'L3', 'トライアングル'])
    expect(coursePresetForClass('470', 'O2')).toMatchObject({
      name: 'トラペゾイド外回り・2周',
      optionLabel: 'トラペゾイド（O2）— 外回り・2周',
      codeMeaning: 'O = Outer（外回り）／2 = 2周仕様',
      route: ['Start', '1', '2', '3S/3P', '2', '3P', 'Finish'],
      initialMarkKeys: ['start-pin', 'start-rc', 'mark-1', 'mark-2', 'mark-3s', 'mark-3p'],
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
