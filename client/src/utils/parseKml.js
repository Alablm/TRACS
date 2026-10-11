// Parses KML (Google Earth) text into normalized
// {geometry, properties, bbox, label} features — the shape parseGeojson.js
// produces. Reads every Placemark's Point / LineString / LinearRing /
// Polygon, including ones nested in MultiGeometry; styling is ignored.
// Points carry their Placemark <name> as both `properties.name` and label,
// so the importer can offer them as fixes.
//
// `DomParserImpl` defaults to the browser's DOMParser; tests pass
// @xmldom/xmldom's, since vitest runs in plain Node.

import { computeBbox } from './parseGeojson.js'

const GEOMETRY_TAGS = new Set(['Point', 'LineString', 'LinearRing', 'Polygon', 'MultiGeometry'])

function localName(node) {
  return node.localName ?? String(node.nodeName ?? '').split(':').pop()
}

function childElements(node, name = null) {
  const out = []
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && (name === null || localName(c) === name)) out.push(c)
  }
  return out
}

function firstChild(node, name) {
  return childElements(node, name)[0] ?? null
}

function descendants(node, name) {
  return Array.from(node.getElementsByTagNameNS('*', name))
}

// "lon,lat[,alt] lon,lat[,alt] ..." → [[lon, lat], ...]; malformed tuples dropped.
function parseCoordinates(el) {
  if (!el) return []
  const out = []
  for (const tuple of (el.textContent ?? '').trim().split(/\s+/)) {
    const [lon, lat] = tuple.split(',').map(Number)
    if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      out.push([lon, lat])
    }
  }
  return out
}

function closeRing(ring) {
  if (ring.length < 3) return null
  const [a, b] = [ring[0], ring[ring.length - 1]]
  if (a[0] !== b[0] || a[1] !== b[1]) ring.push(a)
  return ring.length >= 4 ? ring : null
}

function collectGeometries(el, out) {
  switch (localName(el)) {
    case 'Point': {
      const [c] = parseCoordinates(firstChild(el, 'coordinates'))
      if (c) out.push({ type: 'Point', coordinates: c })
      break
    }
    case 'LineString': {
      const coords = parseCoordinates(firstChild(el, 'coordinates'))
      if (coords.length >= 2) out.push({ type: 'LineString', coordinates: coords })
      break
    }
    case 'LinearRing': {
      const ring = closeRing(parseCoordinates(firstChild(el, 'coordinates')))
      if (ring) out.push({ type: 'LineString', coordinates: ring })
      break
    }
    case 'Polygon': {
      const ringOf = (boundary) => {
        const lr = boundary && firstChild(boundary, 'LinearRing')
        return lr ? closeRing(parseCoordinates(firstChild(lr, 'coordinates'))) : null
      }
      const outer = ringOf(firstChild(el, 'outerBoundaryIs'))
      if (!outer) break
      const holes = childElements(el, 'innerBoundaryIs').map(ringOf).filter(Boolean)
      out.push({ type: 'Polygon', coordinates: [outer, ...holes] })
      break
    }
    case 'MultiGeometry':
      for (const child of childElements(el)) {
        if (GEOMETRY_TAGS.has(localName(child))) collectGeometries(child, out)
      }
      break
  }
}

// Returns { name, features }. `name` is the Document's own <name> when present.
export function parseKml(text, DomParserImpl = globalThis.DOMParser) {
  if (!DomParserImpl) throw new Error('KML parsing is not available here')
  const doc = new DomParserImpl().parseFromString(text, 'text/xml')
  if (!doc?.documentElement || descendants(doc, 'parsererror').length) {
    throw new Error('Not a valid KML file')
  }

  const features = []
  for (const pm of descendants(doc, 'Placemark')) {
    const name = (firstChild(pm, 'name')?.textContent ?? '').trim()
    const geoms = []
    for (const child of childElements(pm)) {
      if (GEOMETRY_TAGS.has(localName(child))) collectGeometries(child, geoms)
    }
    for (const geometry of geoms) {
      const isPoint = geometry.type === 'Point'
      features.push({
        geometry,
        properties: name ? { name } : {},
        bbox:  computeBbox(geometry),
        label: isPoint && name ? [name] : null,
      })
    }
  }

  if (!features.length) throw new Error('No usable geometry found in KML')
  const docEl  = descendants(doc, 'Document')[0]
  const docName = docEl ? (firstChild(docEl, 'name')?.textContent ?? '').trim() : ''
  return { name: docName || null, features }
}
