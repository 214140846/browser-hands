const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
require('node:fs').mkdirSync(TEST_TMP, { recursive: true })
// mcp 单测专用替身：stdio 传输（换成内存传输）、server/ 下 6 个同目录依赖、extension/redact 的替身。
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
    pluginVersion: '0.2.3' as string | undefined,
    refreshCount: 0,
    refreshInfoCount: 0,
    onlineList: [{ info: { profileId: 'p1' } }] as any[],
    selectable: new Set<string>(['p1']),
    selected: [] as string[],
    switchResult: undefined as any,
    switchCalls: [] as number[],
    noBrowserText: 'NO-BROWSER-EXPLAIN',
    // find-local
    parseCalls: [] as string[],
    findCalls: [] as { rows: any; query: string }[],
    findResult: [{ ref: 'ref_9', role: 'button', label: 'Go', p: 1 }] as any,
    formatResult: { ok: true, text: 'FOUND-TEXT' } as any,
    formatCalls: [] as any[],
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

  const browser = () => ({ conn, info: { profileId: 'p1', protocolVersion: state.pluginProtocol, extensionVersion: state.pluginVersion } })

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
    findLocal: {
      parseTree: (s: string) => (state.parseCalls.push(s), [{ ref: 'row', role: 'r', name: 'n', line: s }]),
      findLocal: (rows: any, query: string) => (state.findCalls.push({ rows, query }), state.findResult),
      formatFind: (cands: any) => (state.formatCalls.push({ cands }), state.formatResult),
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
    state.pluginVersion = '0.2.3'
    state.refreshCount = 0
    state.refreshInfoCount = 0
    state.onlineList = [{ info: { profileId: 'p1' } }]
    state.selectable = new Set(['p1'])
    state.selected.length = 0
    state.switchResult = undefined
    state.switchCalls.length = 0
    state.noBrowserText = 'NO-BROWSER-EXPLAIN'
    state.parseCalls.length = 0
    state.findCalls.length = 0
    state.formatCalls.length = 0
    state.findResult = [{ ref: 'ref_9', role: 'button', label: 'Go', p: 1 }]
    state.formatResult = { ok: true, text: 'FOUND-TEXT' }
    state.hintCalls.length = 0
    state.hintImpl = () => ''
    state.truncCalls.length = 0
  }

  return { state, conn, clientSide, modules, captureStdin, restoreStdin, reset }
}
