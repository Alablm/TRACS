import { describe, it, expect } from 'vitest'
import { upsertFixList, mergeFixes, normalizeFixId } from '../../client/src/utils/userFixes.js'

describe('normalizeFixId', () => {
  it('trims and uppercases', () => {
    expect(normalizeFixId('  abc12 ')).toBe('ABC12')
    expect(normalizeFixId(null)).toBe('')
  })
})

describe('upsertFixList', () => {
  it('adds, replaces by ID, drops invalid entries and sorts', () => {
    const current = [{ id: 'BRAVO', lat: 1, lon: 1, source: 'a' }]
    const next = upsertFixList(current, [
      { id: 'alpha', lat: '2', lon: '3', source: 'b' },
      { id: 'bravo', lat: 5, lon: 6, source: 'c' },
      { id: '', lat: 1, lon: 1 },
      { id: 'BAD', lat: 95, lon: 0 },
    ])
    expect(next).toEqual([
      { id: 'ALPHA', lat: 2, lon: 3, source: 'b' },
      { id: 'BRAVO', lat: 5, lon: 6, source: 'c' },
    ])
    expect(current).toHaveLength(1)   // not mutated
  })
})

describe('mergeFixes', () => {
  const base = [
    { id: 'ALPHA', lat: 10, lon: 10 },
    { id: 'charlie', lat: 30, lon: 30 },
  ]

  it('returns the navdata list untouched when there are no user fixes', () => {
    expect(mergeFixes([], base)).toBe(base)
  })

  it('puts user fixes first and drops navdata fixes they override', () => {
    const merged = mergeFixes([
      { id: 'CHARLIE', lat: 31, lon: 31, source: 'x' },
      { id: 'DELTA', lat: 40, lon: 40, source: 'x' },
    ], base)
    expect(merged).toEqual([
      { id: 'CHARLIE', lat: 31, lon: 31, user: true },
      { id: 'DELTA', lat: 40, lon: 40, user: true },
      { id: 'ALPHA', lat: 10, lon: 10 },
    ])
    // first-match lookups resolve to the user's position
    expect(merged.find((f) => f.id.toUpperCase() === 'CHARLIE').lat).toBe(31)
  })
})
