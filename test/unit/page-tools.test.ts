import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import vm from 'node:vm'
import { makeFakes } from './fakes/page-tools-deps'

const f = makeFakes()
;(globalThis as any).chrome = f.chrome
mock.module('../../extension/debugger.js', () => f.debuggerModule)
mock.module('../../extension/frames.js', () => f.framesModule)
mock.module('../../extension/screenshot.js', () => f.screenshotModule)
mock.module('../../extension/sessions.js', () => f.sessionsModule)
const mod = await import('../../extension/page-tools.js')
const { filterValue, javascriptTool, resizeWindow, uploadStash, fileUpload, uploadImage } = mod as any

const LIMIT = 10485760
const hook = () => (globalThis as any).__jevUpload
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected rejection') }, (e) => e)
const b64 = (s: string) => Buffer.from(s).toString('base64')
let seq = 0
const uniq = (p: string) => `${p}-${++seq}`

const realNow = Date.now
beforeEach(() => f.reset())
afterEach(() => {
  Date.now = realNow
  if (hook()) hook().upload = LIMIT
})

// ---------- 导出面与导入副作用 ----------
describe('导出面', () => {
  test('恰好 6 个导出', () => {
    expect(Object.keys(mod).sort()).toEqual(['fileUpload', 'filterValue', 'javascriptTool', 'resizeWindow', 'uploadImage', 'uploadStash'])
  })
  test('导入后挂上传上限钩子，初值 10 MiB，可写', () => {
    expect(hook()).toBeTypeOf('object')
    expect(hook().upload).toBe(LIMIT)
    hook().upload = 5
    expect(hook().upload).toBe(5)
  })
})

// ---------- filterValue ----------
describe('filterValue：层级', () => {
  test('第 6 层的值（连数字）被换成字符串，第 5 层对象照常展开', () => {
    const out = filterValue({ a: { b: { c: { d: { e: { f: 1, g: 'x' } } } } } })
    const l5 = out.a.b.c.d.e
    expect(typeof l5).toBe('object')
    expect(typeof l5.f).toBe('string')
    expect(typeof l5.g).toBe('string')
    expect(l5.g).not.toBe('x')
  })
  test('第 5 层的原始值原样', () => {
    expect(filterValue({ a: { b: { c: { d: { e: 7 } } } } })).toEqual({ a: { b: { c: { d: { e: 7 } } } } })
  })
  test('数组同样计层', () => {
    const out = filterValue([[[[[[42]]]]]])
    expect(Array.isArray(out[0][0][0][0][0])).toBe(true)
    expect(typeof out[0][0][0][0][0][0]).toBe('string')
  })
  test('原始值与 null 原样', () => {
    expect(filterValue(3)).toBe(3)
    expect(filterValue(true)).toBe(true)
    expect(filterValue(null)).toBe(null)
    expect(filterValue('hello world')).toBe('hello world')
    expect(filterValue({ ok: 1, list: [1, 2], n: null })).toEqual({ ok: 1, list: [1, 2], n: null })
  })
  test('不修改输入', () => {
    const input = { password: 'p', arr: Array.from({ length: 120 }, (_, i) => i) }
    const copy = structuredClone(input)
    filterValue(input)
    expect(input).toEqual(copy)
  })
})

describe('filterValue：长度', () => {
  test('1000 字符原样', () => {
    const s = 'q '.repeat(500)
    expect(filterValue(s)).toBe(s)
  })
  test('1001 字符：前 1000 保留，之后的原文不出现', () => {
    const s = 'q '.repeat(500) + '§'
    const out = filterValue(s)
    expect(out.startsWith(s.slice(0, 1000))).toBe(true)
    expect(out.length).toBeGreaterThan(1000)
    expect(out).not.toContain('§')
  })
  test('数组 150 项 → 101 项，末项是含 50 的字符串', () => {
    const out = filterValue(Array.from({ length: 150 }, (_, i) => i))
    expect(out).toHaveLength(101)
    expect(out.slice(0, 100)).toEqual(Array.from({ length: 100 }, (_, i) => i))
    expect(typeof out[100]).toBe('string')
    expect(out[100]).toContain('50')
  })
  test('数组 100 项不追加', () => {
    expect(filterValue(Array.from({ length: 100 }, () => 0))).toHaveLength(100)
  })
})

describe('filterValue：凭证形态的字符串', () => {
  const blocked = (s: string) => {
    const out = filterValue(s)
    expect(typeof out).toBe('string')
    expect(out).not.toContain(s)
  }
  test.each([
    ['sid=abc; theme=dark'],
    ['a=1&b=2'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'],
    ['QUJDREVGR0hJSktMTU5PUFFSUw=='],
    ['0123456789abcdef0123456789ABCDEF'],
  ])('%p → 整串屏蔽', blocked)
  test('超长的 base64 串被屏蔽而不是截断', () => blocked(Buffer.from(Array.from({ length: 1500 }, (_, i) => (i * 37) % 256)).toString('base64')))
  test.each([['a=1'], ['a;b&c'], ['example.com'], ['qwertyuiopzxcvbnmlk'], ['hello world, this is plain text'], ['a.b.c d']])('%p → 原样', (s) => {
    expect(filterValue(s)).toBe(s)
  })
})

describe('filterValue：键名', () => {
  test.each([
    ['password'], ['userPassword'], ['TOKEN'], ['userTokenValue'], ['clientSecret'], ['api_key'], ['apiKey'], ['X-Api-Key'],
    ['authorization'], ['Authorization'], ['credentials'], ['private-key'], ['privatekey'], ['ACCESS_KEY'], ['bearer'], ['oauthState'], ['sessionId'],
  ])('键 %p 的值被屏蔽', (k) => {
    const out = filterValue({ [k]: 'plainvalue', keep: 'ok' })
    expect(typeof out[k]).toBe('string')
    expect(out[k]).not.toContain('plainvalue')
    expect(out.keep).toBe('ok')
  })
  test('敏感键的值是对象 / 数字也整体屏蔽', () => {
    const out = filterValue({ token: { inner: 'zzz' }, secret: 12345 })
    expect(typeof out.token).toBe('string')
    expect(out.token).not.toContain('zzz')
    expect(typeof out.secret).toBe('string')
    expect(out.secret).not.toContain('12345')
  })
  test.each([['cookie'], ['cookies']])('小写 %p 被屏蔽', (k) => {
    const out = filterValue({ [k]: 'plainvalue' })
    expect(typeof out[k]).toBe('string')
    expect(out[k]).not.toContain('plainvalue')
  })
  test('键名保持原顺序', () => {
    expect(Object.keys(filterValue({ z: 1, password: 'x', a: 2 }))).toEqual(['z', 'password', 'a'])
  })
})

// ---------- javascriptTool ----------
const TAB = 11
const page = (url = 'https://site.test/') => f.state.tabs.set(TAB, { url, windowId: 3 })
const run = (text: string, g?: any, extra: any = {}) => javascriptTool({ action: 'javascript_exec', text, tabId: TAB, ...extra }, { name: 'S', mainTabId: 99 }, g)
const val = (value: unknown, type = typeof value, subtype?: string) => ({ result: { type, ...(subtype && { subtype }), value } })
const compileError = (description: string) => ({
  result: { type: 'object', subtype: 'error', className: 'SyntaxError', description },
  exceptionDetails: { exceptionId: 1, text: 'Uncaught', lineNumber: 1, columnNumber: 0, scriptId: '7', exception: { type: 'object', subtype: 'error', className: 'SyntaxError', description } },
})
const RETURN_ERR = 'SyntaxError: Illegal return statement'

describe('javascriptTool：参数与前置检查', () => {
  test.each([[{ text: '1' }], [{ action: 'JAVASCRIPT_EXEC', text: '1' }], [{ action: 'exec', text: '1' }]])('action 不对 %p → invalid_params', async (p) => {
    page()
    const e = await caught(javascriptTool({ tabId: TAB, ...p }, undefined, f.guard()))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('invalid_params')
    expect(f.state.guardKinds).toHaveLength(0)
    expect(f.state.withDebuggerCalls).toHaveLength(0)
  })
  test.each([[undefined], ['']])('text=%p → invalid_params', async (text) => {
    page()
    const e = await caught(javascriptTool({ action: 'javascript_exec', text, tabId: TAB }))
    expect(e.code).toBe('invalid_params')
    expect(f.state.evals).toHaveLength(0)
  })
  test.each([['chrome://version/'], ['chrome-extension://abc/popup.html'], ['devtools://devtools/x'], ['edge://settings']])('受保护页 %p → chrome_protected_page，不调守卫、不碰调试器', async (url) => {
    page(url)
    const e = await caught(run('1', f.guard()))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('chrome_protected_page')
    expect(e.message).toContain(url.slice(0, url.indexOf('://') + 3))
    expect(f.state.guardKinds).toHaveLength(0)
    expect(f.state.withDebuggerCalls).toHaveLength(0)
  })
  test.each([['about:blank'], ['file:///tmp/a.html'], ['http://x.test/']])('%p 放行', async (url) => {
    page(url)
    f.state.replies.push(val(1))
    expect((await run('1')).output).toBe('1')
  })
  test('标签没有网址 → 失败，不碰调试器', async () => {
    f.state.tabs.set(TAB, {})
    const e = await caught(run('1'))
    expect(e).toBeInstanceOf(Error)
    expect(f.state.withDebuggerCalls).toHaveLength(0)
  })
  test('目标标签由 resolveTabId 决定', async () => {
    f.state.tabs.set(99, { url: 'https://main.test/' })
    f.state.replies.push(val(1))
    const s = { name: 'S', mainTabId: 99 }
    const r = await javascriptTool({ action: 'javascript_exec', text: '1' }, s)
    expect(f.state.resolveCalls[0].s).toBe(s)
    expect(r.tabId).toBe(99)
    expect(f.state.withDebuggerCalls).toEqual([99])
  })
  test('守卫以 javascript_tool 调用；拒绝时原样透传、不碰调试器', async () => {
    page()
    const e = await caught(run('1', f.guard(true)))
    expect(e).toBe(f.denial)
    expect(f.state.guardKinds).toEqual(['javascript_tool'])
    expect(f.state.withDebuggerCalls).toHaveLength(0)
  })
})

describe('javascriptTool：求值', () => {
  test('一次 withDebugger 内发 Runtime.evaluate，参数符合约定', async () => {
    page()
    f.state.replies.push(val(3, 'number'))
    const r = await run('1 + 2', f.guard())
    expect(f.state.guardKinds).toEqual(['javascript_tool'])
    expect(f.state.withDebuggerCalls).toEqual([TAB])
    expect(f.state.evals).toHaveLength(1)
    const c = f.state.evals[0]
    expect(c.inside).toBe(true)
    expect(c.tabId).toBe(TAB)
    expect(c.method).toBe('Runtime.evaluate')
    expect(c.params).toMatchObject({ returnByValue: true, awaitPromise: true, replMode: true, timeout: 40000 })
    expect(c.params.expression).toContain('1 + 2')
    expect(c.ms).toBeGreaterThan(40000)
    expect(r).toEqual({ tabId: TAB, output: '3' })
  })
  test('表达式作为脚本求值得到代码的完成值，末行注释不破坏结构', async () => {
    page()
    await run('const k = 20\nk + 1 // trailing note')
    const ctx = vm.createContext({})
    expect(vm.runInContext(f.state.evals[0].params.expression, ctx)).toBe(21)
  })
  test('顶层 let 不泄漏：同名声明连跑两次不报错', async () => {
    page()
    await run('let dup = 5; dup')
    await run('let dup = 6; dup')
    const ctx = vm.createContext({})
    expect(vm.runInContext(f.state.evals[0].params.expression, ctx)).toBe(5)
    expect(vm.runInContext(f.state.evals[1].params.expression, ctx)).toBe(6)
  })
  test('顶层 return 的编译错误 → 不用 REPL 模式重跑一次，以第二次为准', async () => {
    page()
    f.state.replies.push(compileError(RETURN_ERR), val(25, 'number'))
    const r = await run('return 5 * 5')
    expect(f.state.withDebuggerCalls).toHaveLength(1)
    expect(f.state.evals).toHaveLength(2)
    const second = f.state.evals[1]
    expect(second.inside).toBe(true)
    expect(second.method).toBe('Runtime.evaluate')
    expect(second.params.replMode).toBeFalsy()
    expect(second.params).toMatchObject({ returnByValue: true, awaitPromise: true, timeout: 40000 })
    expect(second.params.expression).toContain('return 5 * 5')
    expect(second.ms).toBeGreaterThan(40000)
    expect(await vm.runInContext(second.params.expression, vm.createContext({}))).toBe(25)
    expect(r.output).toBe('25')
  })
  test('运行中抛出的同名错误（带调用栈）不重跑', async () => {
    page()
    const x = compileError(RETURN_ERR) as any
    x.exceptionDetails.stackTrace = { callFrames: [{ functionName: 'f', url: '', lineNumber: 0, columnNumber: 0, scriptId: '7' }] }
    f.state.replies.push(x)
    const e = await caught(run('throw new SyntaxError("x")'))
    expect(f.state.evals).toHaveLength(1)
    expect(e.code).toBe('js_execution_error')
  })
  test('其他语法错误不重跑', async () => {
    page()
    f.state.replies.push(compileError('SyntaxError: Unexpected token )'))
    const e = await caught(run('1 +)'))
    expect(f.state.evals).toHaveLength(1)
    expect(e.code).toBe('js_execution_error')
    expect(e.message).toContain('Unexpected token )')
  })
})

describe('javascriptTool：失败', () => {
  test('页面异常 → js_execution_error，message 含描述', async () => {
    page()
    f.state.replies.push({ result: {}, exceptionDetails: { text: 'Uncaught', exception: { type: 'object', subtype: 'error', className: 'Error', description: 'Error: oops-9\n    at <anonymous>:1:7' } } })
    const e = await caught(run('throw new Error("oops-9")'))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('js_execution_error')
    expect(e.message).toContain('oops-9')
  })
  test('抛出原始值 → message 含该值', async () => {
    page()
    f.state.replies.push({ result: {}, exceptionDetails: { text: 'Uncaught', exception: { type: 'string', value: 'plain-thrown-17' } } })
    const e = await caught(run('throw "plain-thrown-17"'))
    expect(e.code).toBe('js_execution_error')
    expect(e.message).toContain('plain-thrown-17')
  })
  test('没有任何描述 → message 非空', async () => {
    page()
    f.state.replies.push({ result: {}, exceptionDetails: { text: 'Uncaught' } })
    const e = await caught(run('x'))
    expect(e.code).toBe('js_execution_error')
    expect(e.message.length).toBeGreaterThan(0)
  })
  test('超时终止 → js_timeout，message 含 40', async () => {
    page()
    f.state.replies.push({ result: {}, exceptionDetails: { text: 'Uncaught', exception: { type: 'object', subtype: 'error', className: 'Error', description: 'Error: execution was terminated' } } })
    const e = await caught(run('while(true){}'))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('js_timeout')
    expect(e.message).toContain('40')
  })
  test('调试器失败带 code → code 透传，message 含原文', async () => {
    page()
    f.state.withDebuggerError = Object.assign(new Error('attach refused 31'), { code: 'debugger_attach_failed' })
    const e = await caught(run('1'))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('debugger_attach_failed')
    expect(e.message).toContain('attach refused 31')
  })
  test('send 失败不带 code → js_exception', async () => {
    page()
    f.state.replies.push(new Error('pipe broke 44'))
    const e = await caught(run('1'))
    expect(e.code).toBe('js_exception')
    expect(e.message).toContain('pipe broke 44')
  })
  test('页面跳走 / 关闭 → message 另附建议，与普通失败不同', async () => {
    page()
    const plainMsg = 'zz unrelated failure'
    const navMsg = 'zz target navigated or closed'
    f.state.replies.push(new Error(plainMsg))
    const plain = await caught(run('1'))
    f.state.replies.push(new Error(navMsg))
    const nav = await caught(run('1'))
    expect(nav.code).toBe('js_exception')
    expect(nav.message).toContain(navMsg)
    expect(nav.message.replace(navMsg, '')).not.toBe(plain.message.replace(plainMsg, ''))
  })
})

describe('javascriptTool：输出', () => {
  const out = async (reply: any) => {
    page()
    f.state.replies.push(reply)
    return (await run('x')).output
  }
  test('result 缺省 / undefined → "undefined"', async () => {
    expect(await out({})).toBe('undefined')
    expect(await out({ result: { type: 'undefined' } })).toBe('undefined')
  })
  test('null → "null"', async () => expect(await out({ result: { type: 'object', subtype: 'null', value: null } })).toBe('null'))
  test('函数 → description', async () => expect(await out({ result: { type: 'function', className: 'Function', description: 'function q() {}' } })).toBe('function q() {}'))
  test('DOM 节点 → description', async () => expect(await out({ result: { type: 'object', subtype: 'node', className: 'HTMLDivElement', description: 'div#main' } })).toBe('div#main'))
  test('无 value 的对象 → description', async () => expect(await out({ result: { type: 'object', className: 'Window', description: 'Window' } })).toBe('Window'))
  test('不可序列化的原始值 → description', async () => {
    expect(await out({ result: { type: 'number', unserializableValue: 'NaN', description: 'NaN' } })).toBe('NaN')
    expect(await out({ result: { type: 'bigint', unserializableValue: '10n', description: '10n' } })).toBe('10n')
  })
  test('字符串原样，不加引号', async () => expect(await out(val('awaited'))).toBe('awaited'))
  test('数字、布尔 → JSON 文本', async () => {
    expect(await out(val(25))).toBe('25')
    expect(await out(val(false))).toBe('false')
  })
  test('凭证形态的字符串结果被屏蔽', async () => {
    const o = await out(val('sid=1; uid=2'))
    expect(o).not.toContain('sid=1')
  })
  test('对象 → 脱敏后的 2 空格缩进 JSON', async () => {
    const o = await out(val({ password: 'hunter2', ok: 1, list: [1, 2] }, 'object'))
    expect(o).not.toContain('hunter2')
    expect(o).toContain('"ok": 1')
    expect(o).toBe(JSON.stringify(JSON.parse(o), null, 2))
    const back = JSON.parse(o)
    expect(back.ok).toBe(1)
    expect(back.list).toEqual([1, 2])
    expect(typeof back.password).toBe('string')
  })
  test('数组带 value → 内容的 JSON', async () => {
    expect(JSON.parse(await out(val([10, 20], 'object', 'array')))).toEqual([10, 20])
  })
  test('超过 51200 字符：前 51200 保留，之后原文不出现', async () => {
    const items = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}${'w '.repeat(400)}`)
    const full = JSON.stringify(items, null, 2)
    expect(full.length).toBeGreaterThan(51200 + 1000)
    const o = await out(val(items, 'object', 'array'))
    expect(o.length).toBeGreaterThan(51200)
    expect(o.slice(0, 51200)).toBe(full.slice(0, 51200))
    expect(o.slice(51200).startsWith('\n')).toBe(true)
    expect(o).not.toContain('099')
  })
  test('短输出不截断', async () => {
    const o = await out(val({ k: 'x' }, 'object'))
    expect(o).toBe(JSON.stringify({ k: 'x' }, null, 2))
  })
})

// ---------- resizeWindow ----------
describe('resizeWindow', () => {
  const tab = (windowId?: number) => f.state.tabs.set(TAB, { url: 'https://x.test/', ...(windowId !== undefined && { windowId }) })
  test.each([
    [{ height: 700, tabId: TAB }],
    [{ width: 0, height: 700, tabId: TAB }],
    [{ width: 900, height: 700 }],
    [{ width: '900', height: 700, tabId: TAB }],
    [{ width: 900, height: -5, tabId: TAB }],
    [{ width: 7681, height: 100, tabId: TAB }],
    [{ width: 100, height: 4321, tabId: TAB }],
    [{ width: NaN, height: 100, tabId: TAB }],
    [{ width: 100, height: Infinity, tabId: TAB }],
  ])('%p → invalid_params，不读标签', async (p) => {
    tab(3)
    const e = await caught(resizeWindow(p))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('invalid_params')
    expect(f.state.tabGets).toHaveLength(0)
    expect(f.state.windowUpdates).toHaveLength(0)
  })
  test('超限 message 含 7680x4320', async () => {
    expect((await caught(resizeWindow({ width: 8000, height: 100, tabId: TAB }))).message).toContain('7680x4320')
  })
  test('上限本身允许', async () => {
    tab(3)
    await resizeWindow({ width: 7680, height: 4320, tabId: TAB })
    expect(f.state.windowUpdates).toEqual([{ windowId: 3, props: { width: 7680, height: 4320 } }])
  })
  test('改该标签所在窗口，宽高向下取整，output 含 宽x高', async () => {
    tab(3)
    const r = await resizeWindow({ width: 900.7, height: 700.2, tabId: TAB })
    expect(f.state.windowUpdates).toEqual([{ windowId: 3, props: { width: 900, height: 700 } }])
    expect(Object.keys(r).sort()).toEqual(['output', 'tabId'])
    expect(r.tabId).toBe(TAB)
    expect(r.output).toContain('900x700')
  })
  test('标签没有所属窗口 → 失败，不改窗口', async () => {
    tab()
    const e = await caught(resizeWindow({ width: 900, height: 700, tabId: TAB }))
    expect(e).toBeInstanceOf(Error)
    expect(f.state.windowUpdates).toHaveLength(0)
  })
})

// ---------- uploadStash / fileUpload ----------
const FT = 21
const sess = { name: 'S', mainTabId: FT }
const up = (p: any, g?: any) => fileUpload({ ref: 'ref_3', ...p }, sess, g)

describe('uploadStash', () => {
  test.each([[{ key: 1, data: 'x' }], [{ key: 'k' }], [{ data: 'x' }]])('%p → invalid_params', async (p) => {
    expect((await caught(uploadStash(p))).code).toBe('invalid_params')
  })
  test('resolve 空对象；分段按顺序拼接后交给页面', async () => {
    const k = uniq('stash')
    expect(await uploadStash({ key: k, data: 'AAAA' })).toEqual({})
    await uploadStash({ key: k, data: 'BBBB' })
    await up({ files: [{ stash: k, name: 'big.bin' }] })
    expect(f.state.pageCalls[0].args[0][0].data).toBe('AAAABBBB')
  })
  test('缺 ref / 页面报错导致失败，暂存键同样已消耗', async () => {
    const k1 = uniq('noref')
    await uploadStash({ key: k1, data: 'QQ==' })
    await caught(fileUpload({ files: [{ stash: k1, name: 'a' }] }, sess))
    expect((await caught(up({ files: [{ stash: k1, name: 'a' }] }))).code).toBe('input_invalid')
    const k2 = uniq('pagefail')
    await uploadStash({ key: k2, data: 'QQ==' })
    f.state.pageReplies.push({ error: 'nope', errorCode: 'x' })
    await caught(up({ files: [{ stash: k2, name: 'a' }] }))
    expect((await caught(up({ files: [{ stash: k2, name: 'a' }] }))).code).toBe('input_invalid')
  })
  test('取一次就清空，再取 → input_invalid', async () => {
    const k = uniq('stash')
    await uploadStash({ key: k, data: 'QQ==' })
    await up({ files: [{ stash: k, name: 'a.bin' }] })
    const e = await caught(up({ files: [{ stash: k, name: 'a.bin' }] }))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('input_invalid')
  })
  test('多文件中有一项不合法 → 整次失败，引用的暂存键已消耗', async () => {
    const k = uniq('multi')
    await uploadStash({ key: k, data: 'QQ==' })
    expect((await caught(up({ files: [{ stash: k, name: 'a.bin' }, { data: 'QQ==', name: '..' }] }))).code).toBe('invalid_params')
    expect((await caught(up({ files: [{ stash: k, name: 'a.bin' }] }))).code).toBe('input_invalid')
  })
  test('从未存过的键 → input_invalid', async () => {
    expect((await caught(up({ files: [{ stash: uniq('none'), name: 'a.bin' }] }))).code).toBe('input_invalid')
  })
  test('最后一次追加已过 5 分钟的键 → 取不到', async () => {
    let now = 1_000_000
    Date.now = () => now
    const k = uniq('old')
    await uploadStash({ key: k, data: 'AAAA' })
    now += 5 * 60 * 1000 + 1
    await uploadStash({ key: uniq('other'), data: 'BBBB' })
    expect((await caught(up({ files: [{ stash: k, name: 'a.bin' }] }))).code).toBe('input_invalid')
  })
  test('过期后往同一键追加 → 只剩新段', async () => {
    let now = 2_000_000
    Date.now = () => now
    const k = uniq('reuse')
    await uploadStash({ key: k, data: 'OLD0' })
    now += 5 * 60 * 1000 + 1
    await uploadStash({ key: k, data: 'NEW0' })
    await up({ files: [{ stash: k, name: 'a.bin' }] })
    expect(f.state.pageCalls[0].args[0][0].data).toBe('NEW0')
  })
  test('5 分钟内持续追加不过期', async () => {
    let now = 3_000_000
    Date.now = () => now
    const k = uniq('live')
    await uploadStash({ key: k, data: 'AAAA' })
    now += 4 * 60 * 1000
    await uploadStash({ key: k, data: 'BBBB' })
    now += 4 * 60 * 1000
    await uploadStash({ key: uniq('other'), data: 'CCCC' })
    await up({ files: [{ stash: k, name: 'a.bin' }] })
    expect(f.state.pageCalls[0].args[0][0].data).toBe('AAAABBBB')
  })
})

describe('fileUpload：参数', () => {
  test('files 空、给了 paths → upload_caller_outdated', async () => {
    const e = await caught(up({ paths: ['/tmp/a.txt'] }))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('upload_caller_outdated')
    expect(f.state.pageCalls).toHaveLength(0)
  })
  test.each([[{}], [{ files: [] }], [{ files: [], paths: [] }]])('%p → invalid_params', async (p) => {
    expect((await caught(up(p))).code).toBe('invalid_params')
  })
  test.each([
    [{ data: 1, name: 'a' }],
    [{ name: 'a' }],
    [{ data: 'QQ==' }],
    [{ data: 'QQ==', name: '' }],
    [{ data: 'QQ==', name: 7 }],
    [{ data: 'QQ==', name: 'dir/' }],
    [{ data: 'QQ==', name: '..' }],
    [{ data: 'QQ==', name: 'a/.' }],
    [{ data: 'QQ==', name: 'x'.repeat(256) }],
  ])('文件项 %p → invalid_params，不调守卫、不碰页面', async (file) => {
    const e = await caught(up({ files: [file] }, f.guard()))
    expect(e.code).toBe('invalid_params')
    expect(f.state.guardKinds).toHaveLength(0)
    expect(f.state.pageCalls).toHaveLength(0)
  })
  test('255 字符的文件名允许', async () => {
    await up({ files: [{ data: 'QQ==', name: 'x'.repeat(255) }] })
    expect(f.state.pageCalls[0].args[0][0].name).toHaveLength(255)
  })
  test('缺 ref → invalid_params', async () => {
    const e = await caught(fileUpload({ files: [{ data: 'QQ==', name: 'a' }] }, sess))
    expect(e.code).toBe('invalid_params')
    expect(f.state.pageCalls).toHaveLength(0)
  })
})

describe('fileUpload：大小上限', () => {
  test('累计计算：单个都不超、合起来超 → input_invalid，含 10 MB', async () => {
    hook().upload = 10
    const e = await caught(up({ files: [{ data: b64('123456'), name: 'a' }, { data: b64('abcdef'), name: 'b' }] }))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('input_invalid')
    expect(e.message).toContain('10 MB')
    expect(f.state.pageCalls).toHaveLength(0)
  })
  test('恰好等于上限放行（按解码后字节数，含 = 填充）', async () => {
    hook().upload = 10
    await up({ files: [{ data: b64('1234'), name: 'a' }, { data: b64('abcdef'), name: 'b' }] })
    expect(f.state.pageCalls).toHaveLength(1)
  })
  test('超 1 字节即拒', async () => {
    hook().upload = 10
    expect((await caught(up({ files: [{ data: b64('12345'), name: 'a' }, { data: b64('abcdef'), name: 'b' }] }))).code).toBe('input_invalid')
  })
  test('暂存取回的数据也计入', async () => {
    hook().upload = 4
    const k = uniq('size')
    await uploadStash({ key: k, data: b64('12345') })
    expect((await caught(up({ files: [{ stash: k, name: 'a' }] }))).code).toBe('input_invalid')
  })
})

describe('fileUpload：执行', () => {
  test('文件名去目录、mimeType 只在是字符串时带上，经 callOnRef 调 uploadFiles', async () => {
    f.state.pageReplies.push({ output: 'page says 2 done' })
    const r = await up({ tabId: FT, files: [{ data: 'aGVsbG8=', name: 'a.txt', mimeType: 'text/plain' }, { data: 'eHk=', name: '../../etc/passwd' }, { data: 'eA==', name: 'c:\\dir\\b.bin', mimeType: 5 }] }, f.guard())
    expect(f.state.guardKinds).toEqual(['file_upload'])
    expect(f.state.pageCalls).toHaveLength(1)
    const c = f.state.pageCalls[0]
    expect(c).toMatchObject({ via: 'ref', tabId: FT, target: 'ref_3', op: 'uploadFiles' })
    expect(c.args).toHaveLength(1)
    expect(c.args[0]).toEqual([
      { data: 'aGVsbG8=', name: 'a.txt', mimeType: 'text/plain' },
      { data: 'eHk=', name: 'passwd' },
      { data: 'eA==', name: 'b.bin' },
    ])
    expect('mimeType' in c.args[0][1]).toBe(false)
    expect('mimeType' in c.args[0][2]).toBe(false)
    expect(r).toEqual({ tabId: FT, output: 'page says 2 done' })
  })
  test('页面 error 为空串视同成功', async () => {
    f.state.pageReplies.push({ error: '', output: 'empty-err-ok' })
    expect((await up({ files: [{ data: 'QQ==', name: 'a' }] })).output).toBe('empty-err-ok')
  })
  test('目标标签由 resolveTabId 决定（没给 tabId 用会话主标签）', async () => {
    const r = await fileUpload({ ref: 'ref_1', files: [{ data: 'QQ==', name: 'a' }] }, { name: 'S', mainTabId: 77 })
    expect(r.tabId).toBe(77)
    expect(f.state.pageCalls[0].tabId).toBe(77)
  })
  test('守卫拒绝 → 原样透传，不碰页面', async () => {
    const e = await caught(up({ files: [{ data: 'QQ==', name: 'a' }] }, f.guard(true)))
    expect(e).toBe(f.denial)
    expect(f.state.pageCalls).toHaveLength(0)
  })
  test('页面报错 → code 为页面错误码，message 含页面原文', async () => {
    f.state.pageReplies.push({ error: 'target is a <button> page-err-61', errorCode: 'element_unsupported' })
    const e = await caught(up({ files: [{ data: 'QQ==', name: 'a' }] }))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('element_unsupported')
    expect(e.message).toContain('page-err-61')
    expect(f.state.pageCalls).toHaveLength(1)
  })
})

// ---------- uploadImage ----------
const IT = 31
const isess = { name: 'shots', mainTabId: IT }
const putImg = (id: string, format: string, base64 = 'iVBORw0KGgo=', session = 'shots') => f.state.images.set(`${session}|${id}`, { base64, format })
const img = (p: any, g?: any, s: any = isess) => uploadImage({ imageId: 'pic_1', ...p }, s, g)

describe('uploadImage：参数', () => {
  test.each([[{ imageId: undefined, ref: 'ref_1' }], [{ imageId: '', ref: 'ref_1' }], [{}], [{ ref: 'ref_1', coordinate: [1, 1] }]])('%p → Error，不碰页面', async (p) => {
    putImg('pic_1', 'png')
    const e = await caught(img(p, f.guard()))
    expect(e).toBeInstanceOf(Error)
    expect(e.message.length).toBeGreaterThan(0)
    expect(f.state.guardKinds).toHaveLength(0)
    expect(f.state.pageCalls).toHaveLength(0)
    expect(f.state.imageLookups).toHaveLength(0)
  })
  test('图片不存在 → screenshot_bytes_unavailable，message 含 id', async () => {
    const e = await caught(img({ imageId: 'pic_404', ref: 'ref_1' }, f.guard()))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('screenshot_bytes_unavailable')
    expect(e.message).toContain('pic_404')
    expect(f.state.guardKinds).toHaveLength(0)
  })
  test('按会话名查图；别的会话的图查不到', async () => {
    putImg('pic_1', 'png', 'QQ==', 'other')
    expect((await caught(img({ ref: 'ref_1' }))).code).toBe('screenshot_bytes_unavailable')
    expect(f.state.imageLookups).toEqual([{ session: 'shots', id: 'pic_1' }])
  })
  test('没有会话 → 按空串会话名查', async () => {
    putImg('pic_1', 'png', 'QQ==', '')
    const r = await uploadImage({ imageId: 'pic_1', ref: 'ref_1', tabId: IT }, undefined)
    expect(f.state.imageLookups).toEqual([{ session: '', id: 'pic_1' }])
    expect(r.tabId).toBe(IT)
  })
  test('超过上限 → input_invalid，不调守卫', async () => {
    hook().upload = 3
    putImg('pic_1', 'png', b64('abcd'))
    const e = await caught(img({ ref: 'ref_1' }, f.guard()))
    expect(e.code).toBe('input_invalid')
    expect(f.state.guardKinds).toHaveLength(0)
    expect(f.state.pageCalls).toHaveLength(0)
  })
})

describe('uploadImage：投放', () => {
  test('按 ref：jpeg 默认名 image.jpg，经 uploadFiles 塞进输入框', async () => {
    putImg('pic_1', 'jpeg', '/9j/AAAA')
    f.state.pageReplies.push({ output: 'in-input' })
    const r = await img({ ref: 'f2:ref_9' }, f.guard())
    expect(f.state.guardKinds).toEqual(['upload_image'])
    expect(f.state.pageCalls).toHaveLength(1)
    expect(f.state.pageCalls[0]).toMatchObject({ via: 'ref', tabId: IT, target: 'f2:ref_9', op: 'uploadFiles' })
    expect(f.state.pageCalls[0].args).toEqual([[{ data: '/9j/AAAA', name: 'image.jpg', mimeType: 'image/jpeg' }]])
    expect(r).toEqual({ tabId: IT, output: 'in-input' })
    expect(f.state.imageLookups).toEqual([{ session: 'shots', id: 'pic_1' }])
  })
  test('页面 error 为空串视同成功', async () => {
    putImg('pic_1', 'png')
    f.state.pageReplies.push({ error: '', output: 'fine-empty' })
    expect((await img({ coordinate: [1, 1] })).output).toBe('fine-empty')
  })
  test('png 默认名 image.png；给了 filename 原样用', async () => {
    putImg('pic_1', 'png')
    await img({ ref: 'ref_1' })
    expect(f.state.pageCalls[0].args[0][0]).toMatchObject({ name: 'image.png', mimeType: 'image/png' })
    await img({ ref: 'ref_1', filename: 'dir/shot.jpg' })
    expect(f.state.pageCalls[1].args[0][0].name).toBe('dir/shot.jpg')
  })
  test('ref 不是文件输入框 → 改为拖放到元素中心（主 frame）', async () => {
    putImg('pic_1', 'png')
    f.state.located = [140, 260]
    f.state.pageReplies.push({ error: 'not an input', errorCode: 'element_unsupported' }, { output: 'dropped-ok' })
    const r = await img({ ref: 'f1:ref_4' })
    expect(f.state.locateCalls).toEqual([{ tabId: IT, ref: 'f1:ref_4' }])
    expect(f.state.pageCalls).toHaveLength(2)
    const drop = f.state.pageCalls[1]
    expect(drop).toMatchObject({ via: 'page', tabId: IT, op: 'dropFiles' })
    expect(drop.frameId ?? 0).toBe(0)
    expect(drop.args).toEqual([140, 260, [{ data: 'iVBORw0KGgo=', name: 'image.png', mimeType: 'image/png' }], [140, 260]])
    expect(r).toEqual({ tabId: IT, output: 'dropped-ok' })
  })
  test('ref 其他错误 → 不拖放，直接失败', async () => {
    putImg('pic_1', 'png')
    f.state.pageReplies.push({ error: 'gone away 88', errorCode: 'ref_stale' })
    const e = await caught(img({ ref: 'ref_1' }))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('ref_stale')
    expect(e.message).toContain('gone away 88')
    expect(f.state.locateCalls).toHaveLength(0)
    expect(f.state.pageCalls).toHaveLength(1)
  })
  test('按坐标：先换成视口坐标，再拖放，第 4 个参数为原坐标', async () => {
    putImg('pic_1', 'jpeg', '/9j/BBBB')
    f.state.pageReplies.push({ output: 'dropped-at' })
    const r = await img({ coordinate: [30, 40] })
    expect(f.state.viewportCalls).toEqual([{ tabId: IT, point: [30, 40], action: 'upload_image' }])
    const drop = f.state.pageCalls[0]
    expect(drop).toMatchObject({ via: 'page', tabId: IT, op: 'dropFiles' })
    expect(drop.frameId ?? 0).toBe(0)
    expect(drop.args).toEqual([60, 80, [{ data: '/9j/BBBB', name: 'image.jpg', mimeType: 'image/jpeg' }], [30, 40]])
    expect(r.output).toBe('dropped-at')
  })
  test('坐标越界：toViewport 的错误原样透传，不碰页面', async () => {
    putImg('pic_1', 'png')
    const boom = Object.assign(new Error('fake out of bounds'), { code: 'coordinate_out_of_bounds' })
    f.state.toViewportImpl = () => {
      throw boom
    }
    expect(await caught(img({ coordinate: [9999, 1] }))).toBe(boom)
    expect(f.state.pageCalls).toHaveLength(0)
  })
  test('拖放失败 → code 为页面错误码，message 含页面原文', async () => {
    putImg('pic_1', 'png')
    f.state.pageReplies.push({ error: 'nothing at point 73', errorCode: 'drop_target_missing' })
    const e = await caught(img({ coordinate: [1, 2] }))
    expect(e.code).toBe('drop_target_missing')
    expect(e.message).toContain('nothing at point 73')
  })
  test('守卫拒绝 → 原样透传，不碰页面', async () => {
    putImg('pic_1', 'png')
    expect(await caught(img({ ref: 'ref_1' }, f.guard(true)))).toBe(f.denial)
    expect(f.state.pageCalls).toHaveLength(0)
  })
})
