// Flight altitude assignment — `++###`/`++######` + click on the scope and
// FRAG's Alt row. Altitudes are always entered as 3-digit groupings in
// hundreds of feet (3,000 ft = 030); a block is two groupings, lower first.

import { altHundreds, METRIC, M_TO_FT } from '../../utils/units.js'

export const ALT_CLEAR = 'CLEAR'

/**
 * Validates a lower/upper pair of 3-digit groupings. An empty `hi` is a hard
 * altitude.
 * @returns {{ lo, hi } | { error }}
 */
export function validateAltPair(lo, hi) {
  if (!/^\d{3}$/.test(lo ?? '')) return { error: 'ILL ALT' }
  if (!hi) return { lo, hi: null }
  if (!/^\d{3}$/.test(hi)) return { error: 'ILL ALT' }
  if (Number(lo) >= Number(hi)) return { error: 'ILL ALT' }
  return { lo, hi }
}

/**
 * Parses the digits after `++`: `200` hard, `200220` block, `000` clear.
 * @returns {{ lo, hi } | ALT_CLEAR | { error }}
 */
export function parseAltEntry(digits) {
  if (digits === '000') return ALT_CLEAR
  if (/^\d{3}$/.test(digits)) return validateAltPair(digits, null)
  if (/^\d{6}$/.test(digits)) return validateAltPair(digits.slice(0, 3), digits.slice(3))
  return { error: 'ILL ALT' }
}

// Entry is always hundreds of feet; .metric shows hundreds of metres, same
// as the live altitude beside it on the datablock.
function displayGroup(group, unitSystem) {
  return unitSystem === METRIC ? altHundreds(Number(group) * 100 / M_TO_FT, unitSystem) : group
}

/** `200` or `200-220` (no prefix) — ATO column and the datablock's R field. */
export function formatAltRange(alt, unitSystem) {
  if (!alt?.lo) return ''
  const lo = displayGroup(alt.lo, unitSystem)
  return alt.hi ? `${lo}-${displayGroup(alt.hi, unitSystem)}` : lo
}

/** `R200` or `R200-220`. */
export function formatAlt(alt, unitSystem) {
  const range = formatAltRange(alt, unitSystem)
  return range ? 'R' + range : ''
}
