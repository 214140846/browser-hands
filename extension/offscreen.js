// GIF 合成页脚本：由 offscreen.html 以普通脚本加载（排在 gif.js 之后），不含 import / export。
// 收到 gif.compose：解码各帧 → 画动作标注 → 统一尺寸 → gif.js 编码 → 回 base64 与对象地址。
// 收到 gif.release：释放对应对象地址。
// 导入时唯一的副作用：在 chrome.runtime.onMessage 上挂一个监听。

// ---------- 调色板与节奏（青绿 + 靛蓝为主，深石板灰做底） ----------
const 调色 = {
  点位环: '#14b8a6',      // 青绿：点击环
  点位芯: '#0f766e',      // 深青：点击芯
  点位描边: '#f0fdfa',    // 极浅青：让环在深色网页上也看得见
  拖线: '#6366f1',        // 靛蓝：拖拽连线
  拖起点: '#a5b4fc',      // 浅靛：起点空心环
  拖终点: '#4338ca',      // 深靛：终点实心点
  标签底: 'rgba(15, 23, 42, 0.86)', // 深石板：标签底板
  标签字: '#e2e8f0',
  标签边: '#2dd4bf',
  进度槽: 'rgba(15, 23, 42, 0.35)',
  进度条: '#22d3ee',      // 青色进度
  补白: '#f8fafc',
}
const 缺省停留毫秒 = 600
const 末帧加长毫秒 = 1400
const 缺省画质 = 10
const 说明保底字数 = 120
const 点击类 = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'left_click_drag'])
const 纯文字类 = new Set(['type', 'key', 'wait'])

// ---------- 小工具 ----------
const 开着 = (opts, key) => !opts || opts[key] === undefined || opts[key] === null || opts[key] !== false
const 正数 = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0
const 有点 = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])

// 解一帧图片：每帧一个 Image，只设一次 src
function 解码(frame) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Image decode failed'))
    img.src = `data:image/${frame.format || 'png'};base64,${frame.base64}`
  })
}

// Blob → 不带前缀的 base64
function 转base64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(new Error('Failed to read the output'))
    r.readAsDataURL(blob)
  })
}

// ---------- 标注画笔 ----------
// 点击标注：外环 + 实芯 + 四个短刻度，整体半径控制在 18×比例（上限 22×比例）
function 画点位(ctx, x, y, s) {
  ctx.save()
  ctx.lineWidth = 3 * s
  ctx.strokeStyle = 调色.点位描边
  ctx.beginPath()
  ctx.arc(x, y, 15 * s, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 2 * s
  ctx.strokeStyle = 调色.点位环
  ctx.beginPath()
  ctx.arc(x, y, 15 * s, 0, Math.PI * 2)
  ctx.stroke()
  // 刻度：从环内侧向外伸一点，像准星
  ctx.beginPath()
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.moveTo(x + dx * 10 * s, y + dy * 10 * s)
    ctx.lineTo(x + dx * 18 * s, y + dy * 18 * s)
  }
  ctx.stroke()
  ctx.fillStyle = 调色.点位芯
  ctx.beginPath()
  ctx.arc(x, y, 4 * s, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// 拖拽：直线段 + 起点空心环 + 终点实心点
function 画拖拽(ctx, a, b, s) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.strokeStyle = 调色.拖线
  ctx.lineWidth = 3 * s
  ctx.setLineDash([8 * s, 5 * s])
  ctx.beginPath()
  ctx.moveTo(a[0], a[1])
  ctx.lineTo(b[0], b[1])
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineWidth = 2.5 * s
  ctx.strokeStyle = 调色.拖起点
  ctx.beginPath()
  ctx.arc(a[0], a[1], 9 * s, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = 调色.拖终点
  ctx.beginPath()
  ctx.arc(b[0], b[1], 8 * s, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 调色.点位描边
  ctx.lineWidth = 2 * s
  ctx.stroke()
  ctx.restore()
}

// 只在空格处断行；单词比行宽还长时独占一行
function 断行(ctx, text, maxW) {
  const words = text.split(' ').filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (cur && ctx.measureText(next).width > maxW) {
      lines.push(cur)
      cur = w
    } else cur = next
  }
  if (cur) lines.push(cur)
  return lines
}

// 文字标签：贴在画面底部居中的圆角底板，左侧一条青色竖边
function 画标签(ctx, raw, iw, ih, s) {
  let text = String(raw).replace(/\s+/g, ' ').trim()
  if (!text) return
  if (text.length > 说明保底字数 * 2) text = `${text.slice(0, 说明保底字数 * 2).replace(/\s+\S*$/, '')} …`
  const fs = Math.max(10, Math.round(13 * s))
  const pad = 8 * s
  const lineH = fs * 1.35
  ctx.save()
  ctx.font = `600 ${fs}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`
  ctx.textBaseline = 'top'
  const maxW = Math.max(40, iw - 4 * pad)
  const lines = 断行(ctx, text, maxW)
  const textW = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)))
  const boxW = Math.min(iw - 2 * pad, textW + 2 * pad + 4 * s)
  const boxH = lines.length * lineH + 2 * pad
  const bx = Math.max(0, (iw - boxW) / 2)
  const by = Math.max(0, ih - boxH - 14 * s)
  ctx.fillStyle = 调色.标签底
  ctx.fillRect(bx, by, boxW, boxH)
  ctx.fillStyle = 调色.标签边
  ctx.fillRect(bx, by, 4 * s, boxH)
  ctx.fillStyle = 调色.标签字
  lines.forEach((l, i) => ctx.fillText(l, bx + pad + 4 * s, by + pad + i * lineH))
  ctx.restore()
}

// 进度：顶部细槽 + 按帧序推进的青色条，末帧填满
function 画进度(ctx, idx, total, iw, s) {
  const h = Math.max(3, Math.round(4 * s))
  ctx.save()
  ctx.fillStyle = 调色.进度槽
  ctx.fillRect(0, 0, iw, h)
  ctx.fillStyle = 调色.进度条
  ctx.fillRect(0, 0, (iw * (idx + 1)) / total, h)
  ctx.restore()
}

// 按判定表决定这一帧要画什么，再在原图范围内画
function 画标注(ctx, frame, img, opts, idx, total) {
  const iw = img.width
  const ih = img.height
  const s = frame.viewportWidth && iw ? iw / frame.viewportWidth : 1
  const act = frame.action
  const 换算 = (p) => [p[0] * s, p[1] * s]
  let 要写字 = false
  if (act && typeof act.type === 'string') {
    const desc = typeof act.description === 'string' && act.description.trim() ? act.description : ''
    const 点位类 = 点击类.has(act.type) || act.type === 'scroll'
    if (act.type === 'left_click_drag' && 有点(act.start_coordinate) && 有点(act.coordinate) && 开着(opts, 'showDragPaths')) {
      画拖拽(ctx, 换算(act.start_coordinate), 换算(act.coordinate), s)
      if (desc && 开着(opts, 'showActionLabels')) 要写字 = true
    }
    if (点位类 && 有点(act.coordinate) && 开着(opts, 'showClickIndicators')) {
      const [x, y] = 换算(act.coordinate)
      画点位(ctx, x, y, s)
      if (desc && 开着(opts, 'showActionLabels')) 要写字 = true
    }
    if (纯文字类.has(act.type) && !有点(act.coordinate) && desc && 开着(opts, 'showActionLabels')) 要写字 = true
    if (要写字) 画标签(ctx, desc, iw, ih, s)
  }
  if (开着(opts, 'showProgressBar')) 画进度(ctx, idx, total, iw, s)
}

// ---------- 合成 ----------
async function 合成(frames, opts) {
  const imgs = await Promise.all(frames.map(解码))
  const W = Math.max(...imgs.map((i) => i.width))
  const H = Math.max(...imgs.map((i) => i.height))
  const gif = new GIF({
    width: W,
    height: H,
    quality: opts && 正数(opts.quality) ? opts.quality : 缺省画质,
    repeat: 0,
    workers: 2,
    workerScript: chrome.runtime.getURL('gif.worker.js'),
  })
  frames.forEach((f, i) => {
    const img = imgs[i]
    const cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    const ctx = cv.getContext('2d')
    // 只有比动画尺寸小时才补白，且只补原图之外的区域
    if (img.width < W || img.height < H) {
      ctx.fillStyle = 调色.补白
      if (img.width < W) ctx.fillRect(img.width, 0, W - img.width, H)
      if (img.height < H) ctx.fillRect(0, img.height, img.width, H - img.height)
    }
    ctx.drawImage(img, 0, 0)
    画标注(ctx, f, img, opts, i, frames.length)
    const base = 正数(f.delay) ? f.delay : 缺省停留毫秒
    gif.addFrame(cv, { delay: i === frames.length - 1 ? base + 末帧加长毫秒 : base })
  })
  const blob = await new Promise((resolve, reject) => {
    gif.on('finished', resolve)
    gif.on('abort', () => reject(new Error('GIF encoding aborted')))
    gif.render()
  })
  const base64 = await 转base64(blob)
  return { base64, blobUrl: URL.createObjectURL(blob), size: blob.size, width: W, height: H }
}

// ---------- 消息入口 ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || !sender.id || sender.id !== chrome.runtime.id) return
  if (!message || typeof message !== 'object') return
  if (message.type === 'gif.release') {
    URL.revokeObjectURL(message.blobUrl)
    return
  }
  if (message.type !== 'gif.compose') return
  合成(message.frames || [], message.options).then(
    (result) => sendResponse({ success: true, result }),
    (err) => sendResponse({ success: false, error: (err && err.message) || 'GIF render failed' }),
  )
  return true
})
