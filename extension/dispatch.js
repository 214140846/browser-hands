// 方法分发中枢：把 MCP 发来的 (method, params, sessionId) 路由到各工具实现，
// 并统一处理会话登记、标签准入、操作指示器、Stop 中止与「换站」守卫。
import { redactUrl, redactTitle } from './redact.js'
import { beginCall, endCall, admit, resolveTabId, listTabs, joinGroup, closeSession } from './sessions.js'
import { startGuard } from './guard.js'
import { trackCall, pointIndicator } from './indicator.js'
import { checkAbort, abortableSleep, stoppedError } from './abort.js'
import { navigate as navigateTab } from './navigate.js'
import { observe } from './observe.js'
import { recordAction, gifCreator } from './gif-recorder.js'
import { click, hover, type as typeText, key as pressKey, wheel, drag, modifierMask, isZoomChord } from './input.js'
import {
  withBackground,
  wakeHidden,
  beginClickInterception,
  abortClickInterception,
  finishClickInterception,
  newTabNote,
} from './background-tab.js'
import { parseRef, prefixRefs, scanAll, inPage, callOnRef, locateRef } from './frames.js'
import { toViewport, screenshot, zoom, cacheImage, beginBatch, endBatch } from './screenshot.js'
import { readConsole, readNetwork } from './logs.js'
import { javascriptTool, fileUpload, uploadImage, resizeWindow, uploadStash } from './page-tools.js'

export const PROTOCOL_VERSION = 1

// ---------- 常量 ----------
const DEFAULT_MAX_CHARS = 50000
const NAME_LIMIT = 60
const WHEEL_STEP_PX = 100
const WHEEL_FALLBACK_MS = 6000
const WAIT_MAX_SECONDS = 10
const REPEAT_MAX = 100

// 刷新快捷键 -> 是否绕过缓存
const REFRESH_KEYS = new Map([
  ['cmd+r', false],
  ['ctrl+r', false],
  ['f5', false],
  ['cmd+shift+r', true],
  ['ctrl+f5', true],
  ['shift+f5', true],
])

// ---------- 小工具 ----------
const fail = (code, message) => Object.assign(new Error(message), { code })
const invalid = (message) => fail('invalid_params', message)
const isPair = (v) => Array.isArray(v) && v.length === 2
const round = (n) => Math.round(n)

// ---------- 模块级状态 ----------
const tasks = new Map() // taskId -> { sessionId, release }
const stoppedSessions = new Set()
const connects = new Map() // requestId -> { finish, windowId, settled }

// ---------- 握手 ----------
export async function profileEmail() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })
    return typeof info?.email === 'string' ? info.email : ''
  } catch {
    return ''
  }
}

async function hello() {
  const stored = await chrome.storage.local.get(['profileId', 'profileName'])
  let profileId = stored.profileId
  if (typeof profileId !== 'string' || !profileId) {
    profileId = crypto.randomUUID()
    await chrome.storage.local.set({ profileId })
  }
  const platform = await chrome.runtime.getPlatformInfo()
  return {
    profileId,
    platform: platform.os,
    profileName: stored.profileName ?? '',
    email: await profileEmail(),
    extensionVersion: chrome.runtime.getManifest().version,
    protocolVersion: PROTOCOL_VERSION,
  }
}

// ---------- 连接确认窗口 ----------
const closeWindow = (id) => {
  try {
    Promise.resolve(chrome.windows.remove(id)).catch(() => {})
  } catch {}
}

function settleConnect(requestId, result, closeIt) {
  const c = connects.get(requestId)
  if (!c) return false
  connects.delete(requestId)
  c.settled = true
  c.finish(result)
  if (closeIt && c.windowId !== undefined) closeWindow(c.windowId)
  return true
}

function connectRequest({ requestId }) {
  return new Promise((finish) => {
    const c = { finish, windowId: undefined, settled: false }
    connects.set(requestId, c)
    Promise.resolve(
      chrome.windows.create({
        url: chrome.runtime.getURL(`connect.html?rid=${encodeURIComponent(requestId)}`),
        type: 'popup',
        focused: true,
        width: 440,
        height: 320,
      }),
    ).then(
      (w) => {
        c.windowId = w?.id
        if (c.settled && c.windowId !== undefined) closeWindow(c.windowId) // 取消先于开窗
      },
      () => {},
    )
  })
}

function connectCancel({ requestId }) {
  settleConnect(requestId, { connected: false, reason: 'cancelled' }, true)
  return {}
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [rid, c] of [...connects]) {
    if (c.windowId === windowId) settleConnect(rid, { connected: false, reason: 'closed' }, false)
  }
})

const cleanName = (raw) => (typeof raw === 'string' ? raw.slice(0, NAME_LIMIT) : '')

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender?.id !== chrome.runtime.id) return undefined
  if (msg === null || typeof msg !== 'object') return undefined
  if (msg.type === 'connectDecision') {
    const name = cleanName(msg.name)
    ;(async () => {
      try {
        if (name) await chrome.storage.local.set({ profileName: name })
        settleConnect(msg.requestId, { connected: true, profileName: name }, true)
        reply({ ok: true })
      } catch {
        reply({ ok: false })
      }
    })()
    return true
  }
  if (msg.type === 'setProfileName') {
    const name = cleanName(msg.name)
    chrome.storage.local.set({ profileName: name }).then(
      () => reply({ ok: true }),
      () => reply({ ok: false }),
    )
    return true
  }
  return undefined
})

// ---------- 任务守卫 ----------
function taskGuard({ taskId }, _s, _g, signal, sessionId) {
  return new Promise((resolve) => {
    tasks.set(taskId, { sessionId, release: () => resolve({ released: true }) })
    // 先于 handle 的 reject 同步打上 Stop 标记
    signal?.addEventListener('abort', () => stoppedSessions.add(sessionId), { once: true })
  })
}

function taskRelease({ taskId }, _s, _g, _signal, sessionId) {
  const t = tasks.get(taskId)
  if (t) {
    tasks.delete(taskId)
    stoppedSessions.delete(t.sessionId)
    t.release()
  }
  stoppedSessions.delete(sessionId)
  return {}
}

function dropSessionState(sessionId) {
  for (const [id, t] of [...tasks]) {
    if (t.sessionId === sessionId) {
      tasks.delete(id)
      t.release()
    }
  }
  stoppedSessions.delete(sessionId)
}

// ---------- read_page / get_page_text / form_input ----------
const pageError = (res, code) => Object.assign(new Error(res.error), { code })

const redactLinks = (text) =>
  text.replace(/(\bhref=)(["'])(.*?)\2/g, (_m, pre, q, v) => `${pre}${q}${redactUrl(v)}${q}`)

const prefixCompact = (text, frameId) => (frameId ? text.replace(/^ref_/gm, `f${frameId}:ref_`) : text)

async function readPage(params, s, g) {
  const tabId = resolveTabId(params, s)
  await g.check('read_page')
  const opts = {
    filter: params.filter || 'interactive',
    depth: params.depth ?? null,
    maxChars: params.max_chars ?? DEFAULT_MAX_CHARS,
    refId: null,
    compact: Boolean(params.compact),
  }

  if (params.ref_id) {
    const { frameId, ref } = parseRef(params.ref_id)
    const res = await inPage(tabId, 'scan', [{ ...opts, refId: ref }], frameId)
    if (res.error) throw pageError(res, res.errorCode)
    const out = { ...res, tabId }
    if (typeof res.pageContent === 'string') out.pageContent = redactLinks(prefixRefs(res.pageContent, frameId))
    if (typeof res.compact === 'string') out.compact = prefixCompact(res.compact, frameId)
    return out
  }

  const frames = await scanAll(tabId, [opts])
  const main = frames.find((f) => f.frameId === 0) ?? frames[0]
  if (main.result.error) throw pageError(main.result, main.result.errorCode)
  const pieces = main.result.pageContent ? [main.result.pageContent] : []
  const lists = main.result.compact ? [main.result.compact] : []
  for (const { frameId, result } of frames) {
    if (frameId === main.frameId || result.error || !result.pageContent) continue
    pieces.push(`--- iframe f${frameId} ---`, prefixRefs(result.pageContent, frameId))
    if (result.compact) lists.push(prefixCompact(result.compact, frameId))
  }
  const out = { ...main.result, pageContent: redactLinks(pieces.join('\n')), tabId }
  if (lists.length) out.compact = lists.join('\n')
  else if (main.result.compact === undefined) delete out.compact
  return out
}

async function getPageText(params, s, g) {
  const tabId = resolveTabId(params, s)
  await g.check('get_page_text')
  const res = await inPage(tabId, 'pageText', [params.max_chars ?? DEFAULT_MAX_CHARS])
  if (res.error) throw pageError(res, 'get_page_text_no_content')
  return { ...res, tabId, title: redactTitle(res.title, res.url), url: redactUrl(res.url) }
}

async function formInput(params, s, g, signal) {
  const tabId = resolveTabId(params, s)
  const { ref, value } = params
  if (!ref || value === undefined || value === null) throw invalid('form_input needs a non-empty "ref" and a "value"')
  checkAbort(signal)
  await g.check('form_input')
  const res = await callOnRef(tabId, ref, 'formInput', [value])
  if (res.error) throw pageError(res, res.errorCode)
  return { tabId, output: res.output }
}

// ---------- computer ----------
const wrapStepError = (e) => {
  const err = new Error(`computer action failed: ${e?.message ?? e}`)
  err.code = e?.code ?? 'computer_action_failed'
  err.cause = e
  return err
}
// 执行步骤：后台模式里的整段操作，失败统一包装
const step = (tabId, fn) => withBackground(tabId, fn).catch((e) => Promise.reject(wrapStepError(e)))

// 点击 / 悬停的目标点：ref 优先，否则截图坐标
const pointNeeded = (p) => {
  if (!p.ref && !isPair(p.coordinate)) throw invalid('Provide "ref" or a two-element "coordinate"')
}
const resolvePoint = (c, label) => (c.params.ref ? locateRef(c.tabId, c.params.ref) : toViewport(c.tabId, c.params.coordinate, label))
const describePoint = (p) => (p.ref ? p.ref : `${round(p.coordinate[0])},${round(p.coordinate[1])}`)

const clicker = (label, button, count, intercept) => async (c) => {
  pointNeeded(c.params)
  await c.recheck(label)
  const [x, y] = await resolvePoint(c, label)
  const mask = c.params.modifiers ? modifierMask(c.params.modifiers) : 0
  await pointIndicator(c.tabId, x, y)
  const token = intercept ? await beginClickInterception(c.tabId) : null
  const before = () => {
    checkAbort(c.signal)
    return c.g.check(`${label} (before press)`)
  }
  try {
    await step(c.tabId, () => click(c.tabId, x, y, button, count, mask, before))
  } catch (e) {
    if (intercept) await abortClickInterception(token)
    throw e
  }
  const note = intercept ? newTabNote(await finishClickInterception(token, c.s)) : ''
  return { output: `${label} @ ${describePoint(c.params)}${note}` }
}

const keyAction = async (c) => {
  const { text, repeat: rawRepeat } = c.params
  if (typeof text !== 'string' || !text) throw invalid('"text" must be a non-empty string')
  const repeat = rawRepeat ?? 1
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > REPEAT_MAX) throw invalid(`"repeat" must be an integer from 1 to ${REPEAT_MAX}`)
  const keys = text.split(/\s+/).filter(Boolean)
  if (!keys.length) throw invalid('"text" has no keys')
  const refresh = keys.length === 1 ? REFRESH_KEYS.get(keys[0].toLowerCase()) : undefined
  if (refresh !== undefined) {
    await c.recheck('key')
    await chrome.tabs.reload(c.tabId, { bypassCache: refresh })
    return { output: `reload | ${keys[0]}` }
  }
  const zoomKey = keys.find((k) => isZoomChord(k))
  if (zoomKey !== undefined) throw invalid(`Page zoom shortcut is not allowed: ${zoomKey}`)
  await c.recheck('key')
  await step(c.tabId, async () => {
    for (let i = 0; i < repeat; i++) {
      for (const k of keys) {
        checkAbort(c.signal)
        await pressKey(c.tabId, k)
      }
    }
  })
  return { output: `key | ${text}${repeat > 1 ? ` ×${repeat}` : ''}` }
}

const DIRECTIONS = {
  up: (n) => [0, -n],
  down: (n) => [0, n],
  left: (n) => [-n, 0],
  right: (n) => [n, 0],
}

const scrollAction = async (c) => {
  const { coordinate, scroll_direction: dir = 'down' } = c.params
  if (!isPair(coordinate)) throw invalid('"coordinate" must be a two-element array')
  if (!Object.hasOwn(DIRECTIONS, dir)) throw invalid(`Unknown scroll_direction: ${dir}`)
  const amount = c.params.scroll_amount || 3
  await c.recheck('scroll')
  const [x, y] = toViewport(c.tabId, coordinate, 'scroll')
  const [dx, dy] = DIRECTIONS[dir](amount * WHEEL_STEP_PX)
  await step(c.tabId, async () => {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('wheel did not respond')), WHEEL_FALLBACK_MS)
    })
    try {
      await Promise.race([Promise.resolve().then(() => wheel(c.tabId, x, y, dx, dy)), timeout])
    } catch {
      await inPage(c.tabId, 'scrollFallback', [x, y, dx, dy])
    } finally {
      clearTimeout(timer)
    }
  })
  return { output: `scroll ${dir}×${amount} @ ${round(coordinate[0])},${round(coordinate[1])}` }
}

const shotAction = (isZoom) => async (c) => {
  await c.recheck(isZoom ? 'zoom' : 'screenshot')
  const { scale, region } = c.params
  return step(c.tabId, async () => {
    await wakeHidden(c.tabId)
    const shot = isZoom ? await zoom(c.tabId, region, scale, c.g) : await screenshot(c.tabId, scale, c.g)
    const imageId = cacheImage(c.s?.name ?? '', shot.base64, shot.format)
    const size = `${shot.width}x${shot.height}`
    const output = isZoom
      ? `zoom ${size} | ${imageId}`
      : `shot ${size} | viewport ${shot.frameWidth}x${shot.frameHeight} | ${imageId}`
    return { output, imageId, base64Image: shot.base64, imageFormat: shot.format }
  })
}

const ACTIONS = {
  left_click: clicker('click', 'left', 1, true),
  double_click: clicker('click×2', 'left', 2, true),
  triple_click: clicker('click×3', 'left', 3, true),
  right_click: clicker('rclick', 'right', 1, false),
  hover: async (c) => {
    pointNeeded(c.params)
    await c.recheck('hover')
    const [x, y] = await resolvePoint(c, 'hover')
    await pointIndicator(c.tabId, x, y)
    await step(c.tabId, () => hover(c.tabId, x, y))
    return { output: `hover @ ${describePoint(c.params)}` }
  },
  left_click_drag: async (c) => {
    const { start_coordinate: from, coordinate: to } = c.params
    if (!isPair(from) || !isPair(to)) throw invalid('Drag needs "start_coordinate" and "coordinate", each a two-element array')
    await c.recheck('drag')
    const a = toViewport(c.tabId, from, 'drag start')
    const b = toViewport(c.tabId, to, 'drag end')
    await pointIndicator(c.tabId, a[0], a[1])
    await step(c.tabId, () => drag(c.tabId, a, b, c.signal))
    return { output: `drag ${round(from[0])},${round(from[1])} => ${round(to[0])},${round(to[1])}` }
  },
  type: async (c) => {
    const { text } = c.params
    if (typeof text !== 'string' || !text) throw invalid('"text" must be a non-empty string')
    await c.recheck('type')
    await step(c.tabId, () => typeText(c.tabId, text, c.signal))
    return { output: `type | ${text}` }
  },
  key: keyAction,
  scroll: scrollAction,
  scroll_to: async (c) => {
    const { ref } = c.params
    if (!ref) throw invalid('"ref" is required for scroll_to')
    await c.recheck('scroll_to')
    await locateRef(c.tabId, ref)
    return { output: `scroll_to | ${ref}` }
  },
  wait: async (c) => {
    const { duration } = c.params
    if (!(duration > 0) || duration > WAIT_MAX_SECONDS) throw invalid(`"duration" must be greater than 0 and at most ${WAIT_MAX_SECONDS} seconds`)
    await abortableSleep(duration * 1000, c.signal)
    return { output: `wait ${duration}s` }
  },
  screenshot: shotAction(false),
  zoom: shotAction(true),
}

async function computer(params, s, g, signal) {
  const tabId = resolveTabId(params, s)
  checkAbort(signal)
  const { action } = params
  if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) throw invalid(`computer: unsupported action ${action}`)
  const c = { params, s, g, signal, tabId, recheck: (stage) => g.check(`computer ${stage}`) }
  const result = await ACTIONS[action](c)
  await recordAction(s, tabId, 'computer', params, result)
  return { tabId, ...result }
}

// ---------- 其余工具 ----------
async function tabsContext(_params, s) {
  const tabs = await listTabs(s)
  return {
    availableTabs: tabs.map((t) => {
      const url = t.url ?? t.pendingUrl ?? ''
      return { tabId: t.id, title: redactTitle(t.title ?? '', url), url: redactUrl(url) }
    }),
    tabGroupId: s.groupId,
    initialTabId: s.mainTabId,
  }
}

async function tabsCreate(_params, s) {
  const tab = await chrome.tabs.create({ windowId: s.windowId, active: false, url: 'about:blank' })
  await joinGroup(s, tab.id)
  return { tabId: tab.id, title: '', url: 'about:blank' }
}

async function tabsClose(params) {
  await chrome.tabs.remove(params.tabId)
  return { tabId: params.tabId }
}

async function navigateTool(params, s, _g, signal) {
  const tabId = resolveTabId(params, s)
  const res = await navigateTab(tabId, params, signal)
  await recordAction(s, tabId, 'navigate', params, res)
  return { tabId, ...res }
}

// ---------- 方法表：[是否挂指示器到标签, 是否起守卫, 实现] ----------
const T = { tab: true, guard: true }
const N = { tab: true, guard: false }
const O = { tab: false, guard: false }
const METHODS = {
  read_page: [T, readPage],
  get_page_text: [T, getPageText],
  form_input: [T, formInput],
  computer: [T, computer],
  javascript_tool: [T, (p, s, g) => javascriptTool(p, s, g)],
  file_upload: [T, (p, s, g) => fileUpload(p, s, g)],
  upload_image: [T, (p, s, g) => uploadImage(p, s, g)],
  navigate: [N, navigateTool],
  jev_task_guard: [N, taskGuard],
  connect_request: [O, connectRequest],
  connect_cancel: [O, connectCancel],
  hello: [O, hello],
  tabs_context_mcp: [O, tabsContext],
  tabs_create_mcp: [O, tabsCreate],
  tabs_close_mcp: [O, tabsClose],
  jev_observe: [O, (p, s, _g, signal) => observe(resolveTabId(p, s), { max: p.max }, signal)],
  jev_task_release: [O, taskRelease],
  gif_creator: [O, async (p, s) => ({ tabId: resolveTabId(p, s), ...(await gifCreator(p, s, resolveTabId(p, s))) })],
  batch_begin: [O, () => (beginBatch(), {})],
  batch_end: [O, () => (endBatch(), {})],
  read_console_messages: [O, (p, s) => readConsole(p, s, undefined)],
  read_network_requests: [O, (p, s) => readNetwork(p, s, undefined)],
  resize_window: [O, (p) => resizeWindow(p)],
  upload_stash: [O, (p) => uploadStash(p)],
}

// ---------- 入口 ----------
export async function handle(method, params, sessionId) {
  if (method === 'session_closed') {
    dropSessionState(sessionId)
    return closeSession(sessionId)
  }
  if (!Object.hasOwn(METHODS, method)) throw fail('unknown_method', `no handler registered for "${method}"`)
  const [kind, run] = METHODS[method]
  if (!sessionId) return run(params, undefined, undefined, undefined, undefined)
  if (stoppedSessions.has(sessionId) && method !== 'jev_task_release' && method !== 'batch_end') throw stoppedError()

  const s = await beginCall(sessionId)
  try {
    if (params.tabId !== undefined && method !== 'tabs_context_mcp' && method !== 'tabs_create_mcp') await admit(s, params.tabId)
    const tab = kind.tab ? resolveTabId(params, s) : undefined
    const call = trackCall(sessionId, tab)
    try {
      call.stopped.catch(() => {})
      const job = (async () => run(params, s, kind.guard ? await startGuard(tab) : undefined, call.signal, sessionId))()
      job.catch(() => {})
      return await Promise.race([job, call.stopped])
    } finally {
      call.done()
    }
  } finally {
    endCall(s)
  }
}
