// Visual themes the hero cycles through. Each pairs a raymarched shape with a
// dither algorithm and a two-color palette.

/** 0 Bayer 8x8 · 1 Bayer 4x4 · 2 Bayer 2x2 · 3 noise · 4 halftone · 5 ASCII */
export type DitherMode = 0 | 1 | 2 | 3 | 4 | 5

export interface Theme {
  name: string
  /** Shape index in the scene shader's `sd()` switch. */
  shape: number
  mode: DitherMode
  ink: string
  paper: string
  /** Dither cell size in CSS px (for ASCII: the size of one glyph pixel). */
  cell: number
  /** Camera distance; larger shapes need more. */
  distance: number
  /** Idle rotation speed in radians per second. */
  spin: number
  crt?: boolean
}

export const THEMES: Theme[] = [
  { name: 'Orbit', shape: 3, mode: 3, ink: '#111111', paper: '#f4f2ec', cell: 3, distance: 5.8, spin: 0.12 },
  { name: 'Knot', shape: 0, mode: 0, ink: '#1d3bff', paper: '#e9e3d3', cell: 4, distance: 6.6, spin: 0.35 },
  { name: 'Blob', shape: 1, mode: 1, ink: '#ff4f00', paper: '#0d0c0b', cell: 4, distance: 6.4, spin: 0.15 },
  { name: 'Lattice', shape: 2, mode: 0, ink: '#8bff6a', paper: '#041004', cell: 3, distance: 6.2, spin: 0.25, crt: true },
  { name: 'Twist', shape: 4, mode: 1, ink: '#e8261b', paper: '#f7d9d3', cell: 5, distance: 6.4, spin: 0.3 },
  { name: 'Sponge', shape: 5, mode: 4, ink: '#141414', paper: '#efe8d8', cell: 9, distance: 7.6, spin: 0.18 },
  { name: 'Helix', shape: 6, mode: 5, ink: '#6ee7ff', paper: '#071330', cell: 2, distance: 6.4, spin: 0.1 },
  { name: 'Ripple', shape: 7, mode: 2, ink: '#f2f2f2', paper: '#0a0a0a', cell: 7, distance: 6.2, spin: 0.2 },
]

export const MODE_LABEL = ['BAYER 8×8', 'BAYER 4×4', 'BAYER 2×2', 'NOISE DITHER', 'HALFTONE 45°', 'ASCII'] as const
