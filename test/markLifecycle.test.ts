import { describe, expect, it } from 'vitest'
import { bootstrapMarks, type MarkBootstrapSource } from '../src/eventClient'

const courseNodes: MarkBootstrapSource['courseNodes'] = [{
  race_id: 'race-1',
  node_id: 'node-1',
  mark_id: 'mark-1',
  node_order: 1,
  label: '1マーク',
  node_type: 'single',
  target_lng: 139.466,
  target_lat: 35.294,
  mark_type: 'windward',
}]

function event(
  eventType: string,
  sequence: number,
  position: readonly [number, number],
  committeeBoatId: string,
): MarkBootstrapSource['markEvents'][number] {
  return {
    race_id: 'race-1',
    mark_id: 'mark-1',
    event_type: eventType,
    lng: position[0],
    lat: position[1],
    accuracy_metres: 3,
    committee_boat_id: committeeBoatId,
    sequence,
    payload_json: '{}',
  }
}

describe('mark lifecycle bootstrap', () => {
  it('keeps drop, verification, and recovery positions separate after reload', () => {
    const marks = bootstrapMarks({
      courseNodes,
      markEvents: [
        event('dropped', 1, [139.4661, 35.2941], 'drop-boat'),
        event('confirmed', 2, [139.46613, 35.29412], 'verify-boat'),
        event('recovered', 3, [139.467, 35.295], 'recovery-boat'),
      ],
    }, 'race-1')

    expect(marks[0]).toMatchObject({
      status: 'recovered',
      actual: [139.4661, 35.2941],
      verificationPosition: [139.46613, 35.29412],
      recoveryPosition: [139.467, 35.295],
      assignedBoatId: 'drop-boat',
    })
  })

  it('starts a new placement state when a confirmed mark is moved', () => {
    const marks = bootstrapMarks({
      courseNodes,
      markEvents: [
        event('dropped', 1, [139.4661, 35.2941], 'drop-boat'),
        event('confirmed', 2, [139.46613, 35.29412], 'verify-boat'),
        event('moved', 3, [139.4665, 35.2946], 'drop-boat'),
      ],
    }, 'race-1')

    expect(marks[0]).toMatchObject({
      status: 'deployed',
      actual: [139.4665, 35.2946],
      assignedBoatId: 'drop-boat',
    })
    expect(marks[0]?.verificationPosition).toBeUndefined()
    expect(marks[0]?.recoveryPosition).toBeUndefined()
  })
})
