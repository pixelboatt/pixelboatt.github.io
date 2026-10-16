import { DITHER, SCENE, VERTEX } from './shaders'
import type { Theme } from './themes'

/** The scene is raymarched at 1/BASE of the canvas resolution, then dithered at full res. */
const BASE = 3

// ASCII ramp from dark to bright as 4x5 bitmaps, packed into floats for the shader.
const GLYPHS = [
  ['....', '....', '....', '....', '....'], ['....', '....', '....', '....', '.X..'], ['....', '.X..', '....', '.X..', '....'],
  ['....', '....', 'XXX.', '....', '....'], ['....', 'XXX.', '....', 'XXX.', '....'], ['....', '.X..', 'XXX.', '.X..', '....'],
  ['X.X.', '.X..', 'XXX.', '.X..', 'X.X.'], ['.X.X', 'XXXX', '.X.X', 'XXXX', '.X.X'], ['XXXX', 'X..X', 'X.XX', 'X...', 'XXXX'],
].map((rows) => [...rows.join('')].reduce((bits, c, i) => (c === 'X' ? bits + 2 ** i : bits), 0))

export interface Frame {
  time: number
  /** Pointer in -1..1, used for the light direction. */
  mouse: [number, number]
  /** Yaw and pitch in radians. */
  rotation: [number, number]
  from: Theme
  to: Theme
  /** Shape blend 0..1; 0 renders `from` only. */
  morph: number
  distance: number
  /** Push the shape right so it sits beside the text column. */
  offset: boolean
  /** Wipe origin in canvas px, origin bottom-left. */
  wipeCenter: [number, number]
  /** Pixels inside this radius use `to`'s palette and dither. */
  wipeRadius: number
  cellFrom: number
  cellTo: number
}

export interface Renderer {
  resize(width: number, height: number): void
  draw(frame: Frame): void
  dispose(): void
}

type Uniforms = Record<string, WebGLUniformLocation | null>

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)

/** Two-pass WebGL renderer for the dithered hero shape. Returns null without WebGL. */
export function createRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext('webgl', { antialias: false })
  if (!gl) return null

  const shaders: WebGLShader[] = []
  const program = (fragment: string) => {
    const p = gl.createProgram()
    for (const [type, src] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s))
      gl.attachShader(p, s)
      shaders.push(s)
    }
    gl.bindAttribLocation(p, 0, 'p')
    gl.linkProgram(p)
    const u: Uniforms = {}
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(p, i)!.name.replace('[0]', '')
      u[name] = gl.getUniformLocation(p, name)
    }
    return { p, u }
  }
  const scene = program(SCENE)
  const dither = program(DITHER)

  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ]) gl.texParameteri(gl.TEXTURE_2D, k, v)
  const framebuffer = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)

  gl.useProgram(dither.p)
  gl.uniform1i(dither.u.uTex, 0)
  gl.uniform1fv(dither.u.uG, GLYPHS)

  let w = 1, h = 1, bw = 1, bh = 1

  return {
    resize(width, height) {
      w = canvas.width = Math.max(1, width)
      h = canvas.height = Math.max(1, height)
      bw = Math.ceil(w / BASE)
      bh = Math.ceil(h / BASE)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    },
    draw(f) {
      let u = scene.u
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.viewport(0, 0, bw, bh)
      gl.useProgram(scene.p)
      gl.uniform2f(u.uRes, bw, bh)
      gl.uniform1f(u.uTime, f.time)
      gl.uniform2f(u.uMouse, ...f.mouse)
      gl.uniform2f(u.uRot, ...f.rotation)
      gl.uniform1i(u.uA, f.from.shape)
      gl.uniform1i(u.uB, f.to.shape)
      gl.uniform1f(u.uK, f.morph)
      gl.uniform1f(u.uDist, f.distance)
      gl.uniform1f(u.uOff, f.offset ? (0.45 * (bw / bh)) / 1.6 : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      u = dither.u
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, w, h)
      gl.useProgram(dither.p)
      gl.uniform2f(u.uRes, w, h)
      gl.uniform2f(u.uClick, ...f.wipeCenter)
      gl.uniform1f(u.uR, f.wipeRadius)
      gl.uniform1i(u.uMA, f.from.mode)
      gl.uniform1i(u.uMB, f.to.mode)
      gl.uniform1f(u.uCA, f.cellFrom)
      gl.uniform1f(u.uCB, f.cellTo)
      gl.uniform3fv(u.uInkA, rgb(f.from.ink))
      gl.uniform3fv(u.uPaperA, rgb(f.from.paper))
      gl.uniform3fv(u.uInkB, rgb(f.to.ink))
      gl.uniform3fv(u.uPaperB, rgb(f.to.paper))
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      gl.deleteFramebuffer(framebuffer)
      gl.deleteTexture(texture)
      gl.deleteBuffer(buffer)
      shaders.forEach((s) => gl.deleteShader(s))
      gl.deleteProgram(scene.p)
      gl.deleteProgram(dither.p)
    },
  }
}
