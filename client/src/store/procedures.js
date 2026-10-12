import { create } from 'zustand'
import { useUserNavdataStore } from './userNavdata.js'
import { mergeProcedures, buildGroups } from '../utils/userProcedures.js'

const NO_GROUPS = { sidGroups: {}, starGroups: {}, appchGroups: {} }

// The active theatre's user procedures (see store/userNavdata.js).
function userProcs() {
  const { byTheatre, theatre } = useUserNavdataStore.getState()
  return byTheatre[theatre]?.procs ?? []
}

// `raw` + DCB groups for the facility: navdata procedures with the user's
// own procedures for that airport layered on top.
function derive(baseRaw, icao) {
  const raw = mergeProcedures(baseRaw, userProcs(), icao)
  return { raw, ...(raw ? buildGroups(raw) : NO_GROUPS) }
}

export const useProceduresStore = create((set, get) => ({
  icao:        null,
  baseRaw:     null,   // navdata procedures as served, null when none
  raw:         null,   // baseRaw + user procedures
  sidGroups:   {},
  starGroups:  {},
  appchGroups: {},
  visible:     new Set(),
  loading:     false,

  loadForIcao: async (icao) => {
    if (!icao || get().icao === icao) return
    set({ loading: true })
    let baseRaw = null
    try {
      const res = await fetch(`/api/navdata/procedures?icao=${encodeURIComponent(icao)}`)
      // 404 just means no navdata procedures here; user ones may still exist.
      if (res.ok) baseRaw = await res.json()
      else if (res.status !== 404) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.error('[procedures] load error:', err.message)
    }
    set({ icao, baseRaw, ...derive(baseRaw, icao), visible: new Set(), loading: false })
  },

  toggleVisible: (key) => set((s) => {
    const next = new Set(s.visible)
    next.has(key) ? next.delete(key) : next.add(key)
    return { visible: next }
  }),
  setVisible: (keys) => set({ visible: new Set(keys) }),

  // Individual procedures shown via .proc command (keyed by raw proc name, e.g. "ATUD3F")
  commandVisible: new Set(),

  toggleProc: (key) => set((s) => {
    const next = new Set(s.commandVisible)
    next.has(key) ? next.delete(key) : next.add(key)
    return { commandVisible: next }
  }),

  clearCommandProcs: () => set({ commandVisible: new Set() }),

  reset: () => set({
    icao: null, baseRaw: null, raw: null,
    ...NO_GROUPS,
    visible: new Set(), commandVisible: new Set(), loading: false,
  }),
}))

// Re-merge whenever the active theatre's user procedures change (load,
// edit, import, or another window's edit).
useUserNavdataStore.subscribe((state, prev) => {
  const next = state.byTheatre[state.theatre]?.procs
  if (state.theatre === prev.theatre && next === prev.byTheatre[prev.theatre]?.procs) return
  const { icao, baseRaw } = useProceduresStore.getState()
  if (!icao) return
  useProceduresStore.setState(derive(baseRaw, icao))
})
