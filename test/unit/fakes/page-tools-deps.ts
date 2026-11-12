// page-tools 单测专用替身：假 chrome（tabs.get / windows.update）+ 四个同目录依赖的替身模块。
// 只按 specs/page-tools.md 依赖表的签名模拟；不是共享 fake。
type Fn = (...a: any[]) => any
// 坐标替身：视口坐标 = 截图坐标 × 2，便于断言换算结果被用上了
const doubled = (_tab: number, pt: [number, number]) => pt.map((n) => n * 2) as [number, number]

type PageReply = { output?: unknown; error?: string; errorCode?: string }

export function makeFakes() {
  const state = {
    // chrome
    tabs: new Map<number, { url?: string; windowId?: number }>(),
    tabGets: [] as number[],
    windowUpdates: [] as { windowId: number; props: any }[],
    // debugger
    insideDebugger: false,
    withDebuggerCalls: [] as number[],
    withDebuggerError: undefined as any,
    evals: [] as { tabId: number; method: string; params: any; ms?: number; inside: boolean }[],
    // 依次回给每次 send 的 CDP 响应；函数形式可按参数决定；Error 则 reject
    replies: [] as any[],
    // frames
    pageCalls: [] as { via: 'ref' | 'page'; tabId: number; target: string; op: string; args: any[]; frameId?: number }[],
    pageReplies: [] as PageReply[],
    located: [0, 0] as [number, number],
    locateCalls: [] as { tabId: number; ref: string }[],
    // screenshot
    images: new Map<string, { base64: string; format: string }>(),
    imageLookups: [] as { session: string; id: string }[],
    viewportCalls: [] as { tabId: number; point: any; action: string }[],
    toViewportImpl: doubled as Fn,
    // sessions
    resolveCalls: [] as { params: any; s: any }[],
    // guard
    guardKinds: [] as string[],
  }

  const chrome: any = {
    tabs: {
      get: async (tabId: number) => {
        state.tabGets.push(tabId)
        const t = state.tabs.get(tabId)
        if (!t) throw new Error(`fake: no tab ${tabId}`)
        return { id: tabId, ...t }
      },
    },
    windows: {
      update: async (windowId: number, props: any) => {
        state.windowUpdates.push({ windowId, props })
        return { id: windowId, ...props }
      },
    },
  }

  const debuggerModule = {
    withDebugger: async (tabId: number, fn: () => any) => {
      state.withDebuggerCalls.push(tabId)
      if (state.withDebuggerError) throw state.withDebuggerError
      state.insideDebugger = true
      try {
        return await fn()
      } finally {
        state.insideDebugger = false
      }
    },
    send: async (tabId: number, method: string, params?: any, ms?: number) => {
      state.evals.push({ tabId, method, params, ms, inside: state.insideDebugger })
      let r = state.replies.shift() ?? { result: { type: 'undefined' } }
      if (typeof r === 'function') r = r(params)
      if (r instanceof Error) throw r
      return r
    },
  }

  const nextPage = (): PageReply => state.pageReplies.shift() ?? { output: 'fake page ok' }
  const framesModule = {
    callOnRef: async (tabId: number, ref: string, op: string, args: any[] = []) => {
      state.pageCalls.push({ via: 'ref', tabId, target: ref, op, args })
      return nextPage()
    },
    inPage: async (tabId: number, op: string, args: any[], frameId?: number) => {
      state.pageCalls.push({ via: 'page', tabId, target: '', op, args, frameId })
      return nextPage()
    },
    locateRef: async (tabId: number, ref: string) => {
      state.locateCalls.push({ tabId, ref })
      return state.located
    },
  }

  const screenshotModule = {
    getImage: (session: string, id: string) => {
      state.imageLookups.push({ session, id })
      return state.images.get(`${session}|${id}`)
    },
    toViewport: (tabId: number, point: any, action: string) => {
      state.viewportCalls.push({ tabId, point, action })
      return state.toViewportImpl(tabId, point, action)
    },
  }

  const sessionsModule = {
    resolveTabId: (params: any, s: any) => {
      state.resolveCalls.push({ params, s })
      return params.tabId ?? s?.mainTabId
    },
  }

  // 守卫：记录 check 的 kind；deny 时 reject 一个固定对象
  const denial = Object.assign(new Error('guard said no (fake)'), { code: 'navigated_away' })
  const guard = (deny = false) => ({
    check: async (kind: string) => {
      state.guardKinds.push(kind)
      if (deny) throw denial
    },
  })

  const reset = () => {
    state.tabs.clear()
    state.tabGets.length = 0
    state.windowUpdates.length = 0
    state.withDebuggerCalls.length = 0
    state.withDebuggerError = undefined
    state.evals.length = 0
    state.replies.length = 0
    state.pageCalls.length = 0
    state.pageReplies.length = 0
    state.located = [0, 0]
    state.locateCalls.length = 0
    state.images.clear()
    state.imageLookups.length = 0
    state.viewportCalls.length = 0
    state.toViewportImpl = doubled
    state.resolveCalls.length = 0
    state.guardKinds.length = 0
  }

  return { state, chrome, debuggerModule, framesModule, screenshotModule, sessionsModule, guard, denial, reset }
}
