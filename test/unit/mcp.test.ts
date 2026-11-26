const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
require('node:fs').mkdirSync(TEST_TMP, { recursive: true })
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { FAKE_PROTOCOL, makeFakes } from './fakes/mcp-deps'

// 安全网：万一某个替身没生效，真 registry 也只会去扫这个空目录，不会碰用户的浏览器
process.env.JEV_SOCKET_DIR = TEST_TMP + '/spec-mcp/sock'
delete process.env.JEV_SWITCH_TIMEOUT_MS

const f = makeFakes()
const S = f.state
mock.module('@modelcontextprotocol/sdk/server/stdio.js', () => f.modules.stdio)
mock.module('../../server/paths', () => f.modules.paths)
mock.module('../../server/browsers', () => f.modules.browsers)
mock.module('../../server/registry', () => f.modules.registry)
mock.module('../../server/find-local', () => f.modules.findLocal)
mock.module('../../server/output', () => f.modules.output)
mock.module('../../extension/redact.js', () => f.modules.redact)

f.captureStdin()
const mod = await import('../../server/mcp.ts')
f.restoreStdin()

const CLIENT_NAME = 'spec-client'
const client = new Client({ name: CLIENT_NAME, version: '9.9.9' })
let tools: any[] = []
beforeAll(async () => {
  await client.connect(f.clientSide)
  tools = (await client.listTools()).tools
})
beforeEach(() => f.reset())
afterEach(() => {
  delete process.env.JEV_SWITCH_TIMEOUT_MS
})

type R = { content: any[]; isError: boolean }
const call = async (name: string, args: Record<string, unknown> = {}): Promise<R> => (await client.callTool({ name, arguments: args })) as any
const texts = (r: R) => r.content.filter((c) => c.type === 'text').map((c) => c.text as string)
const text = (r: R) => texts(r).join('\n')
const methods = () => S.calls.map((c) => c.method)
const firstLineJson = (s: string) => JSON.parse(s.split('\n')[0])
// 标签块里那行 JSON
const tabJson = (s: string) => {
  for (const l of s.split('\n')) {
    try {
      const o = JSON.parse(l)
      if (o && typeof o === 'object' && 'availableTabs' in o) return o
    } catch {}
  }
  return undefined
}
const hasTabBlock = (s: string) => tabJson(s) !== undefined && s.includes('Alpha page') && s.includes('Beta page')
const rejected = async (name: string, args: Record<string, unknown>) => {
  f.reset()
  let bad = false
  try {
    const r = await call(name, args)
    bad = r.isError === true
  } catch {
    bad = true
  }
  expect(bad).toBe(true)
  expect(S.calls.length).toBe(0)
  expect(S.refreshCount).toBe(0)
}

// ---------- 导入副作用 ----------
describe('导入副作用', () => {
  test('没有任何导出', () => {
    expect(Object.keys(mod)).toEqual([])
  })
  test('服务器名 thundermcp', () => {
    expect(client.getServerVersion()?.name).toBe('thundermcp')
  })
  test('说明文字非空，且开头的注释行不下发', () => {
    const ins = client.getInstructions()
    expect(typeof ins).toBe('string')
    expect((ins as string).trim().length).toBeGreaterThan(0)
    expect((ins as string).startsWith('<!--')).toBe(false)
  })
  test('监听 stdin 的 close，触发后以退出码 0 退出', () => {
    expect(S.stdinCloseCbs.length).toBe(1)
    const realExit = process.exit
    const codes: unknown[] = []
    ;(process as any).exit = (c?: number) => void codes.push(c)
    try {
      S.stdinCloseCbs[0]()
    } finally {
      ;(process as any).exit = realExit
    }
    expect(codes).toEqual([0])
  })
})

// ---------- 工具清单与 schema ----------
const NUM = { type: 'number' }
const STR = { type: 'string' }
const BOOL = { type: 'boolean' }
const arr = (n: number) => ({ type: 'array', items: NUM, minItems: n, maxItems: n })
const EXPECT: Record<string, { props: Record<string, any>; required: string[] }> = {
  tabs_context_mcp: { props: { createIfEmpty: BOOL }, required: [] },
  tabs_create_mcp: { props: {}, required: [] },
  tabs_close_mcp: { props: { tabId: NUM }, required: ['tabId'] },
  read_page: { props: { filter: { type: 'string', enum: ['interactive', 'all'] }, tabId: NUM, depth: NUM, ref_id: STR, max_chars: NUM }, required: [] },
  get_page_text: { props: { tabId: NUM, max_chars: NUM }, required: [] },
  computer: {
    props: {
      action: { type: 'string', enum: ['left_click', 'right_click', 'type', 'screenshot', 'wait', 'scroll', 'key', 'left_click_drag', 'double_click', 'triple_click', 'zoom', 'scroll_to', 'hover'] },
      coordinate: arr(2),
      text: STR,
      duration: { type: 'number', minimum: 0, maximum: 30 },
      scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      scroll_amount: { type: 'number', minimum: 1, maximum: 30 },
      start_coordinate: arr(2),
      region: arr(4),
      scale: NUM,
      repeat: { type: 'number', minimum: 1, maximum: 100 },
      ref: STR,
      modifiers: STR,
      tabId: NUM,
    },
    required: ['action', 'tabId'],
  },
  find: { props: { query: STR, tabId: NUM }, required: ['query'] },
  form_input: { props: { ref: STR, value: { type: ['string', 'boolean', 'number'] }, tabId: NUM }, required: ['ref', 'value', 'tabId'] },
  navigate: { props: { url: STR, tabId: NUM, force: BOOL }, required: ['url', 'tabId'] },
  browser_batch: { props: { actions: { type: 'array', items: { type: 'object', required: ['name', 'input'], props: { name: STR, input: { type: 'object' } } } } }, required: ['actions'] },
  resize_window: { props: { width: NUM, height: NUM, tabId: NUM }, required: ['width', 'height', 'tabId'] },
  javascript_tool: { props: { action: STR, text: STR, tabId: NUM }, required: ['action', 'text', 'tabId'] },
  read_console_messages: { props: { tabId: NUM, onlyErrors: BOOL, clear: BOOL, pattern: STR, limit: NUM }, required: ['tabId'] },
  read_network_requests: { props: { tabId: NUM, urlPattern: STR, clear: BOOL, limit: NUM }, required: ['tabId'] },
  file_upload: {
    props: { files: { type: 'array', items: { type: 'object', required: ['data', 'name'], props: { data: STR, name: STR, mimeType: STR } } }, paths: { type: 'array', items: STR }, ref: STR, tabId: NUM },
    required: ['ref', 'tabId'],
  },
  upload_image: { props: { imageId: STR, ref: STR, coordinate: arr(2), tabId: NUM, filename: STR }, required: ['imageId', 'tabId'] },
  gif_creator: {
    props: {
      action: STR,
      tabId: NUM,
      coordinate: arr(2),
      download: BOOL,
      filename: STR,
      options: { type: 'object', required: [], props: { showClickIndicators: BOOL, showDragPaths: BOOL, showActionLabels: BOOL, showProgressBar: BOOL, quality: NUM } },
    },
    required: ['action', 'tabId'],
  },
  list_connected_browsers: { props: {}, required: [] },
  select_browser: { props: { deviceId: STR }, required: ['deviceId'] },
  switch_browser: { props: {}, required: [] },
}

// 只留 type / enum / 范围 / 长度 / 嵌套，忽略 description 与 $schema
const shape = (s: any): any => {
  if (!s || typeof s !== 'object') return s
  const o: any = {}
  for (const k of ['type', 'enum', 'minimum', 'maximum', 'minItems', 'maxItems']) if (k in s) o[k] = s[k]
  if (s.items) o.items = shape(s.items)
  if (s.type === 'object' && s.properties && s.properties) {
    // 嵌套对象（数组元素 / options）：保留属性与必填
    o.props = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, shape(v)]))
    o.required = [...(s.required ?? [])].sort()
  }
  return o
}

describe('工具清单与 schema', () => {
  test('恰好 20 个工具，名字一一对应', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECT).sort())
    expect(tools.length).toBe(20)
  })
  test('每个工具的 description 是非空字符串', () => {
    for (const t of tools) {
      expect(typeof t.description).toBe('string')
      expect(t.description.trim().length).toBeGreaterThan(0)
    }
  })
  for (const [name, exp] of Object.entries(EXPECT)) {
    test(`${name} 的参数 schema`, () => {
      const t = tools.find((x) => x.name === name)
      expect(t.inputSchema.type).toBe('object')
      expect(Object.keys(t.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(exp.props).sort())
      expect([...(t.inputSchema.required ?? [])].sort()).toEqual([...exp.required].sort())
      for (const [p, want] of Object.entries(exp.props)) {
        const got = shape(t.inputSchema.properties[p])
        // 嵌套对象期望里的 props / required 同样用 shape 的形态
        const norm = (w: any): any => {
          if (!w || typeof w !== 'object') return w
          const o: any = { ...w }
          if (o.items) o.items = norm(o.items)
          if (o.props) o.props = Object.fromEntries(Object.entries(o.props).map(([k, v]) => [k, norm(v)]))
          if (o.required) o.required = [...o.required].sort()
          return o
        }
        if (p === 'input' || (want.type === 'object' && !want.props)) {
          expect(got.type).toBe('object')
        } else {
          expect(got).toEqual(norm(want))
        }
      }
    })
  }
  test('browser_batch 元素 input 是对象', () => {
    const items = tools.find((x) => x.name === 'browser_batch').inputSchema.properties.actions.items
    expect(items.properties.input.type).toBe('object')
  })
})

describe('参数不合法被拒，且不触发任何转发', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['computer', { action: 'wait', duration: 31, tabId: 1 }],
    ['computer', { action: 'wait', duration: -1, tabId: 1 }],
    ['computer', { action: 'scroll', scroll_amount: 0, tabId: 1 }],
    ['computer', { action: 'scroll', scroll_amount: 31, tabId: 1 }],
    ['computer', { action: 'key', text: 'a', repeat: 0, tabId: 1 }],
    ['computer', { action: 'key', text: 'a', repeat: 101, tabId: 1 }],
    ['computer', { action: 'left_click', coordinate: [1, 2, 3], tabId: 1 }],
    ['computer', { action: 'zoom', region: [1, 2, 3], tabId: 1 }],
    ['computer', { action: 'dance', tabId: 1 }],
    ['computer', { action: 'screenshot', tabId: 'x' }],
    ['computer', { action: 'screenshot' }],
    ['read_page', { filter: 'some' }],
    ['read_page', { max_chars: '10' }],
    ['form_input', { ref: 'r', value: [1], tabId: 1 }],
    ['form_input', { ref: 'r', tabId: 1 }],
    ['file_upload', { ref: 'r', tabId: 1, files: [{ data: 'QQ==' }] }],
    ['javascript_tool', { action: 'x', tabId: 1 }],
    ['tabs_close_mcp', {}],
    ['gif_creator', { action: 'export', tabId: 1, options: { quality: 'hi' } }],
    ['select_browser', {}],
    ['browser_batch', { actions: [{ name: 'computer' }] }],
    ['browser_batch', {}],
  ]
  for (const [name, args] of bad) test(`${name} ${JSON.stringify(args)}`, () => rejected(name, args))

  test('边界值与「任意字符串」参数被接受', async () => {
    for (const [name, args] of [
      ['computer', { action: 'wait', duration: 30, tabId: 1 }],
      ['computer', { action: 'wait', duration: 0, tabId: 1 }],
      ['computer', { action: 'scroll', scroll_amount: 1, tabId: 1 }],
      ['computer', { action: 'key', text: 'a', repeat: 100, tabId: 1 }],
      ['javascript_tool', { action: 'anything-at-all', text: '1', tabId: 1 }],
      ['gif_creator', { action: 'whatever', tabId: 1 }],
      ['form_input', { ref: 'r', value: true, tabId: 1 }],
      ['form_input', { ref: 'r', value: 3, tabId: 1 }],
      ['form_input', { ref: 'r', value: 's', tabId: 1 }],
    ] as [string, any][]) {
      f.reset()
      const r = await call(name, args)
      expect(r.isError).toBe(false)
    }
  })
})

// ---------- 转发与结果文字 ----------
describe('标签管理', () => {
  test('tabs_context_mcp：结果是标签块', async () => {
    const r = await call('tabs_context_mcp', { createIfEmpty: true })
    expect(r.isError).toBe(false)
    expect(S.calls[0].method).toBe('tabs_context_mcp')
    const t = text(r)
    const j = tabJson(t)
    expect(j).toEqual({ availableTabs: S.tabs, tabGroupId: 7, initialTabId: 11 })
    for (const tab of S.tabs) {
      expect(t).toContain(String(tab.tabId))
      expect(t).toContain(tab.title)
      expect(t).toContain(tab.url)
    }
    expect(t).not.toContain('4711')
  })
  test('tabs_create_mcp：发 {}，结果含新标签 id 与标签块', async () => {
    const r = await call('tabs_create_mcp')
    expect(S.calls[0]).toMatchObject({ method: 'tabs_create_mcp', params: {} })
    expect(text(r)).toContain('5151')
    expect(hasTabBlock(text(r))).toBe(true)
  })
  test('tabs_close_mcp：转发 tabId，结果含该 id 与标签块', async () => {
    const r = await call('tabs_close_mcp', { tabId: 12 })
    expect(S.calls[0]).toMatchObject({ method: 'tabs_close_mcp', params: { tabId: 12 } })
    expect(text(r)).toContain('12')
    expect(hasTabBlock(text(r))).toBe(true)
  })
})

describe('读页面', () => {
  test('read_page：参数原样、结果含内容 / 视口 / 标签块 / 执行标签', async () => {
    const r = await call('read_page', { filter: 'all', tabId: 3, depth: 4, ref_id: 'ref_2', max_chars: 999 })
    expect(S.calls[0]).toMatchObject({ method: 'read_page', params: { filter: 'all', tabId: 3, depth: 4, ref_id: 'ref_2', max_chars: 999 } })
    const t = text(r)
    expect(t).toContain('PAGE-TREE')
    expect(t).toContain('1280x720')
    expect(t).toContain('4711')
    expect(hasTabBlock(t)).toBe(true)
    expect(t.indexOf('PAGE-TREE')).toBeLessThan(t.indexOf('Alpha page'))
  })
  test('read_page：没给的可选参数不出现，未声明参数不转发', async () => {
    await call('read_page', { bogus: 1 })
    expect(S.calls[0].params).toEqual({})
  })
  test('get_page_text：含标题 / 网址 / 元素名 / 正文，正文在标签块之前', async () => {
    S.replies.set('get_page_text', { title: 'T<b>', url: 'https://doc.test/x', source: 'main', text: 'BODY-TEXT', tabId: 4711 })
    const r = await call('get_page_text', { tabId: 2 })
    expect(S.calls[0]).toMatchObject({ method: 'get_page_text', params: { tabId: 2 } })
    const t = text(r)
    for (const s of ['https://doc.test/x', 'main', 'BODY-TEXT', '4711']) expect(t).toContain(s)
    expect(t).not.toContain('T<b>')
    expect(t.indexOf('BODY-TEXT')).toBeLessThan(t.indexOf('Alpha page'))
  })
})

describe('带 output 的动作', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['computer', { action: 'left_click', coordinate: [1, 2], tabId: 5 }],
    ['form_input', { ref: 'ref_1', value: 'v', tabId: 5 }],
    ['navigate', { url: 'x.test', tabId: 5, force: true }],
    ['javascript_tool', { action: 'javascript_exec', text: '1+1', tabId: 5 }],
    ['resize_window', { width: 800, height: 600, tabId: 5 }],
    ['read_console_messages', { tabId: 5, onlyErrors: true, pattern: 'x', limit: 3, clear: true }],
    ['read_network_requests', { tabId: 5, urlPattern: '/api', limit: 3, clear: false }],
    ['upload_image', { imageId: 'img', ref: 'ref_3', tabId: 5, filename: 'a.png' }],
    ['gif_creator', { action: 'start_recording', tabId: 5, options: { quality: 3 } }],
    ['file_upload', { ref: 'ref_4', tabId: 5, paths: ['/x'], files: [{ data: 'QQ==', name: 'a.txt', mimeType: 'text/plain' }] }],
  ]
  for (const [name, args] of cases) {
    test(`${name}：参数原样转发，结果 = output + 标签块`, async () => {
      S.replies.set(name, { output: `OUT-${name}`, tabId: 4711 })
      const r = await call(name, args)
      expect(r.isError).toBe(false)
      expect(S.calls[0]).toMatchObject({ method: name, params: args })
      const t = text(r)
      expect(t).toContain(`OUT-${name}`)
      expect(t).toContain('4711')
      expect(hasTabBlock(t)).toBe(true)
      expect(t.indexOf(`OUT-${name}`)).toBeLessThan(t.indexOf('Alpha page'))
      expect(r.content.every((c) => c.type === 'text')).toBe(true)
    })
  }
  test('computer 带 base64Image：文字块之后多一个图片块', async () => {
    S.replies.set('computer', { output: 'shot', tabId: 4711, base64Image: 'QUJD', imageFormat: 'png' })
    const r = await call('computer', { action: 'screenshot', tabId: 1 })
    expect(r.content.map((c) => c.type)).toEqual(['text', 'image'])
    expect(r.content[1]).toMatchObject({ data: 'QUJD', mimeType: 'image/png' })
  })
  test('computer 图片：jpeg 同理；图片内容不被脱敏 / 截断', async () => {
    S.replies.set('computer', { output: 'shot', tabId: 4711, base64Image: 'SECRETxx', imageFormat: 'jpeg' })
    const r = await call('computer', { action: 'screenshot', tabId: 1 })
    expect(r.content[1]).toMatchObject({ data: 'SECRETxx', mimeType: 'image/jpeg' })
    expect(S.truncCalls.every((t) => !t.includes('SECRETxx'))).toBe(true)
  })
  test('computer 没有图片时只有文字块', async () => {
    const r = await call('computer', { action: 'wait', duration: 1, tabId: 1 })
    expect(r.content.every((c) => c.type === 'text')).toBe(true)
  })
})

describe('find', () => {
  test('读树（filter all），本地打分；成功文字含 formatFind 的 text，在标签块之前', async () => {
    S.replies.set('read_page', { pageContent: 'TREE-X', viewport: { width: 1, height: 1 }, tabId: 12 })
    const r = await call('find', { query: 'sign-in link', tabId: 12 })
    expect(r.isError).toBe(false)
    expect(S.calls[0]).toMatchObject({ method: 'read_page', params: { filter: 'all', tabId: 12 } })
    expect(methods()).not.toContain('find')
    expect(S.parseCalls).toEqual(['TREE-X'])
    expect(S.findCalls[0].query).toBe('sign-in link')
    expect(S.findCalls[0].rows).toEqual([{ ref: 'row', role: 'r', name: 'n', line: 'TREE-X' }])
    expect(S.formatCalls[0]).toEqual({ cands: S.findResult })
    const t = text(r)
    expect(t).toContain('FOUND-TEXT')
    expect(t.indexOf('FOUND-TEXT')).toBeLessThan(t.indexOf('Alpha page'))
    expect(hasTabBlock(t)).toBe(true)
    expect(t).toContain('12')
  })
  test('formatFind 失败 → 错误结果含其 error', async () => {
    S.formatResult = { ok: false, error: 'NOTHING-MATCHED' }
    const r = await call('find', { query: 'x' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('NOTHING-MATCHED')
    expect(text(r)).not.toContain('Alpha page')
  })
  test('没给 tabId 时读树参数里 tabId 为空；不查标签清单', async () => {
    await call('find', { query: 'x' })
    expect(S.calls[0].method).toBe('read_page')
    expect(S.calls[0].params.filter).toBe('all')
    expect(S.calls[0].params.tabId).toBeUndefined()
    expect(methods()).not.toContain('get_page_text')
  })
})

// ---------- 通用流程 ----------
describe('选浏览器', () => {
  test('调用前先 refresh', async () => {
    await call('tabs_create_mcp')
    expect(S.refreshCount).toBe(1)
  })
  test('一个都不在线：错误 = explainNoBrowser 的文字，无插件调用', async () => {
    S.pickResult = { error: '', none: true }
    const r = await call('read_page')
    expect(r.isError).toBe(true)
    expect(text(r)).toContain(S.noBrowserText)
    expect(S.calls.length).toBe(0)
  })
  test('pick 给出 error：错误文字就是它，无插件调用；提示器照常被问（isError 为真）', async () => {
    S.pickResult = { error: 'PICK-ERR-TEXT', code: 'select_browser' }
    const r = await call('navigate', { url: 'x', tabId: 1 })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('PICK-ERR-TEXT')
    expect(S.calls.length).toBe(0)
    expect(S.hintCalls).toEqual([{ method: 'navigate', params: { url: 'x', tabId: 1 }, isError: true }])
  })
})

describe('会话标识', () => {
  test('客户端名 + 连字符 + 非空后缀；所有插件调用（含内部查询）同一个；跨调用不变', async () => {
    await call('find', { query: 'x' })
    await call('tabs_create_mcp')
    const ids = new Set(S.calls.map((c) => c.sid))
    expect(ids.size).toBe(1)
    const id = [...ids][0] as string
    expect(id.startsWith(`${CLIENT_NAME}-`)).toBe(true)
    expect(id.length).toBeGreaterThan(CLIENT_NAME.length + 1)
    f.reset()
    await call('read_page')
    expect(new Set(S.calls.map((c) => c.sid))).toEqual(new Set([id]))
  })
})

describe('协议版本提醒', () => {
  test('版本一致：没有提醒', async () => {
    const r = await call('computer', { action: 'wait', duration: 1, tabId: 1 })
    expect(text(r)).not.toContain('9191')
  })
  test('版本不一致：结果里出现两个版本号', async () => {
    S.pluginProtocol = 9191
    const r = await call('form_input', { ref: 'r', value: 'v', tabId: 1 })
    expect(r.isError).toBe(false)
    expect(text(r)).toContain('9191')
    expect(text(r)).toContain(String(FAKE_PROTOCOL))
  })
  test('带图时提醒仍在文字块里，图片块不受影响', async () => {
    S.pluginProtocol = 9191
    S.replies.set('computer', { output: 'o', tabId: 1, base64Image: 'QQ==', imageFormat: 'png' })
    const r = await call('computer', { action: 'screenshot', tabId: 1 })
    expect(r.content.map((c) => c.type)).toEqual(['text', 'image'])
    expect(r.content[0].text).toContain('9191')
  })
})

describe('脱敏', () => {
  test('成功结果的文字过 sanitizeText（含标签标题）', async () => {
    S.tabs = [{ tabId: 11, title: 'has SECRET inside', url: 'https://alpha.test/SECRET' }]
    S.replies.set('form_input', { output: 'out SECRET end', tabId: 11 })
    const r = await call('form_input', { ref: 'r', value: 'v', tabId: 11 })
    expect(text(r)).toContain('[S]')
    expect(text(r)).not.toContain('SECRET')
  })
  test('错误文字（插件报错）同样脱敏，且原样带出插件的错误文字', async () => {
    S.replies.set('navigate', new Error('page_loading: tok SECRET tok'))
    const r = await call('navigate', { url: 'x', tabId: 1 })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('page_loading')
    expect(text(r)).toContain('[S]')
    expect(text(r)).not.toContain('SECRET')
  })
  test('标签标题 / 网址经 escapeJson', async () => {
    S.tabs = [{ tabId: 11, title: 'Alpha <img> page', url: 'https://alpha.test/?q=<x>' }]
    const r = await call('tabs_context_mcp')
    const t = text(r)
    expect(t).not.toContain('<img>')
    expect(t).not.toContain('<x>')
    expect(t).toContain('\\u003c')
  })
  test('get_page_text 的标题经 escapeJson', async () => {
    S.replies.set('get_page_text', { title: 'Hi <u>', url: 'https://d.test', source: 's', text: 'b', tabId: 1 })
    const r = await call('get_page_text', {})
    expect(text(r)).not.toContain('<u>')
  })
})

describe('错误处理与结果形状', () => {
  test('插件报错 → isError:true 的文字结果，message 原样出现，调用本身不 reject', async () => {
    S.replies.set('read_page', new Error('debugger_attach_failed: could not attach'))
    const r = await call('read_page', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('debugger_attach_failed: could not attach')
    expect(typeof r.isError).toBe('boolean')
  })
  test('成功时 isError 恰为 false', async () => {
    const r = await call('tabs_create_mcp')
    expect(r.isError).toBe(false)
  })
})

describe('截断', () => {
  test('文字块过 truncateOutput', async () => {
    S.replies.set('form_input', { output: 'X'.repeat(6000), tabId: 1 })
    const r = await call('form_input', { ref: 'r', value: 'v', tabId: 1 })
    expect(S.truncCalls.length).toBeGreaterThan(0)
    expect(text(r)).toContain('<<CUT>>')
  })
  test('调用者传了数字 max_chars：不截断（read_page / get_page_text）', async () => {
    S.replies.set('read_page', { pageContent: 'P'.repeat(6000), viewport: { width: 1, height: 1 }, tabId: 1 })
    const r = await call('read_page', { max_chars: 100000 })
    expect(S.truncCalls.length).toBe(0)
    expect(text(r)).not.toContain('<<CUT>>')
    expect(text(r)).toContain('P'.repeat(6000))
    S.replies.set('get_page_text', { title: 't', url: 'u', source: 's', text: 'Q'.repeat(6000), tabId: 1 })
    const r2 = await call('get_page_text', { max_chars: 100000 })
    expect(S.truncCalls.length).toBe(0)
    expect(text(r2)).toContain('Q'.repeat(6000))
  })
  test('max_chars 为 0 也算明确要，不截', async () => {
    S.replies.set('read_page', { pageContent: 'P'.repeat(6000), viewport: { width: 1, height: 1 }, tabId: 1 })
    await call('read_page', { max_chars: 0 })
    expect(S.truncCalls.length).toBe(0)
  })
  test('没传 max_chars 的 read_page 仍然截断', async () => {
    S.replies.set('read_page', { pageContent: 'P'.repeat(6000), viewport: { width: 1, height: 1 }, tabId: 1 })
    const r = await call('read_page', {})
    expect(text(r)).toContain('<<CUT>>')
  })
  test('图片块不过 truncateOutput', async () => {
    S.replies.set('computer', { output: 'o', tabId: 1, base64Image: 'I'.repeat(6000), imageFormat: 'png' })
    const r = await call('computer', { action: 'screenshot', tabId: 1 })
    expect(r.content[1].data).toBe('I'.repeat(6000))
  })
})

describe('提示器', () => {
  test('收到内部方法名 / 解析后参数 / 是否错误', async () => {
    await call('read_page', { filter: 'all', tabId: 2 })
    await call('find', { query: 'd' })
    await call('tabs_close_mcp', { tabId: 3 })
    expect(S.hintCalls.map((h) => h.method)).toEqual(['read_page', 'find', 'tabs_close_mcp'])
    expect(S.hintCalls[0]).toEqual({ method: 'read_page', params: { filter: 'all', tabId: 2 }, isError: false })
    expect(S.hintCalls[1].params).toEqual({ query: 'd' })
    expect(S.hintCalls.every((h) => h.isError === false)).toBe(true)
  })
  test('出错时 isError 为 true', async () => {
    S.replies.set('navigate', new Error('x: y'))
    await call('navigate', { url: 'u', tabId: 1 })
    expect(S.hintCalls[0].isError).toBe(true)
  })
  test('返回非空提醒 → 末尾多一个文字块；空串 / undefined → 不多', async () => {
    S.hintImpl = () => 'HINT-TEXT'
    const r = await call('tabs_create_mcp')
    const last = r.content[r.content.length - 1]
    expect(last).toEqual({ type: 'text', text: 'HINT-TEXT' })
    expect(r.content.length).toBe(2)
    S.hintImpl = () => undefined
    const r2 = await call('tabs_create_mcp')
    expect(r2.content.length).toBe(1)
    S.hintImpl = () => ''
    const r3 = await call('tabs_create_mcp')
    expect(r3.content.length).toBe(1)
  })
  test('提醒块不再被截断', async () => {
    S.hintImpl = () => 'H'.repeat(6000)
    const r = await call('tabs_create_mcp')
    expect(r.content[r.content.length - 1].text).toBe('H'.repeat(6000))
  })
})

// ---------- browser_batch ----------
describe('browser_batch', () => {
  const act = (name: string, input: Record<string, unknown> = {}) => ({ name, input })
  const bad = async (actions: any[]) => {
    f.reset()
    const r = await call('browser_batch', { actions })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('batch_invalid_input')
    expect(S.calls.length).toBe(0)
  }
  test('空数组', () => bad([]))
  test('嵌套 browser_batch', () => bad([act('browser_batch', { actions: [] })]))
  for (const n of ['list_connected_browsers', 'select_browser', 'switch_browser', 'no_such_tool']) {
    test(`不允许的工具 ${n}`, () => bad([act('read_page'), act(n, {})]))
  }
  test('批里有不合法项时，前面合法的项也不执行', () => bad([act('navigate', { url: 'x', tabId: 1 }), act('browser_batch')]))
  test('没有在线浏览器时报选浏览器的错', async () => {
    S.pickResult = { error: '', none: true }
    const r = await call('browser_batch', { actions: [] })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain(S.noBrowserText)
  })

  test('顺序执行：begin → 各项 → end；每项各自的输出出现，标签块只出现一次', async () => {
    S.replies.set('navigate', { output: 'OUT-NAV', tabId: 4711 })
    S.replies.set('form_input', { output: 'OUT-FORM', tabId: 4711 })
    const r = await call('browser_batch', { actions: [act('navigate', { url: 'a', tabId: 1 }), act('form_input', { ref: 'r', value: 'v', tabId: 1 }), act('read_page', { tabId: 1 })] })
    expect(r.isError).toBe(false)
    const m = methods()
    expect(m[0]).toBe('batch_begin')
    expect(m.indexOf('navigate')).toBeLessThan(m.indexOf('form_input'))
    expect(m.indexOf('form_input')).toBeLessThan(m.indexOf('read_page'))
    expect(m.lastIndexOf('batch_end')).toBe(m.indexOf('batch_end'))
    expect(m.indexOf('batch_end')).toBeGreaterThan(m.indexOf('read_page'))
    const ts = texts(r)
    expect(ts.join('\n')).toContain('OUT-NAV')
    expect(ts.join('\n')).toContain('OUT-FORM')
    expect(ts.join('\n')).toContain('PAGE-TREE')
    expect(ts.filter((t) => t.includes('Alpha page')).length).toBe(1)
    expect(hasTabBlock(ts[ts.length - 1])).toBe(true)
    expect(S.calls.find((c) => c.method === 'navigate')!.params).toEqual({ url: 'a', tabId: 1 })
    expect(new Set(S.calls.map((c) => c.sid)).size).toBe(1)
    expect(S.hintCalls[0].method).toBe('browser_batch')
  })
  test('tabs_context_mcp 项在批内没有标签块文字（末尾仍有一次）', async () => {
    const r = await call('browser_batch', { actions: [act('tabs_context_mcp'), act('tabs_create_mcp')] })
    const ts = texts(r)
    expect(ts.filter((t) => t.includes('Alpha page')).length).toBe(1)
  })
  test('别名 tabs_context / tabs_create / tabs_close 等价于 _mcp 名', async () => {
    const r = await call('browser_batch', { actions: [act('tabs_context'), act('tabs_create'), act('tabs_close', { tabId: 12 })] })
    expect(r.isError).toBe(false)
    const m = methods().filter((x) => x.startsWith('tabs_'))
    expect(m).toContain('tabs_create_mcp')
    expect(m).toContain('tabs_close_mcp')
    expect(S.calls.find((c) => c.method === 'tabs_close_mcp')!.params).toEqual({ tabId: 12 })
  })
  test('批内 find 本地处理，不把名字发给插件', async () => {
    const r = await call('browser_batch', { actions: [act('find', { query: 'q' })] })
    expect(r.isError).toBe(false)
    expect(S.findCalls.map((x) => x.query)).toEqual(['q'])
    expect(methods()).not.toContain('find')
  })
  test('批内 computer 的图片块紧跟其文字块，图片不脱敏', async () => {
    S.replies.set('computer', { output: 'SHOT-OUT', tabId: 1, base64Image: 'SECRETim', imageFormat: 'png' })
    const r = await call('browser_batch', { actions: [act('computer', { action: 'screenshot', tabId: 1 }), act('read_page', { tabId: 1 })] })
    const types = r.content.map((c) => c.type)
    const i = types.indexOf('image')
    expect(i).toBeGreaterThan(0)
    expect(r.content[i - 1].text).toContain('SHOT-OUT')
    expect(r.content[i]).toMatchObject({ data: 'SECRETim', mimeType: 'image/png' })
  })
  test('文字块过脱敏', async () => {
    S.replies.set('navigate', { output: 'a SECRET b', tabId: 1 })
    const r = await call('browser_batch', { actions: [act('navigate', { url: 'x', tabId: 1 })] })
    expect(text(r)).not.toContain('SECRET')
    expect(text(r)).toContain('[S]')
  })
  test('中途出错即停：isError、后面不执行、结果含错误与未执行条数、end 仍发', async () => {
    S.replies.set('form_input', new Error('element_unsupported: not a field'))
    const r = await call('browser_batch', {
      actions: [act('navigate', { url: 'a', tabId: 1 }), act('form_input', { ref: 'r', value: 'v', tabId: 1 }), act('read_page', { tabId: 1 }), act('read_page', { tabId: 2 })],
    })
    expect(r.isError).toBe(true)
    const t = text(r)
    expect(t).toContain('element_unsupported: not a field')
    expect(methods().filter((x) => x === 'read_page').length).toBe(0)
    expect(methods()).toContain('batch_end')
    expect(methods()[methods().length - 1] === 'batch_end' || methods().includes('tabs_context_mcp')).toBe(true)
    // 失败块里写着剩余未执行的项数 2
    const failBlock = texts(r).find((x) => x.includes('element_unsupported'))!
    expect(failBlock).toMatch(/\b2\b/)
    // 标签块仍在
    expect(hasTabBlock(t)).toBe(true)
  })
  test('最后一项出错：未执行数为 0', async () => {
    S.replies.set('navigate', new Error('page_loading: busy'))
    const r = await call('browser_batch', { actions: [act('navigate', { url: 'a', tabId: 1 })] })
    expect(r.isError).toBe(true)
    const failBlock = texts(r).find((x) => x.includes('page_loading'))!
    expect(failBlock).toMatch(/\b0\b/)
  })
  test('批结束后「进行中」复位：随后的独立调用附标签块', async () => {
    await call('browser_batch', { actions: [act('read_page', { tabId: 1 })] })
    const r = await call('read_page', { tabId: 1 })
    expect(hasTabBlock(text(r))).toBe(true)
    // 出错的批之后同样复位
    S.replies.set('navigate', new Error('x: y'))
    await call('browser_batch', { actions: [act('navigate', { url: 'a', tabId: 1 })] })
    S.replies.delete('navigate')
    const r2 = await call('read_page', { tabId: 1 })
    expect(hasTabBlock(text(r2))).toBe(true)
  })
  test('batch_end 自身失败被忽略', async () => {
    S.replies.set('batch_end', new Error('end failed'))
    const r = await call('browser_batch', { actions: [act('read_page', { tabId: 1 })] })
    expect(r.isError).toBe(false)
  })
  test('batch_begin 失败：整个调用报错，不执行各项', async () => {
    S.replies.set('batch_begin', new Error('begin_failed: nope'))
    const r = await call('browser_batch', { actions: [act('read_page', { tabId: 1 })] })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('begin_failed')
    expect(methods()).not.toContain('read_page')
  })
  test('协议版本不一致：末尾多一个含两个版本号的文字块', async () => {
    S.pluginProtocol = 9191
    const r = await call('browser_batch', { actions: [act('read_page', { tabId: 1 })] })
    const ts = texts(r)
    const last = ts[ts.length - 1]
    expect(last).toContain('9191')
    expect(last).toContain(String(FAKE_PROTOCOL))
  })
  test('批内带 max_chars 的 read_page 不影响批整体截断（仍会截断）', async () => {
    S.replies.set('read_page', { pageContent: 'P'.repeat(6000), viewport: { width: 1, height: 1 }, tabId: 1 })
    const r = await call('browser_batch', { actions: [act('read_page', { tabId: 1, max_chars: 100000 })] })
    expect(S.truncCalls.length).toBeGreaterThan(0)
    expect(text(r)).toContain('<<CUT>>')
  })
  test('批内 file_upload 同样分段', async () => {
    const data = 'A'.repeat(600001)
    await call('browser_batch', { actions: [act('file_upload', { ref: 'r', tabId: 1, files: [{ data, name: 'big.bin' }] })] })
    expect(methods().filter((m) => m === 'upload_stash').length).toBe(2)
  })
})

// ---------- file_upload ----------
describe('file_upload 分段与总量限制', () => {
  const stashes = () => S.calls.filter((c) => c.method === 'upload_stash')
  const sent = () => S.calls.find((c) => c.method === 'file_upload')!
  test('小文件原样内联，不发 upload_stash', async () => {
    const files = [{ data: 'QUJD', name: 'a.txt', mimeType: 'text/plain' }]
    const r = await call('file_upload', { ref: 'ref_1', tabId: 2, files })
    expect(r.isError).toBe(false)
    expect(stashes().length).toBe(0)
    expect(sent().params).toEqual({ ref: 'ref_1', tabId: 2, files })
  })
  test('只给 paths：原样转发', async () => {
    await call('file_upload', { ref: 'r', tabId: 2, paths: ['/a/b'] })
    expect(sent().params).toEqual({ ref: 'r', tabId: 2, paths: ['/a/b'] })
  })
  test('data 恰为 600000 字符：不分段', async () => {
    const data = 'A'.repeat(600000)
    await call('file_upload', { ref: 'r', tabId: 1, files: [{ data, name: 'x.bin' }] })
    expect(stashes().length).toBe(0)
    expect(sent().params.files[0].data).toBe(data)
  })
  test('data 600001 字符：分两段，每段 ≤ 600000，拼起来等于原文，文件项换成 stash', async () => {
    const data = Array.from({ length: 600001 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('')
    const r = await call('file_upload', { ref: 'r', tabId: 1, files: [{ data, name: 'big.bin', mimeType: 'application/octet-stream' }] })
    expect(r.isError).toBe(false)
    const st = stashes()
    expect(st.length).toBe(2)
    for (const s of st) expect(s.params.data.length).toBeLessThanOrEqual(600000)
    expect(st[0].params.key).toBe(st[1].params.key)
    expect(typeof st[0].params.key).toBe('string')
    expect(st[0].params.key.length).toBeGreaterThan(0)
    expect(st.map((s) => s.params.data).join('')).toBe(data)
    const item = sent().params.files[0]
    expect('data' in item).toBe(false)
    expect(item).toEqual({ name: 'big.bin', mimeType: 'application/octet-stream', stash: st[0].params.key })
    expect(methods().lastIndexOf('upload_stash')).toBeLessThan(methods().indexOf('file_upload'))
    expect(new Set(S.calls.map((c) => c.sid)).size).toBe(1)
  })
  test('多个文件：顺序保留，只有超长的被分段，key 各不相同', async () => {
    const big1 = 'B'.repeat(1300000)
    const big2 = 'C'.repeat(700000)
    await call('file_upload', {
      ref: 'r',
      tabId: 1,
      files: [
        { data: big1, name: 'one' },
        { data: 'small', name: 'two' },
        { data: big2, name: 'three' },
      ],
    })
    const files = sent().params.files
    expect(files.map((x: any) => x.name)).toEqual(['one', 'two', 'three'])
    expect(files[1]).toEqual({ data: 'small', name: 'two' })
    expect(files[0].stash).not.toBe(files[2].stash)
    const join = (key: string) => stashes().filter((s) => s.params.key === key).map((s) => s.params.data).join('')
    expect(join(files[0].stash)).toBe(big1)
    expect(join(files[2].stash)).toBe(big2)
    expect(stashes().filter((s) => s.params.key === files[0].stash).length).toBe(3)
    // 一个文件的段连续发完，再发下一个
    const keys = stashes().map((s) => s.params.key)
    expect(keys).toEqual([files[0].stash, files[0].stash, files[0].stash, files[2].stash, files[2].stash])
  })
  test('总量正好 10485760 字节：通过', async () => {
    const data = 'A'.repeat(13981014) + '=='
    const r = await call('file_upload', { ref: 'r', tabId: 1, files: [{ data, name: 'x' }] })
    expect(r.isError).toBe(false)
    expect(methods()).toContain('file_upload')
  })
  test('总量 10485761 字节：input_invalid、含 10 MB、不发任何转发', async () => {
    const data = 'A'.repeat(13981015) + '='
    const r = await call('file_upload', { ref: 'r', tabId: 1, files: [{ data, name: 'x' }] })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('input_invalid')
    expect(text(r)).toContain('10 MB')
    expect(S.calls.length).toBe(0)
  })
  test('多个文件合计超限：整体被拒', async () => {
    const half = 'A'.repeat(8000000)
    const r = await call('file_upload', { ref: 'r', tabId: 1, files: [{ data: half, name: 'a' }, { data: half, name: 'b' }] })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('input_invalid')
    expect(S.calls.length).toBe(0)
  })
  test('分段中途失败：错误结果，不再发 file_upload', async () => {
    S.replies.set('upload_stash', (_p: any, n: number) => (n === 2 ? new Error('input_invalid: stash full') : {}))
    const r = await call('file_upload', { ref: 'r', tabId: 1, files: [{ data: 'A'.repeat(1300000), name: 'x' }] })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('stash full')
    expect(methods()).not.toContain('file_upload')
  })
})

// ---------- 浏览器管理 ----------
describe('浏览器管理三工具', () => {
  const plain = (r: R) => {
    expect(r.content.length).toBe(1)
    expect(r.content[0].type).toBe('text')
    expect(S.hintCalls.length).toBe(0)
    expect(S.truncCalls.length).toBe(0)
    expect(S.calls.length).toBe(0)
  }
  test('list_connected_browsers：refresh + refreshInfo，文字含 describe', async () => {
    const r = await call('list_connected_browsers')
    expect(r.isError).toBe(false)
    expect(S.refreshCount).toBe(1)
    expect(S.refreshInfoCount).toBe(1)
    expect(text(r)).toContain('DESCRIBE-LIST[p1]')
    plain(r)
  })
  test('list_connected_browsers：没有浏览器也不报错，且不被脱敏', async () => {
    S.onlineList = []
    const r = await call('list_connected_browsers')
    expect(r.isError).toBe(false)
    expect(text(r)).toContain('DESCRIBE-LIST[]')
  })
  test('select_browser 成功', async () => {
    const r = await call('select_browser', { deviceId: 'p1' })
    expect(r.isError).toBe(false)
    expect(S.selected).toEqual(['p1'])
    expect(S.refreshCount).toBe(1)
    expect(S.refreshInfoCount).toBe(1)
    expect(text(r)).toContain('p1')
    expect(text(r)).toContain('DESCRIBE-LIST[p1]')
    plain(r)
  })
  test('select_browser 失败：isError，含错误文字与 describe', async () => {
    const r = await call('select_browser', { deviceId: 'zzz' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('no-such-browser zzz')
    expect(text(r)).toContain('DESCRIBE-LIST[p1]')
    plain(r)
  })
  test('switch_browser：没有在线浏览器 → explainNoBrowser，且不调 switchBrowser', async () => {
    S.onlineList = []
    const r = await call('switch_browser')
    expect(r.isError).toBe(true)
    expect(text(r)).toContain(S.noBrowserText)
    expect(S.switchCalls.length).toBe(0)
    expect(S.refreshCount).toBe(1)
    plain(r)
  })
  test('switch_browser：超时 → isError，以 timed_out 开头', async () => {
    S.switchResult = null
    const r = await call('switch_browser')
    expect(r.isError).toBe(true)
    expect(text(r).startsWith('timed_out')).toBe(true)
    plain(r)
  })
  test('switch_browser：成功 → 含 describe', async () => {
    S.switchResult = { info: { profileId: 'p1' } }
    const r = await call('switch_browser')
    expect(r.isError).toBe(false)
    expect(text(r)).toContain('DESCRIBE-LIST[p1]')
    plain(r)
  })
  test('switch_browser 超时取值：默认 120000；环境变量为正数时用它，每次调用时读取', async () => {
    S.switchResult = null
    await call('switch_browser')
    process.env.JEV_SWITCH_TIMEOUT_MS = '250'
    await call('switch_browser')
    process.env.JEV_SWITCH_TIMEOUT_MS = '90'
    await call('switch_browser')
    expect(S.switchCalls).toEqual([120000, 250, 90])
  })
  test('switch_browser 超时取值：非数字 / 0 / 空串 → 默认', async () => {
    S.switchResult = null
    for (const v of ['abc', '0', '']) {
      process.env.JEV_SWITCH_TIMEOUT_MS = v
      await call('switch_browser')
    }
    expect(S.switchCalls).toEqual([120000, 120000, 120000])
  })
})
