// PROCEDURES tab of the user navdata manager: list, builder and import for
// user SIDs/STARs/approaches (see utils/userProcedures.js for the shape).

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useUserNavdataStore } from '../../store/userNavdata.js'
import { useSessionStore } from '../../store/session.js'
import {
  PROC_CATEGORIES, APPCH_TYPES, PROC_LABEL_MAX,
  procKey, normalizeProcName, groupKeyFor, finalizeProc,
  legToSpec, emptyLegSpec, resolveLegs,
  readProcedureFiles, rowTransitions, exportAirport,
} from '../../utils/userProcedures.js'
import { normalizeFixId } from '../../utils/userFixes.js'
import { trueBearingRangeNm } from '../../utils/bearing.js'

// Within this distance of a runway threshold, a line's end picks that
// airport for an import row that names none.
const AIRPORT_GUESS_NM = 15

const ALT_DESCS  = [['', '-'], ['A', 'at'], ['+', 'at/above'], ['-', 'at/below'], ['B', 'between']]
const SPD_TYPES  = [['', 'at'], ['-', 'max'], ['+', 'min']]
const TURNS      = ['', 'L', 'R']

let _seq = 0
const nextId = () => `t${++_seq}`

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

// Options for a select, keeping a current value that isn't in the list
// (e.g. an imported alt descriptor) so editing doesn't silently drop it.
function withCurrent(options, value) {
  return value && !options.some(([v]) => v === value) ? [...options, [value, value]] : options
}

function downloadJson(fileName, obj) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// ── Navdata name lookup (for the override asterisk) ─────────────────────────

// icao → Set of "CATEGORY|NAME" in that airport's navdata, fetched on demand.
function useBaseProcNames() {
  const [names, setNames] = useState({})
  const requested = useRef(new Set())

  const ensure = useCallback((icaos) => {
    const missing = icaos.filter((i) => i && !requested.current.has(i))
    if (!missing.length) return
    missing.forEach((i) => requested.current.add(i))
    Promise.all(missing.map(async (icao) => {
      const set = new Set()
      try {
        const res = await fetch(`/api/navdata/procedures?icao=${encodeURIComponent(icao)}`)
        if (res.ok) {
          const raw = await res.json()
          for (const c of PROC_CATEGORIES) for (const n of Object.keys(raw[c] ?? {})) set.add(`${c}|${n}`)
        }
      } catch { /* no navdata: nothing to override */ }
      return [icao, set]
    })).then((entries) => setNames((cur) => ({ ...cur, ...Object.fromEntries(entries) })))
  }, [])

  const overrides = useCallback((icao, category, name) =>
    !!names[icao]?.has(`${category}|${normalizeProcName(name)}`), [names])

  return { ensure, overrides }
}

// ── Airport helpers ─────────────────────────────────────────────────────────

function runwayFixLookup(airport) {
  return (id) => {
    const m = /^RW(\d{2}[LCR]?)$/.exec(normalizeFixId(id))
    const rwy = m && airport?.runways.find((r) => r.name === m[1])
    return rwy ? { lat: rwy.lat, lon: rwy.lon } : null
  }
}

function guessAirport(legs, airports) {
  const ends = [legs[0], legs[legs.length - 1]].filter(Boolean)
  let best = null
  let bestNm = AIRPORT_GUESS_NM
  for (const ap of airports) {
    for (const rwy of ap.runways) {
      for (const e of ends) {
        const { rangeNm } = trueBearingRangeNm(e.lat, e.lon, rwy.lat, rwy.lon)
        if (rangeNm < bestNm) { best = ap.icao; bestNm = rangeNm }
      }
    }
  }
  return best ?? ''
}

function AirportSelect({ airports, value, onChange }) {
  const known = airports.some((a) => a.icao === value)
  return (
    <select className="unm-select" value={value} onChange={(e) => onChange(e.target.value)} title="Airport">
      <option value="">airport…</option>
      {!known && value && <option value={value}>{value} (not in theatre)</option>}
      {airports.map((a) => <option key={a.icao} value={a.icao}>{a.icao} {a.name}</option>)}
    </select>
  )
}

function RunwayInput({ runways, value, onChange, placeholder = 'rwy' }) {
  const listId = useMemo(() => `unm-rwy-${nextId()}`, [])
  return (
    <>
      <input className="unm-input unm-w-rwy" list={listId} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.toUpperCase())} title="Runway (e.g. 07, 25L)" />
      <datalist id={listId}>{runways.map((r) => <option key={r.name} value={r.name} />)}</datalist>
    </>
  )
}

// ── Builder ─────────────────────────────────────────────────────────────────

function draftFromProc(proc, defaultIcao) {
  if (!proc) {
    return {
      icao: defaultIcao, category: 'SID', name: '', type: '', runway: '', label: '',
      transitions: [{ id: nextId(), key: '', legs: [emptyLegSpec()] }],
    }
  }
  const keys = Object.keys(proc.transitions)
  return {
    icao: proc.icao, category: proc.category, name: proc.name, type: proc.type ?? '',
    // SID/STAR runway isn't stored; the first runway-looking transition key stands in.
    runway: proc.runway || keys.find((k) => /^\d{2}[LCR]?$/.test(k)) || '',
    label: proc.label ?? '',
    transitions: Object.entries(proc.transitions).map(([key, legs]) => ({ id: nextId(), key, legs: legs.map(legToSpec) })),
  }
}

function LegRow({ leg, index, count, isAppch, onPatch, onMove, onRemove }) {
  const set = (k) => (e) => onPatch({ [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const setUpper = (k) => (e) => onPatch({ [k]: e.target.value.toUpperCase() })
  return (
    <div className="unm-leg-row">
      <span className="unm-muted">{index + 1}</span>
      <select className="unm-select" value={leg.kind} onChange={set('kind')} title="Leg type">
        <option value="fix">fix</option>
        <option value="coord">lat/lon</option>
        <option value="crs">crs/dist</option>
      </select>
      <span className="unm-leg-pos">
        {leg.kind === 'fix' && (
          <input className="unm-input unm-grow" placeholder="ident (fix, navaid, RW07)" value={leg.ident} onChange={setUpper('ident')} />
        )}
        {leg.kind === 'coord' && (
          <>
            <input className="unm-input unm-w-id" placeholder="name" value={leg.ident} onChange={setUpper('ident')} title="Optional name" />
            <input className="unm-input unm-grow" placeholder="lat" value={leg.lat} onChange={set('lat')} />
            <input className="unm-input unm-grow" placeholder="lon" value={leg.lon} onChange={set('lon')} />
          </>
        )}
        {leg.kind === 'crs' && (
          <>
            <input className="unm-input unm-w-id" placeholder="name" value={leg.ident} onChange={setUpper('ident')} title="Optional name" />
            <input className="unm-input unm-grow" placeholder="crs °M" value={leg.crs} onChange={set('crs')} title="Magnetic course from the previous point (or the runway threshold)" />
            <input className="unm-input unm-grow" placeholder="NM" value={leg.dist} onChange={set('dist')} title="Distance in NM" />
          </>
        )}
      </span>
      <span className="unm-leg-alt">
        <select className="unm-select" value={leg.alt_desc} onChange={set('alt_desc')} title="Altitude restriction">
          {withCurrent(ALT_DESCS, leg.alt_desc).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input className="unm-input unm-grow" placeholder="ft" value={leg.alt1} onChange={set('alt1')} disabled={!leg.alt_desc} />
        {leg.alt_desc === 'B' && <input className="unm-input unm-grow" placeholder="ft" value={leg.alt2} onChange={set('alt2')} title="Lower altitude" />}
      </span>
      <span className="unm-leg-spd">
        <input className="unm-input unm-grow" placeholder="kt" value={leg.spd} onChange={set('spd')} title="Speed restriction" />
        <select className="unm-select" value={leg.spd_type} onChange={set('spd_type')} disabled={!leg.spd}>
          {withCurrent(SPD_TYPES, leg.spd_type).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </span>
      <select className="unm-select" value={leg.turn} onChange={set('turn')} title="Turn direction">
        {TURNS.map((t) => <option key={t} value={t}>{t || '-'}</option>)}
      </select>
      {isAppch
        ? <input type="checkbox" checked={leg.missed} onChange={set('missed')} title="Missed approach leg (drawn dashed)" />
        : <span />}
      <span className="unm-row-actions">
        <button className="unm-link" disabled={index === 0} onClick={() => onMove(-1)} title="Move up">↑</button>
        <button className="unm-link" disabled={index === count - 1} onClick={() => onMove(1)} title="Move down">↓</button>
        <button className="unm-x" onClick={onRemove} title="Remove leg">×</button>
      </span>
    </div>
  )
}

function TransitionEditor({ t, isAppch, isFirst, resolved, onChange, onRemove }) {
  const [quick, setQuick] = useState('')
  const patchLeg  = (i, p) => onChange({ ...t, legs: t.legs.map((l, j) => (j === i ? { ...l, ...p } : l)) })
  const removeLeg = (i) => onChange({ ...t, legs: t.legs.filter((_, j) => j !== i) })
  const moveLeg   = (i, d) => {
    const legs = [...t.legs]
    ;[legs[i], legs[i + d]] = [legs[i + d], legs[i]]
    onChange({ ...t, legs })
  }
  const addFixes = () => {
    const idents = quick.split(/[\s,]+/).map(normalizeFixId).filter(Boolean)
    if (!idents.length) return
    onChange({ ...t, legs: [...t.legs, ...idents.map((ident) => ({ ...emptyLegSpec('fix'), ident }))] })
    setQuick('')
  }
  const keyHint = isAppch
    ? (isFirst ? 'blank = final approach' : 'IAF ident')
    : (isFirst ? 'runway (07) or blank = all' : 'runway or enroute fix')

  return (
    <div className="unm-trans">
      <div className="unm-trans-head">
        <span className="unm-muted">TRANSITION</span>
        <input className="unm-input unm-w-trans" value={t.key} placeholder={keyHint} title={keyHint}
          onChange={(e) => onChange({ ...t, key: e.target.value.toUpperCase() })} />
        <span className="unm-muted">{plural(resolved.legs.length, 'leg')} resolved</span>
        <span className="unm-spacer" />
        <button className="unm-x" onClick={onRemove} title="Remove transition">×</button>
      </div>
      <div className="unm-leg-row unm-fix-head">
        <span>#</span><span>TYPE</span><span>POSITION</span><span>ALT</span><span>SPD</span><span>TURN</span>
        <span>{isAppch ? 'MAP' : ''}</span><span />
      </div>
      {t.legs.map((leg, i) => (
        <LegRow key={i} leg={leg} index={i} count={t.legs.length} isAppch={isAppch}
          onPatch={(p) => patchLeg(i, p)} onMove={(d) => moveLeg(i, d)} onRemove={() => removeLeg(i)} />
      ))}
      <div className="unm-trans-foot">
        <button className="unm-btn" onClick={() => onChange({ ...t, legs: [...t.legs, emptyLegSpec(t.legs.at(-1)?.kind ?? 'fix')] })}>+ leg</button>
        <input className="unm-input unm-grow" placeholder="add fixes by ident: KTS LOBI ALIK" value={quick}
          onChange={(e) => setQuick(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFixes() } }} />
        <button className="unm-btn" disabled={!quick.trim()} onClick={addFixes}>Add</button>
      </div>
    </div>
  )
}

function ProcBuilder({ theatre, airports, facilityIcao, lookupFix, procs, initial, overrides, ensureBase, onSave, onCancel }) {
  const defaultIcao = facilityIcao || airports[0]?.icao || ''
  const [draft, setDraft] = useState(() => draftFromProc(initial, defaultIcao))
  const [busy, setBusy]   = useState(false)
  const patch = (p) => setDraft((d) => ({ ...d, ...p }))

  // The theatre's airport list can arrive after the builder opens.
  useEffect(() => {
    if (defaultIcao) setDraft((d) => (d.icao ? d : { ...d, icao: defaultIcao }))
  }, [defaultIcao])

  useEffect(() => { ensureBase([draft.icao]) }, [draft.icao, ensureBase])

  const airport = useMemo(() => airports.find((a) => a.icao === draft.icao) ?? null, [airports, draft.icao])
  const runways = useMemo(() => airport?.runways ?? [], [airport])
  const isAppch = draft.category === 'APPCH'

  const lookup = useMemo(() => {
    const rwy = runwayFixLookup(airport)
    return (id) => lookupFix(id) ?? rwy(id)
  }, [lookupFix, airport])

  // Course/distance legs at the start of a transition project from a runway
  // threshold: the transition's own key when it names a runway, else the
  // procedure's runway.
  const resolved = useMemo(() => draft.transitions.map((t) => {
    const rwy = runways.find((r) => r.name === t.key) ?? runways.find((r) => r.name === draft.runway) ?? null
    return resolveLegs(t.legs, { lookupFix: lookup, origin: rwy, theatre })
  }), [draft.transitions, draft.runway, runways, lookup, theatre])

  const candidate = {
    icao: draft.icao, category: draft.category, name: draft.name, type: draft.type,
    runway: draft.runway, label: draft.label,
    transitions: Object.fromEntries(draft.transitions.map((t, i) => [t.key.trim(), resolved[i].legs])),
    source: initial?.source ?? 'manual',
  }

  const errors = resolved.flatMap((r, i) =>
    r.errors.map((e) => `${draft.transitions[i].key || (isAppch ? 'final' : 'common')}: ${e}`))
  const keys = draft.transitions.map((t) => t.key.trim())
  if (new Set(keys).size !== keys.length) errors.unshift('Two transitions have the same name')
  if (!errors.length) {
    try { finalizeProc(candidate) } catch (err) { errors.unshift(err.message) }
  }

  const name = normalizeProcName(draft.name)
  const newKey = procKey({ icao: draft.icao, category: draft.category, name })
  const replacesOwn = name && (!initial || procKey(initial) !== newKey) && procs.some((p) => procKey(p) === newKey)
  const replacesNav = name && overrides(draft.icao, draft.category, name)
  const defaultLabel = name ? groupKeyFor(draft.category, name, { type: draft.type, runway: draft.runway }) : ''

  const save = async () => {
    setBusy(true)
    await onSave(candidate)
    setBusy(false)
  }

  return (
    <div className="unm-body">
      <div className="unm-toolbar unm-wrap">
        <AirportSelect airports={airports} value={draft.icao} onChange={(icao) => patch({ icao })} />
        <select className="unm-select" value={draft.category} onChange={(e) => patch({ category: e.target.value })} title="Category">
          {PROC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className="unm-input unm-w-name" placeholder="name (ALIK1D)" value={draft.name} maxLength={12}
          onChange={(e) => patch({ name: e.target.value.toUpperCase() })} />
        {isAppch && (
          <select className="unm-select" value={draft.type} onChange={(e) => patch({ type: e.target.value })} title="Approach type">
            <option value="">type…</option>
            {withCurrent(APPCH_TYPES.map((t) => [t, t]), draft.type).map(([v]) => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        <RunwayInput runways={runways} value={draft.runway} onChange={(runway) => patch({ runway })} />
        <input className="unm-input unm-w-label" placeholder={defaultLabel || 'DCB label'} value={draft.label} maxLength={PROC_LABEL_MAX}
          onChange={(e) => patch({ label: e.target.value.toUpperCase() })}
          title={`DCB button text - blank uses the default grouping${defaultLabel ? ` (${defaultLabel})` : ''}`} />
      </div>
      {(replacesNav || replacesOwn) && (
        <div className="unm-note">
          {replacesNav && <span className="unm-override">* replaces the navdata {draft.category} {name} at {draft.icao}. </span>}
          {replacesOwn && <span className="unm-warn">Replaces your existing {draft.category} {name}.</span>}
        </div>
      )}
      <div className="unm-list">
        {draft.transitions.map((t, i) => (
          <TransitionEditor key={t.id} t={t} isAppch={isAppch} isFirst={i === 0} resolved={resolved[i]}
            onChange={(next) => patch({ transitions: draft.transitions.map((x) => (x.id === t.id ? next : x)) })}
            onRemove={() => patch({ transitions: draft.transitions.filter((x) => x.id !== t.id) })} />
        ))}
        <div className="unm-trans-add">
          <button className="unm-btn" onClick={() => patch({
            transitions: [...draft.transitions, { id: nextId(), key: '', legs: [emptyLegSpec()] }],
          })}>+ transition</button>
        </div>
      </div>
      {errors.length > 0 && (
        <div className="unm-errors" title={errors.join('\n')}>
          {errors.slice(0, 3).map((e, i) => <div key={i}>{e}</div>)}
          {errors.length > 3 && <div>…and {errors.length - 3} more</div>}
        </div>
      )}
      <div className="unm-footer">
        <button className="unm-btn" onClick={onCancel}>Cancel</button>
        <button className="unm-btn unm-btn-primary" disabled={errors.length > 0 || busy || !theatre} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ── Import ──────────────────────────────────────────────────────────────────

function rowCheck(row) {
  if (row.error) return { error: row.error }
  try {
    return { proc: finalizeProc({ ...row, transitions: rowTransitions(row) }) }
  } catch (err) {
    return { error: err.message }
  }
}

function rowSummary(row) {
  const trans = rowTransitions(row)
  const legs = Object.values(trans).reduce((n, l) => n + (l?.length ?? 0), 0)
  return `${plural(Object.keys(trans).length, 'transition')}, ${plural(legs, 'leg')}`
}

function ProcImport({ theatre, airports, facilityIcao, procs, rows, setRows, overrides, ensureBase, nearestFix, onDone, onCancel }) {
  const upsertProcs = useUserNavdataStore((s) => s.upsertProcs)
  const [skipped, setSkipped]   = useState([])
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading]   = useState(false)
  const [busy, setBusy]         = useState(false)
  const fileRef = useRef()

  useEffect(() => { ensureBase(rows.map((r) => r.icao)) }, [rows, ensureBase])

  const ownKeys = useMemo(() => new Set(procs.map(procKey)), [procs])

  const processFiles = async (fileList) => {
    if (!fileList?.length) return
    setLoading(true)
    const result = await readProcedureFiles(fileList, { nearestFix })
    // A row naming no airport takes the one nearest a line's ends, else the
    // current airport.
    const added = result.rows.map((r) => (r.icao ? r : {
      ...r,
      icao: (r.lineLegs && guessAirport(r.lineLegs, airports)) || facilityIcao,
    }))
    setRows((rs) => [...rs, ...added])
    setSkipped(result.skipped)
    setLoading(false)
  }

  const patchRow  = (key, p) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  const removeRow = (key) => setRows((rs) => rs.filter((r) => r.key !== key))

  const checked = rows.map((row) => ({ row, ...rowCheck(row) }))
  const ready = checked.filter((c) => c.proc)

  const doImport = async () => {
    setBusy(true)
    const err = await upsertProcs(theatre, ready.map((c) => ({ ...c.proc, source: c.row.fileName })))
    setBusy(false)
    if (err) return onDone({ error: err })
    onDone({ message: `Imported ${plural(ready.length, 'procedure')} into ${theatre}` })
    setRows([])
    setSkipped([])
  }

  const dropProps = {
    onDragOver:  (e) => { e.preventDefault(); setDragging(true) },
    onDragLeave: (e) => { e.preventDefault(); setDragging(false) },
    onDrop:      (e) => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files) },
  }
  const fileInput = (
    <input ref={fileRef} type="file" accept=".json,.geojson,.ndgeojson,.kml,.kmz,.zip,*" multiple style={{ display: 'none' }}
      onChange={(e) => { processFiles(e.target.files); e.target.value = '' }} />
  )

  if (loading) return <div className="unm-status">Parsing…</div>

  if (!rows.length) {
    return (
      <div className="unm-body">
        <div className={`unm-dropzone${dragging ? ' dragging' : ''}`} {...dropProps} onClick={() => fileRef.current?.click()}>
          <span className="unm-drop-icon">⬆</span>
          <span className="unm-drop-label">Drop navdata procedure JSON (an airport file or single procedures), or GeoJSON/KML/KMZ lines</span>
          <span className="unm-drop-sub">or click to browse - each line becomes one procedure</span>
          {fileInput}
        </div>
        <div className="unm-footer"><button className="unm-btn" onClick={onCancel}>Back</button></div>
      </div>
    )
  }

  return (
    <div className="unm-body" {...dropProps}>
      <div className="unm-toolbar">
        <span className="unm-muted">{plural(rows.length, 'item')} - {ready.length} to import</span>
        <span className="unm-spacer" />
        <button className="unm-btn" onClick={() => fileRef.current?.click()}>Add files</button>
        <button className="unm-btn" onClick={() => { setRows([]); setSkipped([]) }}>Start over</button>
        {fileInput}
      </div>
      <div className="unm-list">
        {checked.map(({ row, error }) => {
          const runways = airports.find((a) => a.icao === row.icao)?.runways ?? []
          const name = normalizeProcName(row.name)
          const replacesNav = !error && overrides(row.icao, row.category, name)
          const replacesOwn = !error && ownKeys.has(procKey({ icao: row.icao, category: row.category, name }))
          return (
            <div key={row.key} className="unm-import-row">
              <div className="unm-import-main">
                <AirportSelect airports={airports} value={row.icao} onChange={(icao) => patchRow(row.key, { icao })} />
                <select className="unm-select" value={row.category} onChange={(e) => patchRow(row.key, { category: e.target.value })} title="Category">
                  <option value="">category…</option>
                  {PROC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input className="unm-input unm-grow" value={row.name} maxLength={12} placeholder="name"
                  onChange={(e) => patchRow(row.key, { name: e.target.value.toUpperCase() })} title={row.fileName} />
                {row.category === 'APPCH' && (
                  <select className="unm-select" value={row.type} onChange={(e) => patchRow(row.key, { type: e.target.value })} title="Approach type">
                    <option value="">type…</option>
                    {withCurrent(APPCH_TYPES.map((t) => [t, t]), row.type).map(([v]) => <option key={v} value={v}>{v}</option>)}
                  </select>
                )}
                {(row.category === 'APPCH' || row.lineLegs) && (
                  <RunwayInput runways={runways} value={row.runway} onChange={(runway) => patchRow(row.key, { runway })} />
                )}
                <button className="unm-x" onClick={() => removeRow(row.key)} title="Remove">×</button>
              </div>
              <div className={`unm-import-sub${error ? ' error' : ''}`}>
                {row.fileName}: {error ?? rowSummary(row)}
                {replacesNav && <span className="unm-override"> · * replaces navdata {name}</span>}
                {replacesOwn && <span className="unm-warn"> · replaces your {name}</span>}
              </div>
            </div>
          )
        })}
        {skipped.length > 0 && (
          <div className="unm-skipped" title={skipped.join('\n')}>
            Skipped {plural(skipped.length, 'unsupported file')}: {skipped.map((n) => n.split('/').pop()).join(', ')}
          </div>
        )}
      </div>
      <div className="unm-footer">
        <button className="unm-btn" onClick={onCancel}>Back</button>
        <button className="unm-btn unm-btn-primary" disabled={!ready.length || busy || !theatre} onClick={doImport}>
          {busy ? 'Importing…' : `Import${ready.length ? ` (${ready.length})` : ''}`}
        </button>
      </div>
    </div>
  )
}

// ── List ────────────────────────────────────────────────────────────────────

function ProcRow({ proc, selected, onSelect, overrides, onLabel, onEdit, onDelete }) {
  const [label, setLabel] = useState(proc.label ?? '')
  useEffect(() => { setLabel(proc.label ?? '') }, [proc.label])
  const key = procKey(proc)
  const legs = Object.values(proc.transitions).reduce((n, l) => n + l.length, 0)
  const detail = [proc.type, proc.runway && `RWY ${proc.runway}`].filter(Boolean).join(' ')
  return (
    <div className="unm-proc-row">
      <input type="checkbox" checked={selected} onChange={(e) => onSelect(key, e.target.checked)} />
      <span>{proc.icao}</span>
      <span className="unm-muted">{proc.category}</span>
      <span className="unm-fix-id" title={overrides ? 'Overrides a navdata procedure with the same name' : undefined}>
        {proc.name}{overrides && <span className="unm-override"> *</span>}
      </span>
      <span className="unm-muted" title={`${plural(Object.keys(proc.transitions).length, 'transition')}, ${plural(legs, 'leg')}`}>{detail || '-'}</span>
      <input className="unm-input" value={label} maxLength={PROC_LABEL_MAX}
        placeholder={groupKeyFor(proc.category, proc.name, { ...proc, label: '' })}
        onChange={(e) => setLabel(e.target.value.toUpperCase())}
        onBlur={() => { const v = label.trim(); if (v !== (proc.label ?? '')) onLabel(key, v) }}
        title="DCB button text - blank uses the default grouping" />
      <span className="unm-row-actions">
        <span className="unm-muted unm-source" title={proc.source ?? ''}>{proc.source ?? ''}</span>
        <button className="unm-link" onClick={() => onEdit(proc)}>edit</button>
        <button className="unm-x" onClick={() => onDelete([key])} title="Delete">×</button>
      </span>
    </div>
  )
}

export function ProceduresTab({ theatre, procs, airports, lookupFix, nearestFix, pendingRows, onPendingTaken, onStatus }) {
  const updateProc  = useUserNavdataStore((s) => s.updateProc)
  const upsertProcs = useUserNavdataStore((s) => s.upsertProcs)
  const removeProcs = useUserNavdataStore((s) => s.removeProcs)
  const { ensure: ensureBase, overrides } = useBaseProcNames()

  // The airport the user is signed into, when it's in this theatre.
  const facilityId   = useSessionStore((s) => s.facilityId)
  const facilityIcao = airports.some((a) => a.icao === facilityId) ? facilityId : ''

  const [mode, setMode]         = useState('list')   // list | build | import
  const [editing, setEditing]   = useState(null)     // proc being edited, null = new
  const [importRows, setImportRows] = useState([])
  const [filter, setFilter]     = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [confirm, setConfirm]   = useState(null)     // { label, keys }

  useEffect(() => { setSelected(new Set()); setConfirm(null); setMode('list'); setImportRows([]) }, [theatre])
  useEffect(() => { ensureBase([...new Set(procs.map((p) => p.icao))]) }, [procs, ensureBase])

  // Procedure files dropped on the IMPORT tab land here.
  useEffect(() => {
    if (!pendingRows?.length) return
    setImportRows((rs) => [...rs, ...pendingRows.map((r) => (r.icao ? r : { ...r, icao: facilityIcao }))])
    setMode('import')
    onPendingTaken()
  }, [pendingRows, onPendingTaken, facilityIcao])

  const q = filter.trim().toUpperCase()
  const shown = q
    ? procs.filter((p) => procKey(p).includes(q) || (p.label ?? '').includes(q) || (p.source ?? '').toUpperCase().includes(q))
    : procs
  const icaos = useMemo(() => [...new Set(procs.map((p) => p.icao))].sort(), [procs])

  const report = (err, ok) => onStatus(err ? { error: err } : { message: ok })

  const saveBuilt = async (candidate) => {
    const err = editing
      ? await updateProc(theatre, procKey(editing), candidate)
      : await upsertProcs(theatre, [candidate])
    report(err, `Saved ${candidate.category} ${normalizeProcName(candidate.name)} at ${candidate.icao}`)
    if (!err) { setMode('list'); setEditing(null) }
  }

  const del = async (keys) => {
    const err = await removeProcs(theatre, keys)
    report(err, `Deleted ${plural(keys.length, 'procedure')}`)
    if (!err) setSelected((s) => { const n = new Set(s); keys.forEach((k) => n.delete(k)); return n })
    setConfirm(null)
  }

  const toggle = (key, on) => setSelected((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n })
  const allShownSelected = shown.length > 0 && shown.every((p) => selected.has(procKey(p)))

  if (mode === 'build') {
    return (
      <ProcBuilder theatre={theatre} airports={airports} facilityIcao={facilityIcao} lookupFix={lookupFix} procs={procs} initial={editing}
        overrides={overrides} ensureBase={ensureBase} onSave={saveBuilt}
        onCancel={() => { setMode('list'); setEditing(null) }} />
    )
  }

  if (mode === 'import') {
    return (
      <ProcImport theatre={theatre} airports={airports} facilityIcao={facilityIcao} procs={procs} rows={importRows} setRows={setImportRows}
        overrides={overrides} ensureBase={ensureBase} nearestFix={nearestFix}
        onDone={(result) => { onStatus(result); if (!result.error) setMode('list') }}
        onCancel={() => setMode('list')} />
    )
  }

  return (
    <div className="unm-body">
      <div className="unm-toolbar">
        <input className="unm-input" placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="unm-spacer" />
        <button className="unm-btn" onClick={() => { setEditing(null); setMode('build') }}>New</button>
        <button className="unm-btn" onClick={() => setMode('import')}>Import</button>
        <select className="unm-select" value="" disabled={!icaos.length}
          onChange={(e) => { const icao = e.target.value; if (icao) downloadJson(`${icao}.json`, exportAirport(procs, icao)) }}>
          <option value="">export airport…</option>
          {icaos.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <button className="unm-btn" disabled={!selected.size}
          onClick={() => setConfirm({ label: `Delete ${plural(selected.size, 'selected procedure')}?`, keys: [...selected] })}>
          Delete selected
        </button>
      </div>

      {confirm && (
        <div className="unm-confirm">
          <span>{confirm.label}</span>
          <button className="unm-btn unm-btn-danger" onClick={() => del(confirm.keys)}>Confirm</button>
          <button className="unm-btn" onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      )}

      <div className="unm-proc-row unm-fix-head">
        <input type="checkbox" checked={allShownSelected} title="Select all shown"
          onChange={(e) => setSelected(e.target.checked ? new Set(shown.map(procKey)) : new Set())} />
        <span>APT</span><span>CAT</span><span>NAME</span><span>TYPE/RWY</span><span>DCB LABEL</span><span>SOURCE</span>
      </div>
      <div className="unm-list">
        {shown.map((p) => (
          <ProcRow key={procKey(p)} proc={p} selected={selected.has(procKey(p))} onSelect={toggle}
            overrides={overrides(p.icao, p.category, p.name)}
            onLabel={async (key, label) => report(await updateProc(theatre, key, { label }), 'Saved')}
            onEdit={(proc) => { setEditing(proc); setMode('build') }}
            onDelete={(keys) => setConfirm({ label: `Delete ${p.category} ${p.name} at ${p.icao}?`, keys })} />
        ))}
        {!procs.length && <div className="unm-empty">No user procedures in {theatre}</div>}
      </div>
      <div className="unm-footnote">* overrides a navdata procedure with the same name · procedures appear in the STARS DCB when their airport is your facility</div>
    </div>
  )
}
