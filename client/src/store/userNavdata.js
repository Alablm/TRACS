// User-added fixes and STARS video maps, per theatre. Persisted to IndexedDB
// via utils/localDb.js — one `<theatre>|fix-list` record holding that
// theatre's fixes, and one `<theatre>|map|<id>` record per video map.
// Local to this machine only; never sent to WebRTC or relay peers.
//
// Only theatres actually looked at are held in memory: the active one (set
// by store/navdata.js when a scope loads its theatre) plus whichever the
// manager dialog has opened. Every action persists first and updates memory
// only after the write succeeds, so the UI never shows unsaved data.

import { create } from 'zustand'
import {
  loadPrefix, putRecords, deleteRecords, onRemoteChange, describeDbError,
} from '../utils/localDb.js'
import { upsertFixList, normalizeFixId, isValidLatLon } from '../utils/userFixes.js'

const fixListKey = (theatre) => `${theatre}|fix-list`
const mapRecordKey = (theatre, id) => `${theatre}|map|${id}`

// Default DCB button text for a newly imported map: the file/layer name,
// uppercased, separators turned into spaces, capped to what fits on two
// half-button lines.
export function defaultMapLabel(name) {
  return String(name ?? '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, 16)
}

async function readTheatre(theatre) {
  const rows  = await loadPrefix(`${theatre}|`)
  let fixes   = []
  const maps  = []
  for (const [key, value] of rows) {
    if (key === fixListKey(theatre)) fixes = Array.isArray(value) ? value : []
    else if (key.startsWith(`${theatre}|map|`)) maps.push(value)
  }
  maps.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0))
  return { fixes, maps }
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const useUserNavdataStore = create((set, get) => {
  // Saves run one at a time, so two quick edits (e.g. back-to-back imports)
  // can't both read the same `current` and drop each other's changes.
  let queue = Promise.resolve()

  // Runs `write` (which persists), then applies `apply(current, result)` to
  // memory. Resolves null on success or the error message on failure.
  function commit(theatre, write, apply) {
    const run = queue.then(() => commitNow(theatre, write, apply))
    queue = run
    return run
  }

  async function commitNow(theatre, write, apply) {
    try {
      await get().ensureTheatre(theatre)
      const current = get().byTheatre[theatre] ?? { fixes: [], maps: [] }
      const next = await write(current)
      set((s) => ({ byTheatre: { ...s.byTheatre, [theatre]: apply(current, next) }, lastError: null }))
      return null
    } catch (err) {
      const msg = describeDbError(err)
      console.error('[userNavdata] save failed:', msg)
      set({ lastError: msg })
      return msg
    }
  }

  async function writeFixes(theatre, fixes) {
    if (fixes.length) await putRecords([[fixListKey(theatre), fixes]])
    else await deleteRecords([fixListKey(theatre)])
    return fixes
  }

  const withFixes = (cur, fixes) => ({ ...cur, fixes })

  return {
    theatre:   null,   // the theatre the scopes are showing
    byTheatre: {},     // { [theatre]: { fixes: [...], maps: [...] } } — loaded theatres only
    lastError: null,

    setActiveTheatre: (theatre) => {
      if (!theatre || get().theatre === theatre) return
      set({ theatre })
      get().ensureTheatre(theatre).catch((err) => {
        const msg = describeDbError(err)
        console.error('[userNavdata] load failed:', msg)
        set({ lastError: msg })
      })
    },

    ensureTheatre: async (theatre, force = false) => {
      if (!theatre || (!force && get().byTheatre[theatre])) return
      const data = await readTheatre(theatre)
      set((s) => ({ byTheatre: { ...s.byTheatre, [theatre]: data } }))
    },

    // ── Fixes ────────────────────────────────────────────────────────────
    upsertFixes: (theatre, fixes) => commit(theatre,
      (cur) => writeFixes(theatre, upsertFixList(cur.fixes, fixes)), withFixes),

    // Edits one fix in place; a changed ID replaces whatever fix already
    // held the new ID.
    updateFix: (theatre, oldId, patch) => commit(theatre, (cur) => {
      const old = cur.fixes.find((f) => f.id === oldId)
      if (!old) throw new Error(`Fix ${oldId} not found`)
      const next = { ...old, ...patch, id: normalizeFixId(patch.id ?? old.id) }
      if (!next.id) throw new Error('Fix ID is required')
      if (!isValidLatLon(Number(next.lat), Number(next.lon))) throw new Error('Invalid latitude/longitude')
      return writeFixes(theatre, upsertFixList(cur.fixes.filter((f) => f.id !== oldId), [next]))
    }, withFixes),

    removeFixes: (theatre, ids) => commit(theatre, (cur) => {
      const drop = new Set(ids)
      return writeFixes(theatre, cur.fixes.filter((f) => !drop.has(f.id)))
    }, withFixes),

    clearFixes: (theatre) => commit(theatre, () => writeFixes(theatre, []), withFixes),

    // ── Video maps ───────────────────────────────────────────────────────
    addMap: (theatre, { name, features, source }) => commit(theatre, async () => {
      const map = {
        id:       newId(),
        name,
        label:    defaultMapLabel(name),
        group:    'A',
        features,
        source:   source ?? null,
        addedAt:  Date.now(),
      }
      await putRecords([[mapRecordKey(theatre, map.id), map]])
      return map
    }, (cur, map) => ({ ...cur, maps: [...cur.maps, map] })),

    // patch: any of { name, label, group, features, source }. Replacing
    // `features` (a re-import) keeps the map's id, so its DCB button and
    // saved visibility stay put.
    updateMap: (theatre, id, patch) => commit(theatre, async (cur) => {
      const old = cur.maps.find((m) => m.id === id)
      if (!old) throw new Error('Map not found')
      const map = { ...old, ...patch, id }
      await putRecords([[mapRecordKey(theatre, id), map]])
      return map
    }, (cur, map) => ({ ...cur, maps: cur.maps.map((m) => (m.id === map.id ? map : m)) })),

    removeMaps: (theatre, ids) => commit(theatre, async () => {
      await deleteRecords(ids.map((id) => mapRecordKey(theatre, id)))
      return new Set(ids)
    }, (cur, drop) => ({ ...cur, maps: cur.maps.filter((m) => !drop.has(m.id)) })),

    clearError: () => set({ lastError: null }),
  }
})

// Another window changed records: reload any affected theatre we're holding.
onRemoteChange((changedKeys) => {
  const { byTheatre, ensureTheatre } = useUserNavdataStore.getState()
  const theatres = new Set()
  for (const key of changedKeys) {
    const [theatre, kind] = key.split('|')
    if ((kind === 'fix-list' || kind === 'map') && byTheatre[theatre]) theatres.add(theatre)
  }
  for (const theatre of theatres) {
    ensureTheatre(theatre, true).catch((err) => console.error('[userNavdata] reload failed:', describeDbError(err)))
  }
})
