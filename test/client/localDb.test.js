import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

// Each test gets an empty IndexedDB and freshly imported modules, so module
// level state (idb-keyval store handles, ABM hydration) starts clean.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
})

afterEach(() => {
  delete globalThis.localStorage
})

function memoryLocalStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem:    (k) => (data.has(k) ? data.get(k) : null),
    setItem:    (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    has:        (k) => data.has(k),
  }
}

describe('localDb', () => {
  it('writes, loads by prefix and deletes records', async () => {
    const db = await import('../../client/src/utils/localDb.js')
    await db.putRecords([
      ['Caucasus|map|a', { id: 'a' }],
      ['Caucasus|fix-list', [{ id: 'X' }]],
      ['Syria|map|b', { id: 'b' }],
    ])
    const rows = await db.loadPrefix('Caucasus|')
    expect(rows.map(([k]) => k).sort()).toEqual(['Caucasus|fix-list', 'Caucasus|map|a'])

    await db.deleteRecords(['Caucasus|map|a'])
    expect(await db.getRecords(['Caucasus|map|a', 'Syria|map|b'])).toEqual([undefined, { id: 'b' }])
  })

  it('names quota errors in plain language', async () => {
    const { describeDbError } = await import('../../client/src/utils/localDb.js')
    expect(describeDbError({ name: 'QuotaExceededError', message: 'x' })).toMatch(/storage full/i)
    expect(describeDbError(new Error('boom'))).toBe('boom')
  })
})

describe('ABM drawings storage', () => {
  const legacy = {
    byTheatre: {
      Caucasus: [
        { id: 'l1', name: 'FIRST', visible: true, features: [] },
        { id: 'l2', name: 'SECOND', visible: false, features: [] },
      ],
      Syria: [{ id: 'l3', name: 'THIRD', visible: true, features: [] }],
    },
  }

  it('migrates the localStorage blob into records, then removes it', async () => {
    globalThis.localStorage = memoryLocalStorage({ 'tracs.abm.drawings': JSON.stringify(legacy), 'tracs.abm.drawings.scale': '1.2' })
    const mod = await import('../../client/src/store/abmDrawings.js')
    await mod.drawingsReady

    const { byTheatre } = mod.useAbmDrawingsStore.getState()
    expect(byTheatre.Caucasus.map((l) => l.name)).toEqual(['FIRST', 'SECOND'])
    expect(byTheatre.Syria.map((l) => l.name)).toEqual(['THIRD'])
    expect(byTheatre.Caucasus[0]).not.toHaveProperty('order')
    expect(globalThis.localStorage.has('tracs.abm.drawings')).toBe(false)
    expect(globalThis.localStorage.has('tracs.abm.drawings.scale')).toBe(true)
  })

  it('keeps the IndexedDB copy of a layer and only adds what is missing', async () => {
    const db = await import('../../client/src/utils/localDb.js')
    await db.putRecords([['Caucasus|drawing|l1', { id: 'l1', name: 'FIRST (EDITED)', visible: true, features: [], order: 0 }]])
    const blob = { byTheatre: { Caucasus: [...legacy.byTheatre.Caucasus, { id: 'l4', name: 'FOURTH', visible: true, features: [] }] } }
    globalThis.localStorage = memoryLocalStorage({ 'tracs.abm.drawings': JSON.stringify(blob) })

    const mod = await import('../../client/src/store/abmDrawings.js')
    await mod.drawingsReady
    const names = mod.useAbmDrawingsStore.getState().byTheatre.Caucasus.map((l) => l.name)
    expect(names).toContain('FIRST (EDITED)')
    expect(names).not.toContain('FIRST')
    expect(names).toEqual(expect.arrayContaining(['SECOND', 'FOURTH']))
    expect(names).toHaveLength(3)
    expect(globalThis.localStorage.has('tracs.abm.drawings')).toBe(false)
  })

  it('leaves the blob in place when the records cannot be written', async () => {
    globalThis.localStorage = memoryLocalStorage({ 'tracs.abm.drawings': JSON.stringify(legacy) })
    vi.doMock('../../client/src/utils/localDb.js', async (orig) => ({
      ...(await orig()),
      putRecords: async () => { throw new Error('disk full') },
    }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mod = await import('../../client/src/store/abmDrawings.js')
    await mod.drawingsReady
    expect(globalThis.localStorage.has('tracs.abm.drawings')).toBe(true)
    expect(mod.useAbmDrawingsStore.getState().persistError).toBe('disk full')
    vi.doUnmock('../../client/src/utils/localDb.js')
    errSpy.mockRestore()
  })

  it('persists edits as per-layer writes that survive a reload', async () => {
    const mod = await import('../../client/src/store/abmDrawings.js')
    await mod.drawingsReady
    const store = mod.useAbmDrawingsStore
    store.getState().addLayer('Caucasus', 'A', [])
    store.getState().addLayer('Caucasus', 'B', [])
    store.getState().addLayer('Caucasus', 'C', [])
    const [a, b, c] = store.getState().byTheatre.Caucasus
    store.getState().reorderLayer('Caucasus', c.id, a.id)    // C, A, B
    store.getState().toggleVisible('Caucasus', b.id)
    store.getState().removeLayer('Caucasus', a.id)            // C, B

    // Let the queued writes land, then load in a fresh module instance.
    await new Promise((r) => setTimeout(r, 50))
    vi.resetModules()
    const fresh = await import('../../client/src/store/abmDrawings.js')
    await fresh.drawingsReady
    const layers = fresh.useAbmDrawingsStore.getState().byTheatre.Caucasus
    expect(layers.map((l) => l.name)).toEqual(['C', 'B'])
    expect(layers[1].visible).toBe(false)
  })

  it('diffs only the layers an edit touched', async () => {
    const { diffDrawingWrites } = await import('../../client/src/store/abmDrawings.js')
    const a = { id: 'a' }
    const b = { id: 'b' }
    const c = { id: 'c' }
    const prev = { T: [a, b, c], U: [{ id: 'u' }] }

    // toggle b → only b written
    const b2 = { ...b, visible: false }
    let d = diffDrawingWrites(prev, { ...prev, T: [a, b2, c] })
    expect(d.puts.map(([k]) => k)).toEqual(['T|drawing|b'])
    expect(d.dels).toEqual([])

    // remove a → a deleted, b and c move up so their order is rewritten
    d = diffDrawingWrites(prev, { ...prev, T: [b, c] })
    expect(d.dels).toEqual(['T|drawing|a'])
    expect(d.puts.map(([k, v]) => [k, v.order])).toEqual([['T|drawing|b', 0], ['T|drawing|c', 1]])

    // untouched theatre → nothing
    d = diffDrawingWrites(prev, { ...prev })
    expect(d.puts).toEqual([])
    expect(d.dels).toEqual([])
  })
})
