// navigate 工具：打开网址 / 后退 / 前进，按 force 处理离开确认框，等页面切换与加载后汇报。
import { attach, withDebugger, send, onDebuggerEvent } from './debugger.js'
import { checkAbort } from './abort.js'
import { redactUrl } from './redact.js'

const SWITCH_CAP_MS = 2000 // 页面切换兜底上限
const LOAD_CAP_MS = 30000 // 加载完成上限
const ERROR_SCHEME = 'chrome-error:'

// 每个标签当前进行中的导航「看板」：tabId → { force, acceptedOnce, settle(结局) }
const boards = new Map()

const fail = (code, message) => Object.assign(new Error(message), { code })

// 答复确认框，失败吞掉
const answer = (tabId, accept) => {
  send(tabId, 'Page.handleJavaScriptDialog', { accept }).catch(() => {})
}

// 全局 CDP 事件分发（导入即生效）
onDebuggerEvent((tabId, method, params) => {
  const board = boards.get(tabId)
  if (method === 'Page.javascriptDialogOpening') {
    if (params?.type !== 'beforeunload') return // 其他对话框不碰
    if (board && board.force && !board.acceptedOnce) {
      board.acceptedOnce = true
      answer(tabId, true)
      return
    }
    answer(tabId, false)
    board?.settle({ kind: 'blocked', pageUrl: params?.url ?? '' })
    return
  }
  if (!board) return
  if (method === 'Page.frameNavigated' && params?.frame && params.frame.parentId == null) board.settle({ kind: 'switched' })
  else if (method === 'Page.navigatedWithinDocument') board.settle({ kind: 'switched' })
})

// 调试器断开同样视为页面切换等待结束
chrome.debugger.onDetach.addListener((source) => {
  boards.get(source?.tabId)?.settle({ kind: 'switched' })
})

// 把参数翻译成动作：{ kind: 'back'|'forward'|'url', target? }
function planAction(raw) {
  if (raw === undefined || raw === null || raw === '') throw fail('invalid_params', 'url is required')
  if (typeof raw !== 'string') throw fail('invalid_params', 'url must be a string')
  const lower = raw.toLowerCase()
  if (lower === 'back' || lower === 'forward') return { kind: lower }
  const target = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    new URL(target)
  } catch {
    throw fail('invalid_params', 'url is not a valid address')
  }
  return { kind: 'url', target }
}

const fire = (tabId, plan) =>
  plan.kind === 'back' ? chrome.tabs.goBack(tabId)
    : plan.kind === 'forward' ? chrome.tabs.goForward(tabId)
      : chrome.tabs.update(tabId, { url: plan.target })

// 一次调用的完整过程（可能在 withDebugger 内运行）
async function run(tabId, plan, force, signal) {
  // 加载监听：动作前就挂上，确保同步事件也能接住
  let loaded = false
  let onLoaded = null
  const loadListener = (id, info) => {
    if (id === tabId && info?.status === 'complete') {
      loaded = true
      onLoaded?.()
    }
  }
  chrome.tabs.onUpdated.addListener(loadListener)

  // 页面切换看板：第一个结局生效
  let outcome = null
  let wake = null
  const board = {
    force,
    acceptedOnce: false,
    settle: (o) => {
      if (outcome) return
      outcome = o
      wake?.()
    },
  }
  boards.set(tabId, board)
  const leaveBoard = () => {
    if (boards.get(tabId) === board) boards.delete(tabId)
  }

  try {
    await fire(tabId, plan)

    // 第一段：页面切换等待（超时 / 停止 / 事件任一）
    if (!outcome) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => board.settle({ kind: 'timeout' }), SWITCH_CAP_MS)
        const onAbort = () => board.settle({ kind: 'stopped' })
        signal?.addEventListener('abort', onAbort)
        wake = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        if (signal?.aborted) onAbort()
      })
    }
    leaveBoard()
    if (outcome.kind === 'stopped') checkAbort(signal)
    if (outcome.kind === 'blocked') {
      throw fail('navigate_beforeunload_blocked',
        `Navigation blocked: the page ${redactUrl(outcome.pageUrl)} asked to stay (unsaved changes). Pass force to leave anyway.`)
    }

    // 第二段：加载等待
    if (!loaded) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, LOAD_CAP_MS)
        onLoaded = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    checkAbort(signal)

    // 结果判定
    const info = await chrome.tabs.get(tabId)
    const pending = info?.pendingUrl || ''
    const committed = info?.url || ''
    const landed = pending || committed
    if (landed.startsWith(ERROR_SCHEME)) {
      const shown = plan.kind === 'url' ? plan.target : landed
      throw fail('navigate_load_failed', `Failed to load ${redactUrl(shown)}`)
    }
    const shownUrl = plan.kind === 'url' ? plan.target : landed
    const head = plan.kind === 'url' ? 'Opened' : plan.kind === 'back' ? 'Went back' : 'Went forward'
    const parts = [shownUrl ? `${head} → ${redactUrl(shownUrl)}` : `${head} in history (address unknown)`]
    if (board.acceptedOnce) parts.push('[left page: unsaved changes discarded]')
    if (!loaded) parts.push('[still loading after 30s]')
    return { output: parts.join(' ') }
  } finally {
    leaveBoard()
    chrome.tabs.onUpdated.removeListener(loadListener)
  }
}

export async function navigate(tabId, params, signal) {
  const plan = planAction(params?.url)
  checkAbort(signal)
  const force = Boolean(params?.force)
  let attached = true
  try {
    await attach(tabId)
  } catch {
    attached = false
  }
  return attached ? withDebugger(tabId, () => run(tabId, plan, force, signal)) : run(tabId, plan, force, signal)
}
