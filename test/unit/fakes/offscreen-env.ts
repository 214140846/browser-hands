// offscreen 单测专用运行环境：假 chrome（消息通道）、假 GIF 编码器、假 Image、假 canvas、假 FileReader、可记录的对象地址。
// 2D 上下文用 Proxy 做通用记录器：任何方法调用、属性写入都记下来，并跟踪变换矩阵，测试只看「画了没有、画在哪附近、写了什么字」。

type Fn = (...a: any[]) => any
type Mat = [number, number, number, number, number, number]
type Op = { name: string; args: any[]; m: Mat }

const ID: Mat = [1, 0, 0, 1, 0, 0]
const mul = (p: Mat, q: Mat): Mat => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5],
]
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

export class FakeImage {
  static registry = new Map<string, { w: number; h: number } | 'broken'>()
  static sources: string[] = []
  width = 0
  height = 0
  naturalWidth = 0
  naturalHeight = 0
  complete = false
  onload: Fn | null = null
  onerror: Fn | null = null
  private subs: Record<string, Fn[]> = {}
  private _src = ''
  private settled: Promise<void> | null = null
  addEventListener(t: string, f: Fn) {
    ;(this.subs[t] ||= []).push(f)
  }
  removeEventListener(t: string, f: Fn) {
    this.subs[t] = (this.subs[t] || []).filter((g) => g !== f)
  }
  get src() {
    return this._src
  }
  set src(v: string) {
    this._src = v
    FakeImage.sources.push(v)
    const payload = /^data:[^,]*;base64,(.*)$/s.exec(v)?.[1] ?? ''
    const entry = FakeImage.registry.get(payload)
    this.settled = new Promise((ok, bad) => {
      setTimeout(() => {
        const ev = { type: entry && entry !== 'broken' ? 'load' : 'error', target: this }
        if (entry && entry !== 'broken') {
          this.width = this.naturalWidth = entry.w
          this.height = this.naturalHeight = entry.h
          this.complete = true
          this.onload?.(ev)
          for (const f of this.subs.load || []) f(ev)
          ok()
        } else {
          this.onerror?.(ev)
          for (const f of this.subs.error || []) f(ev)
          bad(new Error('fake: image could not be decoded'))
        }
      }, 1)
    })
    this.settled.catch(() => {})
  }
  decode() {
    return this.settled ?? Promise.reject(new Error('fake: no source'))
  }
}

export class FakeCanvas {
  width = 300
  height = 150
  ops: Op[] = []
  private ctx: any = null
  getContext(kind: string) {
    if (kind !== '2d') return null
    if (!this.ctx) this.ctx = makeCtx(this)
    return this.ctx
  }
}

function makeCtx(canvas: FakeCanvas) {
  let m: Mat = [...ID]
  const stack: Mat[] = []
  const props: Record<string | symbol, any> = {}
  const special: Record<string, Fn> = {
    save: () => void stack.push([...m]),
    restore: () => void (m = stack.pop() ?? m),
    translate: (x: number, y: number) => void (m = mul(m, [1, 0, 0, 1, x, y])),
    scale: (x: number, y: number) => void (m = mul(m, [x, 0, 0, y, 0, 0])),
    rotate: (r: number) => void (m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0])),
    transform: (...a: number[]) => void (m = mul(m, a as Mat)),
    setTransform: (...a: any[]) => {
      if (a.length >= 6) m = a.slice(0, 6) as Mat
      else if (a[0]) m = [a[0].a ?? 1, a[0].b ?? 0, a[0].c ?? 0, a[0].d ?? 1, a[0].e ?? 0, a[0].f ?? 0]
      else m = [...ID]
    },
    resetTransform: () => void (m = [...ID]),
    getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
    measureText: (t: string) => ({ width: String(t).length * 7, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3, fontBoundingBoxAscent: 11, fontBoundingBoxDescent: 3 }),
  }
  const stub = { addColorStop() {} }
  return new Proxy(
    {},
    {
      get(_t, k) {
        if (k === 'canvas') return canvas
        if (typeof k === 'string' && special[k]) return special[k]
        if (k in props) return props[k]
        if (typeof k === 'symbol') return undefined
        return (...args: any[]) => {
          canvas.ops.push({ name: k, args, m: [...m] })
          return stub
        }
      },
      set(_t, k, v) {
        props[k] = v
        return true
      },
    },
  )
}

const PAINT = new Set(['fill', 'stroke', 'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'putImageData'])

// 这张画布（及经它贴上来的其他画布）上的「标注墨迹」次数；贴原图不算
export function inkCount(c: FakeCanvas): number {
  let n = 0
  for (const op of c.ops) {
    if (PAINT.has(op.name)) n++
    else if (op.name === 'drawImage' && op.args[0] instanceof FakeCanvas) n += inkCount(op.args[0])
  }
  return n
}

// 画布上所有写出来的文字（含贴上来的画布）
export function textsOf(c: FakeCanvas): string {
  const out: string[] = []
  for (const op of c.ops) {
    if (op.name === 'fillText' || op.name === 'strokeText') out.push(String(op.args[0]))
    else if (op.name === 'drawImage' && op.args[0] instanceof FakeCanvas) out.push(textsOf(op.args[0]))
  }
  return out.join(' ').replace(/\s+/g, ' ')
}

// 几何点：路径与绘制调用里的坐标，按当时的变换换算到本画布像素；贴上来的画布按落点平移缩放
export function pointsOf(c: FakeCanvas): [number, number][] {
  const pts: [number, number][] = []
  const rect = (m: Mat, x: number, y: number, w: number, h: number) => {
    for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h], [x + w / 2, y + h / 2]]) pts.push(apply(m, px, py))
  }
  for (const { name, args: a, m } of c.ops) {
    switch (name) {
      case 'arc':
      case 'ellipse': {
        // 圆心 + 上下左右四个外沿点
        const rx = Math.abs(a[2] ?? 0)
        const ry = Math.abs(name === 'ellipse' ? a[3] ?? 0 : rx)
        pts.push(apply(m, a[0], a[1]), apply(m, a[0] - rx, a[1]), apply(m, a[0] + rx, a[1]), apply(m, a[0], a[1] - ry), apply(m, a[0], a[1] + ry))
        break
      }
      case 'moveTo':
      case 'lineTo':
        pts.push(apply(m, a[0], a[1]))
        break
      case 'arcTo':
        pts.push(apply(m, a[0], a[1]), apply(m, a[2], a[3]))
        break
      case 'quadraticCurveTo':
        pts.push(apply(m, a[0], a[1]), apply(m, a[2], a[3]))
        break
      case 'bezierCurveTo':
        pts.push(apply(m, a[0], a[1]), apply(m, a[2], a[3]), apply(m, a[4], a[5]))
        break
      case 'rect':
      case 'roundRect':
      case 'fillRect':
      case 'strokeRect':
        rect(m, a[0], a[1], a[2], a[3])
        break
      case 'fillText':
      case 'strokeText':
        pts.push(apply(m, a[1], a[2]))
        break
      case 'drawImage': {
        const src = a[0]
        if (!(src instanceof FakeCanvas)) break
        const [dx, dy, dw, dh] = a.length >= 9 ? [a[5], a[6], a[7], a[8]] : [a[1], a[2], a[3] ?? src.width, a[4] ?? src.height]
        const sx = src.width ? dw / src.width : 1
        const sy = src.height ? dh / src.height : 1
        for (const [px, py] of pointsOf(src)) pts.push(apply(m, dx + px * sx, dy + py * sy))
        break
      }
    }
  }
  return pts
}

// 所有几何点都在给定若干中心的 r 范围内
export const within = (c: FakeCanvas, centers: [number, number][], r: number) =>
  pointsOf(c).every(([px, py]) => centers.some(([x, y]) => Math.hypot(px - x, py - y) <= r))

export const near = (c: FakeCanvas, x: number, y: number, tol: number) =>
  pointsOf(c).some(([px, py]) => Math.hypot(px - x, py - y) <= tol)

// 原图是否以原尺寸放在这张画布的左上角（可经中间画布）
export function placesAtOrigin(c: FakeCanvas, img: FakeImage): boolean {
  for (const { name, args: a, m } of c.ops) {
    if (name !== 'drawImage') continue
    const src = a[0]
    const [dx, dy] = a.length >= 9 ? [a[5], a[6]] : [a[1], a[2]]
    const [ox, oy] = apply(m, dx, dy)
    if (Math.abs(ox) > 0.5 || Math.abs(oy) > 0.5) continue
    if (src === img) return true
    if (src instanceof FakeCanvas && placesAtOrigin(src, img)) return true
  }
  return false
}

export class FakeFileReader {
  result: string | ArrayBuffer | null = null
  error: unknown = null
  readyState = 0
  onload: Fn | null = null
  onloadend: Fn | null = null
  onerror: Fn | null = null
  private subs: Record<string, Fn[]> = {}
  addEventListener(t: string, f: Fn) {
    ;(this.subs[t] ||= []).push(f)
  }
  private finish(r: string | ArrayBuffer) {
    this.result = r
    this.readyState = 2
    const ev = { type: 'load', target: this }
    this.onload?.(ev)
    for (const f of this.subs.load || []) f(ev)
    this.onloadend?.({ ...ev, type: 'loadend' })
    for (const f of this.subs.loadend || []) f({ ...ev, type: 'loadend' })
  }
  readAsDataURL(b: Blob) {
    b.arrayBuffer().then((buf) => this.finish(`data:${b.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`))
  }
  readAsArrayBuffer(b: Blob) {
    b.arrayBuffer().then((buf) => this.finish(buf))
  }
}

export class FakeGIF {
  static all: FakeGIF[] = []
  static mode: 'ok' | 'abort' = 'ok'
  static bytes = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 2, 3, 250, 0, 59])
  opts: Record<string, any>
  added: { image: any; opts: any }[] = []
  private subs: Record<string, Fn[]> = {}
  constructor(opts: Record<string, any> = {}) {
    this.opts = { ...opts }
    FakeGIF.all.push(this)
  }
  setOption(k: string, v: unknown) {
    this.opts[k] = v
  }
  setOptions(o: Record<string, unknown>) {
    Object.assign(this.opts, o)
  }
  on(ev: string, f: Fn) {
    ;(this.subs[ev] ||= []).push(f)
    return this
  }
  addFrame(image: any, opts: any = {}) {
    this.added.push({ image, opts })
  }
  abort() {}
  render() {
    const mode = FakeGIF.mode
    setTimeout(() => {
      if (mode === 'abort') for (const f of this.subs.abort || []) f()
      else {
        const blob = new Blob([FakeGIF.bytes], { type: 'image/gif' })
        for (const f of this.subs.finished || []) f(blob, FakeGIF.bytes)
      }
    }, 1)
  }
}

export function makeOffscreenEnv() {
  const listeners: Fn[] = []
  const created: string[] = []
  const revoked: string[] = []
  const canvases: FakeCanvas[] = []
  const chrome = {
    runtime: {
      id: 'fake-ext',
      lastError: undefined,
      getURL: (p: string) => `chrome-extension://fake-ext/${String(p).replace(/^\/+/, '')}`,
      onMessage: {
        addListener: (f: Fn) => void listeners.push(f),
        removeListener: (f: Fn) => void listeners.splice(listeners.indexOf(f) >>> 0, 1),
        hasListener: (f: Fn) => listeners.includes(f),
      },
    },
  }
  const document = {
    createElement(tag: string) {
      if (String(tag).toLowerCase() !== 'canvas') throw new Error(`fake: only canvas elements exist here, got ${tag}`)
      const c = new FakeCanvas()
      canvases.push(c)
      return c
    },
  }
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL

  const KEYS = ['chrome', 'document', 'Image', 'HTMLCanvasElement', 'FileReader', 'GIF'] as const
  const saved: Record<string, unknown> = {}

  function install() {
    const g = globalThis as any
    for (const k of KEYS) saved[k] = g[k]
    g.chrome = chrome
    g.document = document
    g.Image = FakeImage
    g.HTMLCanvasElement = FakeCanvas
    g.FileReader = FakeFileReader
    g.GIF = FakeGIF
    let n = 0
    URL.createObjectURL = ((b: Blob) => {
      const u = `blob:chrome-extension://fake-ext/obj-${++n}-${b.size}`
      created.push(u)
      return u
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = ((u: string) => void revoked.push(u)) as typeof URL.revokeObjectURL
  }
  function uninstall() {
    const g = globalThis as any
    for (const k of KEYS) {
      if (saved[k] === undefined) delete g[k]
      else g[k] = saved[k]
    }
    URL.createObjectURL = origCreate
    URL.revokeObjectURL = origRevoke
  }

  // 派发一条消息：返回监听器的返回值、首个应答、是否在监听器返回前就应答了、应答次数
  function deliver(message: unknown, sender: Record<string, unknown> = { id: chrome.runtime.id }) {
    let first: (v: unknown) => void
    const reply = new Promise<any>((ok) => (first = ok))
    const st = { returned: [] as unknown[], reply, sync: false, count: 0 }
    let returnedYet = false
    for (const f of listeners) {
      const r = f(message, sender, (v: unknown) => {
        st.count++
        if (!returnedYet) st.sync = true
        if (st.count === 1) first(v)
      })
      st.returned.push(r)
    }
    returnedYet = true
    return st
  }

  return { chrome, listeners, created, revoked, canvases, install, uninstall, deliver }
}
