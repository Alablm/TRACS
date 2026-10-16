import { stripAcid } from '../../utils/callsignShape.js'
import { isOnGround } from '../../utils/visibleUnits.js'
import { gridBearingRangeNm } from '../../utils/bearing.js'
import { distFromNm, distUnit, IMPERIAL, METRIC } from '../../utils/units.js'

/**
 * Builds the display label for a TACAS position so JTAC entries are clearly distinct from aircrew callsigns.
 */
export function getTacasPositionName(callsign, positionType) {
  const name = callsign.trim().toUpperCase()
  return positionType === 'JTAC' ? `${name} JTAC` : name
}

/**
 * Returns connected TACAS positions only, excluding the current position when provided.
 */
export function getTacasPeerPositions(peers, excludePosition = '') {
  return [...new Set(peers
    .filter((peer) => peer.module === 'TACAS' && typeof peer.position === 'string' && peer.position)
    .map((peer) => peer.position)
    .filter((position) => position !== excludePosition))]
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Finds the echo point created by the current JTAC so it can be edited or highlighted without cross-user confusion.
 */
export function findOwnedTacasEchoPoint(markers, positionName, positionTypeName) {
  if (positionTypeName !== 'JTAC' || !positionName) return null
  const owner = positionName.toUpperCase()
  return markers.find((marker) =>
    marker.markerType === 'ECHO_POINT' && marker.createdBy.toUpperCase() === owner
  ) ?? null
}

/**
 * Resolves the selected echo point from the marker list while falling back to a safe default when no valid selection exists.
 */
export function findSelectedTacasEchoPoint(markers, selectedId, fallback = null) {
  if (!selectedId) return fallback
  return markers.find((marker) => marker.id === selectedId && marker.markerType === 'ECHO_POINT') ?? fallback
}

/**
 * Builds a compact bearing and range readout for a TACAS echo point relative to the player's cursor or current point of interest.
 */
export function formatTacasEchoPointReadout(cursor, echoPoint, theatre, elevationUnit = 'ft') {
  if (!cursor || !echoPoint) return null
  const { gridBearingDeg, rangeNm } = gridBearingRangeNm(
    echoPoint.lat, echoPoint.lng, cursor.lat, cursor.lng, theatre
  )
  const unitSystem = elevationUnit === 'm' ? METRIC : IMPERIAL
  const range = `${Math.round(distFromNm(rangeNm, unitSystem))} ${distUnit(unitSystem)}`
  const cardinal = [
    [0, 'A'],
    [90, 'B'],
    [180, 'C'],
    [270, 'D'],
  ].find(([bearing]) => {
    const difference = Math.abs(((gridBearingDeg - bearing + 540) % 360) - 180)
    return difference <= 10
  })
  if (cardinal) return `${cardinal[1]}${range}`

  const bearing = String(Math.round(gridBearingDeg) % 360).padStart(3, '0')
  return `${bearing} / ${range}`
}

/**
 * Finds a live aircraft matching the current aircrew callsign and returns its basic metadata for TACAS workflows.
 */
export function findTacasAircraft(units, callsign, positionType, getCallsign) {
  if (positionType !== 'AIRCREW') return []
  const wantedCallsign = stripAcid(callsign ?? '')
  if (!wantedCallsign) return []

  const aircraft = []
  for (const [id, unit] of Object.entries(units ?? {})) {
    if (unit.category !== 'Aircraft' && unit.category !== 'Helicopter') continue
    if (unit.alive === false || isOnGround(unit)) continue
    if (!Number.isFinite(unit.position?.lat) || !Number.isFinite(unit.position?.lng)) continue
    const resolvedCallsign = getCallsign(unit)
    if (resolvedCallsign === wantedCallsign) {
      const typeName = (unit.name ?? '').replace(/[_ ].*$/, '').replace(/^([^-]*-[^-]*)-.*$/, '$1') || null
      aircraft.push({ id, unit, callsign: resolvedCallsign, typeName })
    }
  }
  return aircraft
}

/**
 * Resolves all active aircraft for the set of TACAS aircrew positions so the UI can populate defaults and quick lookups.
 */
export function findTacasAircraftForPositions(units, positionNames, getCallsign) {
  const aircrewCallsigns = new Set(
    positionNames
      .filter((positionName) => !positionName.trim().toUpperCase().endsWith(' JTAC'))
      .map((positionName) => stripAcid(positionName))
      .filter(Boolean)
  )
  if (!aircrewCallsigns.size) return []

  const aircraftById = new Map()
  for (const [id, unit] of Object.entries(units ?? {})) {
    if (unit.category !== 'Aircraft' && unit.category !== 'Helicopter') continue
    if (unit.alive === false || isOnGround(unit)) continue
    if (!Number.isFinite(unit.position?.lat) || !Number.isFinite(unit.position?.lng)) continue
    const callsign = getCallsign(unit)
    if (!aircrewCallsigns.has(callsign)) continue
    const typeName = (unit.name ?? '').replace(/[_ ].*$/, '').replace(/^([^-]*-[^-]*)-.*$/, '$1') || null
    aircraftById.set(id, { id, unit, callsign, typeName })
  }
  return [...aircraftById.values()]
}
