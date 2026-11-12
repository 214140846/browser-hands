// 调试器挂载管理：全扩展唯一直接调用 chrome.debugger.* 的地方。
// 本模块自记账（不向 Chrome 枚举目标），合并并发挂载、短期记住挂载失败、闲置自动断开。
import { sessionClosedHooks } from './sessions.js'

const PROTOCOL = '1.3'
const IDLE_MS = 60000 // 空闲断开
const ATTACH_LIMIT_MS = 8000 // 单次挂载尝试超时
const CMD_LIMIT_MS = 30000 // 默认命令超时
const FAIL_MEMORY_MS = 30000 // 失败记忆
const BACKOFF_MS = [60, 120, 180, 240] // 外部扩展拦截后的退避，合计 600 < 750
const PROTECTED = ['chrome:', 'chrome-extension:', 'devtools:', 'edge:', 'about:']
const FOREIGN_TEXT = 'Cannot access a chrome-extension:// URL of different extension'

// 每个标签一份状态卡片，按需创建
const cards = new Map()
function card(tabId) {
  let c = cards.get(tabId)
  if (!c) {
    c = { live: false, pending: null, failure: null, users: 0, held: false, idleTimer: null }
    cards.set(tabId, c)
  }
  return c
}

const eventSubs = []
const attachedSubs = []
const inject = { msg: '', times: 0, delayMs: 0 }

function codedError(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

const lastErrorText = () => chrome.runtime.lastError?.message

// ---------- 空闲计时 ----------
function stopIdle(c) {
  if (c.idleTimer != null) clearTimeout(c.idleTimer)
  c.idleTimer = null
}
function startIdle(tabId) {
  const c = card(tabId)
  stopIdle(c)
  c.idleTimer = setTimeout(() => {
    c.idleTimer = null
    detach(tabId)
  }, IDLE_MS)
}
// 满足条件才计时：挂着、无人在用、未 hold
function maybeIdle(tabId) {
  const c = card(tabId)
  if (c.live && c.users === 0 && !c.held) startIdle(tabId)
}

// ---------- 单次挂载尝试：结局为 { ok } / { text } / { timeout } ----------
function tryOnce(tabId) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      resolve(r)
    }
    const guard = setTimeout(() => finish({ timeout: true }), ATTACH_LIMIT_MS)
    if (inject.times > 0) {
      inject.times -= 1
      const msg = inject.msg
      setTimeout(() => finish({ text: msg }), inject.delayMs)
      return
    }
    chrome.debugger.attach({ tabId }, PROTOCOL, () => {
      const t = lastErrorText()
      finish(t ? { text: t } : { ok: true })
    })
  })
}

const isAlready = (text) => /already attached/i.test(text)

// 在页内删除非本扩展的扩展 iframe（含 shadow root 内），返回删除个数
function purgeForeignFrames(ownId) {
  let n = 0
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'IFRAME') {
        const src = el.getAttribute('src') || ''
        if (src.startsWith('chrome-extension://') && !src.startsWith(`chrome-extension://${ownId}/`)) {
          el.remove()
          n++
          continue
        }
      }
      const sr = el.shadowRoot || (chrome?.dom?.openOrClosedShadowRoot?.(el) ?? null)
      if (sr) walk(sr)
    }
  }
  walk(document)
  return n
}

async function purge(tabId) {
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: purgeForeignFrames,
      args: [chrome.runtime.id],
    })
    return (out || []).reduce((s, r) => s + (Number(r?.result) || 0), 0)
  } catch {
    return -1 // 注入失败按「没删到」处理
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 走完整挂载流程（含外部扩展拦截重试），成功返回，失败抛 debugger_attach_failed
async function negotiate(tabId) {
  let r = await tryOnce(tabId)
  if (r.text && r.text.includes(FOREIGN_TEXT)) {
    const firstText = r.text
    const removed = await purge(tabId)
    const budget = removed > 0 ? 4 : 1
    for (let i = 0; i < budget; i++) {
      await wait(BACKOFF_MS[i])
      r = await tryOnce(tabId)
      if (!(r.text && r.text.includes(FOREIGN_TEXT))) break
    }
    if (r.text && r.text.includes(FOREIGN_TEXT)) r = { text: firstText }
  }
  if (r.ok || isAlready(r.text)) return
  if (r.timeout) {
    throw codedError('debugger_attach_failed', `Debugger attach timed out after ${ATTACH_LIMIT_MS} ms. DevTools may be open on this tab, or the renderer is stuck`)
  }
  throw codedError('debugger_attach_failed', `Debugger attach failed: ${r.text}`)
}

function rawCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const t = lastErrorText()
      if (t) reject(new Error(t))
      else resolve(res)
    })
  })
}

function timedCommand(tabId, method, params, ms) {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(codedError('cdp_timeout', `${method} got no response within ${ms} ms`)), ms)
    rawCommand(tabId, method, params).then(
      (v) => (clearTimeout(guard), resolve(v)),
      (e) => (clearTimeout(guard), reject(e)),
    )
  })
}

function isProtectedUrl(url) {
  if (!url || url === 'about:blank') return false
  return PROTECTED.some((s) => url.startsWith(s))
}

async function doAttach(tabId) {
  const c = card(tabId)
  const tabInfo = await chrome.tabs.get(tabId) // 失败原样抛出，不记
  if (isProtectedUrl(tabInfo?.url)) {
    throw codedError('chrome_protected_page', 'This is a browser-internal page and cannot be debugged. Open a regular web page first')
  }
  try {
    await negotiate(tabId)
  } catch (e) {
    c.failure = { error: e, at: Date.now() }
    throw e
  }
  c.live = true
  c.failure = null
  try {
    await timedCommand(tabId, 'Page.enable', {}, CMD_LIMIT_MS)
  } catch {
    // Page 域开启失败忽略
  }
  for (const h of attachedSubs) {
    try {
      h(tabId)
    } catch {
      // 单个回调出错不影响其他
    }
  }
}

function recentFailure(c) {
  if (c.failure && Date.now() - c.failure.at < FAIL_MEMORY_MS) return c.failure.error
  return null
}

export function attach(tabId) {
  const c = card(tabId)
  if (c.live) return Promise.resolve()
  if (c.pending) return c.pending
  const remembered = recentFailure(c)
  if (remembered) return Promise.reject(remembered)
  c.failure = null
  const p = doAttach(tabId).finally(() => {
    if (c.pending === p) c.pending = null
  })
  c.pending = p
  return p
}

export async function detach(tabId) {
  const c = card(tabId)
  stopIdle(c)
  c.live = false
  await new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        void lastErrorText() // 读掉错误，避免 Chrome 报未检查
        resolve()
      })
    } catch {
      resolve()
    }
  })
}

const looksDetached = (msg) => /debugger is not attached|detached while handling command/i.test(msg || '')

export async function send(tabId, method, params, ms = CMD_LIMIT_MS) {
  await attach(tabId)
  try {
    return await timedCommand(tabId, method, params, ms)
  } catch (e) {
    if (e?.code || !looksDetached(e?.message)) throw e
  }
  card(tabId).live = false
  await attach(tabId)
  return timedCommand(tabId, method, params, ms)
}

export async function withDebugger(tabId, fn) {
  const c = card(tabId)
  stopIdle(c)
  c.users += 1
  try {
    try {
      await attach(tabId)
    } catch (e) {
      if (e?.code !== 'debugger_attach_failed') throw e
    }
    return await fn()
  } finally {
    c.users -= 1
    if (c.users === 0) maybeIdle(tabId)
  }
}

export function holdDebugger(tabId) {
  card(tabId).held = true
}

export function releaseDebugger(tabId) {
  const c = card(tabId)
  if (!c.held) return
  c.held = false
  maybeIdle(tabId)
}

export function isAttached(tabId) {
  return cards.get(tabId)?.live === true
}

export function onDebuggerEvent(h) {
  eventSubs.push(h)
}

export function onDebuggerAttached(h) {
  attachedSubs.push(h)
}

// ---------- 导入时副作用 ----------
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source?.tabId == null) return
  for (const h of eventSubs) {
    try {
      h(source.tabId, method, params)
    } catch {
      // 订阅者出错互不影响
    }
  }
})

chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId == null) return
  const c = cards.get(source.tabId)
  if (!c) return
  c.live = false
  stopIdle(c)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  const c = cards.get(tabId)
  if (!c) return
  c.held = false
  c.failure = null
})

sessionClosedHooks.push((tabIds) => Promise.all(tabIds.filter((id) => isAttached(id)).map((id) => detach(id))))

globalThis.__jevDebugger = {
  attach,
  detach,
  isAttached,
  inject,
  forgetFailure: (tabId) => {
    const c = cards.get(tabId)
    if (c) c.failure = null
  },
}
