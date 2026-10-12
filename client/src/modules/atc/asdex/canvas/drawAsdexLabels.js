import { latLngToCanvas } from '../../../../utils/projection.js'
import { declutterLabels } from '../../../../canvas/declutterLabels.js'

const FONT_PX = 11
const RUNWAY_LABEL_OFFSET_PX = 14  // beyond the threshold, along the runway axis
const CULL_MARGIN = 20

/**
 * Taxiway labels (OSM-derived anchors from airports_taxiway_labels.json) and
 * runway-end designators, drawn on the surface canvas. Runway ends always
 * win the de-clutter; among taxiways the longer matched stretch wins.
 *
 * taxiwayLabels: [{ ref, lat, lon, runM }]
 * runwayEnds:    [{ name, lat, lon, otherLat, otherLon }]
 */
export function drawAsdexLabels(ctx, view, taxiwayLabels, runwayEnds, colors) {
  const { width, height } = view
  const inView = (x, y) => x >= -CULL_MARGIN && x <= width + CULL_MARGIN && y >= -CULL_MARGIN && y <= height + CULL_MARGIN

  const candidates = []
  for (const r of runwayEnds ?? []) {
    const t = latLngToCanvas(r.lat, r.lon, view)
    const o = latLngToCanvas(r.otherLat, r.otherLon, view)
    const len = Math.hypot(t.x - o.x, t.y - o.y) || 1
    const x = t.x + (t.x - o.x) / len * RUNWAY_LABEL_OFFSET_PX
    const y = t.y + (t.y - o.y) / len * RUNWAY_LABEL_OFFSET_PX
    if (inView(x, y)) candidates.push({ text: r.name, x, y, priority: Infinity, color: colors.runwayLabel ?? '#ffffff' })
  }
  for (const l of taxiwayLabels ?? []) {
    const { x, y } = latLngToCanvas(l.lat, l.lon, view)
    if (inView(x, y)) candidates.push({ text: l.ref, x, y, priority: l.runM, color: colors.taxiwayLabel ?? '#d0d0d0' })
  }
  if (!candidates.length) return

  ctx.save()
  ctx.font = `${FONT_PX}px "Roboto Mono", monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const l of declutterLabels(ctx, candidates, FONT_PX)) {
    ctx.fillStyle = l.color
    ctx.fillText(l.text, l.x, l.y)
  }
  ctx.restore()
}
