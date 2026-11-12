const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
require('node:fs').mkdirSync(TEST_TMP, { recursive: true })
// mcp 单测专用替身：stdio 传输（换成内存传输）、server/ 下 7 个同目录依赖、extension/redact 的替身。
// 只按 specs/mcp.md 依赖表的签名模拟；不是共享 fake。
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

type Fn = (...a: any[]) => any

export const FAKE_PROTOCOL = 4242

export type Call = { method: string; params: any; sid: string | undefined }

export function makeFakes() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()

  const state = {
    // 插件连接
    calls: [] as Call[],
    // 方法名 → 回复（值 / 函数 / Error）；没配的方法用默认回复
    replies: new Map<string, any>(),
    tabs: [
      { tabId: 11, title: 'Alpha page', url: 'https://alpha.test/' },
      { tabId: 12, title: 'Beta page', url: 'https://beta.test/' },
    ] as any[],
    // registry
    pickResult: undefined as any,
    pluginProtocol: FAKE_PROTOCOL as number,
    refreshCount: 0,
    refreshInfoCount: 0,
    onlineList: [{ info: { profileId: 'p1' } }] as any[],
    selectable: new Set<string>(['p1']),
    selected: [] as string[],
    switchResult: undefined as any,
    switchCalls: [] as number[],
    noBrowserText: 'NO-BROWSER-EXPLAIN',
    // jev
    jev: { tag: 'the-jev' } as any,
    jevError: undefined as Error | undefined,
    jevCalls: 0,
    // jev-task
    taskStarts: [] as { conn: any; sid: string; params: any; jev: any }[],
    taskStartResult: { taskId: 't-1', status: 'done' } as any,
    taskStatus: { taskId: 't-1', status: 'running' } as any,
    taskResult: { status: 'done', final: 'x' } as any,
    taskStop: { status: 'stopped' } as any,
    taskCalls: [] as { fn: string; id: string }[],
    // jev-tools
    parseCalls: [] as string[],
    prefilterCalls: [] as { rows: any; query: string }[],
    rankCalls: [] as any[],
    rankResult: { candidates: [{ ref: 'ref_9', role: 'button', label: 'Go', p: 0.9 }], none: 0.1 } as any,
    formatResult: { ok: true, text: 'FOUND-TEXT' } as any,
    formatCalls: [] as any[],
    findJson: { candidates: [{ ref: 'ref_9', p: 0.9 }], none: 0.1 } as any,
    checkCalls: [] as any[],
    checkResult: { p: 0.123456, cost: 0.00012345678, model: 'm-x' } as any,
    // output
    hintCalls: [] as { method: string; params: any; isError: boolean }[],
    hintImpl: (() => '') as Fn,
    truncCalls: [] as string[],
    // 进程
    stdinCloseCbs: [] as Fn[],
  }

  const defaultReply = (method: string, params: any) => {
    if (method === 'tabs_context_mcp') return { availableTabs: state.tabs, tabGroupId: 7, initialTabId: 11 }
    if (method === 'tabs_create_mcp') return { tabId: 5151 }
    if (method === 'tabs_close_mcp') return { tabId: params?.tabId }
    if (method === 'read_page') return { pageContent: 'PAGE-TREE', viewport: { width: 1280, height: 720 }, tabId: 4711 }
    if (method === 'get_page_text') return { title: 'Doc title', url: 'https://doc.test/x', source: 'article', text: 'BODY-TEXT', tabId: 4711 }
    if (method === 'computer') return { output: 'computer-out', tabId: 4711 }
    if (method === 'batch_begin' || method === 'batch_end' || method === 'upload_stash') return {}
    return { output: `out-${method}`, tabId: 4711 }
  }

  const conn = {
    closed: false,
    call: async (method: string, params: any = {}, sid?: string) => {
      state.calls.push({ method, params, sid })
      if (state.replies.has(method)) {
        const r = state.replies.get(method)
        const v = typeof r === 'function' ? r(params, state.calls.filter((c) => c.method === method).length) : r
        if (v instanceof Error) throw v
        return v
      }
      return defaultReply(method, params)
    },
  }

  const browser = () => ({ conn, info: { profileId: 'p1', protocolVersion: state.pluginProtocol } })

  const modules = {
    stdio: {
      StdioServerTransport: class {
        constructor() {
          return serverSide as any
        }
      },
    },
    paths: { PROTOCOL_VERSION: FAKE_PROTOCOL, HOST_NAME: 'x', socketDir: () => TEST_TMP + '/spec-mcp/sock', nativeHostDirs: {} },
    browsers: {
      explainNoBrowser: async () => state.noBrowserText,
    },
    registry: {
      refresh: async () => void state.refreshCount++,
      refreshInfo: async () => void state.refreshInfoCount++,
      pick: () => state.pickResult ?? { browser: browser() },
      online: () => state.onlineList,
      describe: () => `DESCRIBE-LIST[${state.onlineList.map((b: any) => b.info.profileId).join(',')}]`,
      select: (id: string) => {
        if (!state.selectable.has(id)) throw new Error(`no-such-browser ${id}`)
        state.selected.push(id)
      },
      switchBrowser: async (ms: number) => {
        state.switchCalls.push(ms)
        return state.switchResult
      },
    },
    jev: {
      getJev: async () => {
        state.jevCalls++
        if (state.jevError) throw state.jevError
        return state.jev
      },
    },
    jevTask: {
      startJevTask: async (c: any, sid: string, params: any, jev: any) => {
        state.taskStarts.push({ conn: c, sid, params, jev })
        return state.taskStartResult
      },
      jevStatus: (id: string) => (state.taskCalls.push({ fn: 'status', id }), state.taskStatus),
      jevResult: (id: string) => (state.taskCalls.push({ fn: 'result', id }), state.taskResult),
      jevStop: async (id: string) => (state.taskCalls.push({ fn: 'stop', id }), state.taskStop),
    },
    jevTools: {
      parseTree: (s: string) => (state.parseCalls.push(s), [{ ref: 'row', role: 'r', name: 'n', line: s }]),
      prefilter: (rows: any, query: string) => (state.prefilterCalls.push({ rows, query }), [...rows, { prefiltered: true }]),
      rank: async (jev: any, opts: any) => (state.rankCalls.push({ jev, opts }), state.rankResult),
      formatFind: (cands: any, none: any) => (state.formatCalls.push({ cands, none }), state.formatResult),
      jevFindJson: (r: any) => (r === state.rankResult ? state.findJson : { wrong: true }),
      check: async (jev: any, opts: any) => (state.checkCalls.push({ jev, opts }), state.checkResult),
    },
    output: {
      makeHinter: () => ({
        note: (method: string, params: any, isError: boolean) => {
          state.hintCalls.push({ method, params, isError })
          return state.hintImpl(method, params, isError)
        },
      }),
      truncateOutput: (t: string) => {
        state.truncCalls.push(t)
        return t.length > 5000 ? `${t.slice(0, 5000)}<<CUT>>` : t
      },
    },
    // 带可识别标记：sanitizeText 把 SECRET 换成 [S]；escapeJson 把 < 换成 <
    redact: {
      sanitizeText: (t: string) => String(t).replaceAll('SECRET', '[S]'),
      escapeJson: (t: string) => String(t).replaceAll('<', '\\u003c'),
    },
  }

  // 记录 process.stdin.on，不真挂
  const realOn = process.stdin.on.bind(process.stdin)
  const captureStdin = () => {
    ;(process.stdin as any).on = (ev: string, cb: Fn) => {
      if (ev === 'close') state.stdinCloseCbs.push(cb)
      return process.stdin
    }
  }
  const restoreStdin = () => {
    ;(process.stdin as any).on = realOn
  }

  const reset = () => {
    state.calls.length = 0
    state.replies.clear()
    state.tabs = [
      { tabId: 11, title: 'Alpha page', url: 'https://alpha.test/' },
      { tabId: 12, title: 'Beta page', url: 'https://beta.test/' },
    ]
    state.pickResult = undefined
    state.pluginProtocol = FAKE_PROTOCOL
    state.refreshCount = 0
    state.refreshInfoCount = 0
    state.onlineList = [{ info: { profileId: 'p1' } }]
    state.selectable = new Set(['p1'])
    state.selected.length = 0
    state.switchResult = undefined
    state.switchCalls.length = 0
    state.noBrowserText = 'NO-BROWSER-EXPLAIN'
    state.jevCalls = 0
    state.jevError = undefined
    state.taskStarts.length = 0
    state.taskCalls.length = 0
    state.taskStartResult = { taskId: 't-1', status: 'done' }
    state.taskStatus = { taskId: 't-1', status: 'running' }
    state.taskResult = { status: 'done', final: 'x' }
    state.taskStop = { status: 'stopped' }
    state.parseCalls.length = 0
    state.prefilterCalls.length = 0
    state.rankCalls.length = 0
    state.formatCalls.length = 0
    state.checkCalls.length = 0
    state.rankResult = { candidates: [{ ref: 'ref_9', role: 'button', label: 'Go', p: 0.9 }], none: 0.1 }
    state.formatResult = { ok: true, text: 'FOUND-TEXT' }
    state.findJson = { candidates: [{ ref: 'ref_9', p: 0.9 }], none: 0.1 }
    state.checkResult = { p: 0.123456, cost: 0.00012345678, model: 'm-x' }
    state.hintCalls.length = 0
    state.hintImpl = () => ''
    state.truncCalls.length = 0
  }

  return { state, conn, clientSide, modules, captureStdin, restoreStdin, reset }
}
