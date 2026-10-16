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
