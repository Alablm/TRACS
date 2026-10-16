import { beforeEach, describe, expect, it } from 'vitest'
import { useTacasStore } from '../../client/src/store/tacas.js'
import {
  findOwnedTacasEchoPoint,
  getTacasPeerPositions,
  findSelectedTacasEchoPoint,
  findTacasAircraft,
  findTacasAircraftForPositions,
  formatTacasEchoPointReadout,
  getTacasPositionName,
} from '../../client/src/modules/tacas/tacasHelpers.js'
import { stripAcid } from '../../client/src/utils/callsignShape.js'
import { destinationPoint } from '../../client/src/utils/bearing.js'

describe('TACAS shared state', () => {
  beforeEach(() => useTacasStore.getState().reset())

  it('validates and upserts map markers by id', () => {
    const store = useTacasStore.getState()
    store.upsertMarker({ id: 'm1', lat: 24, lng: 54, label: 'Objective' })
    store.upsertMarker({ id: 'm1', lat: 25, lng: 55, label: 'Updated' })
    store.upsertMarker({ id: 'bad', lat: 91, lng: 0, label: 'Invalid' })

    expect(useTacasStore.getState().markers).toHaveLength(1)
    expect(useTacasStore.getState().markers[0]).toMatchObject({ id: 'm1', lat: 25, lng: 55, label: 'Updated' })
  })

  it('keeps one Echo Point per JTAC while allowing other JTACs and regular markers', () => {
    const store = useTacasStore.getState()
    store.upsertMarker({ id: 'echo-old', lat: 24, lng: 54, markerType: 'ECHO_POINT', createdBy: 'RAVEN11', updatedAt: 1 })
    store.upsertMarker({ id: 'normal', lat: 25, lng: 55, createdBy: 'RAVEN11', updatedAt: 2 })
    store.upsertMarker({ id: 'echo-new', lat: 26, lng: 56, markerType: 'ECHO_POINT', createdBy: 'RAVEN11', updatedAt: 3 })
    store.upsertMarker({ id: 'echo-other', lat: 27, lng: 57, markerType: 'ECHO_POINT', createdBy: 'VIPER21', updatedAt: 4 })
    store.upsertMarker({ id: 'echo-invalid', lat: 28, lng: 58, markerType: 'ECHO_POINT', updatedAt: 5 })

    expect(useTacasStore.getState().markers).toHaveLength(3)
    expect(useTacasStore.getState().markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'normal', markerType: 'MARKER' }),
      expect.objectContaining({ id: 'echo-new', markerType: 'ECHO_POINT', label: 'Echo Point' }),
      expect.objectContaining({ id: 'echo-other', markerType: 'ECHO_POINT' }),
    ]))
  })

  describe('TACAS aircraft matching', () => {
    it('shows only the live airborne aircraft with the exact normalized callsign', () => {
      const units = {
        matching: {
          id: 'matching',
          customString: 'RAVEN-11',
          name: 'F-16C_50',
          category: 'Aircraft',
          airborne: true,
          position: { lat: 24, lng: 54 },
        },
        prefixOnly: {
          id: 'prefixOnly',
          customString: 'RAVEN-12',
          category: 'Aircraft',
          airborne: true,
          position: { lat: 25, lng: 55 },
        },
        landed: {
          id: 'landed',
          customString: 'RAVEN-11',
          category: 'Aircraft',
          airborne: false,
          position: { lat: 26, lng: 56 },
        },
        dead: {
          id: 'dead',
          customString: 'RAVEN-11',
          category: 'Aircraft',
          airborne: true,
          alive: false,
          position: { lat: 27, lng: 57 },
        },
      }

      expect(findTacasAircraft(units, 'raven 1-1', 'AIRCREW', (unit) => stripAcid(unit.customString))).toEqual([
        { id: 'matching', unit: units.matching, callsign: 'RAVEN11', typeName: 'F-16C' },
      ])
    })

    describe('TACAS peer filtering', () => {
      it('lists only other connected TACAS positions for direct messaging and marker owners', () => {
        expect(getTacasPeerPositions([
          { module: 'TACAS', position: 'RAVEN11 JTAC' },
          { module: 'TACAS', position: 'VIPER21' },
          { module: 'ATC', position: 'KJFK_TWR' },
          { module: 'ABM', position: 'EAGLE1' },
          { module: 'TACAS', position: 'RAVEN11 JTAC' },
        ], 'VIPER21')).toEqual(['RAVEN11 JTAC'])
      })
    })

    it('keeps JTAC callsign positions distinct and never draws their matching aircraft', () => {
      const aircraft = {
        id: 'matching',
        customString: 'RAVEN11',
        category: 'Aircraft',
        airborne: true,
        position: { lat: 24, lng: 54 },
      }

      expect(getTacasPositionName('raven11', 'JTAC')).toBe('RAVEN11 JTAC')
      expect(getTacasPositionName('raven11', 'AIRCREW')).toBe('RAVEN11')
      expect(findTacasAircraft(
        { matching: aircraft },
        'RAVEN11',
        'JTAC',
        (unit) => stripAcid(unit.customString)
      )).toEqual([])
    })

    it('shows registered Aircrew aircraft to other TACAS positions without drawing JTAC callsigns', () => {
      const units = {
        aircrewAircraft: {
          id: 'aircrewAircraft',
          customString: 'RAVEN11',
          name: 'F-16C_50',
          category: 'Aircraft',
          airborne: true,
          position: { lat: 24, lng: 54 },
        },
        jtacAircraft: {
          id: 'jtacAircraft',
          customString: 'VIPER21',
          name: 'A-10C',
          category: 'Aircraft',
          airborne: true,
          position: { lat: 25, lng: 55 },
        },
      }

      expect(findTacasAircraftForPositions(
        units,
        ['RAVEN11', 'VIPER21 JTAC'],
        (unit) => stripAcid(unit.customString)
      )).toEqual([
        { id: 'aircrewAircraft', unit: units.aircrewAircraft, callsign: 'RAVEN11', typeName: 'F-16C' },
      ])
    })

    it('formats cursor positions as bearing and range from the JTAC Echo Point', () => {
      expect(formatTacasEchoPointReadout(
        { lat: 25, lng: 54 },
        { lat: 24, lng: 54 },
        null
      )).toBe('A60 NM')
      expect(formatTacasEchoPointReadout(
        { lat: 25, lng: 54 },
        { lat: 24, lng: 54 },
        null,
        'm'
      )).toBe('A111 KM')
    })

    it('uses A/B/C/D and distance within 10 degrees of cardinal bearings', () => {
      const echoPoint = { lat: 0, lng: 0 }
      const cardinalReadouts = [
        [0, 'A10'],
        [10, 'A10'],
        [90, 'B10'],
        [180, 'C10'],
        [270, 'D10'],
        [350, 'A10'],
      ]

      for (const [bearing, expected] of cardinalReadouts) {
        const cursor = destinationPoint(echoPoint.lat, echoPoint.lng, bearing, 10)
        expect(formatTacasEchoPointReadout(cursor, echoPoint, null)).toBe(`${expected} NM`)
      }
    })

    it('keeps numeric bearing and range outside cardinal sectors', () => {
      const echoPoint = { lat: 0, lng: 0 }
      const cursor = destinationPoint(echoPoint.lat, echoPoint.lng, 10.1, 10)
      expect(formatTacasEchoPointReadout(cursor, echoPoint, null)).toBe('010 / 10 NM')
      expect(formatTacasEchoPointReadout(cursor, echoPoint, null, 'm')).toBe('010 / 19 KM')
    })

    it('uses only the signed-in JTAC’s Echo Point for its cursor readout', () => {
      const markers = [
        { id: 'raven', markerType: 'ECHO_POINT', createdBy: 'RAVEN11 JTAC', lat: 24, lng: 54 },
        { id: 'viper', markerType: 'ECHO_POINT', createdBy: 'VIPER21 JTAC', lat: 25, lng: 55 },
        { id: 'regular', markerType: 'MARKER', createdBy: 'RAVEN11 JTAC', lat: 26, lng: 56 },
      ]

      expect(findOwnedTacasEchoPoint(markers, 'RAVEN11 JTAC', 'JTAC')).toBe(markers[0])
      expect(findOwnedTacasEchoPoint(markers, 'VIPER21 JTAC', 'JTAC')).toBe(markers[1])
      expect(findOwnedTacasEchoPoint(markers, 'RAVEN11 JTAC', 'AIRCREW')).toBeNull()
      expect(findSelectedTacasEchoPoint(markers, 'viper')).toBe(markers[1])
      expect(markers[1].createdBy).toBe('VIPER21 JTAC')
      expect(findSelectedTacasEchoPoint(markers, null, markers[0])).toBe(markers[0])
    })
  })

  it('deduplicates chat messages and merges join snapshots', () => {
    const store = useTacasStore.getState()
    store.addMessage({ id: 'c1', from: 'ONE', text: 'Check point' })
    store.addMessage({ id: 'c1', from: 'ONE', text: 'Check point' })
    store.applyStateDump({
      markers: [{ id: 'm1', lat: 24, lng: 54, label: 'Rally' }],
      messages: [{ id: 'c1', from: 'ONE', text: 'Check point' }, { id: 'c2', from: 'TWO', text: 'Copy' }],
    })

    expect(useTacasStore.getState().markers).toHaveLength(1)
    expect(useTacasStore.getState().messages.map((message) => message.id)).toEqual(['c1', 'c2'])
  })

  it('keeps direct messages local and out of shared state dumps', () => {
    const store = useTacasStore.getState()
    store.addDirectMessage({
      id: 'dm1',
      from: 'ONE',
      toPosition: 'TWO',
      text: 'Private check',
      timestamp: 10,
    })
    store.applyStateDump({
      messages: [{ id: 'c1', from: 'THREE', text: 'Global check', timestamp: 20 }],
    })

    expect(useTacasStore.getState().directMessages).toEqual([
      expect.objectContaining({ id: 'dm1', from: 'ONE', toPosition: 'TWO' }),
    ])
    expect(useTacasStore.getState().messages).toEqual([
      expect.objectContaining({ id: 'c1', from: 'THREE' }),
    ])
    expect(useTacasStore.getState().messages.map((message) => message.id)).not.toContain('dm1')
  })

  it('keeps one replaceable Aircrew check-in per callsign and merges the latest snapshot', () => {
    const store = useTacasStore.getState()
    store.upsertAircrewCheckIn({
      from: 'RAVEN11',
      values: { identification: 'Mission 1' },
      updatedAt: 10,
    })
    store.upsertAircrewCheckIn({
      from: 'raven11',
      values: { identification: 'Mission 2' },
      updatedAt: 20,
    })
    store.upsertAircrewCheckIn({
      from: 'VIPER21',
      values: { aircraft: '2 x F-16' },
      updatedAt: 15,
    })
    store.applyStateDump({
      aircrewCheckIns: [
        { from: 'RAVEN11', values: { identification: 'Stale check-in' }, updatedAt: 18 },
        { from: 'RAVEN11', values: { identification: 'Latest check-in' }, updatedAt: 25 },
      ],
    })
    store.upsertAircrewCheckIn({
      from: 'RAVEN11',
      values: { identification: 'Out-of-order update' },
      updatedAt: 22,
    })

    expect(useTacasStore.getState().aircrewCheckIns).toEqual([
      expect.objectContaining({ from: 'RAVEN11', values: expect.objectContaining({ identification: 'Latest check-in' }) }),
      expect.objectContaining({ from: 'VIPER21', values: expect.objectContaining({ aircraft: '2 x F-16' }) }),
    ])
  })

  it('deduplicates Echo Points by JTAC when merging a join snapshot', () => {
    useTacasStore.getState().applyStateDump({
      markers: [
        { id: 'echo-old', lat: 24, lng: 54, markerType: 'ECHO_POINT', createdBy: 'RAVEN11', updatedAt: 1 },
        { id: 'echo-new', lat: 25, lng: 55, markerType: 'ECHO_POINT', createdBy: 'raven11', updatedAt: 2 },
      ],
      messages: [],
    })

    expect(useTacasStore.getState().markers).toEqual([
      expect.objectContaining({ id: 'echo-new', label: 'Echo Point' }),
    ])
  })
})