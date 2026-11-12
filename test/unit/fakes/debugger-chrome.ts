// debugger 单测专用替身：假 chrome（调试器 / 标签 / 注入脚本）+ 可手动推进的假时钟 + 假会话模块。
// 只给 debugger 单测用，不是共享 fake。chrome 回调一律异步执行，lastError 只在回调期间有值。

type Fn = (...a: any[]) => any
export type Outcome = 'ok' | 'hang' | { error: string } | { result: any }

function channel() {
  const subs: Fn[] = []
  return { addListener: (f: Fn) => void subs.push(f), fire: (...a: unknown[]) => subs.forEach((f) => f(...a)), subs }
}

// ---------- 假时钟：顶替全局 setTimeout / clearTimeout / Date.now ----------
export function installClock() {
  const realNow = Date.now
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  let now = 1_000_000
  let seq = 0
  const timers = new Map<number, { due: number; fn: Fn; args: unknown[] }>()
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  }
  ;(globalThis as any).setTimeout = (fn: Fn, ms = 0, ...args: unknown[]) => {
    const id = ++seq
    timers.set(id, { due: now + Math.max(0, Number(ms) || 0), fn, args })
    return id
  }
  ;(globalThis as any).clearTimeout = (id: number) => void timers.delete(id)
  Date.now = () => now
  return {
    flush,
    pending: () => timers.size,
    /** 推进 ms 毫秒，按到期先后触发计时器，每触发一个都先排空微任务 */
    async advance(ms: number) {
      const end = now + ms
      await flush()
      for (;;) {
        let pick: number | undefined
        for (const [id, t] of timers) if (t.due <= end && (pick === undefined || t.due < timers.get(pick)!.due)) pick = id
        if (pick === undefined) break
        const t = timers.get(pick)!
        timers.delete(pick)
        now = Math.max(now, t.due)
        t.fn(...t.args)
        await flush()
      }
      now = end
      await flush()
    },
    restore() {
      Date.now = realNow
      ;(globalThis as any).setTimeout = realSet
      ;(globalThis as any).clearTimeout = realClear
    },
  }
}

// ---------- 假 chrome ----------
export function makeDebuggerChrome() {
  const pages = new Map<number, string | undefined>()
  const attachCalls: { tabId: number; version: string }[] = []
  const detachCalls: number[] = []
  const commands: { tabId: number; method: string; params: unknown }[] = []
  const scriptCalls: any[] = []
  const attachPlan = new Map<number, Outcome[]>() // 每个标签接下来几次 attach 的结果，用完后默认成功
  const commandPlan = new Map<string, Outcome[]>() // `${tabId}|${method}` 的接下来几次结果，用完后默认 {}
  let scriptResult: (() => any) | undefined
  const onEvent = channel()
  const onDetach = channel()
  const tabRemoved = channel()

  const runtime: any = { id: 'ownextid', lastError: undefined }
  const respond = (o: Outcome, cb: Fn) => {
    if (o === 'hang') return
    queueMicrotask(() => {
      if (typeof o === 'object' && 'error' in o) {
        runtime.lastError = { message: o.error }
        try {
          cb()
        } finally {
          runtime.lastError = undefined
        }
      } else cb(o === 'ok' ? undefined : o.result)
    })
  }

  const api: any = {
    runtime,
    tabs: {
      get: async (id: number) => {
        if (!pages.has(id)) throw new Error(`No tab with id: ${id}.`)
        return { id, url: pages.get(id) }
      },
      onRemoved: tabRemoved,
    },
    debugger: {
      attach: (target: { tabId: number }, version: string, cb: Fn) => {
        attachCalls.push({ tabId: target.tabId, version })
        respond(attachPlan.get(target.tabId)?.shift() ?? 'ok', cb)
      },
      detach: (target: { tabId: number }, cb: Fn) => {
        detachCalls.push(target.tabId)
        respond({ error: 'Debugger is not attached to the tab with id: ' + target.tabId + '.' }, cb)
      },
      sendCommand: (target: { tabId: number }, method: string, params: unknown, cb: Fn) => {
        commands.push({ tabId: target.tabId, method, params })
        respond(commandPlan.get(`${target.tabId}|${method}`)?.shift() ?? { result: {} }, cb)
      },
      onEvent,
      onDetach,
    },
    scripting: {
      executeScript: async (opts: any) => {
        scriptCalls.push(opts)
        if (!scriptResult) return [{ result: 0 }]
        return scriptResult()
      },
    },
  }

  const sessionClosedHooks: Fn[] = []

  return {
    api,
    // bun 的 mock.module 在同进程跨测试文件生效；补上会话模块的另一个导出，免得别的单测导入时缺名
    sessionsModule: { sessionClosedHooks, resolveTabId: (p: { tabId?: number }, s: { mainTabId: number }) => p.tabId ?? s.mainTabId },
    attachCalls,
    detachCalls,
    commands,
    scriptCalls,
    addTab: (id: number, url: string | undefined = 'https://example.com/') => void pages.set(id, url),
    planAttach: (id: number, ...o: Outcome[]) => void attachPlan.set(id, o),
    planCommand: (id: number, method: string, ...o: Outcome[]) => void commandPlan.set(`${id}|${method}`, o),
    setScriptResult: (f: (() => any) | undefined) => void (scriptResult = f),
    attachesFor: (id: number) => attachCalls.filter((c) => c.tabId === id).length,
    cmdsFor: (id: number) => commands.filter((c) => c.tabId === id).map((c) => c.method),
    fireEvent: (source: object, method: string, params: unknown) => onEvent.fire(source, method, params),
    fireDetach: (id: number) => onDetach.fire({ tabId: id }, 'target_closed'),
    closeTab: (id: number) => {
      pages.delete(id)
      tabRemoved.fire(id, {})
    },
    closeSession: (ids: number[]) => Promise.all(sessionClosedHooks.map((h) => h(ids, 'sess-x'))),
  }
}
