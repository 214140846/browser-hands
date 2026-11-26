// 指示器的后台一侧 + 调用取消。
// 状态变化才发消息：第一个调用开始 → 画；空闲 HIDE_DELAY_MS 后 → 撤；页面导航完成 → 重画；点 Stop → 立即撤。没有心跳、没有轮询。
// 截图 / 放大 / 点击前后用 withIndicatorHidden 包一层：先让光框和 Stop 瞬间消失，睡 50ms 等重绘，动作完再恢复。
// Stop 点击（content 发来的 STOP）和状态小窗的"全部停止"都走 stopCalls，让进行中的调用返回 stopped。
import { stoppedError } from './abort.js'
import { listSessions } from './sessions.js'

const HIDE_DELAY_MS = 1500

const calls = new Set() // {sessionId, tabId, stop}
const hideTimers = new Map() // tabId -> timer

// 先试调页内函数，没有（页面刚刷新 / 第一次）才注入 indicator-page.js，之后复用
async function inPage(tabId, op, args = []) {
  const call = () => chrome.scripting.executeScript({ target: { tabId }, func: (o, a) => window.__jevIndicator?.[o](...a) ?? null, args: [op, args] })
  let [r] = await call()
  if (r?.result == null) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['indicator-page.js'] })
    ;[r] = await call()
  }
  return r?.result ?? null
}

const busy = (tabId) => [...calls].some((c) => c.tabId === tabId)
const quietly = (p) => p.catch(() => {}) // 受保护页面 / 标签已关：画不了就算了

export const showIndicator = (tabId) => quietly(inPage(tabId, 'show'))
export const hideIndicator = (tabId) => quietly(inPage(tabId, 'hide'))
const SETTLE_MS = 50 // 隐藏后等一帧重绘，截图里才不会残留光框
const CURSOR_WAIT_MS = 250 // 等光标走到位的上限

// 光标移动到 (x, y)（取整）。waitMs > 0 时最多等光标落点这么久，0 = 不等
export const pointIndicator = (tabId, x, y, waitMs = 0) => {
  const moving = quietly(inPage(tabId, 'moveCursor', [Math.round(x), Math.round(y)]))
  return waitMs > 0 ? Promise.race([moving, new Promise((r) => setTimeout(r, waitMs))]) : moving
}
export { CURSOR_WAIT_MS }

// 只对页面里已有指示器的标签生效（不会为了隐藏而注入脚本）；返回是否真的隐藏了
async function inPageIfPresent(tabId, op, args = []) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: (o, a) => window.__jevIndicator?.[o](...a) ?? null, args: [op, args] })
    return r?.result != null
  } catch {
    return false // 受保护页面 / 标签已关
  }
}

// 隐藏 → 睡 50ms → 执行 → 立即恢复。point 为点击目标（视口整数坐标）。没有在跑的调用或页面没有指示器时直接执行
export async function withIndicatorHidden(tabId, fn, point) {
  const hidden = tabId !== undefined && busy(tabId) && (await inPageIfPresent(tabId, 'suppress', [point ?? null]))
  if (hidden) await new Promise((r) => setTimeout(r, SETTLE_MS))
  try {
    return await fn()
  } finally {
    if (hidden) await inPageIfPresent(tabId, 'restore')
  }
}

// 登记一次进行中的调用；返回 {stopped, done}。stopped 是 Stop 时 reject 的 promise，done 在调用结束时调用
export function trackCall(sessionId, tabId) {
  let rejectStopped
  const controller = new AbortController() // Stop 时 abort，动作据此真中止
  const stopped = new Promise((_, rej) => (rejectStopped = rej))
  stopped.catch(() => {})
  const c = { sessionId, tabId, stop: () => (controller.abort(), rejectStopped(stoppedError())) }
  calls.add(c)
  if (tabId !== undefined) {
    clearTimeout(hideTimers.get(tabId))
    hideTimers.delete(tabId)
    showIndicator(tabId)
  }
  return {
    stopped,
    signal: controller.signal,
    done() {
      calls.delete(c)
      if (tabId === undefined || busy(tabId)) return
      clearTimeout(hideTimers.get(tabId))
      hideTimers.set(
        tabId,
        setTimeout(() => {
          hideTimers.delete(tabId)
          if (!busy(tabId)) hideIndicator(tabId)
        }, HIDE_DELAY_MS),
      )
    },
  }
}

// tabId 缺省 = 全部；返回被停掉的调用数
export function stopCalls(tabId) {
  let n = 0
  for (const c of calls) {
    if (tabId !== undefined && c.tabId !== tabId) continue
    c.stop()
    n++
  }
  return n
}

// 导航完成后重画（页面脚本和 shadow root 随文档一起没了）
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && busy(tabId)) showIndicator(tabId)
})

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return
  if (msg?.type === 'STOP' && sender.tab) {
    const tabId = sender.tab.id
    const stopped = stopCalls(tabId) // 只停这个标签上的调用
    clearTimeout(hideTimers.get(tabId))
    hideTimers.delete(tabId)
    hideIndicator(tabId) // 点 Stop 立即撤，不等空闲计时
    reply({ stopped })
  } else if (msg?.type === 'stopAll') {
    reply({ stopped: stopCalls() })
  } else if (msg?.type === 'getStatus') {
    listSessions().then((sessions) => reply({ sessions: sessions.map((s) => ({ ...s, running: [...calls].filter((c) => c.sessionId === s.id).length })) }))
    return true
  }
})
