import { M_TO_FT } from '../../utils/units.js'

const terrainElevationRequests = new Map()

export const TACAS_NINE_LINE_FIELDS = [
  { number: 1, key: 'ipBp', label: 'IP/BP', maxLength: 20 },
  { number: 2, key: 'heading', label: 'Heading', maxLength: 10 },
  { number: 3, key: 'distance', label: 'Distance', maxLength: 10 },
  { number: 4, key: 'targetElevation', label: 'Target Elevation', maxLength: 20 },
  { number: 5, key: 'targetDescription', label: 'Target Description', maxLength: 36 },
  { number: 6, key: 'targetLocation', label: 'Target Location', maxLength: 48 },
  { number: 7, key: 'markType', label: 'Mark Type', maxLength: 36 },
  { number: 8, key: 'friendlies', label: 'Friendlies', maxLength: 36 },
  { number: 9, key: 'egress', label: 'Egress', maxLength: 20 },
  { number: 10, key: 'remarks', label: 'Remarks', maxLength: 100 },
]

/**
 * Converts a terrain elevation in meters into the requested display unit for TACAS labels.
 */
export function formatTargetElevation(elevationM, unit = 'ft') {
  if (!Number.isFinite(elevationM)) return null
  return unit === 'm'
    ? `${Math.round(elevationM)} m MSL`
    : `${Math.round(elevationM * M_TO_FT)} ft MSL`
}

/**
 * Caches and reuses terrain-elevation lookups for the same map grid cell so repeated marker renders do not spam the server.
 */
export function fetchTerrainElevation(lat, lng) {
  const key = `${Math.round(lat * 100)},${Math.round(lng * 100)}`
  if (terrainElevationRequests.has(key)) return terrainElevationRequests.get(key)

  const params = new URLSearchParams({ lat, lng })
  const request = fetch(`/api/elevation?${params}`)
    .then((response) => {
      if (!response.ok) throw new Error(`Elevation request failed (${response.status})`)
      return response.json()
    })
    .then(({ elevationM }) => Number.isFinite(elevationM) ? elevationM : null)
    .catch((error) => {
      terrainElevationRequests.delete(key)
      throw error
    })

  terrainElevationRequests.set(key, request)
  return request
}

/**
 * Serializes the nine-line fields into the plain-text format used in TACAS transmissions.
 */
export function formatTacasNineLine(values) {
  return TACAS_NINE_LINE_FIELDS
    .map(({ number, label, key }) => `${number}. ${label}: ${values[key]?.trim() ?? ''}`)
    .join('\n')
}
