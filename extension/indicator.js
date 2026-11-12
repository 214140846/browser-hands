// 指示器的后台一侧 + 调用取消。
// 状态变化才发消息：第一个调用开始 → 画；空闲 HIDE_DELAY_MS 后 → 撤；页面导航完成 → 重画。没有心跳、没有轮询。
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
export const pointIndicator = (tabId, x, y) => quietly(inPage(tabId, 'moveCursor', [x, y]))

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
    reply({ stopped: stopCalls(sender.tab.id) }) // 只停这个标签上的调用
  } else if (msg?.type === 'stopAll') {
    reply({ stopped: stopCalls() })
  } else if (msg?.type === 'getStatus') {
    listSessions().then((sessions) => reply({ sessions: sessions.map((s) => ({ ...s, running: [...calls].filter((c) => c.sessionId === s.id).length })) }))
    return true
  }
})
