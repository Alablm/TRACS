import { describe, it, expect, beforeAll } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { zipSync, strToU8 } from 'fflate'
import { parseKml } from '../../client/src/utils/parseKml.js'
import {
  readImportFiles, parseFixCsv, finalizeRow, outsideShare,
} from '../../client/src/utils/userNavdataImport.js'

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Test Doc</name>
    <Folder>
      <Placemark><name>ALPHA</name><Point><coordinates>37.5,44.25,0</coordinates></Point></Placemark>
      <Placemark><name>Route</name><LineString><coordinates>37,44 37.5,44.5 38,44.2</coordinates></LineString></Placemark>
      <Placemark>
        <name>Zone</name>
        <Polygon>
          <outerBoundaryIs><LinearRing><coordinates>37,44 38,44 38,45 37,45 37,44</coordinates></LinearRing></outerBoundaryIs>
          <innerBoundaryIs><LinearRing><coordinates>37.4,44.4 37.6,44.4 37.6,44.6</coordinates></LinearRing></innerBoundaryIs>
        </Polygon>
      </Placemark>
      <Placemark>
        <name>Multi</name>
        <MultiGeometry>
          <Point><coordinates>36,43</coordinates></Point>
          <LineString><coordinates>36,43 36.5,43.5</coordinates></LineString>
        </MultiGeometry>
      </Placemark>
    </Folder>
  </Document>
</kml>`

const LOTATC = JSON.stringify({
  type: 'layer', name: 'URRV_NAVAIDS',
  drawings: [
    { type: 'point', name: 'BEKAS', latitude: 44.1, longitude: 39.1 },
    { type: 'line', name: 'Sector', points: [{ latitude: 44, longitude: 39 }, { latitude: 44.5, longitude: 39.5 }] },
  ],
})

const GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'wpt1' }, geometry: { type: 'Point', coordinates: [39.2, 44.2] } },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[39, 44], [39.3, 44.3]] } },
  ],
})

// Minimal File stand-in: readImportFiles only uses name + arrayBuffer().
function fakeFile(name, data) {
  const bytes = typeof data === 'string' ? strToU8(data) : data
  return { name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
}

beforeAll(() => {
  // KML parsing uses the browser DOMParser; vitest runs in plain Node.
  globalThis.DOMParser = DOMParser
})

describe('parseKml', () => {
  it('reads points, lines, polygons with holes and multigeometry', () => {
    const { name, features } = parseKml(KML, DOMParser)
    expect(name).toBe('Test Doc')
    expect(features.map((f) => f.geometry.type)).toEqual(['Point', 'LineString', 'Polygon', 'Point', 'LineString'])

    const [alpha, , zone] = features
    expect(alpha.geometry.coordinates).toEqual([37.5, 44.25])
    expect(alpha.label).toEqual(['ALPHA'])
    expect(alpha.properties.name).toBe('ALPHA')

    expect(zone.geometry.coordinates).toHaveLength(2)        // outer + hole
    expect(zone.geometry.coordinates[1]).toHaveLength(4)     // hole ring got closed
    expect(zone.label).toBeNull()
  })

  it('rejects files without geometry', () => {
    expect(() => parseKml('<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>', DOMParser)).toThrow()
  })
})

describe('parseFixCsv', () => {
  it('reads ID,lat,lon rows, skipping header, comments and junk', () => {
    const fixes = parseFixCsv('id,lat,lon\n# comment\nabcde, 44.5, 39.25\n\nBAD,x,y\nXYZ;45;40\n')
    expect(fixes).toEqual([
      { id: 'ABCDE', lat: 44.5, lon: 39.25 },
      { id: 'XYZ', lat: 45, lon: 40 },
    ])
  })

  it('throws when nothing is usable', () => {
    expect(() => parseFixCsv('id,lat,lon\n')).toThrow()
  })
})

describe('readImportFiles', () => {
  it('routes LotATC, GeoJSON, KML, CSV and reports unsupported files', async () => {
    const { rows, skipped } = await readImportFiles([
      fakeFile('urrv.json', LOTATC),
      fakeFile('map.geojson', GEOJSON),
      fakeFile('doc.kml', KML),
      fakeFile('fixes.csv', 'ONE,44,39\nTWO,44.1,39.1'),
      fakeFile('notes.txt', 'hello'),
    ], 'Caucasus')

    expect(skipped).toEqual(['notes.txt'])
    const [lotatc, geo, kml, csv] = rows

    expect(lotatc.name).toBe('URRV_NAVAIDS')
    expect(lotatc.fixes.map((f) => f.id)).toEqual(['BEKAS'])
    expect(lotatc.features).toHaveLength(1)
    expect(lotatc.pointCandidates).toBe(0)

    expect(geo.name).toBe('map')
    expect(geo.pointCandidates).toBe(1)
    expect(geo.pointsAsFixes).toBe(true)
    expect(finalizeRow(geo).fixes).toEqual([{ id: 'WPT1', lat: 44.2, lon: 39.2 }])
    expect(finalizeRow(geo).features).toHaveLength(1)
    expect(finalizeRow({ ...geo, pointsAsFixes: false }).features).toHaveLength(2)

    expect(kml.name).toBe('Test Doc')
    expect(kml.pointCandidates).toBe(2)

    expect(csv.fixes).toHaveLength(2)
    expect(csv.features).toHaveLength(0)
  })

  it('expands zips (including a nested .kmz) into one row per entry', async () => {
    const kmz  = zipSync({ 'doc.kml': strToU8(KML) })
    const zip  = zipSync({
      'Caucasus/': new Uint8Array(0),
      'Caucasus/URRV.json': strToU8(LOTATC),
      'Caucasus/empty.json': strToU8(JSON.stringify({ type: 'layer', name: 'KZLA_NAVAIDS', drawings: [] })),
      'maps/doc.kmz': kmz,
      'README.md': strToU8('# readme'),
      'helper.py': strToU8('print(1)'),
      '.gitignore': strToU8('x'),
    })
    const { rows, skipped } = await readImportFiles([fakeFile('LotATC-Drawings.zip', zip)], 'Caucasus')

    expect(rows.map((r) => r.name)).toEqual(['URRV_NAVAIDS', 'KZLA_NAVAIDS', 'Test Doc'])
    expect(rows[1].error).toMatch(/empty/i)
    expect(skipped).toEqual(['README.md', 'helper.py'])
  })

  it('reports a broken file as an error row without sinking the rest', async () => {
    const { rows } = await readImportFiles([
      fakeFile('broken.geojson', '{ not json'),
      fakeFile('ok.csv', 'ONE,44,39'),
    ], 'Caucasus')
    expect(rows[0].error).toBeTruthy()
    expect(rows[1].error).toBeNull()
  })
})

describe('closed lines as polygons', () => {
  const sector = JSON.stringify({
    type: 'layer', name: 'URRV_SECTOR',
    drawings: [
      { type: 'line', name: 'Closed', points: [
        { latitude: 44, longitude: 39 }, { latitude: 44.5, longitude: 39 }, { latitude: 44.5, longitude: 39.5 }, { latitude: 44, longitude: 39 },
      ] },
      { type: 'line', name: 'Open', points: [{ latitude: 44, longitude: 39 }, { latitude: 44.5, longitude: 39.5 }] },
    ],
  })

  it('offers closed lines as polygons, on by default, and converts only those', async () => {
    const { rows: [row] } = await readImportFiles([fakeFile('URRV_SECTOR.json', sector)], 'Caucasus')
    expect(row.closedLineCandidates).toBe(1)
    expect(row.closedLinesAsPolygons).toBe(true)

    const converted = finalizeRow(row).features
    expect(converted.map((f) => f.geometry.type)).toEqual(['Polygon', 'LineString'])
    expect(converted[0].geometry.coordinates[0]).toHaveLength(4)

    expect(finalizeRow({ ...row, closedLinesAsPolygons: false }).features.map((f) => f.geometry.type))
      .toEqual(['LineString', 'LineString'])
  })
})

describe('outsideShare', () => {
  it('measures how much of a row falls outside a theatre bbox', () => {
    const row = {
      fixes: [{ id: 'A', lat: 44, lon: 39 }, { id: 'B', lat: 10, lon: 10 }],
      features: [{ bbox: [38, 43, 40, 45] }, { bbox: [-120, 35, -119, 36] }],
    }
    expect(outsideShare(row, [33, 40, 50, 47])).toBe(0.5)
    expect(outsideShare(row, null)).toBeNull()
    expect(outsideShare({ fixes: [], features: [] }, [0, 0, 1, 1])).toBeNull()
  })
})
