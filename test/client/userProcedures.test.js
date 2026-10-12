import { describe, it, expect } from 'vitest'
import {
  mergeProcedures, buildGroups, groupKeyFor, resolveLegs, legToSpec,
  parseProcedureJson, finalizeProc, rowTransitions, exportAirport,
  makeFixLookup, makeNearestFix, readProcedureFiles,
} from '../../client/src/utils/userProcedures.js'
import { computeMagvar } from '../../client/src/utils/magvar.js'
import { trueBearingRangeNm, toMagneticFromTrue } from '../../client/src/utils/bearing.js'

// Trimmed from a real navdata procedures file (cache/<theatre>/procedures/UGKO.json).
const UGKO = {
  SID: {
    ALIK1D: { type: 'GPS', transitions: { '07': [
      { alt_desc: 'A', lat: 42.178689, lon: 42.497642, id: 'DER07' },
      { alt_desc: '+', alt1: 1500, lat: 42.201593, lon: 42.605704 },
      { alt_desc: 'A', spd: 250, spd_type: '-', turn: 'L', rec_id: 'KTS', rec_lon: 42.484806, rec_lat: 42.175722, lat: 42.175722, lon: 42.484806, id: 'KTS' },
    ] } },
  },
  STAR: {
    ALIK1C: { type: 'GPS', transitions: { '07': [
      { lat: 42.3, lon: 42.1, id: 'ALIK' },
      { lat: 42.175722, lon: 42.484806, id: 'KTS' },
    ] } },
  },
  APPCH: {
    'I07-Y': { type: 'ILS', runway: '07', transitions: {
      '': [
        { alt_desc: '+', alt1: 2000, lat: 42.158678, lon: 42.340936, id: 'FD07' },
        { alt_desc: 'A', alt1: 183, lat: 42.174958, lon: 42.467789, id: 'RW07' },
        { missed: true, lat: 42.2, lon: 42.6 },
      ],
      KTS1: [{ lat: 42.175722, lon: 42.484806, id: 'KTS' }, { lat: 42.15, lon: 42.3, id: 'FD07' }],
    } },
  },
}

const userProc = (over = {}) => ({
  icao: 'UGKO', category: 'SID', name: 'TEST1D', type: '', runway: '', label: '',
  transitions: { '25': [{ lat: 42.17, lon: 42.5, id: 'A' }, { lat: 42.1, lon: 42.3, id: 'B' }] },
  ...over,
})

describe('DCB grouping', () => {
  it('groups navdata the same way as before', () => {
    const g = buildGroups(UGKO)
    expect(g.sidGroups).toEqual({ ALIK1: ['ALIK1D'] })
    expect(g.starGroups).toEqual({ ALIK1: ['ALIK1C'] })
    expect(g.appchGroups).toEqual({ 'ILS 07': ['I07-Y'] })
  })

  it('uses a user label as the button when set', () => {
    expect(groupKeyFor('SID', 'TEST1D', { label: 'MY SIDS' })).toBe('MY SIDS')
    expect(groupKeyFor('SID', 'TEST1D', {})).toBe('TEST1')
    expect(groupKeyFor('APPCH', 'R25', { type: 'RNAV', runway: '25' })).toBe('RNAV 25')
    expect(groupKeyFor('APPCH', 'X', { type: 'TCN' })).toBe('TACAN CIRC')
  })
})

describe('mergeProcedures', () => {
  it('returns the navdata untouched when the airport has no user procedures', () => {
    expect(mergeProcedures(UGKO, [userProc({ icao: 'UGTB' })], 'UGKO')).toBe(UGKO)
    expect(mergeProcedures(null, [], 'UGKO')).toBeNull()
  })

  it('adds user procedures and replaces same-name navdata ones', () => {
    const merged = mergeProcedures(UGKO, [
      userProc(),
      userProc({ category: 'APPCH', name: 'I07-Y', type: 'ILS', runway: '07', label: 'MY ILS' }),
    ], 'UGKO')
    expect(Object.keys(merged.SID)).toEqual(['ALIK1D', 'TEST1D'])
    expect(merged.SID.TEST1D).toMatchObject({ user: true })
    expect(merged.APPCH['I07-Y']).toMatchObject({ user: true, runway: '07', label: 'MY ILS' })
    expect(UGKO.SID.TEST1D).toBeUndefined()   // base not mutated
    expect(buildGroups(merged).appchGroups).toEqual({ 'MY ILS': ['I07-Y'] })
  })

  it('works for an airport with no navdata', () => {
    const merged = mergeProcedures(null, [userProc()], 'UGKO')
    expect(merged.SID.TEST1D.transitions['25']).toHaveLength(2)
    expect(merged.STAR).toEqual({})
  })
})

describe('resolveLegs', () => {
  const lookupFix = makeFixLookup([[{ id: 'kts', lat: 42.175722, lon: 42.484806 }], [{ id: 'KTS', lat: 0, lon: 0 }]])

  it('resolves fix, coordinate and course/distance legs', () => {
    const origin = { lat: 42.17, lon: 42.48 }
    const { legs, errors } = resolveLegs([
      { kind: 'crs', ident: '', crs: '0', dist: '10', alt_desc: '+', alt1: '3000' },
      { kind: 'fix', ident: 'kts', spd: '210', spd_type: '-' },
      { kind: 'coord', ident: 'wp1', lat: '42.3', lon: '42.7', turn: 'R', missed: true },
    ], { lookupFix, origin })
    expect(errors).toEqual([])
    expect(legs[1]).toEqual({ lat: 42.175722, lon: 42.484806, id: 'KTS', fix: 'KTS', spd: 210, spd_type: '-' })
    expect(legs[2]).toEqual({ lat: 42.3, lon: 42.7, id: 'WP1', turn: 'R', missed: true })

    // 000° magnetic for 10 NM from the origin, with no theatre grid params.
    const { trueBearingDeg, rangeNm } = trueBearingRangeNm(origin.lat, origin.lon, legs[0].lat, legs[0].lon)
    expect(rangeNm).toBeCloseTo(10, 1)
    const mag = toMagneticFromTrue(trueBearingDeg, computeMagvar(origin.lat, origin.lon))
    expect(Math.min(mag, 360 - mag)).toBeCloseTo(0, 0)
    expect(legs[0]).toMatchObject({ crs: 0, dist: 10, alt_desc: '+', alt1: 3000 })
  })

  it('reports unresolvable legs', () => {
    const { legs, errors } = resolveLegs([
      { kind: 'crs', crs: '90', dist: '5' },
      { kind: 'fix', ident: 'NOPE' },
      { kind: 'coord', lat: '95', lon: '0' },
    ], { lookupFix })
    expect(legs).toEqual([])
    expect(errors).toEqual([
      'Leg 1: course/distance needs a previous point or a runway',
      'Leg 2: unknown fix NOPE',
      'Leg 3: invalid latitude/longitude',
    ])
  })

  it('round-trips a stored leg through the builder', () => {
    const leg = UGKO.SID.ALIK1D.transitions['07'][2]
    const { legs } = resolveLegs([legToSpec(leg)], {})
    expect(legs[0]).toEqual(leg)
  })
})

describe('procedure files', () => {
  it('reads a navdata airport file, taking the ICAO from the file name', () => {
    const cands = parseProcedureJson('ugko.json', UGKO)
    expect(cands.map((c) => `${c.icao} ${c.category} ${c.name}`)).toEqual([
      'UGKO SID ALIK1D', 'UGKO STAR ALIK1C', 'UGKO APPCH I07-Y',
    ])
    expect(cands[2]).toMatchObject({ type: 'ILS', runway: '07' })
  })

  it('reads single procedures, alone or in an array', () => {
    const one = { airport: 'ugko', category: 'star', name: 'x1a', transitions: { '': [] } }
    expect(parseProcedureJson('a.json', one)).toEqual([expect.objectContaining({ icao: 'UGKO', category: 'STAR', name: 'x1a' })])
    expect(parseProcedureJson('a.json', [one, one])).toHaveLength(2)
  })

  it('ignores other JSON', () => {
    expect(parseProcedureJson('a.json', { type: 'FeatureCollection', features: [] })).toBeNull()
    expect(parseProcedureJson('a.json', { name: 'layer', drawings: [] })).toBeNull()
  })

  it('round-trips through export', () => {
    const procs = parseProcedureJson('UGKO.json', UGKO).map((c) => finalizeProc({ ...c, label: c.name === 'ALIK1D' ? 'alik' : '' }))
    const exported = exportAirport(procs, 'UGKO')
    expect(exported.SID.ALIK1D).toEqual({ type: 'GPS', label: 'ALIK', transitions: UGKO.SID.ALIK1D.transitions })
    expect(exported.APPCH['I07-Y']).toEqual(UGKO.APPCH['I07-Y'])
  })

  it('turns GeoJSON lines into procedures, naming vertices near known fixes', async () => {
    const nearestFix = makeNearestFix([[{ id: 'KTS', lat: 42.175722, lon: 42.484806 }]])
    const gj = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', properties: { name: 'vec1' },
        geometry: { type: 'LineString', coordinates: [[42.4848, 42.1757], [42.6, 42.3]] },
      }],
    }
    const file = { name: 'lines.geojson', arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(gj)).buffer }
    const { rows } = await readProcedureFiles([file], { nearestFix })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'VEC1', error: null })
    expect(rows[0].lineLegs.map((l) => l.id ?? null)).toEqual(['KTS', null])

    const sid = { ...rows[0], icao: 'UGKO', category: 'SID', runway: '07' }
    expect(Object.keys(rowTransitions(sid))).toEqual(['07'])
    expect(Object.keys(rowTransitions({ ...sid, category: 'APPCH' }))).toEqual([''])
  })
})

describe('finalizeProc', () => {
  it('normalizes and validates', () => {
    const p = finalizeProc(userProc({ icao: 'ugko', category: 'sid', name: ' test 1d ', label: 'abc', runway: '25' }))
    expect(p).toMatchObject({ icao: 'UGKO', category: 'SID', name: 'TEST1D', label: 'ABC', runway: '' })
    expect(() => finalizeProc(userProc({ icao: '' }))).toThrow(/airport/i)
    expect(() => finalizeProc(userProc({ category: 'FOO' }))).toThrow(/category/i)
    expect(() => finalizeProc(userProc({ transitions: { '': [{ lat: 1, lon: 1 }] } }))).toThrow(/two legs/i)
  })
})
