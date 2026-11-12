// gif-recorder：按会话录动作帧，导出时交给 offscreen 合成页做成 GIF，再下载或拖放到页面。
// 行为以 specs/gif-recorder.md 为准。
import { screenshot, getContext, setContext, toViewport } from './screenshot.js'
import { withBackground, wakeHidden } from './background-tab.js'
import { sessionClosedHooks } from './sessions.js'

// ---------- 常量 ----------
const FRAME_CAP = 50
const COMPOSE_LIMIT_MS = 120000
const DOWNLOAD_LIMIT_MS = 30000
const SETTLE_MS = 120 // 截图前等页面画完的短停（≤1 秒）
const ACTIONS = ['start_recording', 'stop_recording', 'export', 'clear']
const CLICKY = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'left_click_drag'])

// ---------- 会话仓库：名字 → { live, frames } ----------
const reels = new Map()
const reelOf = (name) => {
  let r = reels.get(name)
  if (!r) reels.set(name, (r = { live: false, frames: [] }))
  return r
}
const dropReel = (name) => void reels.delete(name)
const pushFrame = (reel, frame) => {
  reel.frames.push(frame)
  if (reel.frames.length > FRAME_CAP) reel.frames.splice(0, reel.frames.length - FRAME_CAP)
}

sessionClosedHooks.push((_tabIds, name) => dropReel(name))

const badParams = (message) => Object.assign(new Error(message), { code: 'invalid_params' })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

export function isRecording(name) {
  return typeof name === 'string' && reels.get(name)?.live === true
}

// ---------- 动作记录 ----------
// 动作名 → 动词短语；没登记的动作用名字本身（下划线换空格）
const VERBS = {
  navigate: 'Opened',
  type: 'Typed',
  key: 'Pressed',
  wait: 'Paused',
  zoom: 'Zoomed in',
  scroll: 'Scrolled',
  hover: 'Hovered',
  left_click: 'Clicked',
  right_click: 'Right-clicked',
  double_click: 'Double-clicked',
  triple_click: 'Triple-clicked',
  left_click_drag: 'Dragged',
}
const clip = (v, n) => { const t = String(v); return t.length > n ? t.slice(0, n - 1) + '…' : t }
// 统一拼接：动词 + 可选细节（网址 / 文本）+ 可选落点
function describe(type, p) {
  const verb = VERBS[type] ?? String(type).split('_').join(' ')
  const detail = type === 'navigate' ? p.url : p.text
  const parts = [verb]
  if (detail != null && detail !== '') parts.push(`'${clip(detail, 28)}'`)
  if (Array.isArray(p.coordinate)) parts.push(`at ${p.coordinate[0]},${p.coordinate[1]}`)
  return parts.join(' ')
}

// 代理坐标 → 视口坐标；任何问题都返回 undefined（只是不画标注）
function convert(tabId, point, label) {
  if (!Array.isArray(point) || point.length !== 2) return undefined
  try {
    return toViewport(tabId, point, label)
  } catch {
    return undefined
  }
}

function buildAction(tool, tabId, p) {
  const type = tool === 'navigate' ? 'navigate' : p.action
  const action = { type, description: describe(type, p), stamp: Date.now() }
  if (tool === 'navigate') return Object.assign(action, { url: p.url })
  for (const key of ['coordinate', 'start_coordinate']) {
    const v = convert(tabId, p[key], key)
    if (v) action[key] = v
  }
  if (typeof p.text === 'string') action.text = p.text
  return action
}

// 在后台包裹里截一张「动作后」的图，并恢复代理原有的坐标上下文
async function captureAfter(tabId) {
  const before = getContext(tabId)
  try {
    return await withBackground(tabId, async () => {
      await wakeHidden(tabId)
      await pause(SETTLE_MS)
      const shot = await screenshot(tabId, 1)
      const ctx = getContext(tabId)
      return {
        base64: shot.base64,
        format: shot.format,
        viewportWidth: ctx?.viewportWidth ?? shot.width,
        viewportHeight: ctx?.viewportHeight ?? shot.height,
      }
    })
  } finally {
    if (before) setContext(tabId, before)
  }
}

export async function recordAction(s, tabId, tool, p, result) {
  try {
    const name = s?.name
    if (!name || !isRecording(name) || !p) return
    const reel = reelOf(name)
    if (tool === 'computer') {
      const kind = p.action
      if (!kind) return
      if (kind === 'screenshot' || kind === 'zoom') {
        const img = result?.base64Image
        if (!img) return
        if (kind === 'screenshot') {
          const ctx = getContext(tabId)
          pushFrame(reel, {
            base64: img,
            format: result.imageFormat ?? 'jpeg',
            ...(ctx ? { viewportWidth: ctx.viewportWidth, viewportHeight: ctx.viewportHeight } : {}),
          })
        } else {
          pushFrame(reel, { base64: img, format: result.imageFormat ?? 'png', action: buildAction('computer', tabId, p) })
        }
        return
      }
    } else if (tool === 'navigate') {
      if (!p.url) return
    } else return

    // 坐标按录制截图之前的上下文换算
    const action = buildAction(tool, tabId, p)
    if (tool === 'computer' && CLICKY.has(p.action)) {
      const prev = reel.frames.at(-1)
      if (prev && prev.viewportWidth != null && prev.viewportHeight != null) {
        pushFrame(reel, {
          base64: prev.base64,
          format: prev.format,
          viewportWidth: prev.viewportWidth,
          viewportHeight: prev.viewportHeight,
          action,
        })
      }
    }
    const shot = await captureAfter(tabId)
    pushFrame(reel, { ...shot, action })
  } catch {
    // 录制失败不影响动作本身
  }
}

// ---------- 导出 ----------
const delayFor = (action) => {
  if (!action) return 800
  if (action.type === 'wait') return 300
  if (CLICKY.has(action.type)) return 1500
  return 800
}
const pick = (opts, key, fallback) => (opts?.[key] == null ? fallback : opts[key])

function exportOptions(opts) {
  return {
    showClickIndicators: pick(opts, 'showClickIndicators', true),
    showDragPaths: pick(opts, 'showDragPaths', true),
    showActionLabels: pick(opts, 'showActionLabels', true),
    showProgressBar: pick(opts, 'showProgressBar', true),
    quality: pick(opts, 'quality', 10),
  }
}

function autoName() {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[:T]/g, '-')
  return `recording-${stamp}.gif`
}

function wireFrame(fr) {
  const out = { base64: fr.base64, format: fr.format, delay: delayFor(fr.action) }
  if (fr.action) out.action = fr.action
  if (fr.viewportWidth != null) out.viewportWidth = fr.viewportWidth
  if (fr.viewportHeight != null) out.viewportHeight = fr.viewportHeight
  return out
}

// 把合成请求发给 offscreen，回调形式 + 超时
function askCompose(frames, options) {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (fn, v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn(v)
    }
    const timer = setTimeout(() => finish(reject, new Error('offscreen composer gave no answer within 120s')), COMPOSE_LIMIT_MS)
    try {
      chrome.runtime.sendMessage({ type: 'gif.compose', frames, options }, (reply) => {
        const err = chrome.runtime.lastError
        if (err) return finish(reject, new Error(`could not reach offscreen composer (${err.message ?? err})`))
        if (!reply?.success) return finish(reject, new Error(reply?.error ? `offscreen composer refused: ${reply.error}` : 'offscreen composer returned no GIF'))
        finish(resolve, reply.result)
      })
    } catch (e) {
      finish(reject, new Error(`could not reach offscreen composer (${e?.message ?? e})`))
    }
  })
}

function release(blobUrl) {
  try {
    const r = chrome.runtime.sendMessage({ type: 'gif.release', blobUrl })
    if (r && typeof r.catch === 'function') r.catch(() => {})
  } catch {}
}

// 下载状态 → 判定：true 成功、Error 失败、undefined 还没到终态
const verdictOf = (state) =>
  state === 'complete' ? true : state === 'interrupted' ? new Error('browser stopped the download midway') : undefined

// 发起下载并守着它：事件、发起后的一次探查、限时三方谁先给出判定就以谁为准
async function downloadTo(blobUrl, filename) {
  const id = await chrome.downloads.download({ url: blobUrl, filename, saveAs: false })
  let onDelta, timer
  const watched = new Promise((settle) => {
    const offer = (v) => v !== undefined && settle(v)
    onDelta = (delta) => delta?.id === id && offer(verdictOf(delta.state?.current))
    chrome.downloads.onChanged.addListener(onDelta)
    timer = setTimeout(() => settle(new Error('download still pending after 30s')), DOWNLOAD_LIMIT_MS)
    chrome.downloads.search({ id }).then((hits) => offer(verdictOf(hits?.[0]?.state)), () => {})
  })
  const verdict = await watched.finally(() => {
    clearTimeout(timer)
    chrome.downloads.onChanged.removeListener(onDelta)
  })
  if (verdict !== true) throw verdict
  const hits = await chrome.downloads.search({ id }).catch(() => [])
  return hits?.[0]?.filename || filename
}

// 注入页面执行：base64 → File，在视口坐标处元素上依次派发拖放三事件
function dropIntoPage(b64, name, x, y) {
  const raw = atob(b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  const target = document.elementFromPoint(x, y)
  if (!target) throw new Error(`no element at (${x}, ${y})`)
  const file = new File([bytes], name, { type: 'image/gif' })
  const carrier = new DataTransfer()
  carrier.items.add(file)
  for (const type of ['dragenter', 'dragover', 'drop']) {
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: carrier, clientX: x, clientY: y }))
  }
  return { dropped: name }
}

async function dropTo(tabId, gifResult, filename, [x, y]) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: dropIntoPage, args: [gifResult.base64, filename, x, y] })
  if (!results?.[0]?.result) throw new Error('page did not accept the dropped GIF')
}

async function exportGif(p, name, tabId) {
  const toDisk = p.download === true
  const hasPoint = Array.isArray(p.coordinate) && p.coordinate.length === 2
  if (!toDisk && !hasPoint) throw badParams('export: pass download: true to save the file, or coordinate [x, y] to drop it on the page')
  const reel = reels.get(name)
  if (!reel || reel.frames.length === 0) throw badParams('export: the reel is empty - call start_recording and do some actions first')
  const point = hasPoint ? toViewport(tabId, p.coordinate, 'export coordinate') : undefined
  const filename = typeof p.filename === 'string' && p.filename ? p.filename : autoName()
  const frames = reel.frames.map(wireFrame)
  const options = exportOptions(p.options)

  await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Compose recorded frames into an animated GIF' })
  let summary
  try {
    const gifResult = await askCompose(frames, options)
    try {
      const where = toDisk ? await downloadTo(gifResult.blobUrl, filename) : (await dropTo(tabId, gifResult, filename, point), filename)
      summary = `GIF ready - ${frames.length} frame(s), ${gifResult.width}x${gifResult.height}, ${gifResult.size} B; ${toDisk ? 'saved at' : 'dropped onto page as'} ${where}`
    } finally {
      release(gifResult.blobUrl)
    }
  } finally {
    await chrome.offscreen.closeDocument().catch(() => {})
  }
  dropReel(name)
  return summary
}

export async function gifCreator(p, s, tabId) {
  const verb = p?.action
  if (!verb) throw badParams(`gif_creator: action is required (one of ${ACTIONS.join(' | ')})`)
  if (!ACTIONS.includes(verb)) throw badParams(`gif_creator: "${verb}" is not an action; pick one of ${ACTIONS.join(' | ')}`)
  const name = s?.name
  switch (verb) {
    case 'start_recording': {
      const reel = reelOf(name)
      if (reel.live) return { output: `Recorder is already on - keeping the ${reel.frames.length} frame(s) captured so far.` }
      reel.frames = []
      reel.live = true
      return { output: 'Recorder on: every successful browser action now adds a frame.' }
    }
    case 'stop_recording': {
      const reel = reels.get(name)
      if (!reel?.live) return { output: 'Recorder was already off; nothing changed.' }
      reel.live = false
      return { output: `Recorder off - ${reel.frames.length} frame(s) held, ready for export.` }
    }
    case 'clear': {
      const n = reels.get(name)?.frames.length ?? 0
      dropReel(name)
      return { output: `Reel wiped: ${n} frame(s) discarded, recorder off.` }
    }
    default:
      return { output: await exportGif(p, name, tabId) }
  }
}
