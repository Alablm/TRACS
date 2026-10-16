import { tmForward, tmInverse } from '../../utils/transverseMercator.js'
import { utmZoneNumber, utmZoneParams, mgrs100kSquareId, latBand } from '../../utils/mgrs.js'

export const TILE_SIZE = 256
const MAX_MERCATOR_LAT = 85.0511287798066
const DEFAULT_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile'
const CUSTOM_TILE_URL = 'https://maps.dcsolympus.com/maps' /** TODO: Change to TRACS host */
const TERRAIN_TILESETS = {
  caucasus: 'alt-caucasus',
  germanycw: 'alt-GermanyCW',
  marianaislands: 'alt-marianasislands',
  marianaislandswwii: 'alt-MarianaIslandsWWII',
  nevada: 'alt-nevada',
  normandy: 'alt-Normandy',
  persiangulf: 'alt-persiangulf',
  syria: 'alt-syria',
}

/**
 * Maps the terrain name to the cached tile set used by the TACAS map so it can swap between base and theater-specific imagery.
 */
function terrainTileset(terrain) {
  if (typeof terrain !== 'string') return null
  return TERRAIN_TILESETS[terrain.toLowerCase().replace(/[^a-z]/g, '')] ?? null
}

/**
 * Resolves the default fallback tile URL when the custom terrain tileset is unavailable or disabled.
 */
function defaultTileUrl(zoom, tileY, tileX) {
  return `${DEFAULT_TILE_URL}/${zoom}/${tileY}/${tileX}`
}

/**
 * Converts latitude/longitude into the Mercator world-pixel coordinates used for map tiling and screen placement.
 */
export function latLngToWorldPixel(lat, lng, zoom) {
  const size = TILE_SIZE * 2 ** zoom
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat))
  const sinLat = Math.sin(clampedLat * Math.PI / 180)
  return {
    x: ((lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * size,
  }
}

/**
 * Inverse of latLngToWorldPixel: translates map-pixel coordinates back into geographic coordinates for world-to-screen conversions.
 */
export function worldPixelToLatLng(x, y, zoom) {
  const size = TILE_SIZE * 2 ** zoom
  const wrappedX = ((x % size) + size) % size
  const clampedY = Math.max(0, Math.min(size, y))
  const n = Math.PI - (2 * Math.PI * clampedY) / size
  return {
    lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    lng: (wrappedX / size) * 360 - 180,
  }
}

/**
 * Enumerates the tile set needed to cover the current viewport, including the fallback imagery used when custom terrain tiles fail.
 */
export function visibleTiles(width, height, center, zoom, terrain) {
  if (width <= 0 || height <= 0) return []
  const centerPixel = latLngToWorldPixel(center.lat, center.lng, zoom)
  const tileset = terrainTileset(terrain)
  const minX = Math.floor((centerPixel.x - width / 2) / TILE_SIZE)
  const maxX = Math.floor((centerPixel.x + width / 2) / TILE_SIZE)
  const minY = Math.max(0, Math.floor((centerPixel.y - height / 2) / TILE_SIZE))
  const maxY = Math.min(2 ** zoom - 1, Math.floor((centerPixel.y + height / 2) / TILE_SIZE))
  const tiles = []

  for (let tileX = minX; tileX <= maxX; tileX++) {
    for (let tileY = minY; tileY <= maxY; tileY++) {
      const wrappedX = ((tileX % (2 ** zoom)) + (2 ** zoom)) % (2 ** zoom)
      const fallbackUrl = defaultTileUrl(zoom, tileY, wrappedX)
      tiles.push({
        key: `${zoom}/${tileX}/${tileY}`,
        url: tileset
          ? `${CUSTOM_TILE_URL}/${tileset}/${zoom}/${wrappedX}/${tileY}.png`
          : fallbackUrl,
        fallbackUrl: tileset ? fallbackUrl : null,
        left: tileX * TILE_SIZE - centerPixel.x + width / 2,
        top: tileY * TILE_SIZE - centerPixel.y + height / 2,
      })
    }
  }
  return tiles
}

/**
 * Projects a latitude/longitude point onto screen coordinates so markers and UI elements stay aligned with the map center.
 */
export function pointToScreen(lat, lng, center, zoom, width, height) {
  const worldSize = TILE_SIZE * 2 ** zoom
  const point = latLngToWorldPixel(lat, lng, zoom)
  const centerPixel = latLngToWorldPixel(center.lat, center.lng, zoom)
  let dx = point.x - centerPixel.x
  if (dx > worldSize / 2) dx -= worldSize
  if (dx < -worldSize / 2) dx += worldSize
  return { x: width / 2 + dx, y: height / 2 + point.y - centerPixel.y }
}

const MGRS_SQUARE_SIZE = 100000
const MGRS_BANDS = 'CDEFGHJKLMNPQRSTUVWX'

export function mgrsGridSpacingForZoom(zoom) {
  if (zoom <= 6) return null
  if (zoom <= 9) return MGRS_SQUARE_SIZE
  return MGRS_SQUARE_SIZE / (10 ** Math.min(zoom - 9, 5))
}

function normalizeLongitude(lng) {
  return ((lng + 180) % 360 + 360) % 360 - 180
}

function unwrapLongitude(lng, referenceLng) {
  let result = lng
  while (result - referenceLng > 180) result -= 360
  while (result - referenceLng < -180) result += 360
  return result
}

function gridZoneForIndex(zoneIndex) {
  return ((zoneIndex % 60) + 60) % 60 + 1
}

function gridBandIndex(lat) {
  return Math.max(0, Math.min(MGRS_BANDS.length - 1, Math.floor((lat + 80) / 8)))
}

function gridLinePath(fixed, start, end, vertical, params, center, zoom, width, height) {
  const path = []
  const steps = zoom >= 12 ? 1 : zoom >= 10 ? 4 : 12
  for (let index = 0; index <= steps; index++) {
    const varying = start + ((end - start) * index) / steps
    const easting = vertical ? fixed : varying
    const northing = vertical ? varying : fixed
    const { lat, lng } = tmInverse(easting, northing, params)
    const point = pointToScreen(lat, lng, center, zoom, width, height)
    path.push(`${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
  }
  return path.join(' ')
}

function zoneBandPath(westLng, eastLng, southLat, northLat, center, zoom, width, height) {
  const corners = [
    [southLat, westLng],
    [southLat, eastLng],
    [northLat, eastLng],
    [northLat, westLng],
  ].map(([lat, lng]) => pointToScreen(lat, lng, center, zoom, width, height))
  const d = `${corners.map((point, index) =>
    `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`
  ).join(' ')} Z`
  return { corners, d }
}

/**
 * Builds MGRS zone, square, and precision-grid geometry in map-screen pixels.
 */
export function mgrsGridForView(center, zoom, width, height) {
  if (width <= 0 || height <= 0) return { lines: [], labels: [], clips: [], zoneLabel: null }

  const centerPixel = latLngToWorldPixel(center.lat, center.lng, zoom)
  const screenSamples = [
    [0, 0], [width / 2, 0], [width, 0],
    [0, height / 2], [width, height / 2],
    [0, height], [width / 2, height], [width, height],
  ].map(([x, y]) => {
    const point = worldPixelToLatLng(centerPixel.x + x - width / 2, centerPixel.y + y - height / 2, zoom)
    return { ...point, lng: unwrapLongitude(point.lng, center.lng) }
  })
  const minLat = Math.max(-80, Math.min(...screenSamples.map(({ lat }) => lat)))
  const maxLat = Math.min(84, Math.max(...screenSamples.map(({ lat }) => lat)))
  const minLng = Math.min(...screenSamples.map(({ lng }) => lng))
  const maxLng = Math.max(...screenSamples.map(({ lng }) => lng))
  const zoneLabel = center.lat >= -80 && center.lat < 84
    ? `${utmZoneNumber(center.lng)}${latBand(center.lat)}`
    : null
  if (minLat >= maxLat || minLng >= maxLng) return { lines: [], labels: [], clips: [], zoneLabel }

  const lines = []
  const labels = []
  const clips = []
  const spacing = mgrsGridSpacingForZoom(zoom)
  const firstZoneIndex = Math.floor((minLng + 180) / 6)
  const lastZoneIndex = Math.floor((maxLng + 180 - 1e-10) / 6)
  const firstBand = gridBandIndex(minLat)
  const lastBand = gridBandIndex(maxLat - 1e-10)

  for (let zoneIndex = firstZoneIndex; zoneIndex <= lastZoneIndex; zoneIndex++) {
    const zone = gridZoneForIndex(zoneIndex)
    const westLng = -180 + zoneIndex * 6
    const eastLng = westLng + 6
    const visibleWest = Math.max(minLng, westLng)
    const visibleEast = Math.min(maxLng, eastLng)
    for (let bandIndex = firstBand; bandIndex <= lastBand; bandIndex++) {
      const band = MGRS_BANDS[bandIndex]
      const southLat = -80 + bandIndex * 8
      const northLat = band === 'X' ? 84 : southLat + 8
      const visibleSouth = Math.max(minLat, southLat)
      const visibleNorth = Math.min(maxLat, northLat)
      if (visibleSouth >= visibleNorth || visibleWest >= visibleEast) continue

      const { d } = zoneBandPath(westLng, eastLng, southLat, northLat, center, zoom, width, height)
      const clipId = `tacas-mgrs-${zoneIndex}-${bandIndex}`
      const clipCorners = [
        [visibleSouth, visibleWest],
        [visibleSouth, visibleEast],
        [visibleNorth, visibleEast],
        [visibleNorth, visibleWest],
      ].map(([lat, lng]) => pointToScreen(lat, lng, center, zoom, width, height))
      clips.push({
        id: clipId,
        d: `${clipCorners.map((point, index) =>
          `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`
        ).join(' ')} Z`,
      })

      const zoneCenter = pointToScreen((southLat + northLat) / 2, (westLng + eastLng) / 2, center, zoom, width, height)
      if (spacing === null) {
        lines.push({ d, major: true, clipId, zoneBoundary: true })
        if (zoneCenter.x >= -30 && zoneCenter.x <= width + 30 &&
            zoneCenter.y >= -30 && zoneCenter.y <= height + 30) {
          labels.push({ x: zoneCenter.x, y: zoneCenter.y, text: `${zone}${band}`, zone: true })
        }
        continue
      }
      lines.push({ d, major: true, clipId, zoneBoundary: true })

      const hemisphere = (southLat + northLat) / 2 < 0 ? 'S' : 'N'
      const params = utmZoneParams(zone, hemisphere)
      const clippedCorners = [
        [visibleSouth, visibleWest],
        [visibleSouth, visibleEast],
        [visibleNorth, visibleEast],
        [visibleNorth, visibleWest],
      ].map(([lat, lng]) => tmForward(lat, normalizeLongitude(lng), params))
      const eastings = clippedCorners.map(({ easting }) => easting)
      const northings = clippedCorners.map(({ northing }) => northing)
      const minEasting = Math.min(...eastings)
      const maxEasting = Math.max(...eastings)
      const minNorthing = Math.min(...northings)
      const maxNorthing = Math.max(...northings)
      const majorPaths = []
      const minorPaths = []

      for (let easting = Math.floor(minEasting / spacing) * spacing;
        easting <= Math.ceil(maxEasting / spacing) * spacing; easting += spacing) {
        const path = gridLinePath(easting, minNorthing - spacing, maxNorthing + spacing, true, params, center, zoom, width, height)
        if (easting % MGRS_SQUARE_SIZE === 0) majorPaths.push(path)
        else minorPaths.push(path)
      }
      for (let northing = Math.floor(minNorthing / spacing) * spacing;
        northing <= Math.ceil(maxNorthing / spacing) * spacing; northing += spacing) {
        const path = gridLinePath(northing, minEasting - spacing, maxEasting + spacing, false, params, center, zoom, width, height)
        if (northing % MGRS_SQUARE_SIZE === 0) majorPaths.push(path)
        else minorPaths.push(path)
      }
      if (majorPaths.length) lines.push({ d: majorPaths.join(' '), major: true, clipId })
      if (minorPaths.length) lines.push({ d: minorPaths.join(' '), major: false, clipId })

      for (let easting = Math.floor(minEasting / MGRS_SQUARE_SIZE) * MGRS_SQUARE_SIZE;
        easting < Math.ceil(maxEasting / MGRS_SQUARE_SIZE) * MGRS_SQUARE_SIZE; easting += MGRS_SQUARE_SIZE) {
        for (let northing = Math.floor(minNorthing / MGRS_SQUARE_SIZE) * MGRS_SQUARE_SIZE;
          northing < Math.ceil(maxNorthing / MGRS_SQUARE_SIZE) * MGRS_SQUARE_SIZE; northing += MGRS_SQUARE_SIZE) {
          const labelEasting = (Math.max(easting, minEasting) + Math.min(easting + MGRS_SQUARE_SIZE, maxEasting)) / 2
          const labelNorthing = (Math.max(northing, minNorthing) + Math.min(northing + MGRS_SQUARE_SIZE, maxNorthing)) / 2
          const { lat, lng } = tmInverse(labelEasting, labelNorthing, params)
          const point = pointToScreen(lat, lng, center, zoom, width, height)
          if (point.x < -30 || point.x > width + 30 || point.y < -30 || point.y > height + 30) continue
          labels.push({
            x: point.x,
            y: point.y,
            text: mgrs100kSquareId(zone, labelEasting, labelNorthing),
            clipId,
          })
        }
      }
    }
  }

  return { lines, labels, clips, zoneLabel }
}