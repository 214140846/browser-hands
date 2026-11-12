// background-tab 单测专用替身：假 chrome（标签 / 窗口 / 静音 / 注入 / 建标签 / 分组）+ 两个同目录依赖的替身模块。
// 不是共享 fake，只按 specs/background-tab.md 依赖表的签名模拟。
// 注入：标签绑了 Playwright 页面时，把注入函数序列化后在页面里真跑；否则按剧本返回。
import type { Page } from 'playwright'

type Fn = (...a: any[]) => any
export const NO_GROUP = -1
export const EXT_ID = 'fake-ext-id'

export interface FakeTab {
  id: number
  windowId?: number
  index: number
  groupId?: number
  active: boolean
  audible?: boolean
  mutedInfo?: { muted: boolean; reason?: string; extensionId?: string }
}

const deferred = () => {
  let resolve!: () => void
  const p = new Promise<void>((r) => (resolve = r))
  return { p, resolve }
}

export function makeFakes() {
  const state = {
    tabs: new Map<number, FakeTab>(),
    windows: new Map<number, { focused: boolean; state: string }>(),
    // 每条 CDP 命令：调用时刻的记录 + 可编排的延迟 / 失败
    sent: [] as { tabId: number; method: string; params: any; at: number }[],
    sendGate: undefined as undefined | ((method: string, params: any) => Promise<void> | void),
    sendFails: (_m: string, _p: any) => false,
    calls: [] as string[], // 有序事件流：send / mute / unmute / fn 等，用来断言「何时」
    muteUpdates: [] as { tabId: number; muted: boolean }[],
    updateFails: false,
    scripts: [] as { tabId: number; target: any; injectImmediately?: boolean; func: Fn; args?: any[] }[],
    scriptFails: false,
    scriptResult: (_call: any): any[] => [{ result: undefined }],
    pages: new Map<number, Page>(),
    created: [] as any[],
    createImpl: undefined as undefined | ((props: any, n: number) => any),
    nextTabId: 9000,
    grouped: [] as any[],
    groupFails: false,
    joined: [] as { session: any; tabId: number }[],
    joinFails: false,
    withDebuggerCalls: [] as number[],
    insideDebugger: 0,
    chromeCalls: 0,
  }

  const now = () => performance.now()
  const count = () => void state.chromeCalls++

  const chrome: any = {
    runtime: { id: EXT_ID },
    tabGroups: { TAB_GROUP_ID_NONE: NO_GROUP },
    tabs: {
      get: async (tabId: number) => {
        count()
        const t = state.tabs.get(tabId)
        if (!t) throw new Error(`No tab with id: ${tabId}.`)
        return structuredClone(t)
      },
      update: async (tabId: number, props: { muted?: boolean }) => {
        count()
        if (state.updateFails) throw new Error('update failed')
        const t = state.tabs.get(tabId)
        if (!t) throw new Error(`No tab with id: ${tabId}.`)
        if (props.muted !== undefined) {
          state.muteUpdates.push({ tabId, muted: props.muted })
          state.calls.push(props.muted ? 'mute' : 'unmute')
          t.mutedInfo = props.muted ? { muted: true, reason: 'extension', extensionId: EXT_ID } : { muted: false }
        }
        return structuredClone(t)
      },
      create: async (props: any) => {
        count()
        state.created.push(props)
        if (state.createImpl) return state.createImpl(props, state.created.length)
        return { id: ++state.nextTabId, windowId: props.windowId ?? 1, index: props.index ?? 0 }
      },
      group: async (opts: any) => {
        count()
        state.grouped.push(opts)
        if (state.groupFails) throw new Error('group failed')
        return opts.groupId
      },
    },
    windows: {
      get: async (windowId: number) => {
        count()
        const w = state.windows.get(windowId)
        if (!w) throw new Error(`No window with id: ${windowId}.`)
        return { id: windowId, ...w }
      },
    },
    scripting: {
      executeScript: async (opts: any) => {
        count()
        const tabId = opts?.target?.tabId
        const call = { tabId, target: opts?.target, injectImmediately: opts?.injectImmediately, func: opts?.func, args: opts?.args }
        state.scripts.push(call)
        if (state.scriptFails) throw new Error('Cannot access contents of the page.')
        const page = state.pages.get(tabId)
        if (page) {
          // 与 Chrome 一样：函数被序列化后在页面里执行，引用模块作用域会失败
          const src = `(${String(opts.func)})(...${JSON.stringify(opts.args ?? [])})`
          return [{ frameId: 0, result: await page.evaluate(src) }]
        }
        return state.scriptResult(call)
      },
    },
  }

  const debuggerModule = {
    send: async (tabId: number, method: string, params?: any) => {
      state.sent.push({ tabId, method, params, at: now() })
      state.calls.push(`send:${method}:${JSON.stringify(params?.enabled ?? null)}`)
      await state.sendGate?.(method, params)
      if (state.sendFails(method, params)) throw new Error('command failed')
      return {}
    },
    withDebugger: async (tabId: number, fn: () => any) => {
      state.withDebuggerCalls.push(tabId)
      state.insideDebugger++
      try {
        return await fn()
      } finally {
        state.insideDebugger--
      }
    },
    attach: async () => {},
    detach: async () => {},
    holdDebugger: () => {},
    releaseDebugger: () => {},
    isAttached: () => true,
    onDebuggerEvent: () => {},
    onDebuggerAttached: () => {},
  }

  const sessionsModule = {
    joinGroup: async (session: any, tabId: number) => {
      state.joined.push({ session, tabId })
      if (state.joinFails) throw new Error('join failed')
    },
    sessionClosedHooks: [] as Fn[],
    beginCall: async () => ({}),
    endCall: () => {},
    listTabs: async () => [],
    admit: async () => {},
    resolveTabId: (p: any, s: any) => p?.tabId ?? s?.mainTabId,
    closeSession: async () => ({}),
    listSessions: async () => [],
  }

  const reset = () => {
    state.sent.length = 0
    state.sendGate = undefined
    state.sendFails = () => false
    state.calls.length = 0
    state.muteUpdates.length = 0
    state.updateFails = false
    state.scripts.length = 0
    state.scriptFails = false
    state.scriptResult = () => [{ result: undefined }]
    state.pages.clear()
    state.created.length = 0
    state.createImpl = undefined
    state.grouped.length = 0
    state.groupFails = false
    state.joined.length = 0
    state.joinFails = false
    state.withDebuggerCalls.length = 0
  }

  let nextId = 100
  // 建一个标签 + 它所在的窗口；默认是后台（非活动标签）
  const addTab = (o: Partial<FakeTab> & { focused?: boolean; winState?: string } = {}) => {
    const id = ++nextId
    const windowId = 'windowId' in o ? o.windowId : id + 50000
    const { focused = true, winState = 'normal', ...rest } = o
    if (windowId !== undefined && !state.windows.has(windowId)) state.windows.set(windowId, { focused, state: winState })
    const t: FakeTab = { id, windowId, index: 4, groupId: NO_GROUP, active: false, audible: false, mutedInfo: { muted: false }, ...rest }
    state.tabs.set(id, t)
    return t
  }

  return { chrome, state, debuggerModule, sessionsModule, reset, addTab, deferred }
}
