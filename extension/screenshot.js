// 截图模块：可视区截图、区域放大、出图尺寸求解、坐标上下文与批次、按会话缓存图片。
// 出图全部交给调试协议按目标尺寸直接生成，不在页面里用 canvas。
import { send } from './debugger.js'
import { sessionClosedHooks } from './sessions.js'

// ---------- 常量 ----------
const MAX_EDGE = 1568 // 长边上限
const TILE = 28 // 切块边长
const MAX_TILES = 1568 // 块数上限
const MAX_B64 = 1398100 // 约 1 MB 的 base64 长度
const Q_NORMAL = 75
const Q_FALLBACK = 50
const CACHE_LIMIT = 30

// 带错误码的 Error
const fail = (message, code) => {
  const e = new Error(message)
  if (code) e.code = code
  return e
}

// ---------- 出图尺寸 ----------
const fits = (w, h) => w <= MAX_EDGE && h <= MAX_EDGE && Math.ceil(w / TILE) * Math.ceil(h / TILE) <= MAX_TILES
const scaledH = (w2, w, h) => Math.max(1, Math.round((w2 * h) / w))

export function targetSize(w, h) {
  if (fits(w, h)) return [w, h]
  // 竖图：对调后求解再对调回来，保证横竖对称
  if (h > w) {
    const [a, b] = targetSize(h, w)
    return [b, a]
  }
  // 横图：「合格」对 w' 单调（w' 增大时两边和块数都不减），二分找最大合格宽
  let lo = 1
  let hi = Math.min(w, MAX_EDGE)
  if (!fits(lo, scaledH(lo, w, h))) return [1, 1] // 理论上不会到这里
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid, scaledH(mid, w, h))) lo = mid
    else hi = mid - 1
  }
  return [lo, scaledH(lo, w, h)]
}

// ---------- 坐标上下文与批次 ----------
const contexts = new Map() // tabId → Ctx
let batching = false
const pending = new Map() // 批内暂存

export function beginBatch() {
  batching = true // 重复开批不清暂存
}

export function endBatch() {
  for (const [tabId, ctx] of pending) contexts.set(tabId, ctx)
  pending.clear()
  batching = false
}

export function setContext(tabId, ctx) {
  const c = { viewportWidth: ctx.viewportWidth, viewportHeight: ctx.viewportHeight, screenshotWidth: ctx.screenshotWidth, screenshotHeight: ctx.screenshotHeight }
  if (batching) pending.set(tabId, c)
  else contexts.set(tabId, c)
}

export function getContext(tabId) {
  return contexts.get(tabId)
}

// ---------- 坐标换算 ----------
const validNum = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0

export function toViewport(tabId, point, action) {
  const [x, y] = Array.isArray(point) ? point : []
  const c = contexts.get(tabId)
  const show = (n) => (Number.isFinite(n) ? Math.round(n) : n)
  if (!validNum(x) || !validNum(y)) {
    throw fail(`${action}: point (${show(x)}, ${show(y)}) is invalid. Coordinates must be finite, non-negative pixels.`, 'coordinate_out_of_bounds')
  }
  if (!c) return [x, y]
  if (x >= c.screenshotWidth + 2 || y >= c.screenshotHeight + 2) {
    throw fail(
      `${action}: point (${show(x)}, ${show(y)}) lies outside the last screenshot (${c.screenshotWidth}x${c.screenshotHeight}). Use coordinates from the full-size screenshot frame, not from a downscaled copy; if the page moved, take a new screenshot.`,
      'coordinate_out_of_bounds',
    )
  }
  return [Math.round((x * c.viewportWidth) / c.screenshotWidth), Math.round((y * c.viewportHeight) / c.screenshotHeight)]
}

// ---------- 图片缓存 ----------
const caches = new Map() // session → Map(id → {base64, format})，Map 保留插入顺序
let seq = 0

export function cacheImage(session, base64, format) {
  const id = `img_${++seq}`
  let m = caches.get(session)
  if (!m) caches.set(session, (m = new Map()))
  m.set(id, { base64, format })
  while (m.size > CACHE_LIMIT) m.delete(m.keys().next().value)
  return id
}

export function getImage(session, id) {
  return caches.get(session)?.get(id)
}

// ---------- 事件接线 ----------
sessionClosedHooks.push((_tabIds, sessionName) => {
  caches.delete(sessionName)
  endBatch() // 会话断开视同结束批次
})

globalThis.chrome?.tabs?.onRemoved?.addListener?.((tabId) => {
  contexts.delete(tabId)
  pending.delete(tabId)
})

// ---------- 截图前复查 ----------
export async function recheckBeforeCapture(guard) {
  if (guard) await guard.check('screenshot')
}

// ---------- imageSize ----------
function decodeHead(base64) {
  try {
    const head = base64.slice(0, 131072)
    const s = atob(head.slice(0, head.length - (head.length % 4)))
    const u = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
    return u
  } catch {
    return null
  }
}

export function imageSize(base64) {
  if (typeof base64 !== 'string') return null
  const b = decodeHead(base64)
  if (!b) return null
  // PNG：8 字节签名 + IHDR 宽高（大端）
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length >= 24 && sig.every((v, i) => b[i] === v)) {
    const dv = new DataView(b.buffer)
    return { width: dv.getUint32(16), height: dv.getUint32(20) }
  }
  // JPEG：从 SOI 后逐段走，找第一个 SOF
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null
      const m = b[i + 1]
      if (m === 0xff) { i++; continue } // 填充字节
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue } // 无长度标记
      if (m === 0xd9 || m === 0xda) return null // 到图像数据都没找到 SOF
      const len = (b[i + 2] << 8) | b[i + 3]
      if (len < 2) return null
      // SOF0..SOF15，排除 DHT(C4)、JPG(C8)、DAC(CC)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (i + 9 > b.length) return null
        const height = (b[i + 5] << 8) | b[i + 6]
        const width = (b[i + 7] << 8) | b[i + 8]
        return width && height ? { width, height } : null
      }
      i += 2 + len
    }
  }
  return null
}

// ---------- 截图公共部分 ----------
const clampScale = (s) => (typeof s === 'number' && Number.isFinite(s) && s >= 0.1 && s <= 1 ? s : 1)

async function readViewport(tabId) {
  const r = await send(tabId, 'Runtime.evaluate', {
    expression: '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, x: scrollX, y: scrollY })',
    returnByValue: true,
  })
  const v = r?.result?.value
  const width = Number(v?.width)
  const height = Number(v?.height)
  if (!(width > 0) || !(height > 0)) throw new Error('Could not read the viewport size of this tab.')
  const dpr = Number(v.dpr) > 0 ? Number(v.dpr) : 1
  return { width, height, dpr, x: Number(v.x) || 0, y: Number(v.y) || 0 }
}

async function capture(tabId, format, quality, box, scale) {
  const params = { format }
  if (format === 'jpeg') params.quality = quality
  Object.assign(params, { captureBeyondViewport: false, fromSurface: true, clip: { ...box, scale } })
  const r = await send(tabId, 'Page.captureScreenshot', params)
  if (!r?.data) throw new Error('The browser returned no image data for the screenshot.')
  return r.data
}

// 按预期出图尺寸截图；格式为 JPEG 时处理超大降质，尺寸不符时修正一次
async function shoot(tabId, format, box, dpr, wantW, wantH) {
  // 缩放系数：预期宽 / 物理宽，不超过 1
  let scale = Math.min(1, wantW / (box.width * dpr))
  let quality = Q_NORMAL
  let data = await capture(tabId, format, quality, box, scale)
  if (format === 'jpeg' && data.length > MAX_B64) {
    quality = Q_FALLBACK
    data = await capture(tabId, format, quality, box, scale)
  }
  let size = imageSize(data)
  if (size && (Math.abs(size.width - wantW) > 1 || Math.abs(size.height - wantH) > 1)) {
    scale = Math.min(1, scale * (wantW / size.width))
    data = await capture(tabId, format, quality, box, scale)
    size = imageSize(data)
  }
  return { data, width: size?.width ?? wantW, height: size?.height ?? wantH }
}

// ---------- screenshot ----------
export async function screenshot(tabId, scale, guard) {
  await recheckBeforeCapture(guard)
  const vp = await readViewport(tabId)
  const physW = Math.round(vp.width * vp.dpr)
  const physH = Math.round(vp.height * vp.dpr)
  const [frameWidth] = targetSize(physW, physH)
  const frameHeight = Math.max(1, Math.round(physH * Math.min(1, frameWidth / physW)))
  const s = clampScale(scale)
  const wantW = Math.max(1, Math.round(frameWidth * s))
  const wantH = Math.max(1, Math.round(frameHeight * s))
  const box = { x: vp.x, y: vp.y, width: vp.width, height: vp.height }
  const shot = await shoot(tabId, 'jpeg', box, vp.dpr, wantW, wantH)
  setContext(tabId, { viewportWidth: vp.width, viewportHeight: vp.height, screenshotWidth: frameWidth, screenshotHeight: frameHeight })
  return { base64: shot.data, format: 'jpeg', width: shot.width, height: shot.height, frameWidth, frameHeight }
}

// ---------- zoom ----------
export async function zoom(tabId, region, scale, guard) {
  if (!Array.isArray(region) || region.length !== 4) throw fail('zoom needs a region [x0, y0, x1, y1].', 'invalid_params')
  await recheckBeforeCapture(guard)
  const vp = await readViewport(tabId) // 顺序：形状 → 守卫 → 视口 → 数值 → 越界
  const [x0, y0, x1, y1] = region
  if (!region.every(validNum) || x1 <= x0 || y1 <= y0) {
    throw fail('region must be four non-negative numbers with x1 > x0 and y1 > y0.', 'invalid_params')
  }
  const c = contexts.get(tabId)
  const rx = c ? c.viewportWidth / c.screenshotWidth : 1
  const ry = c ? c.viewportHeight / c.screenshotHeight : 1
  const vx0 = x0 * rx
  const vy0 = y0 * ry
  const vx1 = x1 * rx
  const vy1 = y1 * ry
  if (vx1 > vp.width + 2 * rx || vy1 > vp.height + 2 * ry) {
    throw fail(`region falls outside the visible viewport (${vp.width}x${vp.height}); pick an area inside it.`, 'coordinate_out_of_bounds')
  }
  const box = { x: vx0 + vp.x, y: vy0 + vp.y, width: vx1 - vx0, height: vy1 - vy0 }
  const physW = Math.max(1, Math.round(box.width * vp.dpr))
  const physH = Math.max(1, Math.round(box.height * vp.dpr))
  const [tw, th] = targetSize(physW, physH)
  const s = clampScale(scale)
  const wantW = Math.max(1, Math.min(physW, Math.round(tw * s)))
  const wantH = Math.max(1, Math.min(physH, Math.round(th * s)))
  const shot = await shoot(tabId, 'png', box, vp.dpr, wantW, wantH)
  return { base64: shot.data, format: 'png', width: shot.width, height: shot.height }
}

// 端到端测试钩子
globalThis.__jevShot = { beginBatch, endBatch, getContext, setContext }
