// dispatch 单测专用替身：假 chrome + 14 个同目录依赖的替身模块。
// 只按 specs/dispatch.md 依赖表的签名模拟；每次调用记进 log，行为可由测试经 over 覆盖。
type Fn = (...a: any[]) => any

const hub = () => {
  const ls = new Set<Fn>()
  return {
    addListener: (f: Fn) => void ls.add(f),
    removeListener: (f: Fn) => void ls.delete(f),
    list: () => [...ls],
  }
}

export type Entry = { name: string; args: any[] }

export function makeFakes() {
  const log: Entry[] = []
  const over: Record<string, Fn> = {}
  const state = {
    store: new Map<string, unknown>(),
    windowSeq: 900,
    groupTabs: new Set<number>([100, 101, 102]),
    tabs: [] as any[],
    frames: [] as any[],
    newTabs: [] as number[],
    zoomKeys: new Set<string>(),
    imageSeq: 0,
    calls: [] as { sessionId: string; tabId: number | undefined; controller: AbortController; stop: () => void; doneCount: number }[],
    sessions: new Map<string, any>(),
    email: 'person@example.org' as string | undefined | Error,
    abortOnTrack: false,
  }

  // 统一出口：先记账，再走覆盖实现或默认实现
  const spy = (label: string, impl: Fn): Fn =>
    (...args: any[]) => {
      log.push({ name: label, args })
      return (over[label] ?? impl)(...args)
    }
  // 一组替身：记账标签 = 前缀.键（无前缀时就是键）
  const group = (prefix: string, impls: Record<string, Fn>) =>
    Object.fromEntries(Object.entries(impls).map(([k, impl]) => [k, spy(prefix ? `${prefix}.${k}` : k, impl)]))

  const halted = () => Object.assign(new Error('halted by user'), { code: 'stopped', fromFake: true })

  // ---------- chrome ----------
  const onRemoved = hub()
  const onMessage = hub()
  const chrome: any = {
    runtime: {
      id: 'self-ext',
      getURL: (p: string) => `chrome-extension://self-ext/${p}`,
      getManifest: () => ({ version: '3.2.1' }),
      onMessage,
      ...group('runtime', { getPlatformInfo: async () => ({ os: 'linux' }) }),
    },
    storage: {
      local: group('storage', {
        get: async (keys: string | string[]) => {
          const out: Record<string, unknown> = {}
          for (const k of [keys].flat()) if (state.store.has(k)) out[k] = state.store.get(k)
          return out
        },
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) state.store.set(k, v)
        },
      }),
    },
    identity: group('identity', {
      getProfileUserInfo: async () => {
        if (state.email instanceof Error) throw state.email
        return state.email === undefined ? {} : { email: state.email }
      },
    }),
    windows: {
      onRemoved,
      ...group('win', { create: async () => ({ id: ++state.windowSeq }), remove: async () => {} }),
    },
    tabs: group('tabs', {
      create: async (o: any) => ({ id: 777, windowId: o?.windowId }),
      remove: async () => {},
      reload: async () => {},
    }),
  }

  const nothing = async () => {}
  // 返回固定值的异步替身表 / 什么都不做的替身名单
  const fixed = (prefix: string, table: Record<string, unknown>) =>
    group(prefix, Object.fromEntries(Object.entries(table).map(([k, v]) => [k, async () => v])))
  const quiet = (prefix: string, names: string[]) => group(prefix, Object.fromEntries(names.map((k) => [k, nothing])))

  // ---------- 依赖模块（只含依赖表里的导出） ----------
  const redactModule = group('', {
    redactUrl: (u: string) => `<u:${u}>`,
    redactTitle: (t: string, u: string) => `<t:${t}|${u}>`,
  })

  const backgroundTabModule = {
    ...quiet('', ['wakeHidden', 'abortClickInterception']),
    ...group('', {
      withBackground: async (_tabId: number, fn: Fn) => fn(),
      beginClickInterception: async (tabId: number) => ({ armedOn: tabId }),
      finishClickInterception: async () => state.newTabs,
      newTabNote: (ids: number[]) => (ids.length ? ` ~NOTE[${ids.join('/')}]~` : ''),
    }),
  }

  const guardModule = group('', {
    startGuard: async (tabId: number) => ({ tabId, check: spy('guard.check', nothing) }),
  })

  const inputModule = {
    ...quiet('input', ['hover', 'type', 'key', 'wheel', 'drag']),
    ...group('input', {
      click: async (...a: any[]) => {
        await a[6]?.()
      },
      modifierMask: (_names: string) => 9,
      isZoomChord: (k: string) => state.zoomKeys.has(k),
    }),
  }

  const framesModule = {
    ...fixed('', { inPage: {}, callOnRef: { output: 'filled' }, locateRef: [40.4, 50.6] }),
    ...group('', {
      parseRef: (ref: string) => {
        const m = /^f(\d+):(.+)$/.exec(ref)
        return m ? { frameId: Number(m[1]), ref: m[2] } : { frameId: 0, ref }
      },
      prefixRefs: (text: string, frameId: number) => (frameId ? text.split('[ref_').join(`[f${frameId}:ref_`) : text),
      scanAll: async () => state.frames,
    }),
  }

  const navigateModule = fixed('', { navigate: { output: 'went' } })
  const observeModule = fixed('', { observe: { observed: true } })

  const abortModule = group('', {
    stoppedError: halted,
    checkAbort: (signal?: AbortSignal) => {
      if (signal?.aborted) throw halted()
    },
    abortableSleep: async (_ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw halted()
    },
  })

  const screenshotModule = group('', {
    beginBatch: () => {},
    endBatch: () => {},
    cacheImage: () => `pic_${++state.imageSeq}`,
    screenshot: async () => ({ base64: 'SHOTB64', format: 'jpeg', width: 640, height: 480, frameWidth: 1280, frameHeight: 960 }),
    zoom: async () => ({ base64: 'ZOOMB64', format: 'png', width: 321, height: 123 }),
    toViewport: (_t: number, c: number[], _action: string) => [c[0] * 2, c[1] * 2],
  })

  const logsModule = fixed('', { readConsole: { from: 'console' }, readNetwork: { from: 'network' } })

  const pageToolsModule = fixed('', {
    javascriptTool: { from: 'js' },
    resizeWindow: { from: 'resize' },
    uploadStash: {},
    fileUpload: { from: 'file' },
    uploadImage: { from: 'image' },
  })

  const indicatorModule = group('', {
    pointIndicator: nothing,
    trackCall: (sessionId: string, tabId: number | undefined) => {
      const controller = new AbortController()
      let reject!: Fn
      const stopped = new Promise((_, rej) => (reject = rej))
      stopped.catch(() => {})
      const entry = {
        sessionId,
        tabId,
        controller,
        doneCount: 0,
        stop: () => {
          controller.abort()
          reject(halted())
        },
      }
      state.calls.push(entry)
      if (state.abortOnTrack) controller.abort()
      return {
        stopped,
        signal: controller.signal,
        done: () => {
          entry.doneCount++
          log.push({ name: 'call.done', args: [sessionId, tabId] })
        },
      }
    },
  })

  const gifModule = { ...fixed('', { gifCreator: { output: 'gif done' } }), ...quiet('', ['recordAction']) }

  const sessionOf = (sid: string) => {
    let s = state.sessions.get(sid)
    if (!s) state.sessions.set(sid, (s = { name: `name-${sid}`, groupId: 31, mainTabId: 100, windowId: 8 }))
    return s
  }
  const sessionsModule = group('', {
    beginCall: async (sid: string) => sessionOf(sid),
    endCall: () => {},
    listTabs: async () => state.tabs,
    joinGroup: nothing,
    admit: async (_s: any, tabId: number) => {
      if (!state.groupTabs.has(tabId)) throw Object.assign(new Error('outside'), { code: 'tab_outside_group' })
    },
    resolveTabId: (p: any, s: any) => p.tabId ?? s.mainTabId,
    closeSession: async (sid: string) => ({ closedFake: sid }),
  })

  const reset = () => {
    log.length = 0
    for (const k of Object.keys(over)) delete over[k]
    state.store.clear()
    state.windowSeq = 900
    state.imageSeq = 0
    state.groupTabs = new Set([100, 101, 102])
    state.tabs = []
    state.frames = []
    state.newTabs = []
    state.zoomKeys = new Set()
    state.calls = []
    state.sessions.clear()
    state.email = 'person@example.org'
    state.abortOnTrack = false
  }

  const named = (name: string) => log.filter((e) => e.name === name)

  return {
    chrome,
    log,
    over,
    state,
    reset,
    named,
    listeners: { onRemoved, onMessage },
    modules: {
      'redact.js': redactModule,
      'background-tab.js': backgroundTabModule,
      'guard.js': guardModule,
      'input.js': inputModule,
      'frames.js': framesModule,
      'navigate.js': navigateModule,
      'observe.js': observeModule,
      'abort.js': abortModule,
      'screenshot.js': screenshotModule,
      'logs.js': logsModule,
      'page-tools.js': pageToolsModule,
      'indicator.js': indicatorModule,
      'gif-recorder.js': gifModule,
      'sessions.js': sessionsModule,
    } as Record<string, Record<string, any>>,
  }
}
