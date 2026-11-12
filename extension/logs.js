// 标签页控制台 / 网络日志：懒开启收集，按标签分桶，换站清空，空闲自动停止。
import { send, onDebuggerEvent, onDebuggerAttached, holdDebugger, releaseDebugger, isAttached } from './debugger.js'
import { sessionClosedHooks, resolveTabId } from './sessions.js'
import { redactUrl } from './redact.js'

const TEXT_CAP = 16384
const CONSOLE_CAP = 10000
const NETWORK_CAP = 1000
const DEFAULT_LIMIT = 100
const FAILED_STATUS = 503
const DOMAINS = ['Runtime', 'Network']

let idleMs = 60000

// tabId → 桶：{ host, live, timer, starting, consoleList, netList, netById }
const buckets = new Map()

function hostOf(url) {
  try {
    return new URL(url).hostname || ''
  } catch {
    return ''
  }
}

// 把文本里出现的 http(s) 网址逐个脱敏
function scrub(text) {
  return String(text).replace(/https?:\/\/[^\s"'<>()]+/g, (u) => redactUrl(u))
}

const where = (f) => `${redactUrl(f.url || '')}:${f.lineNumber ?? 0}:${f.columnNumber ?? 0}`

function argText(a) {
  if (!a) return ''
  if ('value' in a && a.value !== undefined && (a.value === null || typeof a.value !== 'object')) return String(a.value)
  if (a.description != null) return String(a.description)
  if ('unserializableValue' in a) return String(a.unserializableValue)
  if (a.value !== undefined) {
    try {
      return JSON.stringify(a.value)
    } catch {
      return String(a.value)
    }
  }
  return a.type || ''
}

// 单参数截到上限，总长截到两倍上限（第一个参数必在）
function joinArgs(args) {
  let out = ''
  for (const a of args || []) {
    const piece = argText(a).slice(0, TEXT_CAP)
    const next = out ? `${out} ${piece}` : piece
    if (out && next.length > 2 * TEXT_CAP) {
      out = next.slice(0, 2 * TEXT_CAP)
      break
    }
    out = next
  }
  return out
}

function pushCapped(list, item, cap, onDrop) {
  list.push(item)
  while (list.length > cap) {
    const gone = list.shift() // 注意：不能写成 onDrop?.(list.shift())，可选调用会短路掉 shift
    if (onDrop) onDrop(gone)
  }
}

function recordConsole(b, p) {
  const frames = p.stackTrace?.callFrames || []
  pushCapped(b.consoleList, {
    kind: p.type || 'log',
    at: p.timestamp ?? Date.now(),
    body: scrub(joinArgs(p.args)),
    place: frames[0] ? where(frames[0]) : '',
    stack: [],
  }, CONSOLE_CAP)
}

function recordException(b, p) {
  const d = p.exceptionDetails || {}
  const raw = d.exception?.description || d.text || 'Unknown uncaught exception'
  const frames = d.stackTrace?.callFrames || []
  pushCapped(b.consoleList, {
    kind: 'exception',
    at: p.timestamp ?? Date.now(),
    body: scrub(String(raw).slice(0, TEXT_CAP)),
    place: d.url ? where(d) : '',
    stack: frames.map((f) => `${f.functionName || '(anonymous)'} @ ${where(f)}`),
  }, CONSOLE_CAP)
}

function recordRequest(b, p) {
  const entry = { id: p.requestId, url: redactUrl(p.request?.url || ''), method: p.request?.method || 'GET', status: null }
  b.netById.set(entry.id, entry)
  pushCapped(b.netList, entry, NETWORK_CAP, (gone) => {
    if (b.netById.get(gone.id) === gone) b.netById.delete(gone.id)
  })
}

// CDP 事件：同步落库
onDebuggerEvent((tabId, method, params) => {
  const b = buckets.get(tabId)
  if (!b || !b.live) return
  const p = params || {}
  switch (method) {
    case 'Runtime.consoleAPICalled': return recordConsole(b, p)
    case 'Runtime.exceptionThrown': return recordException(b, p)
    case 'Network.requestWillBeSent': return recordRequest(b, p)
    case 'Network.responseReceived': {
      const e = b.netById.get(p.requestId)
      if (e) e.status = p.response?.status ?? e.status
      return
    }
    case 'Network.loadingFailed': {
      const e = b.netById.get(p.requestId)
      if (e) e.status = FAILED_STATUS
    }
  }
})

const enableAll = (tabId) => Promise.all(DOMAINS.map((d) => send(tabId, `${d}.enable`)))

onDebuggerAttached((tabId) => {
  if (buckets.get(tabId)?.live) enableAll(tabId).catch(() => {})
})

// 停止收集：保留记录
function halt(tabId) {
  const b = buckets.get(tabId)
  if (!b) return
  clearTimeout(b.timer)
  b.timer = null
  if (!b.live) return
  b.live = false
  releaseDebugger(tabId)
  if (isAttached(tabId)) for (const d of DOMAINS) send(tabId, `${d}.disable`).catch(() => {})
}

// 彻底遗忘：停收集并丢记录
function forget(tabId) {
  halt(tabId)
  buckets.delete(tabId)
}

chrome.tabs.onRemoved.addListener((tabId) => forget(tabId))
sessionClosedHooks.push((tabIds) => {
  for (const id of tabIds || []) forget(id)
})
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const b = buckets.get(tabId)
  if (!b || !info || !info.url) return
  const h = hostOf(info.url)
  if (h === b.host) return
  b.host = h
  b.consoleList.length = 0
  b.netList.length = 0
  b.netById.clear()
})

function armTimer(tabId, b) {
  clearTimeout(b.timer)
  b.timer = setTimeout(() => halt(tabId), idleMs)
}

async function ensureLive(tabId, url) {
  let b = buckets.get(tabId)
  if (!b) {
    b = { host: hostOf(url), live: false, timer: null, starting: null, consoleList: [], netList: [], netById: new Map() }
    buckets.set(tabId, b)
  }
  if (!b.live) {
    if (!b.starting) {
      b.starting = (async () => {
        holdDebugger(tabId)
        try {
          await enableAll(tabId)
          b.live = true
        } catch (e) {
          releaseDebugger(tabId)
          throw e
        } finally {
          b.starting = null
        }
      })()
    }
    await b.starting
  }
  armTimer(tabId, b)
  return b
}

// 公共前置：守卫 → 取标签 → 开收集；任何失败包装后抛出
async function withTab(tool, prefix, p, s, g, render) {
  try {
    const tabId = resolveTabId(p || {}, s)
    if (g) await g.check(tool)
    const info = await chrome.tabs.get(tabId)
    if (!info?.url) throw new Error(`Tab ${tabId} has no URL to read from`)
    const b = await ensureLive(tabId, info.url)
    return { tabId, output: render(b) }
  } catch (e) {
    const err = new Error(`${prefix}: ${e?.message || 'unknown failure'}`)
    if (e?.code !== undefined) err.code = e.code
    throw err
  }
}

const limitOf = (n) => (Number.isInteger(n) && n >= 0 ? n : DEFAULT_LIMIT)
const clock = (t) => {
  const ms = t > 1e12 ? t : t * 1000
  return new Date(ms).toISOString().slice(11, 23)
}

function makeMatcher(pattern) {
  if (!pattern) return () => true
  try {
    const re = new RegExp(pattern, 'i')
    return (s) => re.test(s)
  } catch {
    const needle = pattern.toLowerCase()
    return (s) => s.toLowerCase().includes(needle)
  }
}

export async function readConsole(p, s, g) {
  return withTab('read_console_messages', 'Could not read console output', p, s, g, (b) => {
    const q = p || {}
    const hit = makeMatcher(q.pattern)
    const rows = b.consoleList.filter((e) => (!q.onlyErrors || e.kind === 'error' || e.kind === 'exception') && hit(e.body))
    const lim = limitOf(q.limit)
    const shown = rows.slice(0, lim)
    if (q.clear) b.consoleList.length = 0
    if (!rows.length) {
      return `Nothing in the console ${q.onlyErrors ? 'error' : 'log'} buffer for this tab yet. Capture begins with the first call to this tool, so reload the page to collect output from its initial load.`
    }
    let head = `${rows.length} ${q.onlyErrors ? 'error' : 'console'} entries captured`
    if (shown.length < rows.length) head += ` — listing the oldest ${shown.length}`
    const blocks = shown.map((e, i) => {
      const lines = [`#${i + 1} ${clock(e.at)} ${e.kind.toUpperCase()}${e.place ? ` (${e.place})` : ''}`, `  ${e.body}`]
      for (const f of e.stack) lines.push(`    at ${f}`)
      return lines.join('\n')
    })
    return [`${head}:`, ...blocks].join('\n\n')
  })
}

export async function readNetwork(p, s, g) {
  return withTab('read_network_requests', 'Could not read network activity', p, s, g, (b) => {
    const q = p || {}
    const pat = q.urlPattern || ''
    const rows = pat ? b.netList.filter((e) => e.url.includes(pat)) : b.netList.slice()
    const lim = limitOf(q.limit)
    const shown = rows.slice(0, lim)
    if (q.clear) {
      b.netList.length = 0
      b.netById.clear()
    }
    const echo = pat ? ` matching "${pat}"` : ''
    if (!rows.length) {
      return `No captured requests${echo} for this tab yet. Capture begins with the first call to this tool; reload the page or interact with it to generate traffic.`
    }
    let head = `${rows.length} request(s) captured${echo}`
    if (shown.length < rows.length) head += ` — listing the oldest ${shown.length}`
    const lines = shown.map((e, i) => `[${i + 1}] ${e.method} ${e.url} -> ${e.status ?? 'pending'}`)
    return [`${head}:`, ...lines].join('\n')
  })
}

// 端到端测试钩子
globalThis.__jevLogs = {
  setIdleMs: (n) => {
    idleMs = n
  },
  isListening: (tabId) => !!buckets.get(tabId)?.live,
  stop: (tabId) => halt(tabId),
  counts: (tabId) => {
    const b = buckets.get(tabId)
    return { console: b ? b.consoleList.length : 0, network: b ? b.netList.length : 0 }
  },
}
