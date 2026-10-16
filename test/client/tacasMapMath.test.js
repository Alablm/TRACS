import { describe, expect, it } from 'vitest'
import {
  latLngToWorldPixel,
  mgrsGridForView,
  mgrsGridSpacingForZoom,
  pointToScreen,
  visibleTiles,
  worldPixelToLatLng,
} from '../../client/src/modules/tacas/mapMath.js'

describe('TACAS map projection', () => {
  it('round-trips geographic coordinates through Web Mercator pixels', () => {
    const point = { lat: 37.5, lng: -122.2 }
    const pixel = latLngToWorldPixel(point.lat, point.lng, 8)
    const result = worldPixelToLatLng(pixel.x, pixel.y, 8)
    expect(result.lat).toBeCloseTo(point.lat, 8)
    expect(result.lng).toBeCloseTo(point.lng, 8)
  })

  it('places the map center at the viewport center and wraps tiles at the date line', () => {
    expect(pointToScreen(0, 0, { lat: 0, lng: 0 }, 4, 800, 600)).toEqual({ x: 400, y: 300 })
    const tiles = visibleTiles(300, 200, { lat: 0, lng: 179.9 }, 2)
    expect(tiles.some((tile) => tile.url.endsWith('/2/2/0'))).toBe(true)
  })

  it('selects the tileset for the active terrain and retains Esri as tile fallback', () => {
    const tiles = visibleTiles(300, 200, { lat: 35, lng: 35 }, 5, 'Syria')
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.every((tile) => tile.url.startsWith('https://maps.dcsolympus.com/maps/alt-syria/'))).toBe(true)
    expect(tiles.every((tile) => tile.fallbackUrl.startsWith('https://server.arcgisonline.com/'))).toBe(true)
  })

  it('uses Esri as the default for terrains without a custom tileset', () => {
    const tiles = visibleTiles(300, 200, { lat: 35, lng: 35 }, 5, 'Sinai')
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.every((tile) => tile.url.startsWith('https://server.arcgisonline.com/'))).toBe(true)
    expect(tiles.every((tile) => tile.fallbackUrl === null)).toBe(true)
  })

  it('generates a labeled MGRS grid for a visible map area', () => {
    const grid = mgrsGridForView({ lat: 41.5, lng: 43.5 }, 8, 800, 600)

    expect(grid.zoneLabel).toBe('38T')
    expect(grid.lines.length).toBeGreaterThan(0)
    expect(grid.lines.some((line) => line.major)).toBe(true)
    expect(grid.labels.length).toBeGreaterThan(0)
    expect(grid.labels.every((label) => /^[A-HJ-NP-Z]{2}$/.test(label.text))).toBe(true)
  })

  it('shows only labeled grid-zone-designator squares through zoom 6', () => {
    const grid = mgrsGridForView({ lat: 41.5, lng: 43.5 }, 6, 800, 600)

    expect(grid.zoneLabel).toBe('38T')
    expect(grid.lines.length).toBeGreaterThan(0)
    expect(grid.lines.every((line) => line.zoneBoundary)).toBe(true)
    expect(grid.labels.some((label) => label.text === '38T')).toBe(true)
  })

  it('retains 100km square identifiers and adds finer grid lines from zoom 7 onward', () => {
    for (const zoom of [7, 8, 9, 10]) {
      const grid = mgrsGridForView({ lat: 41.5, lng: 43.5 }, zoom, 800, 600)
      expect(grid.labels.length).toBeGreaterThan(0)
      expect(grid.labels.every((label) => /^[A-HJ-NP-Z]{2}$/.test(label.text))).toBe(true)
      expect(grid.lines.some((line) => line.major && !line.zoneBoundary)).toBe(true)
    }
  })

  it('adds one decimal digit of grid precision at each zoom from 10, capped at 1m', () => {
    expect([6, 7, 9, 10, 11, 12, 13, 14, 19].map(mgrsGridSpacingForZoom)).toEqual([
      null, 100000, 100000, 10000, 1000, 100, 10, 1, 1,
    ])
  })
})