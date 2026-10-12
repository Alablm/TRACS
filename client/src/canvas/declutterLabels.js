/**
 * Greedy screen-space label de-clutter. Labels are tried in priority order
 * (highest first); one whose box would overlap an already-placed box is
 * dropped. Expects ctx.font to be set already, since boxes come from
 * measureText.
 *
 * labels: [{ text, x, y, priority }] with x/y the label's center in canvas px.
 * Returns the placed subset, each with its box { x0, y0, x1, y1 }.
 */
export function declutterLabels(ctx, labels, fontPx, padPx = 2) {
  const sorted = [...labels].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const placed = []
  for (const l of sorted) {
    const halfW = ctx.measureText(l.text).width / 2 + padPx
    const halfH = fontPx / 2 + padPx
    const box = { x0: l.x - halfW, y0: l.y - halfH, x1: l.x + halfW, y1: l.y + halfH }
    const hit = placed.some(p =>
      box.x0 < p.box.x1 && box.x1 > p.box.x0 && box.y0 < p.box.y1 && box.y1 > p.box.y0)
    if (!hit) placed.push({ ...l, box })
  }
  return placed
}
