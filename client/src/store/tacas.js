import { create } from 'zustand'
import { normalizeTacasAircrewCheckIn } from '../modules/tacas/aircrewCheckIn.js'

const MAX_MESSAGES = 200
const MAX_MARKERS = 500
const MAX_LABEL_LENGTH = 64
const MAX_MESSAGE_LENGTH = 500
const ECHO_POINT = 'ECHO_POINT'

function normalizeMarker(marker) {
  if (!marker || typeof marker.id !== 'string' || !marker.id ||
      !Number.isFinite(marker.lat) || !Number.isFinite(marker.lng) ||
      marker.lat < -90 || marker.lat > 90 || marker.lng < -180 || marker.lng > 180) return null
  const markerType = marker.markerType === ECHO_POINT ? ECHO_POINT : 'MARKER'
  const createdBy = typeof marker.createdBy === 'string' ? marker.createdBy.slice(0, 64) : ''
  if (markerType === ECHO_POINT && !createdBy.trim()) return null
  const label = typeof marker.label === 'string' ? marker.label.trim().slice(0, MAX_LABEL_LENGTH) : ''
  return {
    id: marker.id,
    lat: marker.lat,
    lng: marker.lng,
    label: markerType === ECHO_POINT ? 'Echo Point' : label || 'Marker',
    markerType,
    createdBy,
    updatedAt: Number.isFinite(marker.updatedAt) ? marker.updatedAt : Date.now(),
  }
}

function mergeMarkers(markers) {
  const byId = new Map()
  for (const marker of markers) {
    const value = normalizeMarker(marker)
    if (value) byId.set(value.id, value)
  }

  const latestEchoPointByOwner = new Map()
  for (const marker of byId.values()) {
    if (marker.markerType !== ECHO_POINT) continue
    const owner = marker.createdBy.toUpperCase()
    const current = latestEchoPointByOwner.get(owner)
    if (!current || marker.updatedAt > current.updatedAt ||
        (marker.updatedAt === current.updatedAt && marker.id > current.id)) {
      latestEchoPointByOwner.set(owner, marker)
    }
  }

  return [...byId.values()].filter((marker) =>
    marker.markerType !== ECHO_POINT ||
    latestEchoPointByOwner.get(marker.createdBy.toUpperCase()).id === marker.id
  )
}

function normalizeMessage(message) {
  if (!message || typeof message.id !== 'string' || !message.id || typeof message.text !== 'string') return null
  const text = message.text.trim().slice(0, MAX_MESSAGE_LENGTH)
  if (!text) return null
  return {
    id: message.id,
    from: typeof message.from === 'string' ? message.from.slice(0, 64) : 'Unknown',
    text,
    timestamp: Number.isFinite(message.timestamp) ? message.timestamp : Date.now(),
  }
}

function normalizeDirectMessage(message) {
  const value = normalizeMessage(message)
  const toPosition = typeof message?.toPosition === 'string'
    ? message.toPosition.trim().slice(0, 64)
    : ''
  return value && toPosition ? { ...value, toPosition } : null
}

function mergeAircrewCheckIns(checkIns) {
  const byPosition = new Map()
  for (const checkIn of checkIns) {
    const value = normalizeTacasAircrewCheckIn(checkIn)
    if (!value) continue
    const key = value.from.toUpperCase()
    const current = byPosition.get(key)
    if (!current || value.updatedAt > current.updatedAt) byPosition.set(key, value)
  }
  return [...byPosition.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export const useTacasStore = create((set) => ({
  markers: [],
  messages: [],
  directMessages: [],
  aircrewCheckIns: [],

  upsertMarker: (marker) => {
    const value = normalizeMarker(marker)
    if (!value) return
    set((state) => ({
      markers: mergeMarkers([...state.markers.filter((item) => item.id !== value.id), value]).slice(-MAX_MARKERS),
    }))
  },

  removeMarker: (id) => set((state) => ({ markers: state.markers.filter((marker) => marker.id !== id) })),

  addMessage: (message) => {
    const value = normalizeMessage(message)
    if (!value) return
    set((state) => state.messages.some((item) => item.id === value.id)
      ? state
      : { messages: [...state.messages, value].slice(-MAX_MESSAGES) })
  },

  addDirectMessage: (message) => {
    const value = normalizeDirectMessage(message)
    if (!value) return
    set((state) => state.directMessages.some((item) => item.id === value.id)
      ? state
      : { directMessages: [...state.directMessages, value].slice(-MAX_MESSAGES) })
  },

  upsertAircrewCheckIn: (checkIn) => {
    const value = normalizeTacasAircrewCheckIn(checkIn)
    if (!value) return
    set((state) => {
      const current = state.aircrewCheckIns.find((item) =>
        item.from.toUpperCase() === value.from.toUpperCase()
      )
      if (current && current.updatedAt > value.updatedAt) return state
      return {
        aircrewCheckIns: mergeAircrewCheckIns([
          ...state.aircrewCheckIns.filter((item) => item.from.toUpperCase() !== value.from.toUpperCase()),
          value,
        ]),
      }
    })
  },

  applyStateDump: (payload) => set((state) => {
    const markers = mergeMarkers([...state.markers, ...(payload.markers ?? [])])
    const messages = new Map(state.messages.map((message) => [message.id, message]))
    for (const message of payload.messages ?? []) {
      const value = normalizeMessage(message)
      if (value) messages.set(value.id, value)
    }
    return {
      markers: markers.slice(-MAX_MARKERS),
      messages: [...messages.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_MESSAGES),
      aircrewCheckIns: mergeAircrewCheckIns([
        ...state.aircrewCheckIns,
        ...(payload.aircrewCheckIns ?? []),
      ]),
    }
  }),

  reset: () => set({ markers: [], messages: [], directMessages: [], aircrewCheckIns: [] }),
}))

export function applyTacasStateDump(payload) {
  useTacasStore.getState().applyStateDump(payload)
}