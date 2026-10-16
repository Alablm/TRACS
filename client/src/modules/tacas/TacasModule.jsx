import { useEffect, useMemo, useRef, useState } from 'react'
import { useControllersStore } from '../../store/controllers.js'
import { useSessionStore } from '../../store/session.js'
import { useTacasStore } from '../../store/tacas.js'
import { useUnitsStore } from '../../store/units.js'
import { resolveCallsign } from '../../utils/callsign.js'
import { findCoalitionBullseye } from '../../utils/tacticalHelpers.js'
import { useMissionClock } from '../../utils/useMissionClock.js'
import { sendTacasDirectMessage, sendWebrtcEvent } from '../../webrtc/client.js'
import { formatCoordinates } from '../../utils/coords.js'
import { latLngToWorldPixel, mgrsGridForView, pointToScreen, TILE_SIZE, visibleTiles, worldPixelToLatLng } from './mapMath.js'
import { getTacasAircrewCheckInDefaults, TACAS_AIRCREW_CHECK_IN_FIELDS } from './aircrewCheckIn.js'
import { fetchTerrainElevation, formatTacasNineLine, formatTargetElevation, TACAS_NINE_LINE_FIELDS } from './nineLine.js'
import {
  findOwnedTacasEchoPoint,
  getTacasPeerPositions,
  findSelectedTacasEchoPoint,
  findTacasAircraft,
  findTacasAircraftForPositions,
  formatTacasEchoPointReadout,
} from './tacasHelpers.js'
import './TacasModule.css'

const MIN_ZOOM = 2
const MAX_ZOOM = 19
const MIN_SIDEBAR_WIDTH = 240
const MAX_SIDEBAR_WIDTH = 600
const DEFAULT_SIDEBAR_WIDTH = 330
const DEFAULT_SIDEBAR_SECTION_HEIGHTS = [190, 132, 132]
const MIN_SIDEBAR_SECTION_HEIGHT = 72
const MIN_SIDEBAR_CHAT_HEIGHT = 100
const SIDEBAR_SECTION_HEADER_HEIGHT = 39
const SIDEBAR_SECTION_RESIZER_HEIGHT = 6
const COORDINATE_FORMATS = ['dms', 'decimal', 'mgrs', 'ddm', 'metric']
const COORDINATE_FORMAT_LABELS = { dms: 'DMS', decimal: 'DEC', mgrs: 'MGRS', ddm: 'DDM', metric: 'XY' }
const COMPACT_SIDEBAR_MEDIA_QUERY = '(max-width: 760px), (any-pointer: coarse)'

/**
 * Keeps the mobile sidebar in a compact state by default to avoid taking over the screen on touch devices.
 */
function initialCollapsedSections() {
  if (!window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches) return {}
  return { markers: true, echoPoints: true, checkIns: true, chat: false }
}

/**
 * Reads the last persisted height for the mobile sidebar so the TACAS panel retains its layout across visits.
 */
function readMobileSidebarHeight() {
  const storedHeight = Number(localStorage.getItem('tracs.tacas.mobileSidebarHeight'))
  if (Number.isFinite(storedHeight) && storedHeight >= 180 && storedHeight <= 1000) return storedHeight
  return Math.max(240, Math.min(480, Math.round(window.innerHeight * 0.42)))
}

/**
 * Restores the configured sizes for each sidebar section after a refresh, while falling back to the default layout when data is stale.
 */
function readSidebarSectionHeights() {
  const storedHeights = localStorage.getItem('tracs.tacas.sidebarSectionHeights')
  if (!storedHeights) return DEFAULT_SIDEBAR_SECTION_HEIGHTS

  try {
    const heights = JSON.parse(storedHeights)
    if (Array.isArray(heights) &&
        heights.length === DEFAULT_SIDEBAR_SECTION_HEIGHTS.length &&
        heights.every((height) => Number.isFinite(height) && height >= MIN_SIDEBAR_SECTION_HEIGHT && height <= 1000)) {
      return heights
    }
  } catch (error) {
    console.error('Unable to read TACAS sidebar section heights', error)
  }
  return DEFAULT_SIDEBAR_SECTION_HEIGHTS
}

/**
 * Restores the previous sidebar width, clamped to the safe range for the tactical layout.
 */
function readSidebarWidth() {
  const storedWidth = Number(localStorage.getItem('tracs.tacas.sidebarWidth'))
  return Number.isFinite(storedWidth) && storedWidth >= MIN_SIDEBAR_WIDTH && storedWidth <= MAX_SIDEBAR_WIDTH
    ? storedWidth
    : DEFAULT_SIDEBAR_WIDTH
}

/**
 * Formats map coordinates according to the user's selected display mode, preserving a graceful fallback when the format is not available.
 */
function formatTacasCoordinates(lat, lng, format, theatre) {
  return formatCoordinates(lat, lng, format, theatre) ?? 'XY unavailable'
}

/**
 * Renders a single tile in the TACAS map using the custom or fallback image source as needed.
 */
function TacasMapTile({ tile }) {
  const [customTileFailed, setCustomTileFailed] = useState(false)
  return (
    <>
      {tile.fallbackUrl && (
        <img
          alt=""
          className="tacas-tile tacas-tile-fallback"
          draggable="false"
          height={TILE_SIZE}
          src={tile.fallbackUrl}
          style={{ left: tile.left, top: tile.top }}
          width={TILE_SIZE}
        />
      )}
      {(!tile.fallbackUrl || !customTileFailed) && (
        <img
          alt=""
          className="tacas-tile tacas-tile-custom"
          draggable="false"
          height={TILE_SIZE}
          onError={() => {
            if (tile.fallbackUrl) setCustomTileFailed(true)
          }}
          src={tile.url}
          style={{ left: tile.left, top: tile.top }}
          width={TILE_SIZE}
        />
      )}
    </>
  )
}

/**
 * Uses the coalition bullseye as the initial map center so the TACAS view opens near the relevant battle area.
 */
function initialView() {
  const { bullseyes, coalition } = useSessionStore.getState()
  const bullseye = findCoalitionBullseye(bullseyes, coalition)
  return {
    center: {
      lat: bullseye?.latitude ?? 41.5,
      lng: bullseye?.longitude ?? 43.5,
    },
    zoom: 5,
  }
}

/**
 * Restores the locally hidden marker IDs so the user can keep a custom subset of TACAS overlays visible.
 */
function readHiddenMarkerIds() {
  const stored = localStorage.getItem('tracs.tacas.hiddenMarkerIds')
  if (!stored) return []

  try {
    const markerIds = JSON.parse(stored)
    if (Array.isArray(markerIds) && markerIds.every((id) => typeof id === 'string')) return markerIds
    console.error('Unable to read hidden TACAS markers preference: expected an array of marker ids')
  } catch (error) {
    console.error('Unable to read hidden TACAS markers preference', error)
  }
  return []
}

/**
 * Loads the terrain elevation for a marker on demand and displays a lightweight progress label until the fetch resolves.
 */
function MarkerElevation({ lat, lng, elevationUnit }) {
  const elementRef = useRef(null)
  const [elevationM, setElevationM] = useState(undefined)

  useEffect(() => {
    const element = elementRef.current
    if (!element) return undefined

    let requested = false
    let active = true
    const loadElevation = () => {
      if (requested) return
      requested = true
      setElevationM(undefined)
      fetchTerrainElevation(lat, lng)
        .then((value) => { if (active) setElevationM(value) })
        .catch((error) => {
          if (!active) return
          console.error('Unable to load TACAS marker elevation', error)
          setElevationM(null)
        })
    }

    if (typeof IntersectionObserver === 'undefined') {
      loadElevation()
      return () => { active = false }
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect()
        loadElevation()
      }
    })
    observer.observe(element)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [lat, lng])

  const label = elevationM === undefined ? 'ELEV…' : formatTargetElevation(elevationM, elevationUnit) ?? 'ELEV N/A'
  return <small className="tacas-marker-elevation" ref={elementRef}>{label}</small>
}

export default function TacasModule() {
  const positionName = useSessionStore((state) => state.positionName)
  const peers = useSessionStore((state) => state.peers)
  const positionTypeName = useSessionStore((state) => state.positionTypeName)
  const coalition = useSessionStore((state) => state.coalition)
  const mission = useSessionStore((state) => state.mission)
  const { timeStr, localTimeStr, formatTimeAt } = useMissionClock()
  const bullseyes = useSessionStore((state) => state.bullseyes)
  const units = useUnitsStore((state) => state.units)
  const markers = useTacasStore((state) => state.markers)
  const messages = useTacasStore((state) => state.messages)
  const directMessages = useTacasStore((state) => state.directMessages)
  const aircrewCheckIns = useTacasStore((state) => state.aircrewCheckIns)
  const upsertMarker = useTacasStore((state) => state.upsertMarker)
  const removeMarker = useTacasStore((state) => state.removeMarker)
  const addMessage = useTacasStore((state) => state.addMessage)
  const upsertAircrewCheckIn = useTacasStore((state) => state.upsertAircrewCheckIn)
  const registry = useControllersStore((state) => state.registry)

  const mapRef = useRef(null)
  const sidebarPanelRef = useRef(null)
  const dragRef = useRef(null)
  const mobileSidebarResizeRef = useRef(null)
  const sidebarSectionResizeRef = useRef(null)
  const sidebarSectionHeightsRef = useRef(null)
  const chatBodyRef = useRef(null)
  const aircrewCheckInDialogRef = useRef(null)
  const aircrewCheckInReadDialogRef = useRef(null)
  const markerLabelDialogRef = useRef(null)
  const nineLineDialogRef = useRef(null)
  const initialCenterResolved = useRef(false)
  const centeredOnAircraft = useRef(false)
  const [mapSize, setMapSize] = useState({ width: 0, height: 0 })
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const [mobileSidebarHeight, setMobileSidebarHeight] = useState(readMobileSidebarHeight)
  const [sidebarSectionHeights, setSidebarSectionHeights] = useState(readSidebarSectionHeights)
  if (sidebarSectionHeightsRef.current === null) sidebarSectionHeightsRef.current = sidebarSectionHeights
  const [view, setView] = useState(initialView)
  const [placingMarker, setPlacingMarker] = useState(false)
  const [placingEchoPoint, setPlacingEchoPoint] = useState(false)
  const [selectedEchoPointId, setSelectedEchoPointId] = useState(null)
  const [markerOwnerFilter, setMarkerOwnerFilter] = useState('__global__')
  const [hiddenMarkerIds, setHiddenMarkerIds] = useState(readHiddenMarkerIds)
  const [pendingMarker, setPendingMarker] = useState(null)
  const [pendingMarkerLabel, setPendingMarkerLabel] = useState('')
  const [cursor, setCursor] = useState(null)
  const [messageText, setMessageText] = useState('')
  const [chatMode, setChatMode] = useState('global')
  const [showLocalMissionTime, setShowLocalMissionTime] = useState(false)
  const [chatRecipient, setChatRecipient] = useState('')
  const [chatSendError, setChatSendError] = useState('')
  const [nineLineMode, setNineLineMode] = useState('global')
  const [nineLineRecipient, setNineLineRecipient] = useState('')
  const [nineLineSendError, setNineLineSendError] = useState('')
  const [aircrewCheckInValues, setAircrewCheckInValues] = useState({})
  const [selectedAircrewCheckIn, setSelectedAircrewCheckIn] = useState(null)
  const [nineLineMarker, setNineLineMarker] = useState(null)
  const [nineLineValues, setNineLineValues] = useState({})
  const [elevationUnit, setElevationUnit] = useState(
    () => localStorage.getItem('tracs.tacas.elevationUnit') === 'm' ? 'm' : 'ft'
  )
  const [coordinateFormat, setCoordinateFormat] = useState(
    () => COORDINATE_FORMATS.includes(localStorage.getItem('tracs.tacas.coordinateFormat'))
      ? localStorage.getItem('tracs.tacas.coordinateFormat')
      : 'decimal'
  )
  const [showEchoLines, setShowEchoLines] = useState(
    () => localStorage.getItem('tracs.tacas.showEchoLines') !== 'false'
  )
  const [showMgrsGrid, setShowMgrsGrid] = useState(
    () => localStorage.getItem('tracs.tacas.showMgrsGrid') === 'true'
  )
  const [touchMapDraggingEnabled, setTouchMapDraggingEnabled] = useState(
    () => localStorage.getItem('tracs.tacas.touchMapDraggingEnabled') !== 'false'
  )
  const [collapsedSections, setCollapsedSections] = useState(initialCollapsedSections)
  const [updatedSections, setUpdatedSections] = useState({})
  const coordinateTheatre = mission?.mission?.theatre
  const missionClock = showLocalMissionTime ? localTimeStr : timeStr
  const isAircrew = positionTypeName.toUpperCase() === 'AIRCREW'
  const ownAircrewCheckIn = aircrewCheckIns.find((checkIn) =>
    checkIn.from.toUpperCase() === positionName.toUpperCase()
  )
  const directRecipients = useMemo(
    () => getTacasPeerPositions(peers, positionName),
    [peers, positionName]
  )
  const chatMessages = useMemo(
    () => [...messages, ...directMessages].sort((a, b) => a.timestamp - b.timestamp),
    [messages, directMessages]
  )
  const regularMarkers = useMemo(
    () => markers.filter((marker) => marker.markerType !== 'ECHO_POINT'),
    [markers]
  )
  const sortedMarkers = useMemo(
    () => [...regularMarkers].sort((a, b) => b.updatedAt - a.updatedAt),
    [regularMarkers]
  )
  const markerOwners = useMemo(() => {
    const ownersByKey = new Map()
    const tacasPeerPositions = getTacasPeerPositions(peers)
    for (const owner of [positionName, ...tacasPeerPositions, ...regularMarkers.map((marker) => marker.createdBy)]) {
      if (typeof owner !== 'string' || !owner.trim()) continue
      const key = owner.trim().toUpperCase()
      if (!ownersByKey.has(key)) ownersByKey.set(key, owner.trim())
    }
    return [...ownersByKey.values()].sort((a, b) => a.localeCompare(b))
  }, [positionName, peers, regularMarkers])
  const visibleMarkers = markerOwnerFilter === '__global__'
    ? sortedMarkers
    : sortedMarkers.filter((marker) => marker.createdBy.toUpperCase() === markerOwnerFilter.toUpperCase())
  const echoPoints = useMemo(
    () => markers.filter((marker) => marker.markerType === 'ECHO_POINT'),
    [markers]
  )
  const elevationUnitRef = useRef(elevationUnit)
  elevationUnitRef.current = elevationUnit
  const previousSectionItems = useRef(null)
  const nineLineElevationM = useRef(null)
  const nineLineElevationEdited = useRef(false)
  const nineLineLocationEdited = useRef(false)

  useEffect(() => {
    const element = mapRef.current
    if (!element) return
    const resize = () => setMapSize({ width: element.clientWidth, height: element.clientHeight })
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY)
    const handleLayoutChange = (event) => {
      if (event.matches) {
        setCollapsedSections({ markers: true, echoPoints: true, checkIns: true, chat: false })
      } else {
        setCollapsedSections({})
      }
    }
    mediaQuery.addEventListener('change', handleLayoutChange)
    return () => mediaQuery.removeEventListener('change', handleLayoutChange)
  }, [])

  useEffect(() => {
    const element = mapRef.current
    if (!element) return
    const zoomWithWheel = (event) => {
      event.preventDefault()
      const delta = event.deltaY < 0 ? 1 : -1
      setView((current) => ({ ...current, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom + delta)) }))
    }
    element.addEventListener('wheel', zoomWithWheel, { passive: false })
    return () => element.removeEventListener('wheel', zoomWithWheel)
  }, [])

  useEffect(() => {
    if (!collapsedSections.chat && chatBodyRef.current) {
      chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight
    }
  }, [chatMessages, collapsedSections.chat])

  useEffect(() => {
    const currentItems = {
      markers: regularMarkers,
      echoPoints,
      checkIns: aircrewCheckIns,
      chat: chatMessages,
    }
    const previousItems = previousSectionItems.current
    if (previousItems) {
      const changedSections = Object.keys(currentItems).filter((section) => {
        const current = currentItems[section]
        const previous = previousItems[section]
        return JSON.stringify(current) !== JSON.stringify(previous)
      })
      const changedCollapsedSections = changedSections.filter((section) => collapsedSections[section])
      if (changedCollapsedSections.length > 0) {
        setUpdatedSections((current) => {
          const next = { ...current }
          for (const section of changedCollapsedSections) next[section] = true
          return next
        })
      }
    }
    previousSectionItems.current = currentItems
  }, [regularMarkers, echoPoints, aircrewCheckIns, chatMessages, collapsedSections])

  function toggleSection(section) {
    if (window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches) {
      setCollapsedSections({
        markers: section !== 'markers',
        echoPoints: section !== 'echoPoints',
        checkIns: section !== 'checkIns',
        chat: section !== 'chat',
      })
      setUpdatedSections((current) => ({ ...current, [section]: false }))
      return
    }
    const isCollapsed = collapsedSections[section] ?? false
    setCollapsedSections((current) => ({ ...current, [section]: !isCollapsed }))
    if (isCollapsed) {
      setUpdatedSections((current) => ({ ...current, [section]: false }))
    }
  }

  function resizeSidebar(clientX) {
    const workspace = mapRef.current?.closest('.tacas-workspace')
    if (!workspace) return
    const maxWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.floor(workspace.clientWidth * 0.6))
    const width = Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, workspace.getBoundingClientRect().right - clientX))
    setSidebarWidth(width)
  }

  function finishSidebarResize() {
    if (mobileSidebarResizeRef.current) {
      mobileSidebarResizeRef.current = null
      localStorage.setItem('tracs.tacas.mobileSidebarHeight', String(mobileSidebarHeight))
      return
    }
    localStorage.setItem('tracs.tacas.sidebarWidth', String(sidebarWidth))
  }

  function resizeMobileSidebar(clientY) {
    const workspace = mapRef.current?.closest('.tacas-workspace')
    if (!workspace) return
    const maxHeight = Math.min(1000, Math.floor(workspace.clientHeight * 0.8))
    setMobileSidebarHeight(Math.max(180, Math.min(maxHeight, workspace.getBoundingClientRect().bottom - clientY)))
  }

  function handleSidebarResizeKeyDown(event) {
    const compactLayout = window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches
    if (compactLayout) {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      const delta = event.key === 'ArrowUp' ? 16 : -16
      setMobileSidebarHeight((height) => {
        const nextHeight = Math.max(180, Math.min(1000, height + delta))
        localStorage.setItem('tracs.tacas.mobileSidebarHeight', String(nextHeight))
        return nextHeight
      })
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' ? 16 : -16
    const maxWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.floor(event.currentTarget.parentElement.clientWidth * 0.6))
    setSidebarWidth((width) => {
      const nextWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, width + delta))
      localStorage.setItem('tracs.tacas.sidebarWidth', String(nextWidth))
      return nextWidth
    })
  }

  function resizeSidebarSection(currentHeights, index, requestedHeight) {
    const panelHeight = sidebarPanelRef.current?.clientHeight ?? 0
    if (panelHeight === 0) return currentHeights
    const collapsedHeaderHeight = Number.parseFloat(
      getComputedStyle(sidebarPanelRef.current).getPropertyValue('--tacas-collapsed-section-height')
    ) || SIDEBAR_SECTION_HEADER_HEIGHT
    const otherSectionsHeight = currentHeights.reduce((total, height, sectionIndex) => {
      if (sectionIndex === index) return total
      const section = ['markers', 'echoPoints', 'checkIns'][sectionIndex]
      return total + (collapsedSections[section] ? collapsedHeaderHeight : height)
    }, 0)
    const maxHeight = Math.max(
      MIN_SIDEBAR_SECTION_HEIGHT,
      Math.min(1000, panelHeight - otherSectionsHeight -
        SIDEBAR_SECTION_RESIZER_HEIGHT * DEFAULT_SIDEBAR_SECTION_HEIGHTS.length -
        MIN_SIDEBAR_CHAT_HEIGHT)
    )
    return currentHeights.map((height, sectionIndex) => sectionIndex === index
      ? Math.max(MIN_SIDEBAR_SECTION_HEIGHT, Math.min(maxHeight, requestedHeight))
      : height)
  }

  function handleSidebarSectionResizeKeyDown(event, index) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 12 : -12
    const nextHeights = resizeSidebarSection(
      sidebarSectionHeightsRef.current,
      index,
      sidebarSectionHeightsRef.current[index] + delta
    )
    sidebarSectionHeightsRef.current = nextHeights
    setSidebarSectionHeights(nextHeights)
    localStorage.setItem('tracs.tacas.sidebarSectionHeights', JSON.stringify(nextHeights))
  }

  function handleSidebarSectionResizePointerDown(event, index) {
    event.currentTarget.setPointerCapture(event.pointerId)
    sidebarSectionResizeRef.current = {
      index,
      startY: event.clientY,
      startHeight: sidebarSectionHeights[index],
    }
  }

  function handleSidebarSectionResizePointerMove(event) {
    const resize = sidebarSectionResizeRef.current
    if (!resize || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const nextHeights = resizeSidebarSection(
      sidebarSectionHeightsRef.current,
      resize.index,
      resize.startHeight + event.clientY - resize.startY
    )
    sidebarSectionHeightsRef.current = nextHeights
    setSidebarSectionHeights(nextHeights)
  }

  function handleSidebarSectionResizePointerUp() {
    sidebarSectionResizeRef.current = null
    localStorage.setItem('tracs.tacas.sidebarSectionHeights', JSON.stringify(sidebarSectionHeightsRef.current))
  }

  useEffect(() => {
    if (!directRecipients.includes(chatRecipient)) setChatRecipient(directRecipients[0] ?? '')
  }, [directRecipients, chatRecipient])

  useEffect(() => {
    if (!directRecipients.includes(nineLineRecipient)) setNineLineRecipient(directRecipients[0] ?? '')
  }, [directRecipients, nineLineRecipient])

  useEffect(() => {
    if (!nineLineMarker) return undefined

    let active = true
    fetchTerrainElevation(nineLineMarker.lat, nineLineMarker.lng)
      .then((elevationM) => {
        if (!active) return
        nineLineElevationM.current = elevationM
        if (nineLineElevationEdited.current) return
        const elevation = formatTargetElevation(elevationM, elevationUnitRef.current)
        setNineLineValues((current) => current.targetElevation === 'Loading terrain…'
          ? { ...current, targetElevation: elevation ?? 'Elevation unavailable' }
          : current)
      })
      .catch((error) => {
        if (!active || nineLineElevationEdited.current) return
        console.error('Unable to load target elevation for CAS 9-line', error)
        setNineLineValues((current) => current.targetElevation === 'Loading terrain…'
          ? { ...current, targetElevation: 'Elevation unavailable' }
          : current)
      })
    return () => { active = false }
  }, [nineLineMarker])

  useEffect(() => {
    const elevationM = nineLineElevationM.current
    if (!nineLineMarker || elevationM === null || nineLineElevationEdited.current) return
    const elevation = formatTargetElevation(elevationM, elevationUnit)
    setNineLineValues((current) => current.targetElevation === 'Elevation unavailable'
      ? current
      : { ...current, targetElevation: elevation ?? 'Elevation unavailable' })
  }, [nineLineMarker, elevationUnit])

  useEffect(() => {
    if (!nineLineMarker || nineLineLocationEdited.current) return
    setNineLineValues((current) => ({
      ...current,
      targetLocation: formatTacasCoordinates(nineLineMarker.lat, nineLineMarker.lng, coordinateFormat, coordinateTheatre),
    }))
  }, [nineLineMarker, coordinateFormat, coordinateTheatre])

  const tiles = useMemo(
    () => visibleTiles(mapSize.width, mapSize.height, view.center, view.zoom, coordinateTheatre),
    [coordinateTheatre, mapSize, view]
  )
  const mgrsGrid = useMemo(
    () => showMgrsGrid ? mgrsGridForView(view.center, view.zoom, mapSize.width, mapSize.height) : null,
    [mapSize, showMgrsGrid, view]
  )

  const positionedUnits = useMemo(
    () => Object.values(units ?? {}).filter((unit) => Number.isFinite(unit.position?.lat) && Number.isFinite(unit.position?.lng)),
    [units]
  )
  const aircrewPositionNames = useMemo(
    () => Object.values(registry)
      .filter((entry) => entry.suffix === 'TACAS')
      .map((entry) => entry.positionName),
    [registry]
  )
  const matchingAircraft = useMemo(
    () => findTacasAircraftForPositions(units, aircrewPositionNames, resolveCallsign),
    [units, aircrewPositionNames]
  )
  const ownAircraft = useMemo(
    () => findTacasAircraft(units, positionName, positionTypeName, resolveCallsign)[0] ?? null,
    [units, positionName, positionTypeName]
  )

  useEffect(() => {
    if (!centeredOnAircraft.current && matchingAircraft.length) {
      const { position } = matchingAircraft[0].unit
      setView((current) => ({ ...current, center: { lat: position.lat, lng: position.lng } }))
      centeredOnAircraft.current = true
      return
    }
    if (initialCenterResolved.current) return
    const bullseye = findCoalitionBullseye(bullseyes, coalition)
    if (Number.isFinite(bullseye?.latitude) && Number.isFinite(bullseye?.longitude)) {
      initialCenterResolved.current = true
      return
    }
    const unit = positionedUnits[0]
    if (!unit) return
    setView((current) => ({ ...current, center: { lat: unit.position.lat, lng: unit.position.lng } }))
    initialCenterResolved.current = true
  }, [bullseyes, coalition, matchingAircraft, positionedUnits])

  function recenter() {
    if (activeEchoPoint) {
      setView((current) => ({
        center: { lat: activeEchoPoint.lat, lng: activeEchoPoint.lng },
        zoom: Math.max(current.zoom, 7),
      }))
      return
    }
    if (!positionedUnits.length) return
    const lat = positionedUnits.reduce((sum, unit) => sum + unit.position.lat, 0) / positionedUnits.length
    const lng = positionedUnits.reduce((sum, unit) => sum + unit.position.lng, 0) / positionedUnits.length
    setView((current) => ({ center: { lat, lng }, zoom: Math.max(current.zoom, 7) }))
  }

  function placeMarkerAt(lat, lng, label) {
    const marker = {
      id: crypto.randomUUID(),
      lat,
      lng,
      label: placingEchoPoint ? 'Echo Point' : label,
      ...(placingEchoPoint ? { markerType: 'ECHO_POINT' } : {}),
      createdBy: positionName,
      updatedAt: Date.now(),
    }
    upsertMarker(marker)
    sendWebrtcEvent('TACAS_MARKER_UPSERT', { marker })
    setPlacingMarker(false)
    setPlacingEchoPoint(false)
  }

  function handlePointerDown(event) {
    if (event.button !== 0) return
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      view,
      moved: false,
      canPan: event.pointerType !== 'touch' || touchMapDraggingEnabled,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event) {
    const bounds = mapRef.current?.getBoundingClientRect()
    if (bounds) {
      const x = event.clientX - bounds.left
      const y = event.clientY - bounds.top
      setCursor(worldPixelToLatLng(
        latLngToWorldPixel(view.center.lat, view.center.lng, view.zoom).x + x - mapSize.width / 2,
        latLngToWorldPixel(view.center.lat, view.center.lng, view.zoom).y + y - mapSize.height / 2,
        view.zoom
      ))
    }

    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.hypot(dx, dy) > 4) drag.moved = true
    if (!drag.moved || !drag.canPan) return
    const centerPixel = latLngToWorldPixel(drag.view.center.lat, drag.view.center.lng, drag.view.zoom)
    setView({
      zoom: drag.view.zoom,
      center: worldPixelToLatLng(centerPixel.x - dx, centerPixel.y - dy, drag.view.zoom),
    })
  }

  function handlePointerUp(event) {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || drag.moved || !placingMarker) return
    const bounds = mapRef.current?.getBoundingClientRect()
    if (!bounds) return
    const centerPixel = latLngToWorldPixel(view.center.lat, view.center.lng, view.zoom)
    const latLng = worldPixelToLatLng(
      centerPixel.x + event.clientX - bounds.left - mapSize.width / 2,
      centerPixel.y + event.clientY - bounds.top - mapSize.height / 2,
      view.zoom
    )
    if (placingEchoPoint) {
      placeMarkerAt(latLng.lat, latLng.lng)
      return
    }
    setPendingMarker({ lat: latLng.lat, lng: latLng.lng })
    setPendingMarkerLabel(`Marker ${markers.length + 1}`)
    setPlacingMarker(false)
    markerLabelDialogRef.current?.showModal()
  }

  function savePendingMarker(event) {
    event.preventDefault()
    if (!pendingMarker) return
    const defaultLabel = `Marker ${markers.length + 1}`
    placeMarkerAt(
      pendingMarker.lat,
      pendingMarker.lng,
      pendingMarkerLabel.trim().slice(0, 64) || defaultLabel
    )
    markerLabelDialogRef.current?.close()
  }

  function changeZoom(delta) {
    setView((current) => ({ ...current, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom + delta)) }))
  }

  function postMessage(text) {
    text = text.trim()
    if (!text) return
    const message = { id: crypto.randomUUID(), from: positionName, text, timestamp: Date.now() }
    addMessage(message)
    sendWebrtcEvent('TACAS_CHAT_MESSAGE', message)
  }

  function sendMessage(event) {
    event.preventDefault()
    const text = messageText.trim()
    if (!text) return
    if (chatMode === 'direct') {
      if (!chatRecipient) return
      if (!sendTacasDirectMessage({ text, toPosition: chatRecipient })) {
        setChatSendError(`Unable to send direct message to ${chatRecipient}. They may have disconnected.`)
        return
      }
    } else {
      postMessage(text)
    }
    setChatSendError('')
    setMessageText('')
  }

  function openAircrewCheckIn() {
    setAircrewCheckInValues(ownAircrewCheckIn?.values ?? getTacasAircrewCheckInDefaults(positionName, ownAircraft))
    aircrewCheckInDialogRef.current?.showModal()
  }

  function sendAircrewCheckIn(event) {
    event.preventDefault()
    const checkIn = {
      from: positionName,
      values: aircrewCheckInValues,
      updatedAt: Math.max(Date.now(), (ownAircrewCheckIn?.updatedAt ?? 0) + 1),
    }
    upsertAircrewCheckIn(checkIn)
    sendWebrtcEvent('TACAS_AIRCREW_CHECK_IN', { checkIn })
    aircrewCheckInDialogRef.current?.close()
  }

  function openAircrewCheckInDetails(checkIn) {
    setSelectedAircrewCheckIn(checkIn)
    aircrewCheckInReadDialogRef.current?.showModal()
  }

  function openNineLine(marker) {
    setNineLineMarker(marker)
    setNineLineSendError('')
    nineLineElevationM.current = null
    nineLineElevationEdited.current = false
    nineLineLocationEdited.current = false
    setNineLineValues({
      targetDescription: marker.label,
      targetElevation: 'Loading terrain…',
      targetLocation: formatTacasCoordinates(marker.lat, marker.lng, coordinateFormat, coordinateTheatre),
    })
    nineLineDialogRef.current?.showModal()
  }

  function updateNineLineField(key, value) {
    if (key === 'targetElevation') nineLineElevationEdited.current = true
    if (key === 'targetLocation') nineLineLocationEdited.current = true
    setNineLineValues((current) => ({ ...current, [key]: value }))
  }

  function cycleCoordinateFormat() {
    const currentIndex = COORDINATE_FORMATS.indexOf(coordinateFormat)
    const nextFormat = COORDINATE_FORMATS[(currentIndex + 1) % COORDINATE_FORMATS.length]
    localStorage.setItem('tracs.tacas.coordinateFormat', nextFormat)
    setCoordinateFormat(nextFormat)
  }

  function cycleElevationUnit() {
    const nextUnit = elevationUnit === 'ft' ? 'm' : 'ft'
    localStorage.setItem('tracs.tacas.elevationUnit', nextUnit)
    setElevationUnit(nextUnit)
  }

  function toggleEchoLines() {
    const next = !showEchoLines
    localStorage.setItem('tracs.tacas.showEchoLines', String(next))
    setShowEchoLines(next)
  }

  function toggleMgrsGrid() {
    const next = !showMgrsGrid
    localStorage.setItem('tracs.tacas.showMgrsGrid', String(next))
    setShowMgrsGrid(next)
  }

  function toggleTouchMapDragging() {
    const next = !touchMapDraggingEnabled
    localStorage.setItem('tracs.tacas.touchMapDraggingEnabled', String(next))
    setTouchMapDraggingEnabled(next)
  }

  function updateHiddenMarkerIds(nextMarkerIds) {
    localStorage.setItem('tracs.tacas.hiddenMarkerIds', JSON.stringify(nextMarkerIds))
    setHiddenMarkerIds(nextMarkerIds)
  }

  function toggleMarkerVisibility(markerId) {
    updateHiddenMarkerIds(hiddenMarkerIds.includes(markerId)
      ? hiddenMarkerIds.filter((id) => id !== markerId)
      : [...hiddenMarkerIds, markerId])
  }

  function toggleAllMarkerVisibility() {
    const markerIds = visibleMarkers.map((marker) => marker.id)
    const allVisibleMarkersAreVisible = visibleMarkers.every((marker) => !hiddenMarkerIdSet.has(marker.id))
    updateHiddenMarkerIds(allVisibleMarkersAreVisible
      ? [...hiddenMarkerIds.filter((id) => !markerIds.includes(id)), ...markerIds]
      : hiddenMarkerIds.filter((id) => !markerIds.includes(id)))
  }

  function toggleAllEchoPointVisibility() {
    const echoPointIds = echoPoints.map((echoPoint) => echoPoint.id)
    updateHiddenMarkerIds(allEchoPointsVisible
      ? [...hiddenMarkerIds.filter((id) => !echoPointIds.includes(id)), ...echoPointIds]
      : hiddenMarkerIds.filter((id) => !echoPointIds.includes(id)))
  }

  function sendNineLine(event) {
    event.preventDefault()
    const text = formatTacasNineLine(nineLineValues)
    if (nineLineMode === 'direct') {
      if (!nineLineRecipient) return
      if (!sendTacasDirectMessage({ text, toPosition: nineLineRecipient })) {
        setNineLineSendError(`Unable to send direct message to ${nineLineRecipient}. They may have disconnected.`)
        return
      }
    } else {
      postMessage(text)
    }
    nineLineDialogRef.current?.close()
  }

  function deleteMarker(id) {
    removeMarker(id)
    sendWebrtcEvent('TACAS_MARKER_REMOVE', { id })
  }

  function focusMarker(marker) {
    setView((current) => ({ center: { lat: marker.lat, lng: marker.lng }, zoom: Math.max(current.zoom, 10) }))
  }

  const ownEchoPoint = findOwnedTacasEchoPoint(markers, positionName, positionTypeName)
  const activeEchoPoint = findSelectedTacasEchoPoint(markers, selectedEchoPointId, ownEchoPoint)
  const hiddenMarkerIdSet = new Set(hiddenMarkerIds)
  const allMarkersVisible = visibleMarkers.every((marker) => !hiddenMarkerIdSet.has(marker.id))
  const allEchoPointsVisible = echoPoints.every((echoPoint) => !hiddenMarkerIdSet.has(echoPoint.id))
  const theatreName = mission?.mission?.theatre ?? 'NO MISSION THEATRE'

  return (
    <main className="tacas-workspace" style={{ '--tacas-sidebar-width': `${sidebarWidth}px` }}>
      <section className="tacas-map-column">
        <header className="tacas-map-toolbar">
          <div className="tacas-map-title">
            <span>TACAS</span>
            <span className="tacas-theatre">{theatreName}</span>
          </div>
          <div className="tacas-map-actions">
            <button
              aria-label={`Touch map dragging ${touchMapDraggingEnabled ? 'enabled' : 'disabled'}. Toggle touch map dragging`}
              aria-pressed={touchMapDraggingEnabled}
              className={`tacas-icon-button tacas-touch-pan-toggle${touchMapDraggingEnabled ? ' is-active' : ''}`}
              onClick={toggleTouchMapDragging}
              title={`Touch map dragging ${touchMapDraggingEnabled ? 'enabled' : 'disabled'} (local setting)`}
              type="button"
            >
              <svg aria-hidden="true" className="tacas-toolbar-icon" viewBox="0 0 24 24" focusable="false">
                <path d="M8 11V5a1.5 1.5 0 0 1 3 0v5-2a1.5 1.5 0 0 1 3 0v2-1a1.5 1.5 0 0 1 3 0v2-1a1.5 1.5 0 0 1 3 0v5c0 4-2.5 7-6.5 7h-1c-2 0-3.2-.8-4.5-2.2L5 16a1.5 1.5 0 0 1 2.1-2.1L8 15" />
              </svg>
            </button>
            {isAircrew && (
              <button
                aria-label={ownAircrewCheckIn ? 'Update aircrew check-in' : 'Aircrew check-in'}
                className="tacas-place-button"
                onClick={openAircrewCheckIn}
                title={ownAircrewCheckIn ? 'Update aircrew check-in' : 'Aircrew check-in'}
                type="button"
              >
                <svg aria-hidden="true" className="tacas-toolbar-icon" viewBox="0 0 24 24" focusable="false">
                  <path d="M9 4H6a2 2 0 0 0-2 2v14h16V6a2 2 0 0 0-2-2h-3M9 3h6v4H9zM8 13l2.5 2.5L16 10" />
                </svg>
              </button>
            )}
            <button
              aria-label={`Elevation units: ${elevationUnit === 'ft' ? 'feet' : 'meters'}. Switch to ${elevationUnit === 'ft' ? 'meters' : 'feet'}`}
              className="tacas-icon-button"
              onClick={cycleElevationUnit}
              title={`Switch to ${elevationUnit === 'ft' ? 'metric' : 'imperial'}`}
              type="button"
            >
              <svg aria-hidden="true" className="tacas-toolbar-icon" viewBox="0 0 24 24" focusable="false">
                <path d="m5.914 12 2.282 2.283m.76-5.326 2.283 2.282M12 5.914l2.283 2.282m-9.74 5.174 8.826-8.826c.853-.852 1.28-1.278 1.77-1.438.433-.14.898-.14 1.33 0 .491.16.917.586 1.768 1.437l1.22 1.219c.852.852 1.278 1.28 1.438 1.77.14.433.14.897 0 1.33-.16.49-.586.917-1.438 1.77l-8.826 8.826c-.853.852-1.28 1.278-1.77 1.438-.433.14-.897.14-1.33 0-.49-.16-.918-.586-1.77-1.439l-1.22-1.218c-.85-.852-1.276-1.277-1.436-1.769a2.15 2.15 0 0 1 0-1.33c.16-.49.586-.917 1.438-1.77"/>
              </svg>
            </button>
            <button
              aria-label={`Coordinate format: ${COORDINATE_FORMAT_LABELS[coordinateFormat]}. Switch to ${COORDINATE_FORMAT_LABELS[COORDINATE_FORMATS[(COORDINATE_FORMATS.indexOf(coordinateFormat) + 1) % COORDINATE_FORMATS.length]]}`}
              className="tacas-icon-button tacas-elevation-unit"
              onClick={cycleCoordinateFormat}
              title={`Switch coordinate format to ${COORDINATE_FORMATS[(COORDINATE_FORMATS.indexOf(coordinateFormat) + 1) % COORDINATE_FORMATS.length].toUpperCase()}`}
              type="button"
            >
              <svg aria-hidden="true" className="tacas-toolbar-icon" viewBox="0 0 24 24" focusable="false">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3z" />
              </svg>
            </button>
            <button
              aria-label={placingMarker && !placingEchoPoint ? 'Cancel marker placement' : 'Place a marker'}
              className={`tacas-place-button tacas-marker-place-button${placingMarker && !placingEchoPoint ? ' is-active' : ''}`}
              onClick={() => {
                setPlacingEchoPoint(false)
                setPlacingMarker((active) => placingEchoPoint ? true : !active)
              }}
              title="Place a marker at the next map click"
              type="button"
            >
              <svg aria-hidden="true" className="tacas-toolbar-icon" viewBox="0 0 24 24" focusable="false">
                {placingMarker && !placingEchoPoint
                  ? <path d="m6 6 12 12M18 6 6 18" />
                  : <><path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" /><path d="M12 6v6m-3-3h6" /></>}
              </svg>
            </button>
            {positionTypeName === 'JTAC' && (
              <button
                aria-label={placingMarker && placingEchoPoint
                  ? 'Cancel Echo Point placement'
                  : ownEchoPoint ? 'Replace Echo Point' : 'Place Echo Point'}
                className={`tacas-place-button tacas-echo-point-button${placingMarker && placingEchoPoint ? ' is-active' : ''}`}
                onClick={() => {
                  if (placingMarker && placingEchoPoint) {
                    setPlacingMarker(false)
                    setPlacingEchoPoint(false)
                    return
                  }
                  setPlacingEchoPoint(true)
                  setPlacingMarker(true)
                }}
                title={ownEchoPoint ? 'Place a new Echo Point, replacing your current one' : 'Place your Echo Point at the next map click'}
                type="button"
              >
                <svg aria-hidden="true" className="tacas-toolbar-icon" viewBox="0 0 24 24" focusable="false">
                  {placingMarker && placingEchoPoint
                    ? <path d="m6 6 12 12M18 6 6 18" />
                    : <><circle cx="12" cy="12" r="3" /><path d="M12 2v7m0 6v7M2 12h7m6 0h7" /></>}
                </svg>
              </button>
            )}
            <button
              aria-label={`Echo Point lines ${showEchoLines ? 'shown' : 'hidden'}. Toggle Echo Point lines`}
              aria-pressed={showEchoLines}
              className={`tacas-icon-button tacas-echo-lines-toggle${showEchoLines ? ' is-active' : ''}`}
              onClick={toggleEchoLines}
              title={`Echo Point lines ${showEchoLines ? 'shown' : 'hidden'} (local setting)`}
              type="button"
            >
              <svg aria-hidden="true" className="tacas-toolbar-icon" viewBox="0 0 24 24" focusable="false">
                <path d="M12 2v7m0 6v7M2 12h7m6 0h7" />
              </svg>
            </button>
            <button
              aria-label={`MGRS grid ${showMgrsGrid ? 'shown' : 'hidden'}. Toggle MGRS grid`}
              aria-pressed={showMgrsGrid}
              className={`tacas-icon-button tacas-mgrs-grid-toggle${showMgrsGrid ? ' is-active' : ''}`}
              onClick={toggleMgrsGrid}
              title={`MGRS grid ${showMgrsGrid ? 'shown' : 'hidden'} (local setting)`}
              type="button"
            >MGRS</button>
            <button className="tacas-icon-button" onClick={recenter} title="Center on live units" type="button">◎</button>
            <button className="tacas-icon-button" onClick={() => changeZoom(-1)} title="Zoom out" type="button">−</button>
            <span className="tacas-zoom-level">Z{view.zoom}</span>
            <button className="tacas-icon-button" onClick={() => changeZoom(1)} title="Zoom in" type="button">+</button>
          </div>
        </header>
        <div
          className={`tacas-map${placingMarker ? ' is-placing' : ''}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => { dragRef.current = null }}
          onPointerLeave={() => setCursor(null)}
          ref={mapRef}
        >
          {tiles.map((tile) => (
            <TacasMapTile
              key={`${tile.key}/${tile.url}`}
              tile={tile}
            />
          ))}
          {mgrsGrid && (
            <svg
              aria-hidden="true"
              className="tacas-mgrs-grid"
              viewBox={`0 0 ${mapSize.width} ${mapSize.height}`}
              preserveAspectRatio="none"
            >
              <defs>
                {mgrsGrid.clips.map((clip) => (
                  <clipPath id={clip.id} key={clip.id}>
                    <path d={clip.d} />
                  </clipPath>
                ))}
              </defs>
              {mgrsGrid.lines.map((line, index) => (
                <path
                  className={`tacas-mgrs-grid-${line.major ? 'major' : 'minor'}`}
                  clipPath={line.clipId ? `url(#${line.clipId})` : undefined}
                  d={line.d}
                  key={`${index}/${line.clipId}`}
                />
              ))}
              {mgrsGrid.labels.map((label, index) => (
                <text
                  className={label.zone ? 'tacas-mgrs-grid-zone' : undefined}
                  clipPath={label.clipId ? `url(#${label.clipId})` : undefined}
                  key={`${label.text}/${index}`}
                  textAnchor="middle"
                  x={label.x}
                  y={label.y}
                >{label.text}</text>
              ))}
              {mgrsGrid.zoneLabel && (
                <text className="tacas-mgrs-grid-zone" x="8" y="18">{mgrsGrid.zoneLabel}</text>
              )}
            </svg>
          )}
          {matchingAircraft.map(({ id, unit, callsign, typeName }) => {
            const point = pointToScreen(unit.position.lat, unit.position.lng, view.center, view.zoom, mapSize.width, mapSize.height)
            if (point.x < -100 || point.x > mapSize.width + 100 || point.y < -60 || point.y > mapSize.height + 60) return null
            const trackDeg = Number.isFinite(unit.track) ? unit.track * 180 / Math.PI : 0
            const label = typeName ? `${callsign} ${typeName}` : callsign
            return (
              <div
                aria-label={`${label} aircraft`}
                className="tacas-aircraft-marker"
                key={id}
                role="img"
                style={{ left: point.x, top: point.y }}
                title={label}
              >
                <svg aria-hidden="true" className="tacas-aircraft-icon" viewBox="0 0 24 24" style={{ transform: `rotate(${trackDeg}deg)` }}>
                  <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z" />
                </svg>
                <span>{label}</span>
              </div>
            )
          })}
          {showEchoLines && mapSize.width > 0 && mapSize.height > 0 && (
            <svg
              aria-hidden="true"
              className="tacas-echo-lines"
              viewBox={`0 0 ${mapSize.width} ${mapSize.height}`}
              preserveAspectRatio="none"
            >
              {echoPoints.filter((marker) => !hiddenMarkerIdSet.has(marker.id)).map((marker) => {
                const point = pointToScreen(marker.lat, marker.lng, view.center, view.zoom, mapSize.width, mapSize.height)
                if (point.x < 0 || point.x > mapSize.width || point.y < 0 || point.y > mapSize.height) return null
                return (
                  <g key={marker.id}>
                    <line x1={point.x} y1={point.y} x2={point.x} y2="0" />
                    <line x1={point.x} y1={point.y} x2={mapSize.width} y2={point.y} />
                    <line x1={point.x} y1={point.y} x2={point.x} y2={mapSize.height} />
                    <line x1={point.x} y1={point.y} x2="0" y2={point.y} />
                    <text x={point.x} y={point.y - 28} textAnchor="middle" dominantBaseline="middle">A</text>
                    <text x={point.x + 28} y={point.y} textAnchor="middle" dominantBaseline="middle">B</text>
                    <text x={point.x} y={point.y + 28} textAnchor="middle" dominantBaseline="middle">C</text>
                    <text x={point.x - 28} y={point.y} textAnchor="middle" dominantBaseline="middle">D</text>
                  </g>
                )
              })}
            </svg>
          )}
          {markers.filter((marker) => !hiddenMarkerIdSet.has(marker.id)).map((marker) => {
            const point = pointToScreen(marker.lat, marker.lng, view.center, view.zoom, mapSize.width, mapSize.height)
            if (point.x < -100 || point.x > mapSize.width + 100 || point.y < -60 || point.y > mapSize.height + 60) return null
            return (
              <button
                aria-label={marker.markerType === 'ECHO_POINT'
                  ? `Echo Point owned by ${marker.createdBy.replace(/\s+JTAC$/i, '')}`
                  : `Marker ${marker.label}`}
                className={`tacas-map-marker${marker.markerType === 'ECHO_POINT' ? ' tacas-map-echo-point' : ''}`}
                data-tacas-marker
                key={marker.id}
                onClick={(event) => { event.stopPropagation(); focusMarker(marker) }}
                onPointerDown={(event) => event.stopPropagation()}
                style={{ left: point.x, top: point.y }}
                title={`${marker.label} · ${formatTacasCoordinates(marker.lat, marker.lng, coordinateFormat, coordinateTheatre)}`}
                type="button"
              >
                <span className={`tacas-pin${marker.markerType === 'ECHO_POINT' ? ' tacas-echo-pin' : ''}`}>
                  {marker.markerType === 'ECHO_POINT' ? 'E' : null}
                </span>
                <span className="tacas-pin-label">
                  {marker.markerType === 'ECHO_POINT'
                    ? marker.createdBy.replace(/\s+JTAC$/i, '')
                    : marker.label}
                </span>
              </button>
            )
          })}
          <div className="tacas-map-readout">
            {cursor
              ? activeEchoPoint
                ? formatTacasEchoPointReadout(cursor, activeEchoPoint, coordinateTheatre, elevationUnit)
                : formatTacasCoordinates(cursor.lat, cursor.lng, coordinateFormat, coordinateTheatre)
              : `${regularMarkers.length} MARKERS`}
          </div>
          <div className="tacas-attribution">
            Imagery © <a href="https://www.esri.com/en-us/legal/terms/data-attributions" target="_blank" rel="noreferrer">Esri, Maxar, Earthstar Geographics, and the GIS User Community</a>
          </div>
        </div>
      </section>

      <div
        aria-label={window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches
          ? 'Resize TACAS sidebar height'
          : 'Resize TACAS sidebar width'}
        aria-orientation={window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches ? 'horizontal' : 'vertical'}
        aria-valuemax={window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches
          ? Math.min(1000, Math.floor(window.innerHeight * 0.8))
          : Math.min(MAX_SIDEBAR_WIDTH, Math.floor((mapSize.width + sidebarWidth) * 0.6))}
        aria-valuemin={window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches ? 180 : MIN_SIDEBAR_WIDTH}
        aria-valuenow={window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches ? mobileSidebarHeight : sidebarWidth}
        className="tacas-sidebar-resizer"
        onKeyDown={handleSidebarResizeKeyDown}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          if (window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches) {
            mobileSidebarResizeRef.current = true
            resizeMobileSidebar(event.clientY)
          } else {
            resizeSidebar(event.clientX)
          }
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          if (mobileSidebarResizeRef.current) resizeMobileSidebar(event.clientY)
          else resizeSidebar(event.clientX)
        }}
        onPointerUp={finishSidebarResize}
        onPointerCancel={finishSidebarResize}
        role="separator"
        tabIndex={0}
        title="Drag to resize the TACAS sidebar"
      />

      <aside
        className="tacas-side-panel"
        ref={sidebarPanelRef}
        style={{
          '--tacas-mobile-sidebar-height': `${mobileSidebarHeight}px`,
          gridTemplateRows: [
            collapsedSections.markers ? 'var(--tacas-collapsed-section-height)' : `${sidebarSectionHeights[0]}px`,
            `${SIDEBAR_SECTION_RESIZER_HEIGHT}px`,
            collapsedSections.echoPoints ? 'var(--tacas-collapsed-section-height)' : `${sidebarSectionHeights[1]}px`,
            `${SIDEBAR_SECTION_RESIZER_HEIGHT}px`,
            collapsedSections.checkIns ? 'var(--tacas-collapsed-section-height)' : `${sidebarSectionHeights[2]}px`,
            `${SIDEBAR_SECTION_RESIZER_HEIGHT}px`,
            collapsedSections.chat ? 'var(--tacas-collapsed-section-height)' : `minmax(${MIN_SIDEBAR_CHAT_HEIGHT}px, 1fr)`,
          ].join(' '),
        }}
      >
        <section className={`tacas-markers-panel${collapsedSections.markers ? ' is-collapsed' : ''}`}>
          <header className={`tacas-section-heading${updatedSections.markers ? ' has-update' : ''}`}>
            <h2 className="tacas-section-heading-title">
              <button
                aria-expanded={!collapsedSections.markers}
                aria-label={`MARKERS: ${collapsedSections.markers ? 'Expand' : 'Collapse'} section${updatedSections.markers ? ', new updates' : ''}`}
                className="tacas-section-toggle"
                onClick={() => toggleSection('markers')}
                type="button"
              >
                <span className="tacas-section-chevron" aria-hidden="true">{collapsedSections.markers ? '▶' : '▼'}</span>
                <span>MARKERS</span>
                {updatedSections.markers && <span className="tacas-section-updated">NEW</span>}
              </button>
            </h2>
            <div className="tacas-marker-heading-actions">
              <select
                aria-label="Filter markers by user"
                className="tacas-marker-owner-filter"
                onChange={(event) => setMarkerOwnerFilter(event.target.value)}
                value={markerOwnerFilter}
              >
                <option value="__global__">Global</option>
                {markerOwners.map((owner) => <option key={owner.toUpperCase()} value={owner}>{owner}</option>)}
              </select>
              <span>{visibleMarkers.length}</span>
              <button
                aria-label="Toggle visibility of all markers"
                aria-pressed={allMarkersVisible}
                className="tacas-marker-visibility tacas-toggle-all-markers"
                disabled={visibleMarkers.length === 0}
                onClick={toggleAllMarkerVisibility}
                title={`${allMarkersVisible ? 'Hide' : 'Show'} all markers on your map`}
                type="button"
              >{allMarkersVisible ? 'HIDE ALL' : 'SHOW ALL'}</button>
            </div>
          </header>
          {!collapsedSections.markers && (
            <div className="tacas-section-content tacas-marker-list">
              {visibleMarkers.length === 0 ? (
                <div className="tacas-empty-markers">No markers placed</div>
              ) : visibleMarkers.map((marker) => (
                <div className="tacas-marker-row" key={marker.id}>
                  <button className="tacas-marker-focus" onClick={() => focusMarker(marker)} title="Center map on marker" type="button">
                    <span className="tacas-marker-dot" />
                    <span className="tacas-marker-description">
                      <strong>{marker.label}</strong>
                      <small>{formatTacasCoordinates(marker.lat, marker.lng, coordinateFormat, coordinateTheatre)} · {marker.createdBy}</small>
                      <MarkerElevation elevationUnit={elevationUnit} lat={marker.lat} lng={marker.lng} />
                    </span>
                  </button>
                  <button
                    className="tacas-build-nine-line"
                    onClick={() => openNineLine(marker)}
                    title={`Build a 9-line for ${marker.label}`}
                    type="button"
                  >9-line</button>
                  <button
                    aria-label={`${hiddenMarkerIdSet.has(marker.id) ? 'Show' : 'Hide'} marker ${marker.label} on your map`}
                    aria-pressed={!hiddenMarkerIdSet.has(marker.id)}
                    className="tacas-marker-visibility"
                    onClick={() => toggleMarkerVisibility(marker.id)}
                    title={`${hiddenMarkerIdSet.has(marker.id) ? 'Show' : 'Hide'} ${marker.label} on your map`}
                    type="button"
                  >{hiddenMarkerIdSet.has(marker.id) ? 'SHOW' : 'HIDE'}</button>
                  <button className="tacas-delete-marker" onClick={() => deleteMarker(marker.id)} title={`Remove ${marker.label}`} type="button">×</button>
                </div>
              ))}
            </div>
          )}
        </section>

        <div
          aria-hidden={collapsedSections.markers}
          aria-label="Resize Markers window"
          aria-orientation="horizontal"
          aria-valuemax={resizeSidebarSection(sidebarSectionHeights, 0, 1000)[0]}
          aria-valuemin={MIN_SIDEBAR_SECTION_HEIGHT}
          aria-valuenow={sidebarSectionHeights[0]}
          className={`tacas-section-resizer${collapsedSections.markers ? ' is-disabled' : ''}`}
          onKeyDown={(event) => handleSidebarSectionResizeKeyDown(event, 0)}
          onPointerDown={(event) => handleSidebarSectionResizePointerDown(event, 0)}
          onPointerMove={handleSidebarSectionResizePointerMove}
          onPointerUp={handleSidebarSectionResizePointerUp}
          role="separator"
          tabIndex={collapsedSections.markers ? -1 : 0}
          title="Drag to resize the Markers window"
        />

        <section className={`tacas-echo-points-panel${collapsedSections.echoPoints ? ' is-collapsed' : ''}`}>
          <header className={`tacas-section-heading${updatedSections.echoPoints ? ' has-update' : ''}`}>
            <h2 className="tacas-section-heading-title">
              <button
                aria-expanded={!collapsedSections.echoPoints}
                aria-label={`ECHO POINTS: ${collapsedSections.echoPoints ? 'Expand' : 'Collapse'} section${updatedSections.echoPoints ? ', new updates' : ''}`}
                className="tacas-section-toggle"
                onClick={() => toggleSection('echoPoints')}
                type="button"
              >
                <span className="tacas-section-chevron" aria-hidden="true">{collapsedSections.echoPoints ? '▶' : '▼'}</span>
                <span>ECHO POINTS</span>
                {updatedSections.echoPoints && <span className="tacas-section-updated">NEW</span>}
              </button>
            </h2>
            <div className="tacas-marker-heading-actions">
              <span>{echoPoints.length}</span>
              <button
                aria-label="Toggle visibility of all Echo Points"
                aria-pressed={allEchoPointsVisible}
                className="tacas-marker-visibility tacas-toggle-all-markers"
                disabled={echoPoints.length === 0}
                onClick={toggleAllEchoPointVisibility}
                title={`${allEchoPointsVisible ? 'Hide' : 'Show'} all Echo Points on your map`}
                type="button"
              >{allEchoPointsVisible ? 'HIDE ALL' : 'SHOW ALL'}</button>
            </div>
          </header>
          {!collapsedSections.echoPoints && (
            <div className="tacas-section-content tacas-echo-point-list">
              {echoPoints.length === 0 ? (
                <div className="tacas-empty-markers">No Echo Points available</div>
              ) : echoPoints.map((echoPoint) => {
                const isActive = activeEchoPoint?.id === echoPoint.id
                const ownerCallsign = echoPoint.createdBy.replace(/\s+JTAC$/i, '')
                return (
                  <div className="tacas-echo-point-row" key={echoPoint.id}>
                    <span className="tacas-echo-point-owner">
                      <strong>{ownerCallsign}</strong>
                      <small>{isActive ? 'USING FOR READOUT' : 'ECHO POINT'}</small>
                    </span>
                    <button
                      aria-pressed={isActive}
                      className={`tacas-echo-point-use${isActive ? ' is-active' : ''}`}
                      onClick={() => setSelectedEchoPointId(isActive && selectedEchoPointId === echoPoint.id ? null : echoPoint.id)}
                      title={`Use ${ownerCallsign}'s Echo Point for your cursor readout`}
                      type="button"
                    >{isActive ? 'USING' : 'USE'}</button>
                    <button
                      aria-label={`${hiddenMarkerIdSet.has(echoPoint.id) ? 'Show' : 'Hide'} ${ownerCallsign}'s Echo Point on your map`}
                      aria-pressed={!hiddenMarkerIdSet.has(echoPoint.id)}
                      className="tacas-marker-visibility"
                      onClick={() => toggleMarkerVisibility(echoPoint.id)}
                      title={`${hiddenMarkerIdSet.has(echoPoint.id) ? 'Show' : 'Hide'} ${ownerCallsign}'s Echo Point on your map`}
                      type="button"
                    >{hiddenMarkerIdSet.has(echoPoint.id) ? 'SHOW' : 'HIDE'}</button>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <div
          aria-hidden={collapsedSections.echoPoints}
          aria-label="Resize Echo Points window"
          aria-orientation="horizontal"
          aria-valuemax={resizeSidebarSection(sidebarSectionHeights, 1, 1000)[1]}
          aria-valuemin={MIN_SIDEBAR_SECTION_HEIGHT}
          aria-valuenow={sidebarSectionHeights[1]}
          className={`tacas-section-resizer${collapsedSections.echoPoints ? ' is-disabled' : ''}`}
          onKeyDown={(event) => handleSidebarSectionResizeKeyDown(event, 1)}
          onPointerDown={(event) => handleSidebarSectionResizePointerDown(event, 1)}
          onPointerMove={handleSidebarSectionResizePointerMove}
          onPointerUp={handleSidebarSectionResizePointerUp}
          role="separator"
          tabIndex={collapsedSections.echoPoints ? -1 : 0}
          title="Drag to resize the Echo Points window"
        />

        <section className={`tacas-check-ins-panel${collapsedSections.checkIns ? ' is-collapsed' : ''}`}>
          <header className={`tacas-section-heading${updatedSections.checkIns ? ' has-update' : ''}`}>
            <h2 className="tacas-section-heading-title">
              <button
                aria-expanded={!collapsedSections.checkIns}
                aria-label={`AIRCREW CHECK-INS: ${collapsedSections.checkIns ? 'Expand' : 'Collapse'} section${updatedSections.checkIns ? ', new updates' : ''}`}
                className="tacas-section-toggle"
                onClick={() => toggleSection('checkIns')}
                type="button"
              >
                <span className="tacas-section-chevron" aria-hidden="true">{collapsedSections.checkIns ? '▶' : '▼'}</span>
                <span>AIRCREW CHECK-INS</span>
                {updatedSections.checkIns && <span className="tacas-section-updated">NEW</span>}
              </button>
            </h2>
            <span>{aircrewCheckIns.length}</span>
          </header>
          {!collapsedSections.checkIns && (
            <div className="tacas-section-content tacas-check-in-list">
              {aircrewCheckIns.length === 0 ? (
                <div className="tacas-empty-markers">No Aircrew check-ins</div>
              ) : aircrewCheckIns.map((checkIn) => (
                <button
                  className="tacas-check-in-item"
                  key={checkIn.from.toUpperCase()}
                  onClick={() => openAircrewCheckInDetails(checkIn)}
                  type="button"
                >
                  <strong>{checkIn.from}</strong>
                  <small>{checkIn.values.aircraft || 'Check-in'} · {formatTimeAt(checkIn.updatedAt, showLocalMissionTime) ?? '--:--:--'}</small>
                </button>
              ))}
            </div>
          )}
        </section>

        <div
          aria-hidden={collapsedSections.checkIns}
          aria-label="Resize Aircrew Check-Ins window"
          aria-orientation="horizontal"
          aria-valuemax={resizeSidebarSection(sidebarSectionHeights, 2, 1000)[2]}
          aria-valuemin={MIN_SIDEBAR_SECTION_HEIGHT}
          aria-valuenow={sidebarSectionHeights[2]}
          className={`tacas-section-resizer${collapsedSections.checkIns ? ' is-disabled' : ''}`}
          onKeyDown={(event) => handleSidebarSectionResizeKeyDown(event, 2)}
          onPointerDown={(event) => handleSidebarSectionResizePointerDown(event, 2)}
          onPointerMove={handleSidebarSectionResizePointerMove}
          onPointerUp={handleSidebarSectionResizePointerUp}
          role="separator"
          tabIndex={collapsedSections.checkIns ? -1 : 0}
          title="Drag to resize the Aircrew Check-Ins window"
        />

        <section className={`tacas-chat-panel${collapsedSections.chat ? ' is-collapsed' : ''}`}>
          <header className={`tacas-section-heading${updatedSections.chat ? ' has-update' : ''}`}>
            <h2 className="tacas-section-heading-title">
              <button
                aria-expanded={!collapsedSections.chat}
                aria-label={`TACAS CHAT: ${collapsedSections.chat ? 'Expand' : 'Collapse'} section${updatedSections.chat ? ', new updates' : ''}`}
                className="tacas-section-toggle"
                onClick={() => toggleSection('chat')}
                type="button"
              >
                <span className="tacas-section-chevron" aria-hidden="true">{collapsedSections.chat ? '▶' : '▼'}</span>
                <span>TACAS CHAT</span>
                {updatedSections.chat && <span className="tacas-section-updated">NEW</span>}
              </button>
            </h2>
            <span className="tacas-chat-heading-meta">
              <button
                aria-label={`Mission time ${missionClock ?? (showLocalMissionTime ? '--:--:--L' : '--:--:--Z')}. Click to toggle Zulu / Local time`}
                className="tacas-chat-clock"
                onClick={() => setShowLocalMissionTime((showLocal) => !showLocal)}
                title="Click to toggle Zulu / Local time"
                type="button"
              >
                {missionClock ?? (showLocalMissionTime ? '--:--:--L' : '--:--:--Z')}
              </button>
              {Object.values(registry).filter((entry) => entry.suffix === 'TACAS').length} ONLINE
            </span>
          </header>
          {!collapsedSections.chat && (
            <div className="tacas-chat-content">
              <div className="tacas-chat-feed" ref={chatBodyRef}>
                {chatMessages.map((message) => (
                  <article className={`tacas-chat-message${message.from === positionName ? ' is-own' : ''}`} key={message.id}>
                    <header>
                      <strong>({message.from}) &gt; {message.toPosition ? `(${message.toPosition})` : 'Global'}</strong>
                      <time>{formatTimeAt(message.timestamp, showLocalMissionTime) ?? '--:--:--'}</time>
                    </header>
                    <p>{message.text}</p>
                  </article>
                ))}
              </div>
              <form className="tacas-chat-compose" onSubmit={sendMessage}>
                <div className="tacas-chat-routing">
                  <select
                    aria-label="TACAS chat mode"
                    onChange={(event) => { setChatMode(event.target.value); setChatSendError('') }}
                    value={chatMode}
                  >
                    <option value="global">Global</option>
                    <option value="direct">Direct</option>
                  </select>
                  {chatMode === 'direct' && (
                    <select
                      aria-label="Direct message recipient"
                      onChange={(event) => { setChatRecipient(event.target.value); setChatSendError('') }}
                      value={chatRecipient}
                    >
                      {directRecipients.length === 0
                        ? <option value="">No other users online</option>
                        : directRecipients.map((recipient) => <option key={recipient} value={recipient}>{recipient}</option>)}
                    </select>
                  )}
                </div>
                <div className="tacas-chat-input-row">
                  <input
                    aria-label="TACAS chat message"
                    autoComplete="off"
                    maxLength={500}
                    onChange={(event) => { setMessageText(event.target.value); setChatSendError('') }}
                    placeholder={chatMode === 'direct' ? 'Direct message' : 'Message TACAS users'}
                    value={messageText}
                  />
                  <button
                    aria-label="Send message"
                    disabled={!messageText.trim() || (chatMode === 'direct' && !chatRecipient)}
                    title="Send message"
                    type="submit"
                  >↑</button>
                </div>
                {chatSendError && <small className="tacas-chat-error" role="alert">{chatSendError}</small>}
              </form>
            </div>
          )}
        </section>
      </aside>
      {isAircrew && (
        <dialog
          aria-labelledby="tacas-aircrew-check-in-title"
          className="tacas-nine-line-dialog"
          ref={aircrewCheckInDialogRef}
        >
          <form className="tacas-nine-line-form" onSubmit={sendAircrewCheckIn}>
            <header className="tacas-nine-line-header">
              <div><h2 id="tacas-aircrew-check-in-title">AIRCREW CHECK-IN</h2></div>
              <button
                aria-label="Close Aircrew check-in"
                className="tacas-icon-button"
                onClick={() => aircrewCheckInDialogRef.current?.close()}
                type="button"
              >×</button>
            </header>
            <div className="tacas-nine-line-fields">
              {TACAS_AIRCREW_CHECK_IN_FIELDS.map(({ number, key, label, maxLength }) => (
                <label className="tacas-nine-line-field" key={key}>
                  <span><strong>{number}</strong>{label}</span>
                  <input
                    autoFocus={number === 1}
                    maxLength={maxLength}
                    onChange={(event) => setAircrewCheckInValues((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))}
                    value={aircrewCheckInValues[key] ?? ''}
                  />
                </label>
              ))}
            </div>
            <footer className="tacas-nine-line-actions">
              <button
                className="tacas-nine-line-cancel"
                onClick={() => aircrewCheckInDialogRef.current?.close()}
                type="button"
              >Cancel</button>
              <button className="tacas-nine-line-send" type="submit">
                {ownAircrewCheckIn ? 'Update check-in' : 'Send check-in'}
              </button>
            </footer>
          </form>
        </dialog>
      )}
      <dialog
        aria-labelledby="tacas-aircrew-check-in-read-title"
        className="tacas-nine-line-dialog"
        onClose={() => setSelectedAircrewCheckIn(null)}
        ref={aircrewCheckInReadDialogRef}
      >
        <div className="tacas-nine-line-form">
          <header className="tacas-nine-line-header">
            <div>
              <h2 id="tacas-aircrew-check-in-read-title">
                {selectedAircrewCheckIn?.from ?? 'AIRCREW'} CHECK-IN
              </h2>
              {selectedAircrewCheckIn && <p>Updated {formatTimeAt(selectedAircrewCheckIn.updatedAt, showLocalMissionTime) ?? '--:--:--'}</p>}
            </div>
            <button
              aria-label="Close Aircrew check-in details"
              className="tacas-icon-button"
              onClick={() => aircrewCheckInReadDialogRef.current?.close()}
              type="button"
            >×</button>
          </header>
          <div className="tacas-nine-line-fields">
            {TACAS_AIRCREW_CHECK_IN_FIELDS.map(({ number, key, label }) => (
              <div className="tacas-check-in-detail" key={key}>
                <span><strong>{number}</strong>{label}</span>
                <p>{selectedAircrewCheckIn?.values[key] || '—'}</p>
              </div>
            ))}
          </div>
          <footer className="tacas-nine-line-actions">
            <button
              className="tacas-nine-line-cancel"
              onClick={() => aircrewCheckInReadDialogRef.current?.close()}
              type="button"
            >Close</button>
          </footer>
        </div>
      </dialog>
      <dialog
        aria-labelledby="tacas-nine-line-title"
        className="tacas-nine-line-dialog"
        onClose={() => setNineLineMarker(null)}
        ref={nineLineDialogRef}
      >
        <form className="tacas-nine-line-form" onSubmit={sendNineLine}>
          <header className="tacas-nine-line-header">
            <div>
              <h2 id="tacas-nine-line-title">BUILD CAS 9-LINE</h2>
              {nineLineMarker && <p>{nineLineMarker.label} · {formatTacasCoordinates(nineLineMarker.lat, nineLineMarker.lng, coordinateFormat, coordinateTheatre)}</p>}
            </div>
            <button
              aria-label="Close 9-line builder"
              className="tacas-icon-button"
              onClick={() => nineLineDialogRef.current?.close()}
              type="button"
            >×</button>
          </header>
          <div className="tacas-nine-line-fields">
            {TACAS_NINE_LINE_FIELDS.map(({ number, key, label, maxLength }) => (
              <label className="tacas-nine-line-field" key={key}>
                <span><strong>{number}</strong>{label}</span>
                <input
                  autoFocus={number === 1}
                  maxLength={maxLength}
                  onChange={(event) => updateNineLineField(key, event.target.value)}
                  value={nineLineValues[key] ?? ''}
                />
              </label>
            ))}
          </div>
          <div className="tacas-nine-line-routing">
            <label>
              <span>Send mode</span>
              <select
                aria-label="9-line send mode"
                onChange={(event) => { setNineLineMode(event.target.value); setNineLineSendError('') }}
                value={nineLineMode}
              >
                <option value="global">Global</option>
                <option value="direct">Direct</option>
              </select>
            </label>
            {nineLineMode === 'direct' && (
              <label>
                <span>Recipient</span>
                <select
                  aria-label="9-line direct message recipient"
                  onChange={(event) => { setNineLineRecipient(event.target.value); setNineLineSendError('') }}
                  value={nineLineRecipient}
                >
                  {directRecipients.length === 0
                    ? <option value="">No other users online</option>
                    : directRecipients.map((recipient) => <option key={recipient} value={recipient}>{recipient}</option>)}
                </select>
              </label>
            )}
            {nineLineSendError && <small className="tacas-chat-error" role="alert">{nineLineSendError}</small>}
          </div>
          <footer className="tacas-nine-line-actions">
            <button
              className="tacas-nine-line-cancel"
              onClick={() => nineLineDialogRef.current?.close()}
              type="button"
            >Cancel</button>
            <button
              className="tacas-nine-line-send"
              disabled={nineLineMode === 'direct' && !nineLineRecipient}
              type="submit"
            >Send to TACAS chat</button>
          </footer>
        </form>
      </dialog>
      <dialog
        aria-labelledby="tacas-marker-label-title"
        className="tacas-nine-line-dialog"
        onClose={() => {
          setPendingMarker(null)
          setPendingMarkerLabel('')
          setPlacingMarker(false)
        }}
        ref={markerLabelDialogRef}
      >
        <form className="tacas-nine-line-form" onSubmit={savePendingMarker}>
          <header className="tacas-nine-line-header">
            <div><h2 id="tacas-marker-label-title">PLACE MARKER</h2></div>
            <button
              aria-label="Close marker placement"
              className="tacas-icon-button"
              onClick={() => markerLabelDialogRef.current?.close()}
              type="button"
            >×</button>
          </header>
          <div className="tacas-nine-line-fields">
            <label className="tacas-nine-line-field">
              <span>Marker label</span>
              <input
                autoFocus
                maxLength={64}
                onChange={(event) => setPendingMarkerLabel(event.target.value)}
                value={pendingMarkerLabel}
              />
            </label>
          </div>
          <footer className="tacas-nine-line-actions">
            <button
              className="tacas-nine-line-cancel"
              onClick={() => markerLabelDialogRef.current?.close()}
              type="button"
            >Cancel</button>
            <button className="tacas-nine-line-send" type="submit">Place marker</button>
          </footer>
        </form>
      </dialog>
    </main>
  )
}