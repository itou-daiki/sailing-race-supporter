import { describe, expect, it } from 'vitest'
import { buildGateConfiguration } from '../shared/gates'

describe('authoritative gate geometry', () => {
  it('derives mark sides, width, true bearing and center from target positions', () => {
    const configuration = buildGateConfiguration(
      { lower: true, upper: false, second: false },
      [
        { markId: 'mark-3s', label: '下ゲート 3S', nodeType: 'gate', target: [139, 35] },
        { markId: 'mark-3p', label: '下ゲート 3P', nodeType: 'gate', target: [139.001, 35] },
        { markId: 'mark-1', label: '1マーク', nodeType: 'single', target: [139, 35.01] },
      ],
    )

    expect(configuration).toMatchObject({ lower: true, upper: false, second: false })
    expect(configuration.gates).toHaveLength(1)
    expect(configuration.gates[0]).toMatchObject({
      key: '下ゲート 3',
      label: '下ゲート 3',
      starboardMarkId: 'mark-3s',
      portMarkId: 'mark-3p',
      widthMetres: 91.1,
      bearingDegreesTrue: 90,
    })
    expect(configuration.gates[0].center).toEqual([139.0005, 35])
  })

  it('rejects an incomplete gate instead of saving misleading geometry', () => {
    expect(() => buildGateConfiguration(
      { lower: true, upper: false, second: false },
      [{ markId: 'mark-3s', label: '下ゲート 3S', nodeType: 'gate', target: [139, 35] }],
    )).toThrow('S/P両方')
  })

  it('rejects a switch state that disagrees with the physical gate nodes', () => {
    expect(() => buildGateConfiguration(
      { lower: false, upper: false, second: false },
      [
        { markId: 'mark-3s', label: '下ゲート 3S', nodeType: 'gate', target: [139, 35] },
        { markId: 'mark-3p', label: '下ゲート 3P', nodeType: 'gate', target: [139.001, 35] },
      ],
    )).toThrow('構成が一致')
  })

  it('treats the World Sailing 4S/4P inner gate as the primary lower gate', () => {
    const configuration = buildGateConfiguration(
      { lower: true, upper: false, second: false },
      [
        { markId: 'mark-4s', label: '内側ゲート 4S', nodeType: 'gate', target: [131.522, 33.278] },
        { markId: 'mark-4p', label: '内側ゲート 4P', nodeType: 'gate', target: [131.523, 33.278] },
      ],
    )
    expect(configuration.lower).toBe(true)
    expect(configuration.gates[0].label).toBe('内側ゲート 4')
  })
})
