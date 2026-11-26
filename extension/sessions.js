// 会话 ↔ 标签组。一切建组/改组都排进 serial 队列；靠 Chrome 事件自愈，不轮询。
// 不支持标签组的浏览器退到「清单模式」：会话自己记 tabIds，不碰任何 tabGroups 接口。
// 判据只有两条，都不靠猜：没有 chrome.tabGroups；或 host 报告拉起它的是 Arc（Arc 有这个接口，但 chrome.tabs.group 永不返回）。
import { browserKind } from './browser.js'

const COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']
const IDLE_MS = 20000

const sessions = new Map() // sessionId -> {name, groupId, mainTabId, color, windowId, tabIds?, running, timer}；tabIds 只在清单模式有
let nextColor = 0
let loaded
export const sessionClosedHooks = [] // (tabIds, sessionId) => void；调试器模块接在这里解除挂载

function load() {
  return (loaded ??= chrome.storage.session.get(['sessions', 'nextColor']).then((r) => {
    for (const [k, v] of Object.entries(r.sessions ?? {})) sessions.set(k, { ...v, running: 0, timer: null })
    nextColor = r.nextColor ?? 0
  }))
}

function save() {
  const out = {}
  for (const [k, s] of sessions) {
    out[k] = { name: s.name, groupId: s.groupId, mainTabId: s.mainTabId, color: s.color, windowId: s.windowId }
    if (s.tabIds) out[k].tabIds = s.tabIds
  }
  return chrome.storage.session.set({ sessions: out, nextColor })
}

let queue = Promise.resolve()
function serial(fn) {
  const p = queue.then(fn)
  queue = p.catch(() => {})
  return p
}

const titleOf = (s) => `${s.running > 0 ? '⌛' : '✅'} ${s.name}`
export const tracksTabIds = (s) => Array.isArray(s.tabIds)
const listed = tracksTabIds
const groupsUnusable = async () => !chrome.tabGroups || (await browserKind()) === 'arc'

async function retryDrag(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= 3 || !/dragging/i.test(String(e?.message))) throw e
      await new Promise((r) => setTimeout(r, 1000)) // Chrome 正在拖拽标签，只在这种报错时等 1 秒再试
    }
  }
}

const groupTabs = (arg) => retryDrag(() => chrome.tabs.group(arg))

async function pickWindow() {
  try {
    return (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id
  } catch {
    return (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0]?.id
  }
}

async function syncGroup(s) {
  if (listed(s) || s.groupId < 0) return
  const g = await chrome.tabGroups.get(s.groupId)
  const title = titleOf(s)
  if (g.title !== title || g.color !== s.color) await chrome.tabGroups.update(s.groupId, { title, color: s.color })
}

async function aliveTabs(ids) {
  const tabs = []
  for (const id of new Set(ids)) {
    if (id < 0) continue
    const t = await chrome.tabs.get(id).catch(() => null)
    if (t) tabs.push(t)
  }
  return tabs
}

async function repairGroup(s) {
  const main = s.mainTabId >= 0 ? await chrome.tabs.get(s.mainTabId).catch(() => null) : null
  if (main && s.groupId >= 0 && main.groupId === s.groupId) {
    // 正常
  } else if (main) {
    // 主标签被拖出组：老组还在就归队，否则重建
    const old = s.groupId >= 0 ? await chrome.tabGroups.get(s.groupId).catch(() => null) : null
    s.windowId = main.windowId
    s.groupId = await groupTabs(old ? { tabIds: [main.id], groupId: s.groupId } : { tabIds: [main.id] })
  } else {
    const rest = s.groupId >= 0 ? await chrome.tabs.query({ groupId: s.groupId }) : []
    if (rest.length) {
      s.mainTabId = rest[0].id // 主标签被关但组里还有别的，接着用
      s.windowId = rest[0].windowId
    } else {
      const t = await chrome.tabs.create({ windowId: await pickWindow(), active: false, url: 'about:blank' })
      s.mainTabId = t.id
      s.windowId = t.windowId
      s.groupId = await groupTabs({ tabIds: [t.id], createProperties: { windowId: t.windowId } })
    }
  }
  await syncGroup(s)
}

// 清单模式：只认 s.tabIds 里还活着的标签；全没了就新开一个空白页当主标签
async function repairList(s) {
  s.groupId = -1
  const tabs = await aliveTabs([s.mainTabId, ...(s.tabIds ?? [])])
  s.tabIds = tabs.map((t) => t.id)
  const main = tabs.find((t) => t.id === s.mainTabId) ?? tabs[0]
  if (main) {
    s.mainTabId = main.id
    s.windowId = main.windowId
    return
  }
  const t = await chrome.tabs.create({ windowId: await pickWindow(), active: false, url: 'about:blank' })
  s.mainTabId = t.id
  s.windowId = t.windowId
  s.tabIds = [t.id]
}

const repair = async (s) => (listed(s) || (await groupsUnusable()) ? repairList(s) : repairGroup(s))

// 一次调用的开头/结尾：开头保证组存在并标 ⌛，结尾空闲计时后标 ✅
export async function beginCall(sessionId) {
  await load()
  let s = sessions.get(sessionId)
  if (!s) {
    s = { name: sessionId, groupId: -1, mainTabId: -1, color: COLORS[nextColor++ % COLORS.length], windowId: -1, running: 0, timer: null }
    sessions.set(sessionId, s)
  }
  s.running++
  clearTimeout(s.timer)
  try {
    await serial(async () => {
      await repair(s)
      await save()
    })
  } catch (e) {
    endCall(s)
    throw e
  }
  return s
}

export function endCall(s) {
  s.running--
  if (s.running > 0) return
  s.timer = setTimeout(() => {
    if (s.running === 0) serial(() => syncGroup(s)).catch(() => {})
  }, IDLE_MS)
}

export async function listTabs(s) {
  if (listed(s)) return aliveTabs(s.tabIds)
  return chrome.tabs.query({ groupId: s.groupId })
}

export function joinGroup(s, tabId) {
  return serial(async () => {
    if (!listed(s)) return groupTabs({ tabIds: [tabId], groupId: s.groupId })
    if (!s.tabIds.includes(tabId)) s.tabIds.push(tabId)
    await save()
  })
}

// 准入：标签必须在本会话组里（清单模式：在本会话的标签清单里）
export async function admit(s, tabId) {
  if (listed(s)) {
    if (s.tabIds.includes(tabId) && (await chrome.tabs.get(tabId).catch(() => null))) return
  } else {
    const t = await chrome.tabs.get(tabId).catch(() => null)
    if (t && t.groupId === s.groupId) return
  }
  const ids = (await listTabs(s)).map((x) => x.id)
  throw Object.assign(new Error(`Tab ${tabId} is not in this session's tab group. Usable tabIds: [${ids.join(', ')}]`), { code: 'tab_outside_group' })
}

export const resolveTabId = (params, s) => params.tabId ?? s.mainTabId

export async function closeSession(sessionId) {
  await load()
  const s = sessions.get(sessionId)
  if (!s) return {}
  clearTimeout(s.timer)
  s.running = 0
  sessions.delete(sessionId)
  await serial(async () => {
    await syncGroup(s).catch(() => {}) // 组已被关就算了
    await save()
  })
  const ids = listed(s)
    ? (await aliveTabs(s.tabIds)).map((t) => t.id)
    : s.groupId >= 0
      ? (await chrome.tabs.query({ groupId: s.groupId }).catch(() => [])).map((t) => t.id)
      : []
  for (const h of sessionClosedHooks) {
    try {
      await h(ids, sessionId)
    } catch {}
  }
  return {}
}

// 状态小窗用：当前所有会话和各自占的标签
export async function listSessions() {
  await load()
  return Promise.all(
    [...sessions].map(async ([id, s]) => {
      const tabs = listed(s) ? await aliveTabs(s.tabIds) : s.groupId >= 0 ? await chrome.tabs.query({ groupId: s.groupId }).catch(() => []) : []
      return { id, name: s.name, tabs: tabs.map((t) => ({ tabId: t.id, title: t.title ?? '' })) }
    }),
  )
}

// 本会话的标签（组模式看 groupId，清单模式看 tabIds）
export function ownsTab(s, tab) {
  return listed(s) ? s.tabIds.includes(tab.id) : s.groupId >= 0 && tab.groupId === s.groupId
}

// 用户改了组名/颜色 → 改回来（事件驱动）
chrome.tabGroups?.onUpdated.addListener(async (g) => {
  await load()
  for (const s of sessions.values()) {
    if (s.groupId === g.id && (g.title !== titleOf(s) || g.color !== s.color)) serial(() => syncGroup(s)).catch(() => {})
  }
})

// 新标签：opener 属于某会话就并入那个会话（事件驱动，不轮询）
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId === undefined || tab.id === undefined) return
  await load()
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null)
  if (!opener) return
  const s = [...sessions.values()].find((x) => ownsTab(x, opener))
  if (!s || ownsTab(s, tab)) return
  if (!listed(s)) {
    const cur = await chrome.tabs.get(tab.id).catch(() => null)
    if (!cur || cur.groupId === s.groupId) return
  }
  await joinGroup(s, tab.id).catch(() => {})
})

// 清单模式：标签关了就从清单里划掉
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await load()
  for (const s of sessions.values()) {
    if (listed(s) && s.tabIds.includes(tabId)) {
      s.tabIds = s.tabIds.filter((id) => id !== tabId)
      serial(save).catch(() => {})
    }
  }
})
