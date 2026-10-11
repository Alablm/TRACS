import { describe, it, expect } from 'vitest'
import { parseLotatc, isLotatcLayer } from '../../client/src/utils/parseLotatc.js'

// Trimmed from real LotATC drawing exports — one drawing of each type.
const layer = {
  author: 'me',
  enable: true,
  name: 'RF_KSLV',
  shared: false,
  type: 'layer',
  visible: true,
  drawings: [
    { type: 'point', name: 'mintt', text: 'MINTT', latitude: 36.712361, longitude: -115.104861, color: '#ff969696' },
    { type: 'point', name: '', text: 'JUNNO', latitude: 36.730027, longitude: -114.8795 },
    { type: 'text', name: 'MATZ_Label', text: 'SFC-50', latitude: 36.191262, longitude: -115.054461 },
    { type: 'line', name: 'Anapa CTA', points: [
      { latitude: 44.0, longitude: 37.0 }, { latitude: 44.5, longitude: 37.5 }, { latitude: 45.0, longitude: 37.2 },
    ] },
    { type: 'polygon', name: 'NTTR_MOA', points: [
      { latitude: 36.43, longitude: -115.30 }, { latitude: 36.71, longitude: -115.05 }, { latitude: 36.72, longitude: -114.60 },
    ] },
    { type: 'circle', name: 'MATZ', latitude: 36.233134, longitude: -115.034927, radius: 9260 },
    { type: 'rectangle', name: 'unknown kind' },
  ],
}

describe('parseLotatc', () => {
  it('recognises LotATC layers only', () => {
    expect(isLotatcLayer(layer)).toBe(true)
    expect(isLotatcLayer({ type: 'FeatureCollection', features: [] })).toBe(false)
    expect(isLotatcLayer(null)).toBe(false)
  })

  it('turns points into fixes, uppercased, falling back to text for the ID', () => {
    const { fixes } = parseLotatc(layer)
    expect(fixes).toEqual([
      { id: 'MINTT', lat: 36.712361, lon: -115.104861 },
      { id: 'JUNNO', lat: 36.730027, lon: -114.8795 },
    ])
  })

  it('maps lines, polygons, circles and text to features', () => {
    const { name, features, skipped } = parseLotatc(layer)
    expect(name).toBe('RF_KSLV')
    expect(features.map((f) => f.geometry.type)).toEqual(['Point', 'LineString', 'Polygon', 'Polygon'])
    expect(skipped).toEqual({ rectangle: 1 })

    const [text, line, poly, circle] = features
    expect(text.label).toEqual(['SFC-50'])
    expect(text.geometry.coordinates).toEqual([-115.054461, 36.191262])
    expect(line.geometry.coordinates).toHaveLength(3)

    const ring = poly.geometry.coordinates[0]
    expect(ring).toHaveLength(4)
    expect(ring[3]).toEqual(ring[0])

    // 9260 m = 5 NM; every vertex sits ~5 NM (5/60 deg of latitude) from the centre.
    const cRing = circle.geometry.coordinates[0]
    expect(cRing[0]).toEqual(cRing[cRing.length - 1])
    const north = cRing[0]
    expect(north[1] - 36.233134).toBeCloseTo(5 / 60, 3)
    expect(circle.bbox).toHaveLength(4)
  })

  it('keeps an existing closing vertex instead of doubling it', () => {
    const closed = parseLotatc({ type: 'layer', drawings: [{ type: 'polygon', points: [
      { latitude: 1, longitude: 1 }, { latitude: 2, longitude: 1 }, { latitude: 2, longitude: 2 }, { latitude: 1, longitude: 1 },
    ] }] })
    expect(closed.features[0].geometry.coordinates[0]).toHaveLength(4)
  })

  it('falls back to the given name for a nameless layer', () => {
    expect(parseLotatc({ type: 'layer', drawings: [] }, 'FILE').name).toBe('FILE')
  })
})
