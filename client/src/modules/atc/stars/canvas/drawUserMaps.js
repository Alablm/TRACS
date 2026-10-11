import { latLngToCanvas, screenBoundsOfBbox } from '../../../../utils/projection.js'

const FALLBACK_COLOR = '#DDDDDD'
const CULL_MARGIN    = 50

/**
 * User-imported video maps (store/userNavdata.js). Styled by the active
 * palette's CUSTOM entry — stroke colour, dash (in nm, like every airspace
 * category) and fill colour — never the source file's own styling, at MAP A
 * or MAP B brightness per the map's `group`. Polygons fill only when the
 * scope's polygon fill is on, the same setting drawMaps uses. Point features
 * with a label draw as text, part of the map itself (not gated by LBL).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}   view       { centerLat, centerLng, pixelsPerNm, width, height, ... }
 * @param {object[]} userMaps   [{ id, group, features }]
 * @param {object}   visible    maps store visibility; a map shows when visible[`U:${id}`]
 * @param {number}   briteMapA  0–100
 * @param {number}   briteMapB  0–100
 * @param {number}   csMap      0–5 (0 = no text)
 * @param {object}   colors     active palette { [category]: { stroke, fill, dash } }
 * @param {number}   polygonFill 0–100 fill opacity percent (0 = no fill)
 */
export function drawUserMaps(ctx, view, userMaps, visible, briteMapA, briteMapB, csMap, colors, polygonFill = 0) {
  if (!userMaps?.length) return
  const entry = colors?.CUSTOM
  const color = entry?.stroke ?? FALLBACK_COLOR
  const fill  = entry?.fill ?? color
  const dash  = (entry?.dash ?? []).map((v) => v * view.pixelsPerNm)

  for (const map of userMaps) {
    if (!visible[`U:${map.id}`]) continue
    const brite = map.group === 'B' ? briteMapB : briteMapA
    const alpha = Math.max(0, Math.min(1, (brite ?? 50) / 100))
    if (alpha <= 0) continue

    const onScreen = map.features.filter((f) => f.bbox && inView(f.bbox, view))
    if (!onScreen.length) continue

    if (polygonFill > 0) {
      ctx.globalAlpha = alpha * (polygonFill / 100)
      ctx.fillStyle   = fill
      // One fill per polygon: evenodd leaves its holes unfilled, and keeping
      // polygons in separate paths stops overlapping ones (nested sectors)
      // from cancelling each other out.
      for (const f of onScreen) {
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates]
          : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates
            : []
        for (const rings of polys) {
          ctx.beginPath()
          for (const ring of rings) traceLine(ctx, view, ring)
          ctx.fill('evenodd')
        }
      }
    }

    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.lineWidth   = 1.0
    ctx.setLineDash(dash)
    ctx.beginPath()
    for (const f of onScreen) traceGeometry(ctx, view, f.geometry)
    ctx.stroke()
    ctx.setLineDash([])

    if (csMap > 0) {
      const fontSize = 6 + csMap * 2
      const lineH    = fontSize + 3
      ctx.font         = `${fontSize}px "Roboto Mono", monospace`
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle    = color
      for (const f of onScreen) {
        if (f.geometry.type !== 'Point' || !f.label?.length) continue
        const [lng, lat] = f.geometry.coordinates
        const { x, y } = latLngToCanvas(lat, lng, view)
        f.label.forEach((line, i) => {
          ctx.fillText(line, x, y + (i - (f.label.length - 1) / 2) * lineH)
        })
      }
    }
    ctx.globalAlpha = 1.0
  }
}

function traceLine(ctx, view, coords) {
  coords.forEach(([lng, lat], i) => {
    const { x, y } = latLngToCanvas(lat, lng, view)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
}

function traceGeometry(ctx, view, geometry) {
  switch (geometry.type) {
    case 'LineString':
      traceLine(ctx, view, geometry.coordinates)
      break
    case 'MultiLineString':
      for (const line of geometry.coordinates) traceLine(ctx, view, line)
      break
    case 'Polygon':
      for (const ring of geometry.coordinates) traceLine(ctx, view, ring)
      break
    case 'MultiPolygon':
      for (const poly of geometry.coordinates) for (const ring of poly) traceLine(ctx, view, ring)
      break
  }
}

function inView(bbox, view) {
  const b = screenBoundsOfBbox(bbox, view)
  return !(b.x1 < -CULL_MARGIN || b.x0 > view.width + CULL_MARGIN || b.y1 < -CULL_MARGIN || b.y0 > view.height + CULL_MARGIN)
}
