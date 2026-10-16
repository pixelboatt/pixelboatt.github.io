import type { Theme } from './themes'

let audio: AudioContext | null = null

/** Short 1-bit chirp for a theme change; pitch rises with the theme index. */
export function chirp(index: number, count: number) {
  try {
    audio ??= new AudioContext()
    const t0 = audio.currentTime
    const f = 220 * 2 ** (index / count)
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(f * 4, t0)
    osc.frequency.exponentialRampToValueAtTime(f, t0 + 0.16)
    gain.gain.setValueAtTime(0.05, t0)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24)
    osc.connect(gain).connect(audio.destination)
    osc.start(t0)
    osc.stop(t0 + 0.25)

    // crushed noise tick on the attack
    const buf = audio.createBuffer(1, (audio.sampleRate * 0.05) | 0, audio.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() < 0.5 ? -1 : 1) * (1 - i / d.length) ** 3 * 0.12
    const noise = audio.createBufferSource()
    noise.buffer = buf
    noise.connect(audio.destination)
    noise.start(t0)
  } catch {
    // audio is decoration; ignore unsupported or blocked contexts
  }
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** 8px CSS mask tile: half of a 4x4 Bayer matrix at 2px per cell. `on` picks which half. */
export const bayerTile = (on: boolean) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8' shape-rendering='crispEdges'>${BAYER4.map((v, i) =>
      (v < 8) === on ? `<rect x='${(i % 4) * 2}' y='${(i >> 2) * 2}' width='2' height='2'/>` : '',
    ).join('')}</svg>`,
  )}")`

let favicon: HTMLLinkElement | null = null
const work = typeof document === 'undefined' ? null : document.createElement('canvas')

/**
 * Redraw the tab icon as a 32px dithered crop of the canvas around (cx, cy).
 * Must run right after a draw, in the same task, while the WebGL buffer is still readable.
 */
export function updateFavicon(src: HTMLCanvasElement, cx: number, cy: number, side: number, theme: Theme) {
  if (!work) return
  const n = 32
  work.width = work.height = n
  const ctx = work.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(src, cx - side / 2, cy - side / 2, side, side, 0, 0, n, n)
  const img = ctx.getImageData(0, 0, n, n)
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const ink = hex(theme.ink), paper = hex(theme.paper)
  const span = ink.reduce((s, v, i) => s + (v - paper[i]) ** 2, 0) || 1
  for (let i = 0; i < n * n; i++) {
    const p = img.data.subarray(i * 4, i * 4 + 4)
    // how far this averaged pixel sits between paper and ink, then re-dither it
    const k = ink.reduce((s, v, j) => s + (p[j] - paper[j]) * (v - paper[j]), 0) / span
    const c = k * 1.4 > (BAYER4[((i % n) % 4) + (((i / n) | 0) % 4) * 4] + 0.5) / 16 ? ink : paper
    p.set([...c, 255])
  }
  ctx.putImageData(img, 0, 0)
  if (!favicon) {
    document.querySelectorAll('link[rel~="icon"]').forEach((l) => l.remove())
    favicon = document.createElement('link')
    favicon.rel = 'icon'
    favicon.type = 'image/png'
    document.head.appendChild(favicon)
  }
  favicon.href = work.toDataURL('image/png')
}
