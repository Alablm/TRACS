import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

// Each test gets an empty IndexedDB and a freshly imported store.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
})

describe('userNavdata store', () => {
  it('upserts, edits and removes fixes, persisting each change', async () => {
    const { useUserNavdataStore } = await import('../../client/src/store/userNavdata.js')
    const s = () => useUserNavdataStore.getState()

    expect(await s().upsertFixes('Caucasus', [{ id: 'abc', lat: 44, lon: 39, source: 'f1' }])).toBeNull()
    expect(await s().upsertFixes('Caucasus', [{ id: 'ABC', lat: 45, lon: 40, source: 'f2' }, { id: 'DEF', lat: 1, lon: 2 }])).toBeNull()
    expect(s().byTheatre.Caucasus.fixes).toEqual([
      { id: 'ABC', lat: 45, lon: 40, source: 'f2' },
      { id: 'DEF', lat: 1, lon: 2, source: null },
    ])

    expect(await s().updateFix('Caucasus', 'DEF', { id: 'ghi', lat: 3, lon: 4 })).toBeNull()
    expect(s().byTheatre.Caucasus.fixes.map((f) => f.id)).toEqual(['ABC', 'GHI'])

    expect(await s().updateFix('Caucasus', 'GHI', { lat: 200 })).toMatch(/invalid/i)

    expect(await s().removeFixes('Caucasus', ['ABC'])).toBeNull()

    // A fresh module instance reads back what was saved.
    vi.resetModules()
    const fresh = (await import('../../client/src/store/userNavdata.js')).useUserNavdataStore
    await fresh.getState().ensureTheatre('Caucasus')
    expect(fresh.getState().byTheatre.Caucasus.fixes).toEqual([{ id: 'GHI', lat: 3, lon: 4, source: null }])
  })

  it('adds, updates and removes maps per theatre', async () => {
    const { useUserNavdataStore, defaultMapLabel } = await import('../../client/src/store/userNavdata.js')
    const s = () => useUserNavdataStore.getState()
    const features = [{ geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, bbox: [0, 0, 1, 1] }]

    expect(defaultMapLabel('URRV_SECTOR_POLY.json')).toBe('URRV SECTOR POLY')

    await s().addMap('Caucasus', { name: 'URRV_SECTOR', features, source: 'a.json' })
    await s().addMap('Syria', { name: 'LCRA', features, source: 'b.json' })
    const [map] = s().byTheatre.Caucasus.maps
    expect(map).toMatchObject({ name: 'URRV_SECTOR', label: 'URRV SECTOR', group: 'A', source: 'a.json' })

    await s().updateMap('Caucasus', map.id, { label: 'SECTORS', group: 'B', features: [...features, ...features] })
    expect(s().byTheatre.Caucasus.maps[0]).toMatchObject({ id: map.id, label: 'SECTORS', group: 'B' })
    expect(s().byTheatre.Caucasus.maps[0].features).toHaveLength(2)

    await s().removeMaps('Caucasus', [map.id])
    expect(s().byTheatre.Caucasus.maps).toEqual([])

    vi.resetModules()
    const fresh = (await import('../../client/src/store/userNavdata.js')).useUserNavdataStore
    await fresh.getState().ensureTheatre('Caucasus')
    await fresh.getState().ensureTheatre('Syria')
    expect(fresh.getState().byTheatre.Caucasus.maps).toEqual([])
    expect(fresh.getState().byTheatre.Syria.maps.map((m) => m.name)).toEqual(['LCRA'])
  })

  it('upserts, moves and removes procedures', async () => {
    const { useUserNavdataStore } = await import('../../client/src/store/userNavdata.js')
    const s = () => useUserNavdataStore.getState()
    const legs = [{ lat: 42.1, lon: 42.4, id: 'A' }, { lat: 42.2, lon: 42.5, id: 'B' }]
    const proc = { icao: 'UGKO', category: 'SID', name: 'abc1d', transitions: { '07': legs } }

    expect(await s().upsertProcs('Caucasus', [proc])).toBeNull()
    expect(s().byTheatre.Caucasus.procs).toEqual([
      expect.objectContaining({ icao: 'UGKO', category: 'SID', name: 'ABC1D', transitions: { '07': legs } }),
    ])
    expect(await s().upsertProcs('Caucasus', [{ ...proc, name: '' }])).toMatch(/name/i)

    // Re-saving the same airport + category + name replaces it.
    await s().upsertProcs('Caucasus', [{ ...proc, label: 'mine' }])
    expect(s().byTheatre.Caucasus.procs.map((p) => p.label)).toEqual(['MINE'])

    // A rename moves the record.
    expect(await s().updateProc('Caucasus', 'UGKO|SID|ABC1D', { name: 'XYZ1D' })).toBeNull()
    expect(s().byTheatre.Caucasus.procs.map((p) => p.name)).toEqual(['XYZ1D'])

    vi.resetModules()
    let fresh = (await import('../../client/src/store/userNavdata.js')).useUserNavdataStore
    await fresh.getState().ensureTheatre('Caucasus')
    expect(fresh.getState().byTheatre.Caucasus.procs.map((p) => `${p.name} ${p.label}`)).toEqual(['XYZ1D MINE'])

    expect(await fresh.getState().removeProcs('Caucasus', ['UGKO|SID|XYZ1D'])).toBeNull()
    vi.resetModules()
    fresh = (await import('../../client/src/store/userNavdata.js')).useUserNavdataStore
    await fresh.getState().ensureTheatre('Caucasus')
    expect(fresh.getState().byTheatre.Caucasus.procs).toEqual([])
  })

  it('keeps back-to-back saves from overwriting each other', async () => {
    const { useUserNavdataStore } = await import('../../client/src/store/userNavdata.js')
    const s = useUserNavdataStore.getState()
    await Promise.all([
      s.upsertFixes('Caucasus', [{ id: 'ONE', lat: 1, lon: 1 }]),
      s.upsertFixes('Caucasus', [{ id: 'TWO', lat: 2, lon: 2 }]),
    ])
    expect(useUserNavdataStore.getState().byTheatre.Caucasus.fixes.map((f) => f.id)).toEqual(['ONE', 'TWO'])
  })
})
