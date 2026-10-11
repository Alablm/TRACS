import { describe, test, expect } from 'vitest'
import { parseAltEntry, validateAltPair, formatAlt, formatAltRange, ALT_CLEAR } from '../../client/src/modules/abm/flightAlt.js'

describe('ABM flight altitude', () => {
  test('hard, block, and clear entries', () => {
    expect(parseAltEntry('200')).toEqual({ lo: '200', hi: null })
    expect(parseAltEntry('030')).toEqual({ lo: '030', hi: null })
    expect(parseAltEntry('200220')).toEqual({ lo: '200', hi: '220' })
    expect(parseAltEntry('000050')).toEqual({ lo: '000', hi: '050' })
    expect(parseAltEntry('000')).toBe(ALT_CLEAR)
  })

  test('rejects reversed, equal, and wrong-length entries', () => {
    for (const bad of ['220200', '200200', '30', '3000', '20022', '2002200', '']) {
      expect(parseAltEntry(bad)).toHaveProperty('error')
    }
  })

  test('FRAG box pair validation', () => {
    expect(validateAltPair('200', '')).toEqual({ lo: '200', hi: null })
    expect(validateAltPair('200', '220')).toEqual({ lo: '200', hi: '220' })
    expect(validateAltPair('220', '200')).toHaveProperty('error')
    expect(validateAltPair('20', null)).toHaveProperty('error')
    expect(validateAltPair('200', '22')).toHaveProperty('error')
  })

  test('formatting, imperial and metric', () => {
    expect(formatAlt({ lo: '200', hi: null }, 'imperial')).toBe('R200')
    expect(formatAlt({ lo: '200', hi: '220' }, 'imperial')).toBe('R200-220')
    expect(formatAlt(null, 'imperial')).toBe('')
    // 20,000 ft = 6096 m -> 061; 22,000 ft = 6706 m -> 067
    expect(formatAltRange({ lo: '200', hi: '220' }, 'metric')).toBe('061-067')
  })
})
