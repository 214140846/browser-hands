import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { makeLogsChrome } from './fakes/logs-chrome'

// 被测模块导入时就会往 chrome 上挂监听，所以先装假 chrome 再动态导入
// 调试器、会话模块用替身，logs 不依赖它们的真实实现
const fake = makeLogsChrome()
;(globalThis as any).chrome = fake.api
mock.module('../../extension/debugger.js', () => fake.debuggerModule)
mock.module('../../extension/sessions.js', () => fake.sessionsModule)
const mod = await import('../../extension/logs.js')
const { readConsole, readNetwork } = mod
const hook = () => (globalThis as any).__jevLogs

const C_CALL = 'Runtime.consoleAPICalled'
const C_EXC = 'Runtime.exceptionThrown'
const N_REQ = 'Network.requestWillBeSent'
const N_RES = 'Network.responseReceived'
const N_FAIL = 'Network.loadingFailed'
const ON = ['Runtime.enable', 'Network.enable']
const OFF = ['Runtime.disable', 'Network.disable']

let seq = 500
const opened: number[] = []
function tab(url: string | undefined = 'https://shop.example.com/cart') {
  const id = ++seq
  fake.addTab(id, url)
  opened.push(id)
  return id
}
const sess = (id: number) => ({ mainTabId: id })
const log = (t: number, ...vals: unknown[]) =>
  fake.cdp(t, C_CALL, { type: 'log', args: vals.map((value) => ({ type: typeof value, value })), timestamp: 1 })
const msg = (t: number, type: string, text: string) => fake.cdp(t, C_CALL, { type, args: [{ type: 'string', value: text }] })
const con = async (t: number, p: Record<string, unknown> = {}) => (await readConsole({ tabId: t, ...p }, sess(t))).output as string
const net = async (t: number, p: Record<string, unknown> = {}) => (await readNetwork({ tabId: t, ...p }, sess(t))).output as string
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const longestRun = (s: string, ch: string) => Math.max(0, ...(s.match(new RegExp(`${ch}+`, 'g')) ?? []).map((x) => x.length))

beforeAll(() => hook().setIdleMs(60000))
afterAll(() => {
  for (const t of opened) fake.closeTab(t)
})

describe('导出面', () => {
  test('只导出两个读取函数', () => {
    expect(Object.keys(mod).sort()).toEqual(['readConsole', 'readNetwork'])
  })
  test('全局测试钩子提供四个函数', () => {
    for (const k of ['setIdleMs', 'isListening', 'stop', 'counts']) expect(typeof hook()[k]).toBe('function')
  })
  test('返回 { tabId, output }，output 为字符串', async () => {
    const t = tab()
    const r = await readConsole({ tabId: t }, sess(t))
    expect(r.tabId).toBe(t)
    expect(typeof r.output).toBe('string')
    const n = await readNetwork({ tabId: t }, sess(t))
    expect(n.tabId).toBe(t)
    expect(typeof n.output).toBe('string')
  })
})

describe('监听生命周期', () => {
  test('第一次读取前不监听，期间的事件丢弃；读取后开启 Runtime 与 Network 两个域', async () => {
    const t = tab()
    expect(hook().isListening(t)).toBe(false)
    log(t, 'early-bird')
    expect(hook().counts(t)).toEqual({ console: 0, network: 0 })
    await con(t)
    expect(hook().isListening(t)).toBe(true)
    for (const c of ON) expect(fake.cmdsFor(t)).toContain(c)
    expect(fake.held.has(t)).toBe(true)
    expect(await con(t)).not.toContain('early-bird')
    log(t, 'late-bird')
    expect(await con(t)).toContain('late-bird')
  })

  test('参数没给 tabId 时用会话主标签', async () => {
    const t = tab()
    const r = await readConsole({}, sess(t))
    expect(r.tabId).toBe(t)
    expect(hook().isListening(t)).toBe(true)
  })

  test('空闲超时后停止监听并关闭两个域，之后的事件丢弃；再读重新开启', async () => {
    const t = tab()
    hook().setIdleMs(30)
    try {
      await con(t)
      await wait(80)
      expect(hook().isListening(t)).toBe(false)
      for (const c of OFF) expect(fake.cmdsFor(t)).toContain(c)
      expect(fake.held.has(t)).toBe(false)
      log(t, 'while-off')
      expect(hook().counts(t).console).toBe(0)
      hook().setIdleMs(60000)
      const before = fake.cmdsFor(t).filter((c) => c === 'Runtime.enable').length
      await con(t)
      expect(hook().isListening(t)).toBe(true)
      expect(fake.cmdsFor(t).filter((c) => c === 'Runtime.enable').length).toBe(before + 1)
    } finally {
      hook().setIdleMs(60000)
    }
  })

  test('每次读取都重新计时', async () => {
    const t = tab()
    hook().setIdleMs(150)
    try {
      await con(t)
      await wait(100)
      await con(t)
      await wait(100)
      expect(hook().isListening(t)).toBe(true)
      await wait(120)
      expect(hook().isListening(t)).toBe(false)
    } finally {
      hook().setIdleMs(60000)
    }
  })

  test('stop 钩子立即停止监听', async () => {
    const t = tab()
    await con(t)
    hook().stop(t)
    expect(hook().isListening(t)).toBe(false)
    log(t, 'after-stop')
    expect(hook().counts(t).console).toBe(0)
  })

  test('开启域失败：读取抛错，且不处于监听状态', async () => {
    const t = tab()
    fake.failing.add('Network.enable')
    try {
      await expect(con(t)).rejects.toBeInstanceOf(Error)
      expect(hook().isListening(t)).toBe(false)
      expect(fake.held.has(t)).toBe(false)
    } finally {
      fake.failing.delete('Network.enable')
    }
  })

  test('调试器断开后重新挂上，监听中的标签会再次开启两个域', async () => {
    const t = tab()
    await con(t)
    const n = fake.cmdsFor(t).filter((c) => c === 'Network.enable').length
    fake.reattach(t)
    await wait(5)
    expect(fake.cmdsFor(t).filter((c) => c === 'Network.enable').length).toBe(n + 1)
  })

  test('标签关闭：停止监听并丢掉记录', async () => {
    const t = tab()
    await con(t)
    log(t, 'x')
    fake.closeTab(t)
    expect(hook().isListening(t)).toBe(false)
    expect(hook().counts(t)).toEqual({ console: 0, network: 0 })
  })

  test('会话关闭：对其标签停止监听并丢掉记录', async () => {
    const t = tab()
    await con(t)
    log(t, 'x')
    fake.closeSession([t])
    expect(hook().isListening(t)).toBe(false)
    expect(hook().counts(t)).toEqual({ console: 0, network: 0 })
  })
})

describe('控制台记录', () => {
  test('多个参数按顺序以空格拼接；数值、布尔转成文本；无值时用描述', async () => {
    const t = tab()
    await con(t)
    fake.cdp(t, C_CALL, {
      type: 'info',
      args: [
        { type: 'string', value: 'alpha' },
        { type: 'number', value: 42 },
        { type: 'boolean', value: false },
        { type: 'object', description: 'Object-desc' },
      ],
    })
    expect(await con(t)).toContain('alpha 42 false Object-desc')
  })

  test('类型标签为 CDP type 的大写；缺省类型按 log', async () => {
    const t = tab()
    await con(t)
    msg(t, 'warning', 'w-1')
    fake.cdp(t, C_CALL, { args: [{ type: 'string', value: 'no-type' }] })
    const out = await con(t)
    expect(out).toMatch(/\bWARNING\b/)
    expect(out).toMatch(/\bLOG\b/)
  })

  test('有调用位置时显示 地址:行:列', async () => {
    const t = tab()
    await con(t)
    fake.cdp(t, C_CALL, {
      type: 'log',
      args: [{ type: 'string', value: 'located' }],
      stackTrace: { callFrames: [{ url: 'https://cdn.example.net/app.js', lineNumber: 12, columnNumber: 7, functionName: 'f' }] },
    })
    expect(await con(t)).toContain('https://cdn.example.net/app.js:12:7')
  })

  test('异常：用描述作正文，类型标签为 EXCEPTION，附调用栈每帧的地址:行:列', async () => {
    const t = tab()
    await con(t)
    fake.cdp(t, C_EXC, {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: boom-desc' },
        url: 'https://shop.example.com/main.js',
        lineNumber: 3,
        columnNumber: 9,
        stackTrace: {
          callFrames: [
            { functionName: 'outerFn', url: 'https://shop.example.com/main.js', lineNumber: 3, columnNumber: 9 },
            { functionName: '', url: 'https://shop.example.com/lib.js', lineNumber: 40, columnNumber: 2 },
          ],
        },
      },
    })
    const out = await con(t)
    expect(out).toMatch(/\bEXCEPTION\b/)
    expect(out).toContain('TypeError: boom-desc')
    expect(out).toContain('outerFn')
    expect(out).toContain('https://shop.example.com/main.js:3:9')
    expect(out).toContain('https://shop.example.com/lib.js:40:2')
  })

  test('异常没有描述时退回 text 字段；都没有时仍记一条', async () => {
    const t = tab()
    await con(t)
    fake.cdp(t, C_EXC, { exceptionDetails: { text: 'only-text-field' } })
    fake.cdp(t, C_EXC, { exceptionDetails: {} })
    expect(await con(t)).toContain('only-text-field')
    expect(hook().counts(t).console).toBe(2)
  })

  test('正文、调用位置、栈帧里的网址都经过脱敏', async () => {
    const t = tab()
    await con(t)
    fake.cdp(t, C_CALL, {
      type: 'log',
      args: [{ type: 'string', value: 'see https://api.example.com/v1?token=abc123secret ok' }],
      stackTrace: { callFrames: [{ url: 'https://api.example.com/x.js?token=frame999secret', lineNumber: 1, columnNumber: 1 }] },
    })
    fake.cdp(t, C_EXC, {
      exceptionDetails: {
        exception: { description: 'Err at https://api.example.com/?token=exc777secret' },
        stackTrace: { callFrames: [{ functionName: 'g', url: 'https://api.example.com/y.js?token=stk555secret', lineNumber: 2, columnNumber: 3 }] },
      },
    })
    const out = await con(t)
    for (const s of ['abc123secret', 'frame999secret', 'exc777secret', 'stk555secret']) expect(out).not.toContain(s)
    expect(out).toContain('api.example.com')
  })

  test('超长单个参数被截断：保留开头，长度落在上限附近', async () => {
    const t = tab()
    await con(t)
    log(t, 'x'.repeat(50000))
    const n = longestRun(await con(t), 'x')
    expect(n).toBeGreaterThanOrEqual(16384)
    expect(n).toBeLessThanOrEqual(16385)
  })

  test('参数很多时总长有上限，第一个参数一定保留', async () => {
    const t = tab()
    await con(t)
    log(t, 'HEAD-ARG', ...Array.from({ length: 10 }, () => 'y'.repeat(10000)))
    const out = await con(t)
    expect(out).toContain('HEAD-ARG')
    const ys = (out.match(/y/g) ?? []).length
    expect(ys).toBeGreaterThan(10000)
    expect(ys).toBeLessThan(2 * 16385)
  })

  test('异常正文截到 16384 字符', async () => {
    const t = tab()
    await con(t)
    fake.cdp(t, C_EXC, { exceptionDetails: { exception: { description: 'z'.repeat(40000) } } })
    expect(longestRun(await con(t), 'z')).toBe(16384)
  })

  test('每个标签最多保留 10000 条控制台记录，超出丢最早的', async () => {
    const t = tab()
    await con(t)
    for (let i = 0; i < 10005; i++) log(t, `c#${String(i).padStart(5, '0')}#`)
    expect(hook().counts(t).console).toBe(10000)
    const out = await con(t, { limit: 1 })
    expect(out).toContain('c#00005#')
    expect(out).not.toContain('c#00004#')
  })
})

describe('控制台读取与过滤', () => {
  test('onlyErrors 只要 error 与异常', async () => {
    const t = tab()
    await con(t)
    msg(t, 'log', 'plain-log')
    msg(t, 'warning', 'plain-warn')
    msg(t, 'error', 'real-error')
    fake.cdp(t, C_EXC, { exceptionDetails: { exception: { description: 'real-exc' } } })
    const out = await con(t, { onlyErrors: true })
    expect(out).toContain('real-error')
    expect(out).toContain('real-exc')
    expect(out).not.toContain('plain-log')
    expect(out).not.toContain('plain-warn')
  })

  test('pattern 按正则、不区分大小写匹配正文', async () => {
    const t = tab()
    await con(t)
    msg(t, 'log', 'Apple pie')
    msg(t, 'log', 'banana split')
    msg(t, 'log', 'cherry')
    const out = await con(t, { pattern: 'apple|BANANA' })
    expect(out).toContain('Apple pie')
    expect(out).toContain('banana split')
    expect(out).not.toContain('cherry')
  })

  test('pattern 不是合法正则时按不区分大小写的子串匹配', async () => {
    const t = tab()
    await con(t)
    msg(t, 'log', 'call FOO(bar')
    msg(t, 'log', 'other')
    const out = await con(t, { pattern: 'foo(' })
    expect(out).toContain('call FOO(bar')
    expect(out).not.toContain('other')
  })

  test('limit 截取最早的若干条，输出同时给出总数和显示条数', async () => {
    const t = tab()
    await con(t)
    for (let i = 0; i < 7; i++) msg(t, 'log', `item<${i}>`)
    const out = await con(t, { limit: 3 })
    for (const i of [0, 1, 2]) expect(out).toContain(`item<${i}>`)
    for (const i of [3, 4, 5, 6]) expect(out).not.toContain(`item<${i}>`)
    expect(out).toMatch(/\b7\b/)
    expect(out).toMatch(/\b3\b/)
    expect(out.indexOf('item<0>')).toBeLessThan(out.indexOf('item<2>'))
  })

  test('limit 默认 100', async () => {
    const t = tab()
    await con(t)
    for (let i = 0; i < 120; i++) msg(t, 'log', `d<${i}>`)
    const out = await con(t)
    expect(out).toContain('d<99>')
    expect(out).not.toContain('d<100>')
    expect(out).toMatch(/\b120\b/)
  })

  test('clear：本次照常返回结果，之后该标签控制台记录清空（含未命中的）', async () => {
    const t = tab()
    await con(t)
    msg(t, 'log', 'keep-me')
    msg(t, 'log', 'unmatched')
    expect(await con(t, { pattern: 'keep', clear: true })).toContain('keep-me')
    expect(hook().counts(t).console).toBe(0)
    expect(await con(t)).not.toContain('unmatched')
  })

  test('没有结果时：不含任何条目，提示刷新页面', async () => {
    const t = tab()
    msg(t, 'log', 'nope')
    const out = await con(t, { pattern: 'zzz-none' })
    expect(out.length).toBeGreaterThan(0)
    expect(out).toMatch(/refresh|reload/i)
    expect(out).not.toMatch(/\bLOG\b/)
    expect(await con(t, { onlyErrors: true })).toMatch(/refresh|reload/i)
  })
})

describe('网络记录', () => {
  test('请求显示脱敏后的地址和方法；无响应时为未完成，有响应时为状态码', async () => {
    const t = tab()
    await net(t)
    fake.cdp(t, N_REQ, { requestId: 'r1', request: { url: 'https://shop.example.com/ping?token=abc123secret', method: 'GET' } })
    fake.cdp(t, N_REQ, { requestId: 'r2', request: { url: 'https://shop.example.com/slow', method: 'POST' } })
    fake.cdp(t, N_RES, { requestId: 'r1', response: { status: 204 } })
    const out = await net(t)
    expect(out).toContain('shop.example.com/ping')
    expect(out).not.toContain('abc123secret')
    expect(out).toContain('GET')
    expect(out).toContain('POST')
    expect(out).toContain('204')
    const slow = out.slice(out.indexOf('/slow'))
    expect(slow).not.toMatch(/\b\d{3}\b/)
  })

  test('加载失败的请求状态记为 503', async () => {
    const t = tab()
    await net(t)
    fake.cdp(t, N_REQ, { requestId: 'f1', request: { url: 'https://shop.example.com/broken', method: 'GET' } })
    fake.cdp(t, N_FAIL, { requestId: 'f1', errorText: 'net::ERR_FAILED' })
    expect(await net(t)).toContain('503')
  })

  test('未知 requestId 的响应 / 失败事件被忽略', async () => {
    const t = tab()
    await net(t)
    fake.cdp(t, N_RES, { requestId: 'ghost', response: { status: 200 } })
    fake.cdp(t, N_FAIL, { requestId: 'ghost2' })
    expect(hook().counts(t).network).toBe(0)
  })

  test('urlPattern 在脱敏后的地址上做区分大小写的子串匹配', async () => {
    const t = tab()
    await net(t)
    fake.cdp(t, N_REQ, { requestId: 'a', request: { url: 'https://shop.example.com/api/Items?token=abc123secret', method: 'GET' } })
    fake.cdp(t, N_REQ, { requestId: 'b', request: { url: 'https://shop.example.com/static/logo.png', method: 'GET' } })
    const hit = await net(t, { urlPattern: '/api/Items' })
    expect(hit).toContain('/api/Items')
    expect(hit).not.toContain('logo.png')
    expect(await net(t, { urlPattern: '/api/items' })).not.toContain('/api/Items')
    expect(await net(t, { urlPattern: 'abc123secret' })).not.toContain('/api/Items')
  })

  test('limit 截取最早的若干条，输出给出总数', async () => {
    const t = tab()
    await net(t)
    for (let i = 0; i < 6; i++) fake.cdp(t, N_REQ, { requestId: `q${i}`, request: { url: `https://shop.example.com/n${i}x`, method: 'GET' } })
    const out = await net(t, { limit: 2 })
    expect(out).toContain('/n0x')
    expect(out).toContain('/n1x')
    expect(out).not.toContain('/n2x')
    expect(out).toMatch(/\b6\b/)
  })

  test('每个标签最多保留 1000 条请求，超出丢最早的，被丢请求之后的响应不再生效', async () => {
    const t = tab()
    await net(t)
    for (let i = 0; i < 1003; i++) fake.cdp(t, N_REQ, { requestId: `k${i}`, request: { url: `https://shop.example.com/k/${i}/`, method: 'GET' } })
    expect(hook().counts(t).network).toBe(1000)
    fake.cdp(t, N_RES, { requestId: 'k0', response: { status: 418 } })
    const out = await net(t, { limit: 1 })
    expect(out).toContain('/k/3/')
    expect(out).not.toContain('/k/0/')
    expect(out).not.toContain('418')
  })

  test('clear 清空该标签全部请求', async () => {
    const t = tab()
    await net(t)
    fake.cdp(t, N_REQ, { requestId: 'c1', request: { url: 'https://shop.example.com/one', method: 'GET' } })
    expect(await net(t, { clear: true })).toContain('/one')
    expect(hook().counts(t).network).toBe(0)
    fake.cdp(t, N_RES, { requestId: 'c1', response: { status: 200 } })
    expect(hook().counts(t).network).toBe(0)
  })

  test('没有结果时提示刷新；给了 urlPattern 时回显它', async () => {
    const t = tab()
    const out = await net(t)
    expect(out).toMatch(/refresh|reload|trigger/i)
    expect(await net(t, { urlPattern: 'needle-xyz' })).toContain('needle-xyz')
  })
})

describe('换站清空', () => {
  test('同主机换路径保留记录', async () => {
    const t = tab('https://shop.example.com/a')
    await con(t)
    log(t, 'stay')
    fake.goTo(t, 'https://shop.example.com/b?x=1')
    expect(hook().counts(t).console).toBe(1)
  })

  test('换到不同主机：控制台和网络记录都清空，监听保持', async () => {
    const t = tab('https://shop.example.com/a')
    await con(t)
    log(t, 'gone')
    fake.cdp(t, N_REQ, { requestId: 'h1', request: { url: 'https://shop.example.com/x', method: 'GET' } })
    fake.goTo(t, 'https://other.example.org/')
    expect(hook().counts(t)).toEqual({ console: 0, network: 0 })
    expect(hook().isListening(t)).toBe(true)
    fake.cdp(t, N_RES, { requestId: 'h1', response: { status: 200 } })
    expect(hook().counts(t).network).toBe(0)
  })

  test('更新事件不带新地址时不动记录；未跟踪的标签不受影响', async () => {
    const t = tab('https://shop.example.com/a')
    await con(t)
    log(t, 'x')
    fake.update(t, { status: 'complete' })
    expect(hook().counts(t).console).toBe(1)
    const u = tab()
    fake.goTo(u, 'https://elsewhere.example/')
    expect(hook().counts(u)).toEqual({ console: 0, network: 0 })
  })
})

describe('错误', () => {
  test('标签没有地址：抛 Error', async () => {
    const t = tab('') // 空地址等同没有地址
    await expect(readConsole({ tabId: t }, sess(t))).rejects.toBeInstanceOf(Error)
    await expect(readNetwork({ tabId: t }, sess(t))).rejects.toBeInstanceOf(Error)
    expect(hook().isListening(t)).toBe(false)
  })

  test('取标签失败：抛 Error，消息里带原因', async () => {
    const e = await readNetwork({ tabId: 987654 }, sess(1)).catch((x) => x)
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toContain('fake: unknown tab 987654')
  })

  test('守卫用工具名检查；守卫报错时保留其错误码并在消息里带原因', async () => {
    const t = tab()
    const seen: string[] = []
    const guard = {
      check: async (name: string) => {
        seen.push(name)
        if (name.includes('network')) throw Object.assign(new Error('guard-said-no'), { code: 'navigated_away' })
      },
    }
    await readConsole({ tabId: t }, sess(t), guard)
    const e = await readNetwork({ tabId: t }, sess(t), guard).catch((x) => x)
    expect(seen).toEqual(['read_console_messages', 'read_network_requests'])
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('navigated_away')
    expect(e.message).toContain('guard-said-no')
  })

  test('守卫在开启监听之前执行：守卫拒绝时不开始监听', async () => {
    const t = tab()
    const guard = { check: async () => { throw new Error('deny') } }
    await expect(readConsole({ tabId: t }, sess(t), guard)).rejects.toBeInstanceOf(Error)
    expect(hook().isListening(t)).toBe(false)
  })
})
