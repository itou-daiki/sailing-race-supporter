import { geodesicDistanceMetres, geodesicMidpoint, trueBearingDegrees } from './geo.js'

export interface GateNodeInput {
  markId: string
  label: string
  nodeType: string
  target: readonly [longitude: number, latitude: number]
}

export interface GateGeometry {
  key: string
  label: string
  starboardMarkId: string
  portMarkId: string
  widthMetres: number
  bearingDegreesTrue: number
  center: [longitude: number, latitude: number]
}

export interface GateConfiguration {
  lower: boolean
  upper: boolean
  second: boolean
  gates: GateGeometry[]
}

interface GatePairDraft {
  label: string
  starboard?: GateNodeInput
  port?: GateNodeInput
}

function rounded(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces
  return Math.round(value * factor) / factor
}

function gateSide(label: string): 'S' | 'P' | undefined {
  const side = label.trim().match(/([SP])$/u)?.[1]
  return side === 'S' || side === 'P' ? side : undefined
}

function gateKey(label: string): string {
  return label.trim().replace(/[SP]$/u, '').trim()
}

export function buildGateConfiguration(
  flags: { lower: boolean; upper: boolean; second: boolean },
  nodes: readonly GateNodeInput[],
): GateConfiguration {
  const pairs = new Map<string, GatePairDraft>()
  for (const node of nodes.filter((candidate) => candidate.nodeType === 'gate')) {
    const side = gateSide(node.label)
    const key = gateKey(node.label)
    if (!side || !key) throw new Error(`ゲートマーク「${node.label}」のS/P側を判別できません`)
    const pair = pairs.get(key) ?? { label: key }
    if (side === 'S') {
      if (pair.starboard) throw new Error(`ゲート「${key}」のS側が重複しています`)
      pair.starboard = node
    } else {
      if (pair.port) throw new Error(`ゲート「${key}」のP側が重複しています`)
      pair.port = node
    }
    pairs.set(key, pair)
  }

  const gates = [...pairs.entries()].map(([key, pair]): GateGeometry => {
    if (!pair.starboard || !pair.port) throw new Error(`ゲート「${key}」はS/P両方のマークが必要です`)
    const center = geodesicMidpoint(pair.starboard.target, pair.port.target)
    return {
      key,
      label: pair.label,
      starboardMarkId: pair.starboard.markId,
      portMarkId: pair.port.markId,
      widthMetres: rounded(geodesicDistanceMetres(pair.starboard.target, pair.port.target), 1),
      bearingDegreesTrue: rounded(trueBearingDegrees(pair.starboard.target, pair.port.target), 1),
      center: [rounded(center[0], 7), rounded(center[1], 7)],
    }
  })

  const detected = {
    lower: gates.some((gate) => gate.label.startsWith('下ゲート') || gate.label.startsWith('内側ゲート')),
    upper: gates.some((gate) => gate.label.startsWith('上ゲート')),
    second: gates.some((gate) => gate.label.startsWith('中ゲート')),
  }
  if (detected.lower !== flags.lower || detected.upper !== flags.upper || detected.second !== flags.second) {
    throw new Error('ゲート切替と左右マークの構成が一致しません')
  }
  return { ...flags, gates }
}
