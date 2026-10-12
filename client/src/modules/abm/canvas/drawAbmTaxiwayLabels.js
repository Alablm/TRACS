/**
 * Taxiway designators (OSM-derived anchors from airports_taxiway_labels.json)
 * drawn over the .taxiways airport polygons. Shown under the same `.labels`
 * toggle as airspace/fix/drawing names. Skipped past TWY_LABEL_MAX_RANGE_NM:
 * further out a whole airport is a few pixels across and the de-clutter
 * would keep one arbitrary label per field.
 */

import { latLngToCanvas } from '../../../utils/projection.js'
import { declutterLabels } from '../../../canvas/declutterLabels.js'

const TWY_LABEL_MAX_RANGE_NM = 5
const CULL_MARGIN = 20
const LABEL_COLOR = 'rgba(200,200,200,0.85)'

export function drawAbmTaxiwayLabels(ctx, view, labels, visible, csMap = 2) {
  if (!visible || !labels?.length || view.rangeNm > TWY_LABEL_MAX_RANGE_NM) return
  const { width, height } = view

  const candidates = []
  for (const l of labels) {
    const { x, y } = latLngToCanvas(l.lat, l.lon, view)
    if (x < -CULL_MARGIN || x > width + CULL_MARGIN || y < -CULL_MARGIN || y > height + CULL_MARGIN) continue
    candidates.push({ text: l.ref, x, y, priority: l.runM })
  }
  if (!candidates.length) return

  const fontPx = 6 + csMap * 2
  ctx.save()
  ctx.font = `${fontPx}px "Roboto Mono", monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = LABEL_COLOR
  for (const l of declutterLabels(ctx, candidates, fontPx)) ctx.fillText(l.text, l.x, l.y)
  ctx.restore()
}
