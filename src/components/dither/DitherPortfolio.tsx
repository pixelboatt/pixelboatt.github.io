import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent } from 'react'
import { experiences, personalInfo } from '../../data/portfolio'
import { bayerTile, chirp } from './effects'
import { createRenderer } from './renderer'
import { MODE_LABEL, THEMES } from './themes'
import './dither.css'

const MORPH_SECONDS = 1.15
const IDLE_MS = 10_000
/** Half-width of the dithered edge of the wipe, in px. Matches the shader's band. */
const BAND = 26
/** Radius that turns the circular wipe into a practically straight vertical edge (phone swipe). */
const LINE_R = 20_000
const SOUND_KEY = 'dp-sound'
/** Phone layout: full-bleed shape, name over it, contact rows in a bottom sheet, swipe to change theme.
 *  Also short touch screens (phones in landscape), where the desktop column would overflow. Keep in sync with dither.css. */
const PHONE = '(max-width: 819px), (pointer: coarse) and (max-height: 500px)'
/** Touch or narrow screens wipe text with a composited clip-path instead of the dithered mask. */
const COMPACT = '(max-width: 819px), (pointer: coarse)'
/** Controls in a theme layer; every layer renders the same ones in the same order. */
const FOCUSABLE = 'a[href], button'

const pad = (n: number) => String(n).padStart(2, '0')
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)
const next = (i: number, d = 1) => (i + d + THEMES.length) % THEMES.length
/** Mix two #rrggbb colors in sRGB. */
const mixHex = (a: string, b: string, k: number) =>
  '#' + [1, 3, 5].map((i) => Math.round(lerp(parseInt(a.slice(i, i + 2), 16), parseInt(b.slice(i, i + 2), 16), k)).toString(16).padStart(2, '0')).join('')
/** Share of the horizontal line at height `edge` (0..width) inside the circle at (x, y) with radius r. */
const covered = (x: number, y: number, r: number, edge: number, width: number) => {
  const d = Math.abs(edge - y)
  if (r <= d) return 0
  const half = Math.sqrt(r * r - d * d)
  return (clamp(x + half, 0, width) - clamp(x - half, 0, width)) / width
}

/** A theme named in the URL hash, otherwise a random one per visit. */
function pickInitialTheme() {
  const i = THEMES.findIndex((t) => t.name.toLowerCase() === location.hash.slice(1).toLowerCase())
  return i >= 0 ? i : Math.floor(Math.random() * THEMES.length)
}
function readSound() {
  try {
    return localStorage.getItem(SOUND_KEY) === 'on'
  } catch {
    return false
  }
}
function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => matchMedia(query).matches,
  )
}
/** Largest font size where the longer of the two name lines still fits the column.
 *  In the phone layout the name sits above the bottom sheet, so on short screens it is also
 *  capped to the height between its bottom edge and `.dp-ptop`. */
function fitName(el: HTMLElement) {
  el.style.fontSize = '100px'
  const widest = Math.max(...Array.from(el.children, (c) => c.getBoundingClientRect().width))
  let size = Math.min(180, (100 * el.clientWidth) / widest)
  const top = el.closest('.dp-layer')?.querySelector('.dp-ptop')
  if (top) {
    // the hero is anchored to the bottom, so the name's bottom edge stays put and its height scales with the font
    const box = el.getBoundingClientRect()
    size = Math.min(size, (100 * (box.bottom - top.getBoundingClientRect().bottom - 12)) / box.height)
  }
  el.style.fontSize = `${size}px`
}

interface LayerState {
  theme: number
  incoming: boolean
}

interface Controls {
  go(to: number, x?: number, y?: number): void
  target(): number
  excite(on: boolean): void
  kick(): void
}

interface Morph {
  to: number
  /** Progress 0..1. Radial wipes advance on a clock; swipes follow the finger, then ease to `goal`. */
  p: number
  /** Wipe circle in client px. A swipe moves a huge circle so its edge is a vertical line. */
  x: number
  y: number
  r: number
  far: number
  clip: boolean
  /** 0 radial wipe from a point; 1 swipe revealing from the right edge, -1 from the left. */
  line: 0 | 1 | -1
  goal: 0 | 1
  held: boolean
}

/**
 * Single-screen portfolio: a dithered, raymarched shape beside the contact sheet.
 * Clicking the shape morphs to the next theme with a wipe that starts at the click;
 * on phones the theme follows a horizontal swipe instead.
 * The WebGL loop and input live in one effect and only touch refs; React state
 * changes only when a morph starts or ends.
 */
export default function DitherPortfolio() {
  const [initial] = useState(pickInitialTheme)
  const [layers, setLayers] = useState<LayerState[]>([{ theme: initial, incoming: false }])
  const [sound, setSound] = useState(readSound)
  const [paused, setPaused] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  /** Mirrors the phone sheet once it settles open or closed, for aria-expanded and inert. */
  const [sheetOpen, setSheetOpen] = useState(false)
  /** Set once the renderer can't be created (no WebGL, shader or precision failure); layers show the static shape. */
  const [solid, setSolid] = useState(false)
  const compact = useMedia(COMPACT)
  const phone = useMedia(PHONE)

  const labRef = useRef<HTMLElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layerEls = useRef(new Map<number, HTMLDivElement>())
  const controls = useRef<Controls | null>(null)
  const soundRef = useRef(sound)
  const pausedRef = useRef(paused)
  /** Index among the outgoing layer's links and buttons that had focus, restored in the layer that replaces it; -1 for none. */
  const focusAt = useRef(-1)

  useEffect(() => {
    soundRef.current = sound
    try {
      localStorage.setItem(SOUND_KEY, sound ? 'on' : 'off')
    } catch {
      // storage can be blocked; the toggle still works for this visit
    }
  }, [sound])
  useEffect(() => {
    pausedRef.current = paused
    controls.current?.kick()
  }, [paused])

  // The incoming layer starts at the outgoing layer's sheet scroll position.
  useLayoutEffect(() => {
    if (layers.length < 2) return
    const sheet = (t: number) => layerEls.current.get(t)?.querySelector('.dp-sheet')
    const into = sheet(layers[1].theme)
    if (into) into.scrollTop = sheet(layers[0].theme)?.scrollTop ?? 0
  }, [layers])

  // Unmounting the outgoing layer drops keyboard focus to <body>; move it to the same control in the current layer.
  useLayoutEffect(() => {
    const i = focusAt.current
    if (i < 0) return
    focusAt.current = -1
    const el = layerEls.current.get(layers[0].theme)?.querySelectorAll<HTMLElement>(FOCUSABLE)[i]
    if (el && el !== document.activeElement) el.focus({ preventScroll: true })
  }, [layers])

  // A layout effect so the first painted frame already has the page color and a rendered canvas.
  useLayoutEffect(() => {
    const lab = labRef.current!, view = viewRef.current!, canvas = canvasRef.current!
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    let renderer = createRenderer(canvas)
    // whether WebGL works is only known once the real canvas tries; this layout effect re-renders before paint
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!renderer) setSolid(true)
    const s = {
      current: initial,
      morph: null as Morph | null,
      time: reduce ? 4.2 : 0,
      yaw: 0, vel: 0, mx: 0, my: 0, tmx: 0, tmy: 0,
      grain: 1, zoom: 1, excite: 0, exciteTarget: 0,
      sheet: 0,
      lastInput: performance.now(), last: performance.now(), raf: 0,
      w: 1, h: 1,
    }
    const isPhone = () => matchMedia(PHONE).matches
    const cellPx = (i: number) => {
      const t = THEMES[i]
      return Math.max(t.mode === 4 ? 4 : 1, Math.round(t.cell * s.grain))
    }
    /** Shape position in view-height units: beside the text on desktop, above the name on phones. */
    const offset = (): [number, number] => (isPhone() ? [0, 0.17] : [(0.45 * s.w) / s.h / 1.6, 0])
    /** Where the shape sits, in client px. */
    const shapeCenter = (): [number, number] => {
      const r = view.getBoundingClientRect(), [ox, oy] = offset()
      return [r.left + r.width / 2 + ox * r.height, r.top + r.height / 2 - oy * r.height]
    }

    const size = () => {
      // iOS fires resize as its toolbar collapses; reallocating the texture then stalls a morph
      if (view.clientWidth === s.w && view.clientHeight === s.h) return
      s.w = view.clientWidth
      s.h = view.clientHeight
      renderer?.resize(s.w, s.h)
    }

    // iOS Safari 26+ ignores theme-color and tints its bars from the element it hit-tests at each
    // edge. On touch and narrow screens each edge gets a strip whose color follows how much of that
    // edge the wipe covers; on desktop the strips would just show as lines during a morph.
    const tints = new Map<'top' | 'bottom', HTMLDivElement>()
    const tint = (edge: 'top' | 'bottom', color: string) => {
      if (!matchMedia(COMPACT).matches) {
        // went wide (window resized): a strip left behind would show as a stale line
        tints.forEach((t) => t.remove())
        tints.clear()
        return
      }
      let el = tints.get(edge)
      if (!el) {
        el = document.createElement('div')
        el.className = `dp-tint ${edge}`
        el.setAttribute('aria-hidden', 'true')
        document.body.append(el)
        tints.set(edge, el)
      }
      el.style.backgroundColor = color
    }
    /** Browser chrome color: theme-color for most browsers, the edge strips and page background for iOS Safari. */
    const pageColor = (i: number) => {
      document.documentElement.style.setProperty('--page', THEMES[i].paper)
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES[i].paper)
      tint('top', THEMES[i].paper)
      tint('bottom', THEMES[i].paper)
    }
    // Theme bits outside the React tree: browser chrome color, URL.
    const chrome = (i: number) => {
      pageColor(i)
      history.replaceState(null, '', `#${THEMES[i].name.toLowerCase()}`)
    }

    const render = () => {
      if (!renderer) return
      const a = THEMES[s.current], m = s.morph, b = m ? THEMES[m.to] : a, k = m ? easeInOut(m.p) : 0
      const vr = view.getBoundingClientRect()
      renderer.draw({
        time: s.time,
        mouse: [s.mx, s.my],
        rotation: [s.yaw + s.mx * 0.6, s.my * 0.5],
        from: a,
        to: b,
        morph: k,
        distance: lerp(a.distance, b.distance, k) * s.zoom * (1 - 0.1 * s.excite) * (isPhone() ? 1.5 : 1),
        offset: offset(),
        wipeCenter: m ? [m.x - vr.left, s.h - (m.y - vr.top)] : [0, 0],
        wipeRadius: m ? m.r : 1e6,
        cellFrom: cellPx(s.current),
        cellTo: cellPx(m ? m.to : s.current),
      })
    }

    /** Advance the wipe and update both layers' masks so text changes exactly where the canvas does. */
    const stepWipe = () => {
      const m = s.morph!
      const r = lab.getBoundingClientRect()
      if (m.line) {
        // the edge travels across the screen with its dithered band starting and ending off-screen
        const edge = m.line > 0 ? r.width + BAND - m.p * (r.width + 2 * BAND) : -BAND + m.p * (r.width + 2 * BAND)
        m.x = r.left + edge + m.line * LINE_R
        m.y = r.top + r.height / 2
        m.r = LINE_R
      } else {
        // ease-out: the wave lands on the far corner exactly at p=1
        m.r = lerp(-60, m.far + BAND + 4, Math.sin((m.p * Math.PI) / 2))
      }
      const x = m.x - r.left, y = m.y - r.top
      const was = THEMES[s.current].paper, will = THEMES[m.to].paper
      tint('top', mixHex(was, will, covered(x, y, m.r, 0, r.width)))
      tint('bottom', mixHex(was, will, covered(x, y, m.r, r.height, r.width)))
      const into = layerEls.current.get(m.to), from = layerEls.current.get(s.current)
      if (m.clip) {
        // Hard-edged circles: the compositor clips them without repainting the text. They overlap
        // across the canvas's dithered band, so both themes' text shows there, as with the mask.
        const c = Math.max(0, m.r + BAND), hole = Math.max(0, m.r - BAND)
        if (into) {
          into.style.maskImage = 'none'
          into.style.clipPath = `circle(${c}px at ${x}px ${y}px)`
        }
        if (from) from.style.clipPath = hole > 0
          ? `path(evenodd,"M0 0H${r.width}V${r.height}H0Z M${x - hole} ${y}a${hole} ${hole} 0 1 0 ${2 * hole} 0a${hole} ${hole} 0 1 0 ${-2 * hole} 0Z")`
          : 'none'
        return
      }
      const a = Math.max(0, m.r - BAND), b = Math.max(0, m.r + BAND)
      const band = `radial-gradient(circle at ${x}px ${y}px,#0000 ${a}px,#000 ${a}px,#000 ${b}px,#0000 ${b}px)`
      if (into) into.style.maskImage = `radial-gradient(circle at ${x}px ${y}px,#000 ${a}px,#0000 ${a}px),${band},${bayerTile(true)}`
      if (from) from.style.maskImage = `radial-gradient(circle at ${x}px ${y}px,#0000 ${b}px,#000 ${b}px),${band},${bayerTile(false)}`
    }
    /**
     * Remember which control in layer `theme` has focus, before that layer unmounts. A miss keeps
     * an index saved earlier in the same batch, e.g. by `settle()` right before an instant switch.
     */
    const keepFocus = (theme: number) => {
      const all = layerEls.current.get(theme)?.querySelectorAll(FOCUSABLE)
      const i = all ? Array.prototype.indexOf.call(all, document.activeElement) : -1
      if (i >= 0) focusAt.current = i
    }
    const finish = () => {
      const m = s.morph
      if (!m) return
      s.morph = null
      keepFocus(s.current)
      s.current = m.to
      const el = layerEls.current.get(m.to)
      // 'none', not '': until React drops data-incoming, the CSS rule for it would hide the layer for a frame
      if (el) {
        el.style.maskImage = 'none'
        el.style.clipPath = ''
      }
      setLayers([{ theme: m.to, incoming: false }])
      chrome(m.to)
    }
    /** Drop a swipe that was let go before the halfway point. */
    const cancel = () => {
      if (!s.morph) return
      s.morph = null
      const el = layerEls.current.get(s.current)
      if (el) el.style.clipPath = ''
      setLayers([{ theme: s.current, incoming: false }])
      chrome(s.current)
    }
    /** End any morph immediately, the way it was heading. */
    const settle = () => (s.morph?.goal === 0 ? cancel() : finish())

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - s.last) / 1000)
      s.last = now
      const a = THEMES[s.current], m = s.morph
      const spin = m ? lerp(a.spin, THEMES[m.to].spin, easeInOut(m.p)) : a.spin
      const playing = !pausedRef.current && !reduce
      if (playing) {
        s.time += dt
        s.yaw += spin * dt
      }
      s.excite += (s.exciteTarget - s.excite) * 0.08
      s.yaw += s.vel + s.excite * dt * 2.2
      s.vel *= 0.94
      s.mx += (s.tmx - s.mx) * 0.08
      s.my += (s.tmy - s.my) * 0.08
      if (m) {
        if (!m.line) m.p += dt / MORPH_SECONDS
        else if (!m.held) m.p = Math.abs(m.goal - m.p) < 0.002 ? m.goal : m.p + (m.goal - m.p) * Math.min(1, dt * 7)
        if (m.held) stepWipe()
        else if (m.goal === 0 && m.p <= 0) cancel()
        else if (m.p >= 1) finish()
        else stepWipe()
      }
      render()
      const moving = playing || s.morph || Math.abs(s.vel) > 1e-4 ||
        Math.abs(s.tmx - s.mx) + Math.abs(s.tmy - s.my) > 0.001 || Math.abs(s.exciteTarget - s.excite) > 0.001
      s.raf = moving && !document.hidden ? requestAnimationFrame(loop) : 0
    }
    const kick = () => {
      if (s.raf) return
      s.last = performance.now()
      s.raf = requestAnimationFrame(loop)
    }

    /**
     * Morph to theme `to`. Desktop wipes out from client point (x, y); phones sweep a vertical
     * edge in from the side given by `line`, held under the finger when `held` is set.
     */
    const go = (to: number, x?: number, y?: number, withSound = true, line: 0 | 1 | -1 = 0, held = false) => {
      settle()
      if (to === s.current) return
      s.lastInput = performance.now()
      if (withSound && soundRef.current) chirp(to, THEMES.length)
      if (reduce || !renderer) {
        keepFocus(s.current)
        s.current = to
        setLayers([{ theme: to, incoming: false }])
        chrome(to)
        render()
        return
      }
      if (!line && isPhone()) line = 1
      if (x === undefined || y === undefined) [x, y] = shapeCenter()
      const r = lab.getBoundingClientRect()
      const far = Math.hypot(Math.max(x - r.left, r.right - x), Math.max(y - r.top, r.bottom - y))
      s.morph = { to, p: 0, x, y, r: -60, far, clip: !!line || matchMedia(COMPACT).matches, line, goal: 1, held }
      setLayers([{ theme: s.current, incoming: false }, { theme: to, incoming: true }])
      kick()
    }
    // a morph springing back (goal 0) is being dropped, so the next theme counts from the current one
    const target = () => (s.morph && s.morph.goal !== 0 ? s.morph.to : s.current)
    controls.current = {
      go(to, x, y) {
        go(to, x, y, true, isPhone() ? (to > s.current ? 1 : -1) : 0)
      },
      target,
      kick,
      excite(on) {
        s.exciteTarget = on ? 1 : 0
        kick()
      },
    }

    /** Bottom sheet position, 0 peeking to 1 open. CSS reads --sheet on the root; `animate` eases it there. */
    const setSheet = (v: number, animate: boolean) => {
      s.sheet = v
      // closing makes the rows inert, so keep keyboard focus on the handle instead of dropping it to <body>
      const el = layerEls.current.get(s.current)?.querySelector('.dp-sheet')
      if (v <= 0.5 && el?.contains(document.activeElement)) el.querySelector<HTMLElement>('.dp-grab')?.focus({ preventScroll: true })
      lab.classList.toggle('is-sheet-drag', !animate)
      lab.classList.toggle('is-sheet-open', v > 0.5)
      if (animate) setSheetOpen(v > 0.5)
      lab.style.setProperty('--sheet', String(v))
    }
    const sheetTravel = () => {
      const el = layerEls.current.get(s.current)?.querySelector<HTMLElement>('.dp-sheet')
      return el ? Math.max(1, el.offsetHeight - (el.querySelector<HTMLElement>('.dp-peek')?.offsetHeight ?? 0)) : 1
    }

    // Desktop: click to morph from the click point, drag to spin with inertia.
    // Phone: swipe sideways to drag a theme in, tap to sweep to the next one, drag the sheet handle.
    // One primary pointer per gesture; events from any other pointer are ignored until it ends.
    type Down = { id: number; x: number; y: number; lx: number; lt: number; vx: number; moved: number; mode: 'view' | 'swipe' | 'sheet'; sheet0: number; travel: number }
    let down: Down | null = null
    const seen = () => { s.lastInput = performance.now() }
    const onDown = (e: PointerEvent) => {
      // left button or a first touch only: right/middle clicks and extra fingers never start a gesture
      if (down || !e.isPrimary || e.button !== 0) return
      const el = e.target as Element
      const grab = el.closest('.dp-grab')
      if (!grab && el.closest('a, button, .dp-rows, .dp-sheet, .dp-dock')) return
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, lt: e.timeStamp, vx: 0, moved: 0, mode: grab ? 'sheet' : 'view', sheet0: s.sheet, travel: grab ? sheetTravel() : 1 }
      lab.setPointerCapture(e.pointerId)
      if (!grab) view.classList.add('is-dragging')
      seen()
    }
    const onDrag = (e: PointerEvent) => {
      if (down?.id !== e.pointerId) return
      const dx = e.clientX - down.lx
      down.vx = dx / Math.max(1, e.timeStamp - down.lt)
      down.lx = e.clientX
      down.lt = e.timeStamp
      down.moved = Math.max(down.moved, Math.hypot(e.clientX - down.x, e.clientY - down.y))
      if (down.mode === 'sheet') {
        setSheet(clamp(down.sheet0 + (down.y - e.clientY) / down.travel, 0, 1), false)
        return
      }
      if (down.mode === 'view' && down.moved > 8 && isPhone()) {
        const sx = e.clientX - down.x
        if (Math.abs(sx) > Math.abs(e.clientY - down.y) && renderer && !reduce) {
          const line = sx < 0 ? 1 : -1
          go(next(target(), line), undefined, undefined, false, line, true)
          if (s.morph) down.mode = 'swipe'
        }
      }
      if (down.mode === 'swipe') {
        const m = s.morph
        if (m?.held) m.p = clamp(((down.x - e.clientX) * m.line) / lab.clientWidth, 0, 1)
      } else if (down.moved > 6 && !isPhone()) {
        s.vel = dx * 0.006
        s.yaw += dx * 0.008
        kick()
      }
    }
    const onUp = (e: PointerEvent) => {
      const d = down
      if (d?.id !== e.pointerId) return
      view.classList.remove('is-dragging')
      down = null
      if (d.mode === 'sheet') {
        // a tap toggles; a drag past a fifth of the way flips it, otherwise it snaps back
        const flip = d.moved <= 6 || Math.abs(s.sheet - d.sheet0) > 0.2
        setSheet(flip ? 1 - Math.round(d.sheet0) : Math.round(d.sheet0), true)
        return
      }
      if (d.mode === 'swipe') {
        const m = s.morph
        if (!m?.held) return
        m.held = false
        // a flick in the swipe direction commits even short of halfway; a pause before lifting is no flick
        const flick = e.timeStamp - d.lt < 80 && -d.vx * m.line > 0.5
        m.goal = m.p > 0.5 || flick ? 1 : 0
        if (m.goal && soundRef.current) chirp(m.to, THEMES.length)
        kick()
        return
      }
      if (d.moved > 6) {
        // phones without a renderer (or with reduced motion) still change theme on a swipe
        const sx = e.clientX - d.x
        if (isPhone() && (!renderer || reduce) && Math.abs(sx) > 40) go(next(target(), sx < 0 ? 1 : -1))
        return
      }
      if (isPhone() && s.sheet > 0.5) setSheet(0, true)
      else go(next(target()), e.clientX, e.clientY)
    }
    const onCancel = (e: PointerEvent) => {
      if (down?.id !== e.pointerId) return
      view.classList.remove('is-dragging')
      if (down?.mode === 'swipe' && s.morph?.held) {
        s.morph.held = false
        s.morph.goal = 0
        kick()
      }
      if (down?.mode === 'sheet') setSheet(Math.round(down.sheet0), true)
      down = null
    }
    const onMove = (e: PointerEvent) => {
      s.tmx = (e.clientX / innerWidth) * 2 - 1
      s.tmy = -((e.clientY / innerHeight) * 2 - 1)
      seen()
      kick()
    }
    // Wheel changes dither grain; pinch (ctrl+wheel on trackpads) zooms.
    let flashTimer = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      seen()
      if (e.ctrlKey) s.zoom = clamp(s.zoom * Math.exp(e.deltaY * 0.01), 0.6, 1.6)
      else s.grain = clamp(s.grain * Math.exp(-e.deltaY * 0.002), 0.5, 3)
      setFlash(`GRAIN ${s.grain.toFixed(1)}× · ZOOM ${(1 / s.zoom).toFixed(1)}×`)
      clearTimeout(flashTimer)
      flashTimer = window.setTimeout(() => setFlash(null), 1200)
      if (!s.raf) render()
    }
    const onKey = (e: KeyboardEvent) => {
      seen()
      // holding a key would restart the morph (flashing light and dark themes) or flip a toggle on every repeat
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= THEMES.length) controls.current?.go(n - 1)
      else if (e.key === 'ArrowRight') go(next(target()), undefined, undefined, true, isPhone() ? 1 : 0)
      else if (e.key === 'ArrowLeft') go(next(target(), -1), undefined, undefined, true, isPhone() ? -1 : 0)
      else if (e.key === 'm' || e.key === 'M') setSound((v) => !v)
      else if (e.key === 'Escape' && s.sheet > 0) setSheet(0, true)
      else if (e.key === ' ' && !(e.target as Element).closest?.('a, button')) {
        e.preventDefault()
        setPaused((v) => !v)
      }
    }
    const onResize = () => {
      size()
      // crossing the COMPACT breakpoint adds or drops the Safari tint strips
      if (!s.morph) pageColor(s.current)
      // desktop has no sheet; a stale open one (or a drag still in progress) would block the idle cycle
      if (!isPhone()) {
        if (down?.mode === 'sheet') down = null
        if (s.sheet > 0) setSheet(0, true)
      }
      render()
    }
    // Keyboard activation of the sheet handle (pointer taps toggle it in onUp).
    const onClick = (e: globalThis.MouseEvent) => {
      if (e.detail === 0 && (e.target as Element).closest('.dp-grab')) setSheet(s.sheet > 0.5 ? 0 : 1, true)
    }
    const onVisible = () => {
      if (document.hidden) return
      seen()
      kick()
    }
    lab.addEventListener('pointerdown', onDown)
    lab.addEventListener('pointermove', onDrag)
    lab.addEventListener('pointerup', onUp)
    lab.addEventListener('pointercancel', onCancel)
    // capture can also be lost without a pointercancel (e.g. the element is removed); treat it the same
    lab.addEventListener('lostpointercapture', onCancel)
    lab.addEventListener('click', onClick)
    view.addEventListener('wheel', onWheel, { passive: false })
    addEventListener('pointermove', onMove)
    addEventListener('keydown', onKey)
    addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisible)
    // The browser can drop the context (iOS after app switching); preventDefault lets it be restored.
    const onLost = (e: Event) => {
      e.preventDefault()
      renderer = null
    }
    const onRestored = () => {
      renderer = createRenderer(canvas)
      if (!renderer) return setSolid(true)
      s.w = s.h = 0
      size()
      render()
      kick()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    // Nobody touched anything for a while: morph on our own, silently.
    const idle = window.setInterval(() => {
      if (reduce || pausedRef.current || s.morph || down || s.sheet > 0 || document.hidden || performance.now() - s.lastInput < IDLE_MS) return
      // the pointer resting on, or keyboard focus in, the controls is someone reading, not idle;
      // :focus-visible so a dot left focused by a mouse click does not stop the cycle for good
      if (lab.querySelector('.dp-rows:hover, .dp-dock:hover, .dp-pdock:hover, .dp-rows :focus-visible, .dp-dock :focus-visible, .dp-pdock :focus-visible')) return
      go(next(s.current), ...shapeCenter(), false)
    }, 500)

    chrome(initial)
    size()
    render()
    kick()

    return () => {
      cancelAnimationFrame(s.raf)
      clearInterval(idle)
      clearTimeout(flashTimer)
      lab.removeEventListener('pointerdown', onDown)
      lab.removeEventListener('pointermove', onDrag)
      lab.removeEventListener('pointerup', onUp)
      lab.removeEventListener('pointercancel', onCancel)
      lab.removeEventListener('lostpointercapture', onCancel)
      lab.removeEventListener('click', onClick)
      view.removeEventListener('wheel', onWheel)
      removeEventListener('pointermove', onMove)
      removeEventListener('keydown', onKey)
      removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisible)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      renderer?.dispose()
      tints.forEach((el) => el.remove())
      controls.current = null
    }
  }, [initial])

  const hint = flash ?? (paused ? 'PAUSED · SPACE TO PLAY' : phone ? '← SWIPE →' : compact ? 'TAP TO MORPH · DRAG TO SPIN' : 'CLICK TO MORPH · DRAG TO SPIN · SCROLL FOR GRAIN')
  const toggleSound = () => {
    const on = !sound
    setSound(on)
    if (on) chirp(controls.current?.target() ?? 0, THEMES.length)
  }

  return (
    <main className="dp" ref={labRef}>
      <div className="dp-view" ref={viewRef} aria-hidden="true">
        <canvas ref={canvasRef} />
      </div>
      {layers.map(({ theme, incoming }) => (
        <ThemeLayer
          key={theme}
          theme={theme}
          incoming={incoming}
          solid={solid}
          clip={compact}
          phone={phone}
          sheetOpen={sheetOpen}
          hint={hint}
          sound={sound}
          register={(el) => {
            if (el) layerEls.current.set(theme, el)
            else layerEls.current.delete(theme)
          }}
          onDot={(i, e) => {
            const r = e.currentTarget.getBoundingClientRect()
            controls.current?.go(i, r.left + r.width / 2, r.top + r.height / 2)
          }}
          onSound={toggleSound}
          onExcite={(on) => controls.current?.excite(on)}
        />
      ))}
    </main>
  )
}

interface ThemeLayerProps {
  theme: number
  incoming: boolean
  solid: boolean
  /** Wipe with a composited clip-path (touch and narrow screens) instead of the dithered mask. */
  clip: boolean
  /** Render the phone layout: name over the shape, rows in a bottom sheet. */
  phone: boolean
  sheetOpen: boolean
  hint: string
  sound: boolean
  register: (el: HTMLDivElement | null) => void
  onDot: (i: number, e: MouseEvent<HTMLButtonElement>) => void
  onSound: () => void
  onExcite: (on: boolean) => void
}

const now = experiences[0]
const before = experiences[experiences.length - 1]
const since = before.period.split(' ')[0]
const arrow = (period: string) => period.replace(' - ', ' → ').replace('Present', 'present')

/** One full copy of the page chrome and copy, colored by its theme. */
function ThemeLayer({ theme, incoming, solid, clip, phone, sheetOpen, hint, sound, register, onDot, onSound, onExcite }: ThemeLayerProps) {
  const t = THEMES[theme]
  const ref = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLHeadingElement>(null)
  const [scrambles] = useState(incoming)

  useLayoutEffect(() => {
    register(ref.current)
    return () => register(null)
    // registration is keyed by theme, which never changes for a mounted layer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useLayoutEffect(() => {
    const el = nameRef.current!
    const fit = () => fitName(el)
    fit()
    document.fonts?.ready.then(fit)
    addEventListener('resize', fit)
    return () => removeEventListener('resize', fit)
  }, [phone])

  const links = { onPointerEnter: () => onExcite(true), onPointerLeave: () => onExcite(false), onFocus: () => onExcite(true), onBlur: () => onExcite(false) }
  const name = (
    <h1 className="dp-name" ref={nameRef}>
      {personalInfo.name.split(' ').map((part) => <span key={part}>{part}</span>)}
    </h1>
  )
  const sub = (
    <p className="dp-sub">
      {personalInfo.title.toUpperCase()}
      <br />
      FULL-STACK · MOBILE TO METAL · EST. {since}
    </p>
  )
  const rows = (
    <div className="dp-rows">
      <div><b>01</b><span><b>NOW</b> · {now.position} at {now.workplace.replace(/ Company Limited$/, '')}, {arrow(now.period)}. Design, build, ship, support, mentor.</span></div>
      <div><b>02</b><span><b>BEFORE</b> · {before.position}, {arrow(before.period)}.</span></div>
      <div><b>03</b><span><b>STACK</b> · TypeScript, {now.techStacks.join(', ')}.</span></div>
      <div>
        <b>04</b>
        <span>
          <b>SAY HI</b> · <a href={`mailto:${personalInfo.email}`} {...links}>email</a>{' '}
          <a href={personalInfo.github} {...links}>github</a>{' '}
          <a href={personalInfo.linkedin} {...links}>linkedin</a>
        </span>
      </div>
    </div>
  )
  const dots = (
    <nav className="dp-dots" aria-label="Themes">
      {THEMES.map((d, i) => (
        <button
          key={d.name}
          type="button"
          aria-label={d.name}
          aria-current={i === theme}
          title={d.name}
          style={{ '--a': d.ink, '--b': d.paper } as CSSProperties}
          onClick={(e) => onDot(i, e)}
        />
      ))}
    </nav>
  )
  const soundButton = (
    <button type="button" className="dp-snd" aria-pressed={sound} title="Toggle sound (M)" onClick={onSound}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor" />
        {sound ? <path d="M11.5 5.5a3.5 3.5 0 0 1 0 5M13.5 3.5a6.5 6.5 0 0 1 0 9" /> : <path d="M11 6l4 4M15 6l-4 4" />}
      </svg>
      {sound ? 'SOUND ON' : 'SOUND OFF'}
    </button>
  )

  return (
    <div
      ref={ref}
      className={['dp-layer', solid && 'is-solid', clip && 'is-clip'].filter(Boolean).join(' ')}
      data-incoming={incoming || undefined}
      inert={incoming}
      aria-hidden={incoming || undefined}
      style={{ '--ink': t.ink, '--paper': t.paper } as CSSProperties}
    >
      {solid && <div className="dp-fallback" />}
      {/* inside the layer so the wipe masks it with the rest of the theme */}
      {t.crt && !solid && <div className="dp-crt" />}
      {/* dims the shape under the open sheet in this theme's paper, so the wipe recolors it too */}
      {phone && !solid && <div className="dp-dim" />}
      {phone ? (
        <>
          <div className="dp-ptop">
            <Scramble className="" text={`FIG.${pad(theme + 1)} · ${t.name.toUpperCase()}`} animate={scrambles} />
            <span>{pad(theme + 1)} / {pad(THEMES.length)}</span>
            <Scramble className="dp-pmode" text={`${MODE_LABEL[t.mode]} · WEBGL`} animate={scrambles} />
          </div>
          <div className="dp-hero">
            {name}
            {sub}
            <div className="dp-pdock">
              {dots}
              <span>{solid ? 'TAP A DOT' : hint}</span>
            </div>
          </div>
          <section className="dp-sheet" aria-label="Contact sheet">
            <button type="button" className="dp-peek dp-grab" aria-expanded={sheetOpen} aria-controls={`dp-sheet-${theme}`}>
              <div className="dp-grip" />
              <div className="dp-top"><span>CONTACT SHEET</span><span className="dp-arrow">↑</span></div>
            </button>
            {/* inert while peeking so Tab does not land on links hidden below the screen edge */}
            <div id={`dp-sheet-${theme}`} inert={!sheetOpen}>
              {rows}
              <div className="dp-sheet-foot">{soundButton}</div>
            </div>
          </section>
        </>
      ) : (
        <>
          <div className="dp-text">
            <div className="dp-top">
              <span>PS/26</span>
              <span>{pad(theme + 1)} / {pad(THEMES.length)}</span>
            </div>
            {name}
            {sub}
            {rows}
          </div>
          <Scramble className="dp-lbl tl" text={`FIG.${pad(theme + 1)} · ${t.name.toUpperCase()}`} animate={scrambles} />
          <Scramble className="dp-lbl tr" text={`${MODE_LABEL[t.mode]} · WEBGL`} animate={scrambles} />
          <span className="dp-lbl bl">{solid ? 'CLICK A DOT TO CHANGE THEME' : hint}</span>
          <div className="dp-dock">
            {dots}
            {soundButton}
          </div>
        </>
      )}
    </div>
  )
}

/** Label that briefly shows random glyphs, resolving left to right, when `animate` is set on mount. */
function Scramble({ className, text, animate }: { className: string; text: string; animate: boolean }) {
  const [shown, setShown] = useState(text)
  useEffect(() => {
    if (!animate) return
    const pool = '#%@*+=-:.'
    const t0 = performance.now()
    let raf = 0
    const frame = (time: number) => {
      const k = Math.min(1, (time - t0) / 380)
      const n = Math.floor(k * text.length)
      setShown(text.slice(0, n) + [...text.slice(n)].map((c) => (c === ' ' ? ' ' : pool[(Math.random() * pool.length) | 0])).join(''))
      if (k < 1) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [animate, text])
  return <span className={className}>{shown}</span>
}
