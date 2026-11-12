// navigate 单测专用替身：假 chrome（标签 / 调试器事件）+ 三个同目录依赖的替身模块。
// 不是共享 fake，只按 specs/navigate.md 依赖表的签名模拟。
type Fn = (...a: any[]) => any

const hub = () => {
  const ls = new Set<Fn>()
  return {
    addListener: (f: Fn) => void ls.add(f),
    removeListener: (f: Fn) => void ls.delete(f),
    hasListener: (f: Fn) => ls.has(f),
    fire: (...a: any[]) => [...ls].forEach((f) => f(...a)),
    get count() {
      return ls.size
    },
  }
}

export function makeFakes() {
  const state = {
    attachFails: false,
    withDebuggerCalls: [] as number[],
    sent: [] as { tabId: number; method: string; params: any }[],
    sendFails: false,
    tabActs: [] as { tabId: number; kind: string; url?: string }[],
    // 导航动作被调用时执行的剧本（模拟浏览器在动作期间同步 / 异步发出的事件）
    onAct: undefined as undefined | ((tabId: number, kind: string) => void | Promise<void>),
    actError: undefined as any,
    tabInfo: new Map<number, { url?: string; pendingUrl?: string }>(),
  }
  const handlers: Fn[] = []
  const onUpdated = hub()
  const onDetach = hub()

  const act = async (tabId: number, kind: string, url?: string) => {
    state.tabActs.push({ tabId, kind, url })
    if (state.actError) throw state.actError
    await state.onAct?.(tabId, kind)
  }

  const chrome: any = {
    runtime: { id: 'fakeextid', lastError: undefined },
    tabs: {
      onUpdated,
      goBack: (tabId: number) => act(tabId, 'back'),
      goForward: (tabId: number) => act(tabId, 'forward'),
      update: (tabId: number, props: { url: string }) => act(tabId, 'url', props.url),
      get: async (tabId: number) => ({ id: tabId, ...(state.tabInfo.get(tabId) ?? {}) }),
    },
    debugger: { onDetach, onEvent: hub() },
  }

  const debuggerModule = {
    attach: async (_tabId: number) => {
      if (state.attachFails) throw Object.assign(new Error('cannot attach'), { code: 'debugger_attach_failed' })
    },
    withDebugger: async (tabId: number, fn: () => any) => {
      state.withDebuggerCalls.push(tabId)
      return fn()
    },
    send: async (tabId: number, method: string, params?: any) => {
      state.sent.push({ tabId, method, params })
      if (state.sendFails) throw new Error('command failed')
      return {}
    },
    onDebuggerEvent: (h: Fn) => void handlers.push(h),
    detach: async () => {},
    holdDebugger: () => {},
    releaseDebugger: () => {},
    isAttached: () => true,
    onDebuggerAttached: () => {},
  }

  const abortModule = {
    stoppedError: () => Object.assign(new Error('call halted (fake)'), { code: 'stopped' }),
    checkAbort: (signal?: AbortSignal) => {
      if (signal?.aborted) throw abortModule.stoppedError()
    },
    abortableSleep: async () => {},
  }

  // 脱敏替身：给地址套一层可辨认的外壳，测试据此确认输出 / 报错里的地址经过了脱敏
  const masked = (u: string) => `[masked:${u}]`
  const redactModule = {
    redactUrl: (u: string) => masked(u),
    redactTitle: (t: string) => t,
    escapeJson: (t: string) => t,
    sanitizeText: (t: string) => t,
  }

  // 调试协议事件
  const emit = (tabId: number, method: string, params: any = {}) => handlers.forEach((h) => h(tabId, method, params))
  const UNLOAD = 'beforeunload'
  const cdp = {
    leaveDialog: (tabId: number, pageUrl: string) => emit(tabId, 'Page.javascriptDialogOpening', { type: UNLOAD, url: pageUrl, message: '' }),
    otherDialog: (tabId: number, type: string) => emit(tabId, 'Page.javascriptDialogOpening', { type, url: 'https://x.test/', message: 'hi' }),
    mainFrameCommitted: (tabId: number) => emit(tabId, 'Page.frameNavigated', { frame: { id: 'main', url: 'https://next.test/' } }),
    subFrameCommitted: (tabId: number) => emit(tabId, 'Page.frameNavigated', { frame: { id: 'child', parentId: 'main', url: 'https://ad.test/' } }),
    sameDocument: (tabId: number) => emit(tabId, 'Page.navigatedWithinDocument', { frameId: 'main', url: 'https://same.test/#b' }),
    debuggerGone: (tabId: number) => onDetach.fire({ tabId }, 'target_closed'),
    loadComplete: (tabId: number) => onUpdated.fire(tabId, { status: 'complete' }, { id: tabId }),
    loading: (tabId: number) => onUpdated.fire(tabId, { status: 'loading' }, { id: tabId }),
  }
  const answers = () => state.sent.filter((s) => s.method === 'Page.handleJavaScriptDialog')

  return { state, chrome, debuggerModule, abortModule, redactModule, masked, cdp, answers, onUpdated }
}
