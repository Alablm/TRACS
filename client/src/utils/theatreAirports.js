// A theatre's ICAO-mapped airports and their runway thresholds, built from
// the same sources the scopes use (public/runways/<theatre>.json and
// icaoMapping.json). Used where a theatre other than the one on the scope
// needs its airports, e.g. the user navdata manager's procedure builder.

import { getIcaoMapping } from './icaoMapping.js'
import { computeMagvar } from './magvar.js'
import { trueBearingRangeNm, destinationPoint, toMagneticFromTrue } from './bearing.js'

const FT_PER_NM = 6076.115

/**
 * Parallel-runway suffixes for every runway entry in a runways file. Entries
 * sharing a lower-numbered designator are parallels, ordered left to right
 * looking along that lower heading. Returns Map(rwy entry → 'L'|'C'|'R'|''),
 * the suffix in the lower-numbered direction.
 */
export function parallelSuffixes(airbases) {
  const suffixMap = new Map()
  for (const ab of airbases ?? []) {
    if (!Array.isArray(ab.runways) || ab.runways.length === 0) continue
    const groups = {}
    for (const rwy of ab.runways) {
      const recip    = ((rwy.name + 18) % 36) || 36
      const lowerNum = Math.min(rwy.name, recip)
      if (!groups[lowerNum]) groups[lowerNum] = []
      groups[lowerNum].push(rwy)
    }
    for (const [lowerNumStr, rwys] of Object.entries(groups)) {
      if (rwys.length === 1) {
        suffixMap.set(rwys[0], '')
        continue
      }
      const lowerNum = parseInt(lowerNumStr, 10)
      const headRad  = (lowerNum * 10) * Math.PI / 180
      const perpE    = Math.cos(headRad)
      const perpN    = -Math.sin(headRad)
      const cosLat   = Math.cos(rwys[0].lat * Math.PI / 180)
      const sorted   = [...rwys].sort((a, b) =>
        (a.lon * cosLat * perpE + a.lat * perpN) -
        (b.lon * cosLat * perpE + b.lat * perpN)
      )
      const SUFFIXES = rwys.length === 2 ? ['L', 'R'] : ['L', 'C', 'R']
      for (let i = 0; i < sorted.length; i++) {
        suffixMap.set(sorted[i], SUFFIXES[i] ?? 'R')
      }
    }
  }
  return suffixMap
}

function angDist(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360)
  return Math.min(d, 360 - d)
}

const flipSuffix = (s) => (s === 'L' ? 'R' : s === 'R' ? 'L' : s)

// Both runway ends of one runways-file entry, or null when it has no
// usable geometry.
function runwayEnds(rwy) {
  if (rwy.end1?.lat != null && rwy.end2?.lat != null) return [rwy.end1, rwy.end2]
  if (rwy.lat == null || rwy.course_true_deg == null || !rwy.length_ft) return null
  const halfNm  = rwy.length_ft / FT_PER_NM / 2
  const heading = -rwy.course_true_deg
  const a = destinationPoint(rwy.lat, rwy.lon, heading, halfNm)
  const b = destinationPoint(rwy.lat, rwy.lon, heading + 180, halfNm)
  return [{ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }]
}

/**
 * Runway thresholds of one airbase, named the way navdata procedures name
 * runways ("07", "25L"): [{ name, lat, lon }], sorted by name.
 */
export function airbaseRunways(ab, suffixMap) {
  const byName = new Map()
  for (const rwy of Array.isArray(ab.runways) ? ab.runways : []) {
    if (rwy.name == null) continue
    const ends = runwayEnds(rwy)
    if (!ends) continue
    const recip          = ((rwy.name + 18) % 36) || 36
    const primaryIsLower = rwy.name === Math.min(rwy.name, recip)
    const lowerSuffix    = suffixMap.get(rwy) ?? ''
    const ownSuffix      = primaryIsLower ? lowerSuffix : flipSuffix(lowerSuffix)

    // The threshold for rwy.name is the end you land from when heading
    // roughly rwy.name × 10 magnetic.
    const [a, b] = ends
    const { trueBearingDeg } = trueBearingRangeNm(a.lat, a.lon, b.lat, b.lon)
    const magAtoB = toMagneticFromTrue(trueBearingDeg, computeMagvar(a.lat, a.lon))
    const [own, other] = angDist(magAtoB, rwy.name * 10) <= 90 ? [a, b] : [b, a]

    const pad = (n) => String(n).padStart(2, '0')
    const ownName   = pad(rwy.name) + ownSuffix
    const otherName = pad(recip) + flipSuffix(ownSuffix)
    if (!byName.has(ownName))   byName.set(ownName,   { name: ownName,   lat: own.lat,   lon: own.lon })
    if (!byName.has(otherName)) byName.set(otherName, { name: otherName, lat: other.lat, lon: other.lon })
  }
  return [...byName.values()].sort((x, y) => x.name.localeCompare(y.name))
}

// Runways files and icaoMapping keys don't always use the navdata theatre
// name verbatim (e.g. "Sinai" vs SinaiMap.json), so try the common variants.
async function fetchRunwaysFile(theatre) {
  for (const name of [theatre, `${theatre}Map`]) {
    try {
      const res = await fetch(`/runways/${encodeURIComponent(name)}.json`)
      if (res.ok) return await res.json()
    } catch { /* try the next variant */ }
  }
  return null
}

const _cache = {}

/**
 * ICAO-mapped airports of a theatre: [{ icao, name, runways: [{ name, lat, lon }] }],
 * sorted by ICAO. Airbases without an ICAO mapping are left out. Cached per
 * theatre; resolves [] when the runways file can't be loaded.
 */
export function getTheatreAirports(theatre) {
  if (!theatre) return Promise.resolve([])
  if (!_cache[theatre]) {
    _cache[theatre] = (async () => {
      const [data, mapping] = await Promise.all([fetchRunwaysFile(theatre), getIcaoMapping()])
      if (!data) { delete _cache[theatre]; return [] }
      const key = theatre.toLowerCase()
      const icaoByAirbase = mapping[key] ?? mapping[key.replace(/map$/, '')] ?? mapping[`${key}map`] ?? {}
      const suffixMap = parallelSuffixes(data.airbases)
      const byIcao = new Map()
      for (const ab of data.airbases ?? []) {
        const icao = icaoByAirbase[ab.airbase]
        if (!icao) continue
        const runways = airbaseRunways(ab, suffixMap)
        const entry = byIcao.get(icao)
        if (!entry) {
          byIcao.set(icao, { icao, name: ab.airbase, runways })
        } else {
          // Two airbases sharing an ICAO: keep both runway sets.
          const names = new Set(entry.runways.map((r) => r.name))
          entry.runways = [...entry.runways, ...runways.filter((r) => !names.has(r.name))]
          entry.name = `${entry.name} / ${ab.airbase}`
        }
      }
      return [...byIcao.values()].sort((x, y) => x.icao.localeCompare(y.icao))
    })()
  }
  return _cache[theatre]
}
