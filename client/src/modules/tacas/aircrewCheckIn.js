export const TACAS_AIRCREW_CHECK_IN_FIELDS = [
  { number: 1, key: 'identification', label: 'Identification and/or Mission Number', maxLength: 36 },
  { number: 2, key: 'aircraft', label: 'Number and Type of Aircraft', maxLength: 36 },
  { number: 3, key: 'positionAltitude', label: 'Position and Altitude', maxLength: 36 },
  { number: 4, key: 'ordnance', label: 'Ordnance', maxLength: 36 },
  { number: 5, key: 'playtime', label: 'Playtime', maxLength: 36 },
  { number: 6, key: 'capabilities', label: 'Capabilities', maxLength: 36 },
  { number: 7, key: 'abortCode', label: 'Abort Code', maxLength: 36 },
  { number: 8, key: 'remarks', label: 'Remarks', maxLength: 48 },
]

/**
 * Formats the structured aircrew check-in values into the same plain-text layout used in TACAS messages.
 */
export function formatTacasAircrewCheckIn(values) {
  return TACAS_AIRCREW_CHECK_IN_FIELDS
    .map(({ number, label, key }) => `${number}. ${label}: ${values[key]?.trim() ?? ''}`)
    .join('\n')
}

/**
 * Provides the default values for a new aircrew check-in based on the current mission position and aircraft.
 */
export function getTacasAircrewCheckInDefaults(positionName, aircraft) {
  return {
    identification: aircraft?.callsign || positionName,
    aircraft: `1x${aircraft?.typeName ? ` ${aircraft.typeName}` : ''}`,
    abortCode: 'SIERRA SIERRA SIERRA',
  }
}

/**
 * Normalizes incoming check-in payloads to a consistent shape and trims any field values to the TACAS limits.
 */
export function normalizeTacasAircrewCheckIn(checkIn) {
  if (!checkIn || typeof checkIn.from !== 'string' || !checkIn.from.trim()) return null
  const from = checkIn.from.trim().slice(0, 64)
  const values = Object.fromEntries(TACAS_AIRCREW_CHECK_IN_FIELDS.map(({ key, maxLength }) => {
    const value = typeof checkIn.values?.[key] === 'string' ? checkIn.values[key].trim().slice(0, maxLength) : ''
    return [key, value]
  }))
  return {
    from,
    values,
    updatedAt: Number.isFinite(checkIn.updatedAt) ? checkIn.updatedAt : Date.now(),
  }
}
