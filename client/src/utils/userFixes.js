// Pure helpers for user-added fixes: ID normalization, upsert-by-ID, and the
// merge that layers a theatre's user fixes over its navdata fixes.

export function normalizeFixId(id) {
  return String(id ?? '').trim().toUpperCase()
}

export function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

// Returns a new list, sorted by ID, with `incoming` fixes replacing any
// existing fix of the same (normalized) ID — a re-import updates in place.
// Entries without a usable ID or position are dropped.
export function upsertFixList(current, incoming) {
  const byId = new Map(current.map((f) => [f.id, f]))
  for (const f of incoming) {
    const id  = normalizeFixId(f.id)
    const lat = Number(f.lat)
    const lon = Number(f.lon)
    if (!id || !isValidLatLon(lat, lon)) continue
    byId.set(id, { id, lat, lon, source: f.source ?? null })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// User fixes first, so lookups that take the first ID match resolve to the
// user's position; navdata fixes sharing a user fix's ID are left out.
export function mergeFixes(userFixes, baseFixes) {
  if (!userFixes?.length) return baseFixes
  const ids = new Set(userFixes.map((f) => f.id))
  return [
    ...userFixes.map((f) => ({ id: f.id, lat: f.lat, lon: f.lon, user: true })),
    ...baseFixes.filter((f) => !ids.has(normalizeFixId(f.id))),
  ]
}
