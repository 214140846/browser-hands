// gif-recorder 单测专用替身：四个同目录依赖模块 + 假 chrome（offscreen / runtime 消息 / downloads / scripting）+ 拖放用的最小页面环境。
// 不是共享 fake，只按 specs/gif-recorder.md 依赖表的签名模拟。
type Fn = (...a: any[]) => any
type Ctx = { viewportWidth: number; viewportHeight: number; screenshotWidth: number; screenshotHeight: number }

const realSetTimeout = globalThis.setTimeout

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

const outOfBounds = () => Object.assign(new Error('point outside (fake)'), { code: 'coordinate_out_of_bounds' })

// 一个很小的合法 GIF（1x1），用来核对拖放时文件内容 = 解码后的字节
export const GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
export const GIF_W = 1234
export const GIF_H = 777

export function makeFakes() {
  const state = {
    // ---- 截图模块 ----
    ctx: new Map<number, Ctx>(),
    ctxHidden: false, // 模拟读不到上下文
    bgFails: false,
    shotSeq: 0,
    shotFails: false,
    shotCalls: [] as { tabId: number; scale: any; inBackground: boolean; woken: boolean }[],
    // 截图后设的上下文（模拟真实 screenshot 会改上下文）
    shotCtx: { viewportWidth: 1111, viewportHeight: 555, screenshotWidth: 1500, screenshotHeight: 750 } as Ctx,
    shotSize: { width: 1500, height: 750 },
    toViewportCalls: [] as { tabId: number; point: any }[],
    // ---- 后台标签 ----
    bgDepth: 0,
    woken: new Set<number>(),
    bgCalls: [] as number[],
    // ---- 调试器 ----
    sent: [] as { tabId: number; method: string; params: any }[],
    sendFails: false,
    // ---- chrome ----
    log: [] as string[],
    created: [] as any[],
    closeFails: false,
    messages: [] as any[],
    compose: 'ok' as 'ok' | 'fail' | 'failNoText' | 'lastError' | 'silent',
    composeError: 'compose-broke-xyz',
    lastErrorText: 'port-closed-xyz',
    releaseRejects: false,
    download: 'event' as 'event' | 'already' | 'interrupted' | 'hang' | 'reject',
    downloadError: new Error('download api refused (fake)'),
    downloads: [] as any[],
    searchEmpty: false,
    inject: 'run' as 'run' | 'reject',
    injectError: new Error('cannot inject (fake)'),
    injections: [] as any[],
    dropTarget: null as any,
    pointQueries: [] as [number, number][],
  }

  // ---------- 依赖模块替身 ----------
  const screenshotModule = {
    getContext: (tabId: number) => (state.ctxHidden ? undefined : state.ctx.get(tabId)),
    setContext: (tabId: number, c: Ctx) => void state.ctx.set(tabId, c),
    toViewport: (tabId: number, point: [number, number], _label: string): [number, number] => {
      state.toViewportCalls.push({ tabId, point })
      const [x, y] = point
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw outOfBounds()
      const c = state.ctx.get(tabId)
      if (!c) return [x, y]
      if (x >= c.screenshotWidth + 2 || y >= c.screenshotHeight + 2) throw outOfBounds()
      return [Math.round((x * c.viewportWidth) / c.screenshotWidth), Math.round((y * c.viewportHeight) / c.screenshotHeight)]
    },
    screenshot: async (tabId: number, scale?: number) => {
      state.shotCalls.push({ tabId, scale, inBackground: state.bgDepth > 0, woken: state.woken.has(tabId) })
      await Promise.resolve()
      if (state.shotFails) throw new Error('capture failed (fake)')
      state.ctx.set(tabId, { ...state.shotCtx })
      const n = ++state.shotSeq
      return { base64: `shot-${n}`, format: 'jpeg', width: state.shotSize.width, height: state.shotSize.height, frameWidth: state.shotSize.width, frameHeight: state.shotSize.height }
    },
  }

  const backgroundTabModule = {
    withBackground: async (tabId: number, fn: () => any) => {
      state.bgCalls.push(tabId)
      if (state.bgFails) throw new Error('bg failed (fake)')
      state.bgDepth++
      state.woken.delete(tabId)
      try {
        return await fn()
      } finally {
        state.bgDepth--
        state.woken.delete(tabId)
      }
    },
    wakeHidden: async (tabId: number) => {
      await Promise.resolve()
      if (state.bgDepth > 0) state.woken.add(tabId)
    },
  }

  const debuggerModule = {
    send: async (tabId: number, method: string, params?: any) => {
      state.sent.push({ tabId, method, params })
      if (state.sendFails) throw new Error('command failed (fake)')
      return { result: {} }
    },
  }

  const sessionClosedHooks: ((tabIds: number[], name: string) => unknown)[] = []
  const sessionsModule = { sessionClosedHooks }

  // ---------- 假 chrome ----------
  const onChanged = hub()
  let nextDl = 1
  const dlState = new Map<number, string>()
  const dlName = new Map<number, string>()

  const composeReply = () => {
    if (state.compose === 'fail') return { success: false, error: state.composeError }
    if (state.compose === 'failNoText') return { success: false }
    return { success: true, result: { base64: GIF_B64, blobUrl: 'blob:fake/gif-1', size: 4321, width: GIF_W, height: GIF_H } }
  }

  const runtime: any = {
    id: 'fakeextid',
    lastError: undefined,
    getContexts: async () => [], // 实现可能先查合成页是否已存在
    sendMessage(msg: any, cb?: Fn) {
      state.messages.push(msg)
      // 合成请求：带帧数组；回收通知：带 blob 地址
      if (Array.isArray(msg?.frames)) {
        state.log.push('compose')
        if (state.compose === 'silent') return cb ? undefined : new Promise(() => {})
        const transportFails = state.compose === 'lastError'
        const reply = transportFails ? undefined : composeReply()
        if (cb) {
          realSetTimeout(() => {
            runtime.lastError = transportFails ? { message: state.lastErrorText } : undefined
            try {
              cb(reply)
            } finally {
              runtime.lastError = undefined
            }
          }, 1)
          return undefined
        }
        return new Promise((res, rej) => realSetTimeout(() => (transportFails ? rej(new Error(state.lastErrorText)) : res(reply)), 1))
      }
      if (typeof msg?.blobUrl === 'string') {
        state.log.push('release')
        if (cb) {
          realSetTimeout(() => cb(undefined), 1)
          return undefined
        }
        return state.releaseRejects ? Promise.reject(new Error('no receiver (fake)')) : Promise.resolve(undefined)
      }
      return cb ? undefined : Promise.resolve(undefined)
    },
  }

  const chrome: any = {
    runtime,
    offscreen: {
      hasDocument: async () => false,
      createDocument: async (opts: any) => {
        state.created.push(opts)
        state.log.push('create')
      },
      closeDocument: async () => {
        state.log.push('close')
        if (state.closeFails) throw new Error('no document (fake)')
      },
    },
    downloads: {
      onChanged,
      download: async (opts: any) => {
        state.downloads.push(opts)
        state.log.push('download')
        if (state.download === 'reject') throw state.downloadError
        const id = nextDl++
        dlName.set(id, opts.filename)
        if (state.download === 'already') {
          dlState.set(id, 'complete')
          state.log.push('complete')
        } else {
          dlState.set(id, 'in_progress')
          if (state.download === 'event' || state.download === 'interrupted') {
            const end = state.download === 'event' ? 'complete' : 'interrupted'
            realSetTimeout(() => {
              dlState.set(id, end)
              state.log.push(end)
              onChanged.fire({ id, state: { previous: 'in_progress', current: end } })
            }, 20)
          }
        }
        return id
      },
      search: async (q: { id: number }) => {
        if (state.searchEmpty || !dlState.has(q.id)) return []
        return [{ id: q.id, state: dlState.get(q.id), filename: `/fake-downloads/${dlName.get(q.id)}` }]
      },
    },
    scripting: {
      executeScript: async (inj: any) => {
        state.injections.push(inj)
        state.log.push('inject')
        if (state.inject === 'reject') throw state.injectError
        let result: any
        try {
          result = await runInFakePage(() => inj.func(...(inj.args ?? [])))
        } catch {
          result = undefined // 浏览器对注入函数抛错的表现：该 frame 没有结果
        }
        return [{ frameId: 0, result }]
      },
    },
  }

  // ---------- 拖放用的最小页面环境 ----------
  class FakeDataTransfer {
    files: File[] = []
    items: any
    constructor() {
      const files = this.files
      this.items = { add: (f: File) => (files.push(f), null), get length() { return files.length } }
    }
  }
  class FakeDragEvent {
    type: string
    bubbles: boolean
    cancelable: boolean
    dataTransfer: any
    clientX: number
    clientY: number
    constructor(type: string, init: any = {}) {
      this.type = type
      this.bubbles = !!init.bubbles
      this.cancelable = !!init.cancelable
      this.dataTransfer = init.dataTransfer
      this.clientX = init.clientX
      this.clientY = init.clientY
    }
  }
  const at = (x: number, y: number) => {
    state.pointQueries.push([x, y])
    return state.dropTarget
  }
  const fakeDocument = {
    elementFromPoint: at,
    elementsFromPoint: (x: number, y: number) => {
      const el = at(x, y)
      return el ? [el] : []
    },
  }
  async function runInFakePage(fn: () => any) {
    const g = globalThis as any
    const saved = { document: g.document, DataTransfer: g.DataTransfer, DragEvent: g.DragEvent }
    g.document = fakeDocument
    g.DataTransfer = FakeDataTransfer
    g.DragEvent = FakeDragEvent
    try {
      return await fn()
    } finally {
      g.document = saved.document
      g.DataTransfer = saved.DataTransfer
      g.DragEvent = saved.DragEvent
    }
  }
  const makeTarget = () => {
    const got: FakeDragEvent[] = []
    return { got, dispatchEvent: (e: FakeDragEvent) => (got.push(e), true) }
  }

  const reset = () => {
    state.ctx.clear()
    state.ctxHidden = false
    state.bgFails = false
    state.shotFails = false
    state.shotCalls.length = 0
    state.shotCtx = { viewportWidth: 1111, viewportHeight: 555, screenshotWidth: 1500, screenshotHeight: 750 }
    state.shotSize = { width: 1500, height: 750 }
    state.toViewportCalls.length = 0
    state.bgDepth = 0
    state.woken.clear()
    state.bgCalls.length = 0
    state.sent.length = 0
    state.sendFails = false
    state.log.length = 0
    state.created.length = 0
    state.closeFails = false
    state.messages.length = 0
    state.compose = 'ok'
    state.releaseRejects = false
    state.download = 'event'
    state.downloads.length = 0
    state.searchEmpty = false
    state.inject = 'run'
    state.injections.length = 0
    state.dropTarget = null
    state.pointQueries.length = 0
  }

  const composeMessages = () => state.messages.filter((m) => Array.isArray(m?.frames))
  const releaseMessages = () => state.messages.filter((m) => typeof m?.blobUrl === 'string' && !Array.isArray(m?.frames))

  return { state, chrome, screenshotModule, backgroundTabModule, debuggerModule, sessionsModule, onChanged, makeTarget, reset, composeMessages, releaseMessages }
}
