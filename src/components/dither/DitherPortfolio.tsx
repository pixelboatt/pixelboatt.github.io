import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent } from 'react'
import { experiences, personalInfo } from '../../data/portfolio'
import { bayerTile, chirp, updateFavicon } from './effects'
import { createRenderer } from './renderer'
import { MODE_LABEL, THEMES } from './themes'
import './dither.css'

const MORPH_SECONDS = 1.15
const IDLE_MS = 10_000
/** Half-width of the dithered edge of the wipe, in px. Matches the shader's band. */
const BAND = 26
const SOUND_KEY = 'dp-sound'

const pad = (n: number) => String(n).padStart(2, '0')
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)
const next = (i: number, d = 1) => (i + d + THEMES.length) % THEMES.length

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
/** Largest font size where the longer of the two name lines still fits the column. */
function fitName(el: HTMLElement) {
  el.style.fontSize = '100px'
  const widest = Math.max(...Array.from(el.children, (c) => c.getBoundingClientRect().width))
  el.style.fontSize = `${Math.min(180, (100 * el.clientWidth) / widest)}px`
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

/**
 * Single-screen portfolio: a dithered, raymarched shape beside the contact sheet.
 * Clicking the shape morphs to the next theme with a wipe that starts at the click.
 * The WebGL loop and input live in one effect and only touch refs; React state
 * changes only when a morph starts or ends.
 */
export default function DitherPortfolio() {
  const [initial] = useState(pickInitialTheme)
  const [layers, setLayers] = useState<LayerState[]>([{ theme: initial, incoming: false }])
  const [sound, setSound] = useState(readSound)
  const [paused, setPaused] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [hasGL] = useState(() => !!document.createElement('canvas').getContext('webgl'))
  const compact = useMedia('(max-width: 819px), (pointer: coarse)')

  const labRef = useRef<HTMLElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layerEls = useRef(new Map<number, HTMLDivElement>())
  const controls = useRef<Controls | null>(null)
  const soundRef = useRef(sound)
  const pausedRef = useRef(paused)

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

  // The incoming layer starts at the outgoing layer's scroll position (phones scroll the text).
  useLayoutEffect(() => {
    if (layers.length < 2) return
    const text = (t: number) => layerEls.current.get(t)?.querySelector('.dp-text')
    const into = text(layers[1].theme)
    if (into) into.scrollTop = text(layers[0].theme)?.scrollTop ?? 0
  }, [layers])

  useEffect(() => {
    const lab = labRef.current!, view = viewRef.current!, canvas = canvasRef.current!
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const renderer = hasGL ? createRenderer(canvas) : null
    const s = {
      current: initial,
      morph: null as null | { to: number; p: number; x: number; y: number; r: number; far: number },
      time: reduce ? 4.2 : 0,
      yaw: 0, vel: 0, mx: 0, my: 0, tmx: 0, tmy: 0,
      grain: 1, zoom: 1, excite: 0, exciteTarget: 0,
      lastInput: performance.now(), last: performance.now(), raf: 0, favicon: true,
      w: 1, h: 1,
    }
    const narrow = () => innerWidth < 820
    const cellPx = (i: number) => {
      const t = THEMES[i]
      return Math.max(t.mode === 4 ? 4 : 1, Math.round(t.cell * s.grain))
    }
    /** Where the shape sits, in client px. */
    const shapeCenter = (): [number, number] => {
      const r = view.getBoundingClientRect()
      return [r.left + (narrow() ? 0.5 : 0.78125) * r.width, r.top + r.height / 2]
    }

    const size = () => {
      s.w = view.clientWidth
      s.h = view.clientHeight
      renderer?.resize(s.w, s.h)
    }

    // Theme bits outside the React tree: CRT overlay, browser chrome color, URL, favicon.
    const chrome = (i: number) => {
      if (THEMES[i].crt) lab.dataset.crt = ''
      else delete lab.dataset.crt
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES[i].paper)
      history.replaceState(null, '', `#${THEMES[i].name.toLowerCase()}`)
      s.favicon = true
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
        distance: lerp(a.distance, b.distance, k) * s.zoom * (1 - 0.1 * s.excite),
        offset: !narrow(),
        wipeCenter: m ? [m.x - vr.left, s.h - (m.y - vr.top)] : [0, 0],
        wipeRadius: m ? m.r : 1e6,
        cellFrom: cellPx(s.current),
        cellTo: cellPx(m ? m.to : s.current),
      })
      if (s.favicon && !m) {
        s.favicon = false
        const [cx, cy] = shapeCenter()
        updateFavicon(canvas, cx - vr.left, cy - vr.top, Math.min(s.h * 0.8, s.w), a)
      }
    }

    /** Advance the wipe and update both layers' masks so text changes exactly where the canvas does. */
    const stepWipe = () => {
      const m = s.morph!
      // ease-out: the wave lands on the far corner exactly at p=1
      m.r = lerp(-60, m.far + BAND + 4, Math.sin((m.p * Math.PI) / 2))
      if (m.p > 0.5) lab.toggleAttribute('data-crt', !!THEMES[m.to].crt)
      const r = lab.getBoundingClientRect(), x = m.x - r.left, y = m.y - r.top
      const a = Math.max(0, m.r - BAND), b = Math.max(0, m.r + BAND)
      const band = `radial-gradient(circle at ${x}px ${y}px,#0000 ${a}px,#000 ${a}px,#000 ${b}px,#0000 ${b}px)`
      const into = layerEls.current.get(m.to), from = layerEls.current.get(s.current)
      if (into) into.style.maskImage = `radial-gradient(circle at ${x}px ${y}px,#000 ${a}px,#0000 ${a}px),${band},${bayerTile(true)}`
      if (from) from.style.maskImage = `radial-gradient(circle at ${x}px ${y}px,#0000 ${b}px,#000 ${b}px),${band},${bayerTile(false)}`
    }
    const finish = () => {
      const m = s.morph
      if (!m) return
      s.morph = null
      s.current = m.to
      const el = layerEls.current.get(m.to)
      // 'none', not '': until React drops data-incoming, the CSS rule for it would hide the layer for a frame
      if (el) el.style.maskImage = 'none'
      setLayers([{ theme: m.to, incoming: false }])
      chrome(m.to)
    }

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
        m.p += dt / MORPH_SECONDS
        if (m.p >= 1) finish()
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

    /** Morph to theme `to`, wiping out from client point (x, y). */
    const go = (to: number, x?: number, y?: number, withSound = true) => {
      finish()
      if (to === s.current) return
      s.lastInput = performance.now()
      if (withSound && soundRef.current) chirp(to, THEMES.length)
      if (reduce || !renderer) {
        s.current = to
        setLayers([{ theme: to, incoming: false }])
        chrome(to)
        render()
        return
      }
      if (x === undefined || y === undefined) [x, y] = shapeCenter()
      const r = lab.getBoundingClientRect()
      s.morph = { to, p: 0, x, y, r: -60, far: Math.hypot(Math.max(x - r.left, r.right - x), Math.max(y - r.top, r.bottom - y)) }
      setLayers([{ theme: s.current, incoming: false }, { theme: to, incoming: true }])
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES[to].paper)
      kick()
    }
    const target = () => s.morph?.to ?? s.current
    controls.current = {
      go,
      target,
      kick,
      excite(on) {
        s.exciteTarget = on ? 1 : 0
        kick()
      },
    }

    // Tap to morph from the tap point; drag to spin with inertia.
    let down: null | { x: number; y: number; lx: number; moved: number } = null
    const seen = () => { s.lastInput = performance.now() }
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, lx: e.clientX, moved: 0 }
      view.setPointerCapture(e.pointerId)
      view.classList.add('is-dragging')
      seen()
    }
    const onDrag = (e: PointerEvent) => {
      if (!down) return
      const dx = e.clientX - down.lx
      down.lx = e.clientX
      down.moved = Math.max(down.moved, Math.hypot(e.clientX - down.x, e.clientY - down.y))
      if (down.moved > 6) {
        s.vel = dx * 0.006
        s.yaw += dx * 0.008
        kick()
      }
    }
    const onUp = (e: PointerEvent) => {
      view.classList.remove('is-dragging')
      if (down && down.moved <= 6) go(next(target()), e.clientX, e.clientY)
      down = null
    }
    const onCancel = () => {
      down = null
      view.classList.remove('is-dragging')
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
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= THEMES.length) go(n - 1)
      else if (e.key === 'ArrowRight') go(next(target()))
      else if (e.key === 'ArrowLeft') go(next(target(), -1))
      else if (e.key === 'm' || e.key === 'M') setSound((v) => !v)
      else if (e.key === ' ') {
        e.preventDefault()
        setPaused((v) => !v)
      }
    }
    const onResize = () => {
      size()
      render()
    }
    const onVisible = () => {
      if (document.hidden) return
      seen()
      kick()
    }
    view.addEventListener('pointerdown', onDown)
    view.addEventListener('pointermove', onDrag)
    view.addEventListener('pointerup', onUp)
    view.addEventListener('pointercancel', onCancel)
    view.addEventListener('wheel', onWheel, { passive: false })
    addEventListener('pointermove', onMove)
    addEventListener('keydown', onKey)
    addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisible)

    // Nobody touched anything for a while: morph on our own, silently.
    const idle = window.setInterval(() => {
      if (reduce || pausedRef.current || s.morph || document.hidden || performance.now() - s.lastInput < IDLE_MS) return
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
      view.removeEventListener('pointerdown', onDown)
      view.removeEventListener('pointermove', onDrag)
      view.removeEventListener('pointerup', onUp)
      view.removeEventListener('pointercancel', onCancel)
      view.removeEventListener('wheel', onWheel)
      removeEventListener('pointermove', onMove)
      removeEventListener('keydown', onKey)
      removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisible)
      renderer?.dispose()
      controls.current = null
    }
  }, [initial, hasGL])

  const hint = flash ?? (paused ? 'PAUSED · SPACE TO PLAY' : compact ? 'TAP TO MORPH · DRAG TO SPIN' : 'CLICK TO MORPH · DRAG TO SPIN · SCROLL FOR GRAIN')
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
          solid={!hasGL}
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
function ThemeLayer({ theme, incoming, solid, hint, sound, register, onDot, onSound, onExcite }: ThemeLayerProps) {
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
  }, [])

  const links = { onPointerEnter: () => onExcite(true), onPointerLeave: () => onExcite(false), onFocus: () => onExcite(true), onBlur: () => onExcite(false) }
  return (
    <div
      ref={ref}
      className={solid ? 'dp-layer is-solid' : 'dp-layer'}
      data-incoming={incoming || undefined}
      inert={incoming}
      aria-hidden={incoming || undefined}
      style={{ '--ink': t.ink, '--paper': t.paper } as CSSProperties}
    >
      {solid && <div className="dp-fallback" />}
      <div className="dp-text">
        <div className="dp-top">
          <span>PS/26</span>
          <span>{pad(theme + 1)} / {pad(THEMES.length)}</span>
        </div>
        <h1 className="dp-name" ref={nameRef}>
          {personalInfo.name.split(' ').map((part) => <span key={part}>{part}</span>)}
        </h1>
        <p className="dp-sub">
          {personalInfo.title.toUpperCase()}
          <br />
          FULL-STACK · MOBILE TO METAL · EST. {since}
        </p>
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
      </div>
      <Scramble className="dp-lbl tl" text={`FIG.${pad(theme + 1)} · ${t.name.toUpperCase()}`} animate={scrambles} />
      <Scramble className="dp-lbl tr" text={`${MODE_LABEL[t.mode]} · WEBGL`} animate={scrambles} />
      <span className="dp-lbl bl">{solid ? 'CLICK A DOT TO CHANGE THEME' : hint}</span>
      <div className="dp-dock">
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
        <button type="button" className="dp-snd" aria-pressed={sound} title="Toggle sound (M)" onClick={onSound}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor" />
            {sound ? <path d="M11.5 5.5a3.5 3.5 0 0 1 0 5M13.5 3.5a6.5 6.5 0 0 1 0 9" /> : <path d="M11 6l4 4M15 6l-4 4" />}
          </svg>
          {sound ? 'SOUND ON' : 'SOUND OFF'}
        </button>
      </div>
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
