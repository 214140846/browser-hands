// logs 单测专用替身：假 chrome（标签事件、tabs.get）+ 假调试器模块（按规格第 1 节签名）+ 假会话模块。
// 调试器与会话模块用 mock.module 替换，logs 可以先于它们实现。事件派发全部同步。

type Fn = (...a: any[]) => unknown

function channel() {
  const subs: Fn[] = []
  return {
    addListener: (f: Fn) => void subs.push(f),
    removeListener: (f: Fn) => void subs.splice(subs.indexOf(f) >>> 0, 1),
    fire: (...a: unknown[]) => subs.map((f) => f(...a)),
  }
}

export function makeLogsChrome() {
  const pages = new Map<number, { id: number; url?: string }>()
  const sent: { tab: number; cmd: string }[] = []
  const failing = new Set<string>() // 这些命令会失败
  const attachedTabs = new Set<number>()
  const held = new Set<number>()
  const eventSubs: Fn[] = []
  const attachSubs: Fn[] = []
  const closedHooks: Fn[] = []
  const tabUpdated = channel()
  const tabRemoved = channel()

  const api: any = {
    runtime: { id: 'fake-ext', lastError: undefined },
    tabs: {
      onUpdated: tabUpdated,
      onRemoved: tabRemoved,
      onCreated: channel(),
      get: async (id: number) => {
        const t = pages.get(id)
        if (!t) throw new Error(`fake: unknown tab ${id}`)
        return { ...t }
      },
    },
  }

  const debuggerModule = {
    send: async (tab: number, cmd: string, _params?: unknown, _ms?: number) => {
      attachedTabs.add(tab)
      sent.push({ tab, cmd })
      if (failing.has(cmd)) throw new Error(`fake failure in ${cmd}`)
      return {}
    },
    onDebuggerEvent: (h: Fn) => void eventSubs.push(h),
    onDebuggerAttached: (h: Fn) => void attachSubs.push(h),
    holdDebugger: (tab: number) => void held.add(tab),
    releaseDebugger: (tab: number) => void held.delete(tab),
    isAttached: (tab: number) => attachedTabs.has(tab),
  }

  const sessionsModule = {
    sessionClosedHooks: closedHooks,
    resolveTabId: (p: { tabId?: number }, s: { mainTabId: number }) => p.tabId ?? s.mainTabId,
  }

  return {
    api,
    debuggerModule,
    sessionsModule,
    sent,
    failing,
    held,
    addTab(id: number, url?: string) {
      pages.set(id, { id, url })
    },
    /** 标签跳到新地址（同步派发 tabs.onUpdated） */
    goTo(id: number, url: string) {
      pages.set(id, { id, url })
      tabUpdated.fire(id, { url }, { id, url })
    },
    update(id: number, info: object) {
      tabUpdated.fire(id, info, {})
    },
    closeTab(id: number) {
      pages.delete(id)
      tabRemoved.fire(id, {})
    },
    /** 同步派发一条 CDP 事件 */
    cdp(tab: number, method: string, params: unknown) {
      for (const h of eventSubs) h(tab, method, params)
    },
    /** 模拟调试器断开后又挂上 */
    reattach(tab: number) {
      attachedTabs.add(tab)
      for (const h of attachSubs) h(tab)
    },
    closeSession(tabIds: number[]) {
      for (const h of closedHooks) h(tabIds, 'sess-x')
    },
    cmdsFor: (tab: number) => sent.filter((s) => s.tab === tab).map((s) => s.cmd),
  }
}
