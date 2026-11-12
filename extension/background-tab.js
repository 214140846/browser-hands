// 后台标签支持：焦点模拟 + 临时静音、隐藏标签唤醒、最小化窗口下的点击拦截。
// 行为见 specs/background-tab.md。
import { send, withDebugger } from './debugger.js'
import { joinGroup } from './sessions.js'

// ---------- 小工具 ----------

// 吞掉一切失败，失败返回 undefined
const soft = async (fn) => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

// 标签是否在后台：true / false；读不到标签返回 undefined
const probeBackground = async (tabId) => {
  const tab = await soft(() => chrome.tabs.get(tabId))
  if (!tab) return undefined
  if (!tab.active) return true
  const win = await soft(() => chrome.windows.get(tab.windowId))
  if (!win) return true
  return !(win.focused && win.state !== 'minimized')
}

// ---------- 焦点模拟 ----------
// 每个标签一条「轮」记录：
//   users    ——当前参与的调用数
//   live     ——轮是否还在进行（计入 activeCount）
//   ready    ——开启阶段（静音 + 开启命令）完成的 Promise
//   closing  ——收尾阶段（关闭命令 + 解除静音）完成的 Promise，收尾期间新调用要等它
//   weMuted  ——本轮是否加过静音
const rounds = new Map()

globalThis.__jevBg = {
  activeCount: () => {
    let n = 0
    for (const r of rounds.values()) if (r.live) n++
    return n
  },
}

const openRound = async (tabId, round) => {
  const tab = await soft(() => chrome.tabs.get(tabId))
  if (tab && !tab.audible && !tab.mutedInfo?.muted) {
    round.weMuted = true // 先记账：即便静音命令报错，收尾时也会核对并撤销
    await soft(() => chrome.tabs.update(tabId, { muted: true }))
  }
  await soft(() => send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }))
}

const closeRound = async (tabId, round) => {
  const turnOff = soft(() => send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }))
  const unmute = round.weMuted
    ? soft(async () => {
        const tab = await chrome.tabs.get(tabId)
        const mi = tab.mutedInfo
        if (mi?.muted && mi.reason === 'extension' && mi.extensionId === chrome.runtime.id) {
          await chrome.tabs.update(tabId, { muted: false })
        }
      })
    : undefined
  await Promise.all([turnOff, unmute])
}

export async function withFocusEmulation(tabId, fn) {
  let round
  for (;;) {
    const cur = rounds.get(tabId)
    if (cur?.closing) {
      await cur.closing
      continue
    }
    if (cur?.live) {
      cur.users++
      round = cur
      await round.ready
      break
    }
    const bg = await probeBackground(tabId)
    if (rounds.has(tabId)) continue // 等待期间别的调用已经动了这个标签，重新判断
    if (!bg) return await fn()
    round = { users: 1, live: true, weMuted: false, ready: undefined, closing: undefined }
    rounds.set(tabId, round)
    round.ready = openRound(tabId, round)
    await round.ready
    break
  }

  const leave = () => {
    if (--round.users > 0) return undefined
    round.live = false
    round.closing = closeRound(tabId, round).finally(() => {
      if (rounds.get(tabId) === round) rounds.delete(tabId)
    })
    return round.closing
  }

  let result
  try {
    result = await fn()
  } catch (err) {
    leave() // 失败不等收尾，立刻报错
    throw err
  }
  await leave()
  return result
}

export function withBackground(tabId, fn) {
  return withDebugger(tabId, () => withFocusEmulation(tabId, fn))
}

export async function wakeHidden(tabId) {
  try {
    if ((await probeBackground(tabId)) !== true) return
    await send(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 1,
      fromSurface: true,
      clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
    })
  } catch {
    // 只为促使渲染，失败无所谓
  }
}

// ---------- 点击拦截：页内函数（必须自包含，会被序列化注入） ----------

// 武装：挂一次监听（页面全局上只挂一份），清空记录并重新计时
const armGuard = () => {
  const KEY = '__jevBgClickGuard'
  let st = window[KEY]
  if (!st) {
    st = { records: [], armed: false, at: 0 }
    const interactiveTag = (el) => {
      const tag = el.localName
      if (tag === 'button' || tag === 'label' || tag === 'select' || tag === 'textarea' || tag === 'embed' || tag === 'iframe' || tag === 'object' || tag === 'summary' || tag === 'details') return true
      if (tag === 'input') return el.type !== 'hidden'
      if ((tag === 'audio' || tag === 'video') && el.hasAttribute('controls')) return true
      if (tag === 'img' && el.hasAttribute('usemap')) return true
      return el.isContentEditable === true
    }
    const resolveTarget = (a) => {
      const own = a.getAttribute('target')
      const raw = own !== null ? own : document.querySelector('base[target]')?.getAttribute('target') ?? ''
      return raw.trim()
    }
    const opensNewContext = (name) => {
      if (name === '') return false
      const kw = name.toLowerCase()
      if (kw === '_blank') return true
      if (kw === '_self' || kw === '_parent' || kw === '_top') return false
      if (name === window.name) return false
      for (const f of document.querySelectorAll('iframe,frame')) if (f.getAttribute('name') === name) return false
      return true
    }
    st.handler = (ev) => {
      if (!st.armed) return
      if (Date.now() - st.at > 10000) {
        st.armed = false
        return
      }
      if (!ev.isTrusted || ev.defaultPrevented) return
      if (location.origin === 'null') return
      const path = ev.composedPath()
      let anchor = null
      for (const node of path) {
        if (!(node instanceof Element)) continue
        if (node instanceof HTMLAnchorElement) {
          anchor = node
          break
        }
        if (interactiveTag(node)) return // 链接内部的另一个交互元素
      }
      if (!anchor || !anchor.hasAttribute('href') || anchor.isContentEditable) return
      if (anchor.protocol !== 'http:' && anchor.protocol !== 'https:') return
      if (anchor.hasAttribute('download') && anchor.origin === location.origin) return
      if (!opensNewContext(resolveTarget(anchor))) return
      ev.preventDefault()
      st.records.push(anchor.href)
    }
    window.addEventListener('click', st.handler, false)
    window[KEY] = st
  }
  st.records = []
  st.armed = true
  st.at = Date.now()
}

// 取回：返回记录并解除武装
const drainGuard = () => {
  const st = window.__jevBgClickGuard
  if (!st) return []
  const out = st.records.slice()
  st.records = []
  st.armed = false
  return out
}

const inject = (tabId, func) =>
  chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true, func })

// ---------- 点击拦截：扩展侧 ----------

export async function beginClickInterception(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.windowId === undefined || tab.windowId === null) return null
    const win = await chrome.windows.get(tab.windowId)
    if (win.state !== 'minimized') return null
    await inject(tabId, armGuard)
    // 凭据：begin 当时原标签的快照，finish 时不再重读
    return { tabId, windowId: tab.windowId, index: tab.index, groupId: tab.groupId }
  } catch {
    return null
  }
}

const drain = async (tabId) => {
  const results = await soft(() => inject(tabId, drainGuard))
  const out = []
  if (Array.isArray(results)) {
    for (const r of results) if (Array.isArray(r?.result)) out.push(...r.result)
  }
  return out
}

export async function abortClickInterception(token) {
  if (!token) return
  await drain(token.tabId)
}

export async function finishClickInterception(token, session) {
  if (!token) return []
  try {
    const seen = new Set()
    const urls = []
    for (const u of await drain(token.tabId)) {
      if (typeof u !== 'string' || !/^https?:/i.test(u) || seen.has(u)) continue
      seen.add(u)
      urls.push(u)
      if (urls.length === 3) break
    }
    const none = chrome.tabGroups?.TAB_GROUP_ID_NONE
    const inGroup = token.groupId !== undefined && token.groupId !== null && token.groupId !== none
    const ids = []
    for (const [i, url] of urls.entries()) {
      let tab = await soft(() =>
        chrome.tabs.create({ url, active: false, windowId: token.windowId, openerTabId: token.tabId, index: token.index + 1 + i }),
      )
      if (!tab) tab = await soft(() => chrome.tabs.create({ url, active: false }))
      if (!tab || typeof tab.id !== 'number' || tab.windowId !== token.windowId) continue
      if (inGroup) {
        const ok =
          session && session.groupId === token.groupId
            ? await soft(async () => (await joinGroup(session, tab.id), true))
            : await soft(async () => (await chrome.tabs.group({ tabIds: [tab.id], groupId: token.groupId }), true))
        if (!ok) continue
      }
      ids.push(tab.id)
    }
    return ids
  } catch {
    return []
  }
}

export function newTabNote(ids) {
  if (!ids.length) return ''
  return ` Note: this action opened ${ids.length === 1 ? 'a new tab' : 'new tabs'} in the background. Use tab id ${ids.join(', ')} to operate on ${ids.length === 1 ? 'it' : 'them'}.`
}
