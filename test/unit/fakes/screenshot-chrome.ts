// 截图模块单测用的假 chrome：记录调试协议命令，按「视口 + 真实设备像素比」模拟浏览器出图。
// 只给 screenshot 单测用，不是共享 fake。
type Listener = (...a: any[]) => void
const event = () => {
  const ls: Listener[] = []
  return { addListener: (f: Listener) => void ls.push(f), fire: (...a: any[]) => ls.forEach((f) => f(...a)), ls }
}

// 造一段最小的图片头（够读宽高），可选在 base64 后面补齐到指定长度
function pngHeader(w: number, h: number) {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  return b
}
function jpegHeader(w: number, h: number) {
  // SOI, APP0(长度 6), DHT(长度 4，不该被当成尺寸段), SOF0
  const b = [0xff, 0xd8, 0xff, 0xe0, 0, 6, 1, 2, 3, 4, 0xff, 0xc4, 0, 4, 9, 9, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0]
  while (b.length % 3) b.push(0)
  return new Uint8Array(b)
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
export const fakePng = (w: number, h: number) => b64(pngHeader(w, h))
export const fakeJpeg = (w: number, h: number, padTo = 0) => {
  const s = b64(jpegHeader(w, h))
  return padTo > s.length ? s + 'A'.repeat(padTo - s.length) : s
}

export interface Call { tabId: number; method: string; params: any }

export function makeChrome() {
  const state = {
    calls: [] as Call[],
    viewport: { width: 1280, height: 800, dpr: 1, x: 0, y: 0 } as any,
    realDpr: undefined as number | undefined, // 浏览器实际出图用的像素比；不设则等于 viewport.dpr
    oversizeAtQuality: undefined as number | undefined, // 该 JPEG 质量下返回超大数据
    noData: false,
    override: undefined as undefined | ((c: Call) => any), // 返回 undefined 则走默认模拟
  }
  const sim = (c: Call) => {
    if (c.method === 'Runtime.evaluate') return { result: { value: state.viewport } }
    if (c.method === 'Page.captureScreenshot') {
      if (state.noData) return {}
      const d = state.realDpr ?? (state.viewport.dpr || 1)
      const clip = c.params.clip
      const w = Math.max(1, Math.round(clip.width * clip.scale * d))
      const h = Math.max(1, Math.round(clip.height * clip.scale * d))
      if (c.params.format === 'png') return { data: fakePng(w, h) }
      return { data: fakeJpeg(w, h, state.oversizeAtQuality === c.params.quality ? 1_500_000 : 0) }
    }
    return {}
  }
  const chrome: any = {
    runtime: { id: 'fakeextid', lastError: undefined },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: (_t: any, _v: string, cb: () => void) => queueMicrotask(cb),
      detach: (_t: any, cb: () => void) => queueMicrotask(cb),
      sendCommand: ({ tabId }: { tabId: number }, method: string, params: any, cb: (r: any) => void) => {
        const c = { tabId, method, params }
        state.calls.push(c)
        const r = state.override?.(c)
        queueMicrotask(() => cb(r === undefined ? sim(c) : r))
      },
    },
    tabs: {
      onRemoved: event(),
      onCreated: event(),
      get: async (id: number) => ({ id, url: 'https://example.test/' }),
      query: async () => [],
    },
    tabGroups: { onUpdated: event(), get: async () => ({}) },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    scripting: { executeScript: async () => [] },
    windows: { getAll: async () => [], getLastFocused: async () => ({}) },
  }
  // 依赖模块替身：只按规格依赖表的签名模拟
  const sessionClosedHooks: ((tabIds: number[], sessionName: string) => unknown)[] = []
  const debuggerModule = {
    send: (tabId: number, method: string, params?: any) =>
      new Promise((resolve) => chrome.debugger.sendCommand({ tabId }, method, params, resolve)),
  }
  const sessionsModule = { sessionClosedHooks }
  const shots = () => state.calls.filter((c) => c.method === 'Page.captureScreenshot')
  return { chrome, state, shots, debuggerModule, sessionsModule }
}
