// User-built/imported SIDs, STARs and approaches, in the same shape the
// server's navdata procedure files use (server/navdata/tools/extract-navdata.js):
//
//   { SID:   { [name]: { type, transitions: { [key]: [leg] } } },
//     STAR:  { ... },
//     APPCH: { [name]: { type, runway, transitions: { '': [final], [iaf]: [legs] } } } }
//
// A stored user procedure is one record:
//
//   { icao, category, name, type, runway, label, transitions, source, addedAt }
//
// Each leg is a navdata point ({ lat, lon, id?, alt_desc?, alt1?, alt2?, spd?,
// spd_type?, turn?, missed?, rec_* }) plus what the builder needs to edit it
// again: `fix` (the ident it was resolved from) or `crs`/`dist` (projected
// from the previous point). Everything is resolved to lat/lon when saved, so
// the scope reads user procedures exactly like navdata ones.

import { unzipSync } from 'fflate'
import { normalizeFixId, isValidLatLon } from './userFixes.js'
import { parseGeojson } from './parseGeojson.js'
import { parseKml } from './parseKml.js'
import { computeMagvar } from './magvar.js'
import { gridDestinationPoint, toTrueFromMagnetic, trueBearingRangeNm } from './bearing.js'

export const PROC_CATEGORIES = ['SID', 'STAR', 'APPCH']

const TYPE_LABELS = {
  ILS:    'ILS',     RNAV:   'RNAV',    VORDME: 'VOR/DME',
  NDB:    'NDB',     TCN:    'TACAN',   LOC:    'LOC',
  NDBDME: 'NDB/DME', VOR:   'VOR',     GNSS:   'GNSS',
  LDA:    'LDA',     LOCB:  'LOC BC',  GPS:    'GPS',
  IGS:    'IGS',
}

export const APPCH_TYPES = Object.keys(TYPE_LABELS)

// A user procedure's DCB button text is capped to what fits on two
// half-button lines, same as user video maps.
export const PROC_LABEL_MAX = 16

export function normalizeProcName(name) {
  return String(name ?? '').trim().toUpperCase().replace(/[|\s]+/g, '')
}

export function procKey(p) {
  return `${p.icao}|${p.category}|${p.name}`
}

// ── DCB grouping ───────────────────────────────────────────────────────────

function rwyNumber(runway) {
  if (!runway) return 'CIRC'
  const m = runway.match(/\d+/)
  return m ? m[0] : 'CIRC'
}

/**
 * The DCB button a procedure belongs to. A user procedure's own label wins;
 * otherwise SIDs/STARs drop their last character (ARINC's runway/variant
 * letter, so ALIK1D and ALIK1F share ALIK1) and approaches group by type +
 * runway number ("ILS 07").
 */
export function groupKeyFor(category, name, proc) {
  if (proc?.label) return proc.label
  if (category === 'APPCH') {
    const typeLabel = TYPE_LABELS[proc?.type] ?? proc?.type ?? '?'
    return `${typeLabel} ${rwyNumber(proc?.runway)}`
  }
  return name.slice(0, -1)
}

export function buildGroups(raw) {
  const groups = { SID: {}, STAR: {}, APPCH: {} }
  for (const category of PROC_CATEGORIES) {
    for (const [name, proc] of Object.entries(raw?.[category] ?? {})) {
      const key = groupKeyFor(category, name, proc)
      ;(groups[category][key] ??= []).push(name)
    }
  }
  return { sidGroups: groups.SID, starGroups: groups.STAR, appchGroups: groups.APPCH }
}

// ── Merge with navdata ─────────────────────────────────────────────────────

function toRawEntry(p) {
  const entry = { type: p.type ?? '', transitions: p.transitions, user: true }
  if (p.category === 'APPCH' && p.runway) entry.runway = p.runway
  if (p.label) entry.label = p.label
  return entry
}

/**
 * Navdata procedures for `icao` with the user's procedures for that airport
 * layered on top; a user procedure replaces a navdata one of the same name.
 * `baseRaw` may be null (no navdata for the airport). Returns `baseRaw`
 * itself when the user has nothing for this airport.
 */
export function mergeProcedures(baseRaw, userProcs, icao) {
  const mine = icao ? (userProcs ?? []).filter((p) => p.icao === icao) : []
  if (!mine.length) return baseRaw
  const out = {
    SID:   { ...baseRaw?.SID },
    STAR:  { ...baseRaw?.STAR },
    APPCH: { ...baseRaw?.APPCH },
  }
  for (const p of mine) {
    if (out[p.category]) out[p.category][p.name] = toRawEntry(p)
  }
  return out
}

// ── Legs ───────────────────────────────────────────────────────────────────

const round6 = (v) => +Number(v).toFixed(6)
const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v))

const LEG_KEYS = ['lat', 'lon', 'id', 'alt_desc', 'alt1', 'alt2', 'spd', 'spd_type', 'turn', 'missed',
  'rec_id', 'rec_lat', 'rec_lon', 'fix', 'crs', 'dist']

// Keeps only known leg fields; null when the leg has no usable position.
function cleanLeg(leg) {
  if (!leg || typeof leg !== 'object') return null
  const lat = Number(leg.lat)
  const lon = Number(leg.lon)
  if (!isValidLatLon(lat, lon)) return null
  const out = {}
  for (const k of LEG_KEYS) {
    if (leg[k] != null && leg[k] !== '' && leg[k] !== false) out[k] = leg[k]
  }
  out.lat = round6(lat)
  out.lon = round6(lon)
  if (out.id) out.id = normalizeFixId(out.id)
  return out
}

// Cleans every transition's legs and drops transitions left empty.
function cleanTransitions(transitions) {
  const out = {}
  for (const [key, legs] of Object.entries(transitions ?? {})) {
    if (!Array.isArray(legs)) continue
    const clean = legs.map(cleanLeg).filter(Boolean)
    if (clean.length) out[String(key).trim().toUpperCase()] = clean
  }
  return out
}

/** Builder row for a stored leg. */
export function legToSpec(leg) {
  const kind = leg.crs != null ? 'crs' : leg.fix ? 'fix' : 'coord'
  return {
    kind,
    ident:    leg.fix ?? leg.id ?? '',
    lat:      leg.lat != null ? String(leg.lat) : '',
    lon:      leg.lon != null ? String(leg.lon) : '',
    crs:      leg.crs != null ? String(leg.crs) : '',
    dist:     leg.dist != null ? String(leg.dist) : '',
    alt_desc: leg.alt_desc ?? '',
    alt1:     leg.alt1 != null ? String(leg.alt1) : '',
    alt2:     leg.alt2 != null ? String(leg.alt2) : '',
    spd:      leg.spd != null ? String(leg.spd) : '',
    spd_type: leg.spd_type ?? '',
    turn:     leg.turn ?? '',
    missed:   !!leg.missed,
    rec:      leg.rec_id ? { rec_id: leg.rec_id, rec_lat: leg.rec_lat, rec_lon: leg.rec_lon } : null,
  }
}

export function emptyLegSpec(kind = 'fix') {
  return { ...legToSpec({}), kind }
}

function constraintsFromSpec(s) {
  const out = {}
  if (s.alt_desc) out.alt_desc = s.alt_desc
  const alt1 = numOrNull(s.alt1)
  const alt2 = numOrNull(s.alt2)
  const spd  = numOrNull(s.spd)
  if (alt1 != null) out.alt1 = alt1
  if (alt2 != null) out.alt2 = alt2
  if (spd != null)  out.spd  = spd
  if (spd != null && s.spd_type) out.spd_type = s.spd_type
  if (s.turn) out.turn = s.turn
  if (s.missed) out.missed = true
  if (s.rec) Object.assign(out, s.rec)
  return out
}

/**
 * Resolves builder rows into stored legs.
 *   fix   — ident looked up via `lookupFix(id) → { lat, lon } | null`
 *   coord — raw lat/lon, with an optional ident
 *   crs   — magnetic course + NM from the previous point (or `origin`, the
 *           runway threshold, for a first leg), projected in the theatre's
 *           grid like every other scope bearing
 * Returns { legs, errors: [string] }.
 */
export function resolveLegs(specs, { lookupFix, origin = null, theatre = null } = {}) {
  const legs   = []
  const errors = []
  let prev = origin
  specs.forEach((s, i) => {
    const n = i + 1
    const ident = normalizeFixId(s.ident)
    let pt
    if (s.kind === 'fix') {
      const f = ident ? lookupFix?.(ident) : null
      if (!f) { errors.push(`Leg ${n}: unknown fix ${ident || '(blank)'}`); return }
      pt = { lat: round6(f.lat), lon: round6(f.lon), id: ident, fix: ident }
    } else if (s.kind === 'coord') {
      const lat = numOrNull(s.lat)
      const lon = numOrNull(s.lon)
      if (lat == null || lon == null || !isValidLatLon(lat, lon)) { errors.push(`Leg ${n}: invalid latitude/longitude`); return }
      pt = { lat: round6(lat), lon: round6(lon) }
      if (ident) pt.id = ident
    } else if (s.kind === 'crs') {
      const crs  = numOrNull(s.crs)
      const dist = numOrNull(s.dist)
      if (crs == null || crs < 0 || crs > 360) { errors.push(`Leg ${n}: course must be 0-360`); return }
      if (dist == null || dist <= 0) { errors.push(`Leg ${n}: distance must be above 0`); return }
      if (!prev) { errors.push(`Leg ${n}: course/distance needs a previous point or a runway`); return }
      const decl = computeMagvar(prev.lat, prev.lon)
      const d = gridDestinationPoint(prev.lat, prev.lon, toTrueFromMagnetic(crs, decl), dist, theatre)
      pt = { lat: round6(d.lat), lon: round6(d.lng), crs, dist }
      if (ident) pt.id = ident
    } else {
      errors.push(`Leg ${n}: unknown leg type`)
      return
    }
    const leg = { ...pt, ...constraintsFromSpec(s) }
    legs.push(leg)
    prev = leg
  })
  return { legs, errors }
}

/**
 * Fix lookup over several { id, lat, lon } lists, first match wins (pass
 * user fixes first so they override navdata, as on the scope).
 */
export function makeFixLookup(lists) {
  const byId = new Map()
  for (const list of lists) {
    for (const f of list ?? []) {
      const id = normalizeFixId(f.id)
      if (id && !byId.has(id)) byId.set(id, f)
    }
  }
  return (id) => byId.get(normalizeFixId(id)) ?? null
}

/** Ident of the closest point in `lists` within `maxNm`, or null. */
export function makeNearestFix(lists, maxNm = 0.1) {
  const all = lists.flatMap((l) => l ?? [])
  return (lat, lon) => {
    let best = null
    let bestNm = maxNm
    for (const f of all) {
      if (Math.abs(f.lat - lat) > 0.01 || Math.abs(f.lon - lon) > 0.02) continue
      const { rangeNm } = trueBearingRangeNm(lat, lon, f.lat, f.lon)
      if (rangeNm <= bestNm) { best = f; bestNm = rangeNm }
    }
    return best ? normalizeFixId(best.id) : null
  }
}

// ── Validation ─────────────────────────────────────────────────────────────

/** A save-ready procedure record from loose input, or throws with the reason. */
export function finalizeProc(p) {
  const icao     = String(p.icao ?? '').trim().toUpperCase()
  const category = String(p.category ?? '').trim().toUpperCase()
  const name     = normalizeProcName(p.name)
  if (!icao) throw new Error('Airport is required')
  if (!PROC_CATEGORIES.includes(category)) throw new Error('Category must be SID, STAR or APPCH')
  if (!name) throw new Error('Name is required')
  const transitions = cleanTransitions(p.transitions)
  const legCount = Object.values(transitions).reduce((n, legs) => n + legs.length, 0)
  if (legCount < 2) throw new Error(`${name}: needs at least two legs with positions`)
  const label  = String(p.label ?? '').trim().toUpperCase().slice(0, PROC_LABEL_MAX)
  const runway = String(p.runway ?? '').trim().toUpperCase()
  return {
    icao, category, name,
    type:   String(p.type ?? '').trim().toUpperCase(),
    runway: category === 'APPCH' ? runway : '',
    label,
    transitions,
    source: p.source ?? null,
  }
}

// ── Files ──────────────────────────────────────────────────────────────────

function baseName(path) {
  return path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function isAirportProcJson(json) {
  return isObj(json) && !json.transitions &&
    PROC_CATEGORIES.some((c) => isObj(json[c])) &&
    Object.keys(json).every((k) => PROC_CATEGORIES.includes(k))
}

const isSingleProcJson = (json) => isObj(json) && isObj(json.transitions)

/**
 * Procedure candidates from a parsed JSON file, or null when it isn't a
 * procedure file. Recognises a navdata airport file ({ SID, STAR, APPCH },
 * airport taken from an ICAO-looking file name) and single-procedure objects
 * ({ airport|icao, category, name, type?, runway?, label?, transitions }),
 * alone or in an array. Candidates are unvalidated; finalizeProc() checks them.
 */
export function parseProcedureJson(fileName, json) {
  if (isAirportProcJson(json)) {
    const fromName = baseName(fileName).toUpperCase()
    const icao = /^[A-Z0-9]{3,4}$/.test(fromName) ? fromName : ''
    const out = []
    for (const category of PROC_CATEGORIES) {
      for (const [name, proc] of Object.entries(json[category] ?? {})) {
        out.push({
          icao, category, name,
          type: proc?.type ?? '', runway: proc?.runway ?? '', label: proc?.label ?? '',
          transitions: proc?.transitions ?? {},
        })
      }
    }
    return out
  }
  const list = Array.isArray(json) && json.length && json.every(isSingleProcJson) ? json
    : isSingleProcJson(json) ? [json] : null
  if (!list) return null
  return list.map((p) => ({
    icao:     String(p.airport ?? p.icao ?? '').toUpperCase(),
    category: String(p.category ?? '').toUpperCase(),
    name:     p.name ?? '',
    type:     p.type ?? '',
    runway:   p.runway ?? '',
    label:    p.label ?? '',
    transitions: p.transitions,
  }))
}

let _rowSeq = 0
const nextKey = () => `proc${++_rowSeq}`

function procRow(fileName, cand) {
  return { key: nextKey(), fileName, error: null, lineLegs: null, ...cand, name: normalizeProcName(cand.name) }
}

function errorRow(fileName, err) {
  return {
    key: nextKey(), fileName, error: err?.message ?? String(err),
    icao: '', category: '', name: '', type: '', runway: '', label: '', transitions: {}, lineLegs: null,
  }
}

/**
 * One import row per LineString (each part of a MultiLineString counts as
 * its own line): its vertices become legs, named after any fix within
 * 0.1 NM (`nearestFix(lat, lon) → ident | null`).
 */
function rowsFromLines(fileName, features, nearestFix) {
  const rows = []
  let n = 0
  for (const f of features) {
    const g = f.geometry
    const parts = g?.type === 'LineString' ? [g.coordinates]
      : g?.type === 'MultiLineString' ? g.coordinates : []
    for (const coords of parts) {
      n++
      const legs = coords
        .filter((c) => isValidLatLon(c[1], c[0]))
        .map(([lon, lat]) => {
          const leg = { lat: round6(lat), lon: round6(lon) }
          const id = nearestFix?.(lat, lon)
          if (id) leg.id = id
          return leg
        })
      const p = f.properties ?? {}
      const name = p.name ?? p.title ?? `${baseName(fileName)}${n}`
      const row = procRow(fileName, {
        icao: String(p.airport ?? p.icao ?? '').toUpperCase(),
        category: String(p.category ?? '').toUpperCase(),
        name: String(name),
        type: p.type ?? '', runway: p.runway ?? '', label: '',
        transitions: {},
      })
      row.lineLegs = legs
      if (legs.length < 2) row.error = 'Line has fewer than two points'
      rows.push(row)
    }
  }
  if (!rows.length) throw new Error('No lines found')
  return rows
}

/**
 * The transitions an import row will save. A line from GeoJSON/KML becomes
 * one transition keyed the way navdata keys it: the runway for a SID/STAR,
 * '' (the final) for an approach.
 */
export function rowTransitions(row) {
  if (!row.lineLegs) return row.transitions
  const key = row.category === 'APPCH' ? '' : String(row.runway ?? '').trim().toUpperCase()
  return { [key]: row.lineLegs }
}

function parseProcText(fileName, text, nearestFix) {
  if (/\.kml$/i.test(fileName)) return rowsFromLines(fileName, parseKml(text).features, nearestFix)
  let json = null
  try { json = JSON.parse(text) } catch { /* maybe newline-delimited GeoJSON */ }
  const cands = json != null ? parseProcedureJson(fileName, json) : null
  if (cands) return cands.length ? cands.map((c) => procRow(fileName, c)) : [errorRow(fileName, new Error('No procedures in file'))]
  return rowsFromLines(fileName, parseGeojson(text), nearestFix)
}

const PROC_FILE_EXT = /\.(json|geojson|ndgeojson|kml)$/i

function parseProcBytes(fileName, bytes, nearestFix, skipped) {
  try {
    if (/\.kmz$/i.test(fileName)) {
      const entries = unzipSync(bytes)
      const names = Object.keys(entries).filter((n) => /\.kml$/i.test(n))
      const pick = names.find((n) => /(^|\/)doc\.kml$/i.test(n)) ?? names[0]
      if (!pick) throw new Error('No .kml found inside .kmz')
      return rowsFromLines(fileName, parseKml(new TextDecoder().decode(entries[pick])).features, nearestFix)
    }
    if (/\.zip$/i.test(fileName)) {
      const rows = []
      for (const [entryName, data] of Object.entries(unzipSync(bytes))) {
        if (entryName.endsWith('/') || entryName.startsWith('__MACOSX/')) continue
        if (!PROC_FILE_EXT.test(entryName) && !/\.kmz$/i.test(entryName)) {
          if (baseName(entryName) && !baseName(entryName).startsWith('.')) skipped.push(entryName)
          continue
        }
        rows.push(...parseProcBytes(entryName, data, nearestFix, skipped))
      }
      return rows
    }
    if (PROC_FILE_EXT.test(fileName)) return parseProcText(fileName, new TextDecoder().decode(bytes), nearestFix)
    skipped.push(fileName)
    return []
  } catch (err) {
    return [errorRow(fileName, err)]
  }
}

/**
 * Import rows for the PROCEDURES tab from dropped/picked files: navdata or
 * single-procedure JSON, or lines in GeoJSON/KML/KMZ (or a .zip of those).
 * Returns { rows, skipped }.
 */
export async function readProcedureFiles(fileList, { nearestFix } = {}) {
  const rows    = []
  const skipped = []
  for (const file of Array.from(fileList ?? [])) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      rows.push(...parseProcBytes(file.name, bytes, nearestFix, skipped))
    } catch (err) {
      rows.push(errorRow(file.name, err))
    }
  }
  return { rows, skipped }
}

/** Import rows for procedure candidates found by the IMPORT tab. */
export function rowsFromCandidates(fileName, cands) {
  return cands.map((c) => procRow(fileName, c))
}

/**
 * Navdata-format JSON of the user's procedures at one airport, keeping
 * labels and builder metadata so re-importing it loses nothing.
 */
export function exportAirport(procs, icao) {
  const out = { SID: {}, STAR: {}, APPCH: {} }
  for (const p of procs) {
    if (p.icao !== icao) continue
    out[p.category][p.name] = toRawEntry(p)
    delete out[p.category][p.name].user
  }
  return out
}
