// This machine's own persistent records (user fixes, user video maps, ABM
// drawings), in IndexedDB instead of localStorage: no ~5 MB origin-wide
// quota shared with every prefs store, async so large geometry never blocks
// the UI thread, and one record per item so an edit rewrites only that item.
//
// Keys are `<theatre>|<kind>|<id>` (or `<theatre>|<kind>` for a single
// per-theatre record), so one theatre's records load by prefix.
//
// Cross-window: after each write a CHANGED message naming the touched keys
// goes out on a BroadcastChannel; listeners re-read just those keys from
// IndexedDB. Record contents never travel over the channel. Local-only —
// nothing here is ever sent to WebRTC or relay peers.

import { createStore, getMany, setMany, delMany, keys as idbKeys } from 'idb-keyval'

let _store = null
function store() {
  if (!_store) _store = createStore('tracs', 'records')
  return _store
}

let _channel = null
const _listeners = new Set()

function channel() {
  if (!_channel && typeof BroadcastChannel !== 'undefined') {
    _channel = new BroadcastChannel('tracs-localdb')
    _channel.onmessage = (e) => {
      if (e.data?.type !== 'CHANGED' || !Array.isArray(e.data.keys)) return
      for (const fn of _listeners) fn(e.data.keys)
    }
  }
  return _channel
}

function notify(changedKeys) {
  if (changedKeys.length) channel()?.postMessage({ type: 'CHANGED', keys: changedKeys })
}

// fn(keys) runs when another window writes or deletes records. The writing
// window doesn't hear its own changes — it already has them in memory.
export function onRemoteChange(fn) {
  channel()
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

// [[key, value], ...] for every record whose key passes `match`.
export async function loadWhere(match) {
  const all = (await idbKeys(store())).filter((k) => typeof k === 'string' && match(k))
  if (!all.length) return []
  const values = await getMany(all, store())
  return all.map((k, i) => [k, values[i]]).filter(([, v]) => v !== undefined)
}

export function loadPrefix(prefix) {
  return loadWhere((k) => k.startsWith(prefix))
}

// Missing keys come back as undefined, in the same order as `keyList`.
export function getRecords(keyList) {
  return getMany(keyList, store())
}

// entries: [[key, value], ...] — written in one transaction.
export async function putRecords(entries) {
  if (!entries.length) return
  await setMany(entries, store())
  notify(entries.map(([k]) => k))
}

export async function deleteRecords(keyList) {
  if (!keyList.length) return
  await delMany(keyList, store())
  notify(keyList)
}

// Readable message for a failed write, quota exhaustion called out by name
// since that's the one a user can act on (delete some maps/drawings).
export function describeDbError(err) {
  if (err?.name === 'QuotaExceededError') return 'Storage full - delete some maps or drawings and try again'
  return err?.message || String(err)
}
