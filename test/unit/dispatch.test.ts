import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { makeFakes } from './fakes/dispatch-deps'

const f = makeFakes()
;(globalThis as any).chrome = f.chrome
for (const [file, m] of Object.entries(f.modules)) mock.module(`../../extension/${file}`, () => m)
const mod = await import('../../extension/dispatch.js')
const { handle, profileEmail, PROTOCOL_VERSION } = mod as any
const importLog = [...f.log]

const SID = 'S1'
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected rejection') }, (e) => e)
// 第三个参数显式给 undefined 表示「没有会话号」；不给则用 SID
const H = (method: string, params: any = {}, ...sid: [string?]) => handle(method, params, sid.length ? sid[0] : SID)
const tick = () => new Promise((r) => setTimeout(r, 0))
const PENDING = Symbol('pending')
const settledOrPending = (p: Promise<unknown>) => Promise.race([p, new Promise((r) => setTimeout(() => r(PENDING), 20))])
const names = () => f.log.map((e) => e.name)
const first = (name: string) => f.named(name)[0]
const checks = () => f.named('guard.check').map((e) => e.args[0])
// 复查时给的阶段标签只用于报错文案（自定），测试只要求次数，且标签是非空字符串
const expectChecks = (n: number) => {
  expect(checks()).toHaveLength(n)
  for (const l of checks()) expect(typeof l === 'string' && l.length > 0).toBe(true)
}
const expectLabel = (v: unknown) => expect(typeof v === 'string' && (v as string).length > 0).toBe(true)
const deferred = <T = any>() => {
  let resolve!: (v: T) => void
  let reject!: (e: any) => void
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)))
  return { promise, resolve, reject }
}
const sess = () => f.state.sessions.get(SID)

beforeEach(() => f.reset())
// 模块级的任务守卫 / Stop 标记会跨用例残留：每个用例后关掉用到过的会话
afterEach(async () => {
  for (const sid of [SID, 'S2', 'S9']) await handle('session_closed', {}, sid)
})

// ---------- 导出面与导入副作用 ----------
describe('导出面', () => {
  test('恰好 3 个导出，协议版本为 1', () => {
    expect(Object.keys(mod).sort()).toEqual(['PROTOCOL_VERSION', 'handle', 'profileEmail'])
    expect(PROTOCOL_VERSION).toBe(1)
  })
  test('导入时只挂两个监听，不碰存储、不开窗口', () => {
    expect(f.listeners.onRemoved.list()).toHaveLength(1)
    expect(f.listeners.onMessage.list()).toHaveLength(1)
    expect(importLog.filter((e) => /^(storage|win|tabs|identity|runtime)\./.test(e.name))).toEqual([])
  })
})

// ---------- handle：路由与调用生命周期 ----------
describe('handle：路由', () => {
  test('未知方法：Error，code unknown_method，message 含方法名', async () => {
    for (const sid of [SID, undefined]) {
      const e = await caught(H('no_such_thing', {}, sid))
      expect(e).toBeInstanceOf(Error)
      expect(e.code).toBe('unknown_method')
      expect(e.message).toContain('no_such_thing')
    }
  })
  test('没有 sessionId：直接执行，不开会话、不准入、不挂指示器、不起守卫', async () => {
    const r = await H('hello', { tabId: 999 }, undefined)
    expect(r.protocolVersion).toBe(1)
    for (const n of ['beginCall', 'endCall', 'admit', 'trackCall', 'startGuard']) expect(f.named(n)).toHaveLength(0)
  })
  test('有会话：beginCall / endCall / trackCall / done 各一次，结果原样返回', async () => {
    const out = { output: 'x' }
    f.over.navigate = async () => out
    const r = await H('navigate', { url: 'a' })
    expect(r).toEqual({ tabId: 100, output: 'x' })
    expect(f.named('beginCall').map((e) => e.args[0])).toEqual([SID])
    expect(f.named('endCall')).toHaveLength(1)
    expect(first('endCall').args[0]).toBe(sess())
    expect(f.named('trackCall')).toHaveLength(1)
    expect(f.state.calls[0].doneCount).toBe(1)
  })
  test('方法失败：同一个错误对象透传，endCall / done 仍各一次', async () => {
    const boom = Object.assign(new Error('nav broke'), { code: 'nav_code' })
    f.over.navigate = async () => { throw boom }
    expect(await caught(H('navigate', {}))).toBe(boom)
    expect(f.named('endCall')).toHaveLength(1)
    expect(f.state.calls[0].doneCount).toBe(1)
  })
  test('beginCall 失败：原样透传，不 endCall、不 trackCall', async () => {
    const boom = new Error('no session')
    f.over.beginCall = async () => { throw boom }
    expect(await caught(H('navigate', {}))).toBe(boom)
    expect(f.named('endCall')).toHaveLength(0)
    expect(f.named('trackCall')).toHaveLength(0)
  })
  test('给了 tabId：先准入；不在组内则透传准入错误，方法不执行，endCall 一次', async () => {
    const e = await caught(H('navigate', { tabId: 555 }))
    expect(e.code).toBe('tab_outside_group')
    expect(f.named('navigate')).toHaveLength(0)
    expect(f.named('trackCall')).toHaveLength(0)
    expect(f.named('endCall')).toHaveLength(1)
    expect(first('admit').args).toEqual([sess(), 555])
  })
  test('给了组内 tabId：准入通过，按该标签执行', async () => {
    const r = await H('navigate', { tabId: 101 })
    expect(r.tabId).toBe(101)
    expect(first('navigate').args[0]).toBe(101)
  })
  test('没给 tabId：不准入，用会话主标签', async () => {
    const r = await H('navigate', {})
    expect(f.named('admit')).toHaveLength(0)
    expect(r.tabId).toBe(100)
  })
  test.each([['tabs_context_mcp'], ['tabs_create_mcp']])('%s 带组外 tabId 也不准入', async (m) => {
    await H(m, { tabId: 555 })
    expect(f.named('admit')).toHaveLength(0)
  })
  test('tabId 为 0 也算给了，要准入', async () => {
    await caught(H('navigate', { tabId: 0 }))
    expect(first('admit').args[1]).toBe(0)
  })
})

describe('handle：指示器与守卫按工具区分', () => {
  // [方法, 显示指示器(按标签), 起守卫]
  const table: [string, boolean, boolean][] = [
    ['read_page', true, true],
    ['get_page_text', true, true],
    ['computer', true, true],
    ['form_input', true, true],
    ['javascript_tool', true, true],
    ['file_upload', true, true],
    ['upload_image', true, true],
    ['navigate', true, false],
    ['jev_observe', false, false],
    ['gif_creator', false, false],
    ['tabs_context_mcp', false, false],
    ['tabs_create_mcp', false, false],
    ['tabs_close_mcp', false, false],
    ['resize_window', false, false],
    ['read_console_messages', false, false],
    ['read_network_requests', false, false],
    ['upload_stash', false, false],
    ['batch_begin', false, false],
    ['batch_end', false, false],
    ['hello', false, false],
  ]
  test.each(table)('%s：指示器=%p 守卫=%p', async (m, tab, guarded) => {
    await H(m, { tabId: 102, action: 'wait', duration: 1 }).catch(() => {})
    expect(first('trackCall').args).toEqual([SID, tab ? 102 : undefined])
    if (guarded) expect(f.named('startGuard').map((e) => e.args[0])).toEqual([102])
    else expect(f.named('startGuard')).toHaveLength(0)
  })
  test('没给 tabId 时指示器和守卫都落在会话主标签', async () => {
    await H('get_page_text', {}).catch(() => {})
    expect(first('trackCall').args[1]).toBe(100)
    expect(first('startGuard').args[0]).toBe(100)
  })
  test('交给委托工具的守卫就是 startGuard 给的那个；不守卫的工具收到 undefined', async () => {
    await H('javascript_tool', { text: '1' })
    const g = first('javascriptTool').args[2]
    expect(typeof g.check).toBe('function')
    expect(g.tabId).toBe(100)
    await H('read_console_messages', {})
    expect(first('readConsole').args[2]).toBeUndefined()
  })
  test('动作收到的 signal 是本次 trackCall 的 signal', async () => {
    await H('navigate', {})
    expect(first('navigate').args[2]).toBe(f.state.calls[0].controller.signal)
  })
})

describe('handle：Stop', () => {
  test('进行中的调用被 Stop：立刻以 stopped 失败，之后原调用失败不成为未处理拒绝', async () => {
    const d = deferred()
    f.over.navigate = () => d.promise
    const p = H('navigate', {})
    await tick()
    f.state.calls[0].stop()
    const e = await caught(p)
    expect(e.code).toBe('stopped')
    expect(f.named('endCall')).toHaveLength(1)
    expect(f.state.calls[0].doneCount).toBe(1)
    d.reject(new Error('late failure'))
    await tick()
  })
  test('调用开始时信号已中止：computer 以 stopped 失败，不碰输入', async () => {
    f.state.abortOnTrack = true
    const e = await caught(H('computer', { action: 'left_click', coordinate: [1, 1] }))
    expect(e.code).toBe('stopped')
    expect(f.named('input.click')).toHaveLength(0)
  })
})

// ---------- 任务守卫 ----------
describe('jev_task_guard / jev_task_release', () => {
  test('守卫一直挂着，release 后以 { released: true } 结束；release 返回 {}', async () => {
    const g = H('jev_task_guard', { taskId: 't1' })
    expect(await settledOrPending(g)).toBe(PENDING)
    expect(first('trackCall').args).toEqual([SID, 100])
    expect(await H('jev_task_release', { taskId: 't1' })).toEqual({})
    expect(await g).toEqual({ released: true })
  })
  test('release 不存在的任务：返回 {}', async () => {
    expect(await H('jev_task_release', { taskId: 'nope' })).toEqual({})
  })
  test('守卫被 Stop：守卫调用以 stopped 失败；此后本会话新调用直接 stopped，不开会话', async () => {
    const g = H('jev_task_guard', { taskId: 't2' })
    await tick()
    f.state.calls[0].stop()
    expect((await caught(g)).code).toBe('stopped')
    const before = f.named('beginCall').length
    const e = await caught(H('navigate', {}))
    expect(e.code).toBe('stopped')
    expect(f.named('beginCall')).toHaveLength(before)
    expect(f.named('navigate')).toHaveLength(0)
    // 别的会话不受影响
    await H('navigate', {}, 'S2')
    expect(f.named('navigate')).toHaveLength(1)
  })
  test('被 Stop 的会话仍可 batch_end 与 jev_task_release；release 后恢复', async () => {
    const g = H('jev_task_guard', { taskId: 't3' })
    await tick()
    f.state.calls[0].stop()
    await caught(g)
    expect(await H('batch_end', {})).toEqual({})
    expect(f.named('endBatch')).toHaveLength(1)
    expect((await caught(H('batch_begin', {}))).code).toBe('stopped')
    await H('jev_task_release', { taskId: 't3' })
    expect(await H('navigate', {})).toMatchObject({ tabId: 100 })
  })
  test('别的会话 release 这个任务，也解除守卫所属会话的 Stop 标记', async () => {
    const g = H('jev_task_guard', { taskId: 't4' })
    await tick()
    f.state.calls[0].stop()
    await caught(g)
    await H('jev_task_release', { taskId: 't4' }, 'S9')
    expect(await H('navigate', {})).toMatchObject({ tabId: 100 })
  })
  test('本会话 release 一个不存在的任务，也解除本会话的 Stop 标记', async () => {
    const g = H('jev_task_guard', { taskId: 't5' })
    await tick()
    f.state.calls[0].stop()
    await caught(g)
    await H('jev_task_release', { taskId: 'other' })
    expect(await H('navigate', {})).toMatchObject({ tabId: 100 })
  })
})

describe('session_closed', () => {
  test('返回 closeSession 的结果；不开会话', async () => {
    expect(await H('session_closed', {})).toEqual({ closedFake: SID })
    expect(first('closeSession').args[0]).toBe(SID)
    expect(f.named('beginCall')).toHaveLength(0)
  })
  test('结束该会话所有任务守卫（released），别的会话的守卫不动', async () => {
    const a = H('jev_task_guard', { taskId: 'a' })
    const b = H('jev_task_guard', { taskId: 'b' })
    const other = H('jev_task_guard', { taskId: 'c' }, 'S2')
    await tick()
    await H('session_closed', {})
    expect(await a).toEqual({ released: true })
    expect(await b).toEqual({ released: true })
    expect(await settledOrPending(other)).toBe(PENDING)
    await H('jev_task_release', { taskId: 'c' }, 'S2')
    expect(await other).toEqual({ released: true })
  })
  test('清掉该会话的 Stop 标记', async () => {
    const g = H('jev_task_guard', { taskId: 'z' })
    await tick()
    f.state.calls[0].stop()
    await caught(g)
    await H('session_closed', {})
    expect(await H('navigate', {})).toMatchObject({ tabId: 100 })
  })
})

// ---------- 连接确认 ----------
describe('connect_request / connect_cancel / 确认消息', () => {
  const send = (msg: any, senderId = 'self-ext') => {
    const reply = mock(() => {})
    const ret = f.listeners.onMessage.list()[0](msg, { id: senderId }, reply)
    return { reply, ret }
  }
  const openReq = async (rid: string) => {
    const p = H('connect_request', { requestId: rid }, undefined)
    await tick()
    return { p, win: first('win.create') }
  }
  test('开一个获得焦点的弹出窗口，指向扩展内的确认页，带上编码后的请求号', async () => {
    const { p, win } = await openReq('a b&c')
    const o = win.args[0]
    expect(o.type).toBe('popup')
    expect(o.focused).toBe(true)
    expect(o.url.startsWith(f.chrome.runtime.getURL(''))).toBe(true)
    const u = new URL(o.url)
    expect(u.pathname.endsWith('/connect.html')).toBe(true)
    expect(u.searchParams.get('rid')).toBe('a b&c')
    expect(await settledOrPending(p)).toBe(PENDING)
    send({ type: 'connectDecision', requestId: 'a b&c', name: '' })
    await p
  })
  test('用户确认（带名字）：存名字、应答 ok、关窗，请求以 connected true + 名字结束', async () => {
    const { p } = await openReq('r1')
    const { reply, ret } = send({ type: 'connectDecision', requestId: 'r1', name: 'Work' })
    expect(ret).toBe(true)
    expect(await p).toEqual({ connected: true, profileName: 'Work' })
    await tick()
    expect(reply).toHaveBeenCalledWith({ ok: true })
    expect(f.state.store.get('profileName')).toBe('Work')
    expect(f.named('win.remove').map((e) => e.args[0])).toEqual([901])
  })
  test('名字超过 60 个字符截成 60；名字为空不写存储，结果名字为空串', async () => {
    const long = 'n'.repeat(75)
    const r1 = await openReq('r2')
    send({ type: 'connectDecision', requestId: 'r2', name: long })
    expect((await r1.p).profileName).toBe('n'.repeat(60))
    expect(f.state.store.get('profileName')).toBe('n'.repeat(60))
    f.state.store.clear()
    const r2 = await openReq('r3')
    send({ type: 'connectDecision', requestId: 'r3' })
    expect(await r2.p).toEqual({ connected: true, profileName: '' })
    expect(f.state.store.has('profileName')).toBe(false)
  })
  test('connect_cancel：请求以 connected false / cancelled 结束，关窗，返回 {}', async () => {
    const { p } = await openReq('r4')
    expect(await H('connect_cancel', { requestId: 'r4' }, undefined)).toEqual({})
    expect(await p).toEqual({ connected: false, reason: 'cancelled' })
    expect(f.named('win.remove').map((e) => e.args[0])).toEqual([901])
  })
  test('用户关掉确认窗口：请求以 connected false / closed 结束；别的窗口关闭不影响', async () => {
    const { p } = await openReq('r5')
    f.listeners.onRemoved.list()[0](4242)
    expect(await settledOrPending(p)).toBe(PENDING)
    f.listeners.onRemoved.list()[0](901)
    expect(await p).toEqual({ connected: false, reason: 'closed' })
  })
  test('窗口还没开出来就被取消：开出来后立即关掉', async () => {
    const d = deferred<{ id: number }>()
    f.over['win.create'] = () => d.promise
    const p = H('connect_request', { requestId: 'r6' }, undefined)
    await tick()
    await H('connect_cancel', { requestId: 'r6' }, undefined)
    expect(await p).toEqual({ connected: false, reason: 'cancelled' })
    d.resolve({ id: 3131 })
    await tick()
    await tick()
    expect(f.named('win.remove').map((e) => e.args[0])).toEqual([3131])
  })
  test('确认消息对应的请求不存在（已结束或没发过）：照常存名字并应答 ok', async () => {
    const { reply, ret } = send({ type: 'connectDecision', requestId: 'ghost', name: 'Late' })
    expect(ret).toBe(true)
    await tick()
    expect(reply).toHaveBeenCalledWith({ ok: true })
    expect(f.state.store.get('profileName')).toBe('Late')
    expect(f.named('win.remove')).toHaveLength(0)
  })
  test('取消不存在的请求：返回 {}，不关任何窗口', async () => {
    expect(await H('connect_cancel', { requestId: 'ghost' }, undefined)).toEqual({})
    expect(f.named('win.remove')).toHaveLength(0)
  })
  test('关窗失败被吞掉', async () => {
    f.over['win.remove'] = async () => { throw new Error('gone') }
    const { p } = await openReq('r7')
    await H('connect_cancel', { requestId: 'r7' }, undefined)
    expect(await p).toEqual({ connected: false, reason: 'cancelled' })
    await tick()
  })
  test('别的扩展发来的消息：不处理、不应答', () => {
    const { reply, ret } = send({ type: 'setProfileName', name: 'X' }, 'intruder')
    expect(ret).toBeUndefined()
    expect(reply).not.toHaveBeenCalled()
    expect(f.state.store.has('profileName')).toBe(false)
  })
  test('起名消息：存截到 60 字的名字（空串也存），应答 ok，返回 true', async () => {
    const a = send({ type: 'setProfileName', name: 'm'.repeat(80) })
    expect(a.ret).toBe(true)
    await tick()
    expect(f.state.store.get('profileName')).toBe('m'.repeat(60))
    expect(a.reply).toHaveBeenCalledWith({ ok: true })
    const b = send({ type: 'setProfileName' })
    await tick()
    expect(f.state.store.get('profileName')).toBe('')
    expect(b.reply).toHaveBeenCalledWith({ ok: true })
  })
  test('其他类型消息：返回 undefined，不应答', () => {
    for (const msg of [{ type: 'other' }, null, 'text']) {
      const { reply, ret } = send(msg)
      expect(ret).toBeUndefined()
      expect(reply).not.toHaveBeenCalled()
    }
  })
})

// ---------- hello / profileEmail ----------
describe('hello', () => {
  test('恰好 6 个字段，各取自对应来源', async () => {
    f.state.store.set('profileName', 'Home')
    const r = await H('hello', {}, undefined)
    expect(Object.keys(r).sort()).toEqual(['email', 'extensionVersion', 'platform', 'profileId', 'profileName', 'protocolVersion'])
    expect(r.platform).toBe('linux')
    expect(r.profileName).toBe('Home')
    expect(r.email).toBe('person@example.org')
    expect(r.extensionVersion).toBe('3.2.1')
    expect(r.protocolVersion).toBe(1)
  })
  test('没起名：profileName 为空串', async () => {
    expect((await H('hello', {}, undefined)).profileName).toBe('')
  })
  test('profileId：首次生成非空字符串并存下，之后不变', async () => {
    const a = (await H('hello', {}, undefined)).profileId
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
    expect(f.state.store.get('profileId')).toBe(a)
    expect((await H('hello', {}, undefined)).profileId).toBe(a)
  })
  test('profileId：已存的值原样返回，不重写', async () => {
    f.state.store.set('profileId', 'fixed-id')
    expect((await H('hello', {}, undefined)).profileId).toBe('fixed-id')
    expect(f.named('storage.set')).toHaveLength(0)
  })
})

describe('profileEmail', () => {
  test('取任意同步状态的账号邮箱', async () => {
    expect(await profileEmail()).toBe('person@example.org')
    expect(first('identity.getProfileUserInfo').args[0]).toEqual({ accountStatus: 'ANY' })
  })
  test('没有邮箱 → 空串；接口报错 → 空串', async () => {
    f.state.email = undefined
    expect(await profileEmail()).toBe('')
    f.state.email = new Error('identity off')
    expect(await profileEmail()).toBe('')
  })
})

// ---------- 标签工具 ----------
describe('tabs_context_mcp / tabs_create_mcp / tabs_close_mcp', () => {
  test('列出组内标签，标题与网址脱敏；网址缺省时退到待跳网址，再缺省为空串', async () => {
    f.state.tabs = [
      { id: 100, title: 'A', url: 'https://a.test/x' },
      { id: 101, pendingUrl: 'https://b.test/' },
      { id: 102 },
    ]
    const r = await H('tabs_context_mcp', {})
    expect(first('listTabs').args[0]).toBe(sess())
    expect(r).toEqual({
      availableTabs: [
        { tabId: 100, title: '<t:A|https://a.test/x>', url: '<u:https://a.test/x>' },
        { tabId: 101, title: '<t:|https://b.test/>', url: '<u:https://b.test/>' },
        { tabId: 102, title: '<t:|>', url: '<u:>' },
      ],
      tabGroupId: 31,
      initialTabId: 100,
    })
  })
  test('新建：在会话窗口里后台开空白页并入组', async () => {
    const r = await H('tabs_create_mcp', {})
    expect(first('tabs.create').args[0]).toEqual({ windowId: 8, active: false, url: 'about:blank' })
    expect(first('joinGroup').args).toEqual([sess(), 777])
    expect(r).toEqual({ tabId: 777, title: '', url: 'about:blank' })
  })
  test('关闭组内标签：返回 { tabId }', async () => {
    expect(await H('tabs_close_mcp', { tabId: 101 })).toEqual({ tabId: 101 })
    expect(first('tabs.remove').args[0]).toBe(101)
  })
  test('关闭组外标签：准入失败，不关', async () => {
    expect((await caught(H('tabs_close_mcp', { tabId: 404 }))).code).toBe('tab_outside_group')
    expect(f.named('tabs.remove')).toHaveLength(0)
  })
})

// ---------- read_page ----------
describe('read_page', () => {
  const DEFAULTS = { filter: 'interactive', depth: null, maxChars: 50000, refId: null, compact: false }
  test('缺省选项交给 scanAll；先过守卫', async () => {
    f.state.frames = [{ frameId: 0, result: { pageContent: 'main' } }]
    const r = await H('read_page', {})
    expect(first('scanAll').args).toEqual([100, [DEFAULTS]])
    expectChecks(1)
    expect(r).toEqual({ pageContent: 'main', tabId: 100 })
    expect('compact' in r).toBe(false)
    expect('compact' in r).toBe(false)
  })
  test('显式选项', async () => {
    f.state.frames = [{ frameId: 0, result: { pageContent: '' } }]
    await H('read_page', { filter: 'all', depth: 3, max_chars: 10, compact: 1 })
    expect(first('scanAll').args[1]).toEqual([{ filter: 'all', depth: 3, maxChars: 10, refId: null, compact: true }])
  })
  test('守卫拒绝：透传，不扫描', async () => {
    const no = Object.assign(new Error('moved'), { code: 'navigated_away' })
    f.over['guard.check'] = async () => { throw no }
    expect(await caught(H('read_page', {}))).toBe(no)
    expect(f.named('scanAll')).toHaveLength(0)
  })
  test('多个 frame：子 frame 内容接在主 frame 后，编号带前缀；出错或为空的子 frame 跳过；其余字段取主 frame', async () => {
    f.state.frames = [
      { frameId: 0, result: { pageContent: 'top [ref_1]', viewport: { w: 1 } } },
      { frameId: 2, result: { pageContent: 'kid [ref_3]' } },
      { frameId: 3, result: { error: 'bad', pageContent: 'hidden [ref_8]' } },
      { frameId: 4, result: { pageContent: '' } },
    ]
    const r = await H('read_page', {})
    expect(r.viewport).toEqual({ w: 1 })
    expect(r.tabId).toBe(100)
    const lines = r.pageContent.split('\n')
    expect(lines[0]).toBe('top [ref_1]')
    expect(lines.at(-1)).toBe('kid [f2:ref_3]')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('f2')
    expect(r.pageContent).not.toContain('hidden')
    expect(r.pageContent).not.toMatch(/f3|f4/)
  })
  test('主 frame 为空时不以空行开头', async () => {
    f.state.frames = [
      { frameId: 0, result: { pageContent: '' } },
      { frameId: 5, result: { pageContent: 'only [ref_2]' } },
    ]
    const r = await H('read_page', {})
    expect(r.pageContent.startsWith('\n')).toBe(false)
    expect(r.pageContent).toContain('f5')
    expect(r.pageContent.endsWith('only [f5:ref_2]')).toBe(true)
  })
  test('紧凑清单：子 frame 每行行首的编号加 f<id>: 前缀，换行拼接', async () => {
    f.state.frames = [
      { frameId: 0, result: { pageContent: 'a', compact: 'ref_1 a' } },
      { frameId: 2, result: { pageContent: 'b', compact: 'ref_3 b\nref_4 c' } },
    ]
    expect((await H('read_page', {})).compact).toBe('ref_1 a\nf2:ref_3 b\nf2:ref_4 c')
  })
  test('主 frame 没有紧凑清单、子 frame 有：只得子 frame 的（带前缀），无前导换行', async () => {
    f.state.frames = [
      { frameId: 0, result: { pageContent: 'a' } },
      { frameId: 7, result: { pageContent: 'b', compact: 'ref_1 q' } },
    ]
    expect((await H('read_page', {})).compact).toBe('f7:ref_1 q')
  })
  test('主 frame 出错：Error，code 为页面给的码，message 含页面错误', async () => {
    f.state.frames = [{ frameId: 0, result: { error: 'too big page', errorCode: 'page_huge' } }]
    const e = await caught(H('read_page', {}))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('page_huge')
    expect(e.message).toContain('too big page')
  })
  test('href 属性值逐个脱敏（含子 frame）', async () => {
    f.state.frames = [
      { frameId: 0, result: { pageContent: 'link href="https://x.test/?k=1" y' } },
      { frameId: 2, result: { pageContent: 'a href="/p?q=2"' } },
    ]
    const r = await H('read_page', {})
    expect(r.pageContent).toContain('href="<u:https://x.test/?k=1>"')
    expect(r.pageContent).toContain('href="<u:/p?q=2>"')
    expect(r.pageContent).not.toContain('href="https://x.test')
  })
  test('ref_id 带 frame 前缀：只扫那个 frame，refId 为本地编号；结果编号带前缀', async () => {
    f.over.inPage = async () => ({ pageContent: 'sub [ref_9]', compact: 'ref_9 sub' })
    const r = await H('read_page', { ref_id: 'f5:ref_9' })
    expect(f.named('scanAll')).toHaveLength(0)
    expect(first('inPage').args).toEqual([100, 'scan', [{ ...DEFAULTS, refId: 'ref_9' }], 5])
    expect(r.pageContent).toBe('sub [f5:ref_9]')
    expect(r.compact).toBe('f5:ref_9 sub')
    expect(r.tabId).toBe(100)
  })
  test('ref_id 在主 frame：不加前缀', async () => {
    f.over.inPage = async () => ({ pageContent: 'p [ref_2] href="h"', compact: 'ref_2 p' })
    const r = await H('read_page', { ref_id: 'ref_2' })
    expect(first('inPage').args[3] ?? 0).toBe(0)
    expect(r.compact).toBe('ref_2 p')
    expect(r.pageContent).toBe('p [ref_2] href="<u:h>"')
  })
  test('ref_id 扫描出错：带页面错误码失败', async () => {
    f.over.inPage = async () => ({ error: 'gone', errorCode: 'ref_stale' })
    expect((await caught(H('read_page', { ref_id: 'f1:ref_1' }))).code).toBe('ref_stale')
  })
})

// ---------- get_page_text ----------
describe('get_page_text', () => {
  test('主 frame 取正文，缺省上限 50000；标题网址脱敏', async () => {
    f.over.inPage = async () => ({ text: 'body', title: 'Tt', url: 'https://q.test/' })
    const r = await H('get_page_text', {})
    const a = first('inPage').args
    expect(a.slice(0, 3)).toEqual([100, 'pageText', [50000]])
    expect(a[3] ?? 0).toBe(0)
    expectChecks(1)
    expect(r).toEqual({ text: 'body', tabId: 100, title: '<t:Tt|https://q.test/>', url: '<u:https://q.test/>' })
  })
  test('max_chars 透传', async () => {
    f.over.inPage = async () => ({ title: '', url: '' })
    await H('get_page_text', { max_chars: 77 })
    expect(first('inPage').args[2]).toEqual([77])
  })
  test('页面报错：code 固定为 get_page_text_no_content，message 含页面错误', async () => {
    f.over.inPage = async () => ({ error: 'no main text', errorCode: 'whatever' })
    const e = await caught(H('get_page_text', {}))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('get_page_text_no_content')
    expect(e.message).toContain('no main text')
  })
})

// ---------- form_input ----------
describe('form_input', () => {
  test.each([
    [{ value: 'v' }],
    [{ ref: '', value: 'v' }],
    [{ ref: 'ref_1' }],
    [{ ref: 'ref_1', value: null }],
  ])('参数不全 %p → invalid_params，不复查、不碰页面', async (p) => {
    const e = await caught(H('form_input', p))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('invalid_params')
    expectChecks(0)
    expect(f.named('callOnRef')).toHaveLength(0)
  })
  test.each([[false], [0], ['']])('假值 %p 也是合法 value', async (v) => {
    await H('form_input', { ref: 'ref_1', value: v })
    expect(first('callOnRef').args).toEqual([100, 'ref_1', 'formInput', [v]])
  })
  test('成功：先复查，返回 { tabId, output }', async () => {
    const r = await H('form_input', { ref: 'f2:ref_7', value: 'x', tabId: 101 })
    expectChecks(1)
    expect(first('callOnRef').args).toEqual([101, 'f2:ref_7', 'formInput', ['x']])
    expect(r).toEqual({ tabId: 101, output: 'filled' })
  })
  test('页面报错：code 为页面给的码', async () => {
    f.over.callOnRef = async () => ({ error: 'not a field', errorCode: 'element_unsupported' })
    const e = await caught(H('form_input', { ref: 'ref_1', value: 'x' }))
    expect(e.code).toBe('element_unsupported')
    expect(e.message).toContain('not a field')
  })
  test('信号已中止：stopped，不碰页面', async () => {
    f.state.abortOnTrack = true
    expect((await caught(H('form_input', { ref: 'ref_1', value: 'x' }))).code).toBe('stopped')
    expect(f.named('callOnRef')).toHaveLength(0)
  })
})

// ---------- navigate / jev_observe / gif_creator / batch / 委托 ----------
describe('navigate / jev_observe / gif_creator / batch', () => {
  test('navigate：结果并上 tabId，并记一帧', async () => {
    const p = { url: 'https://n.test/' }
    const r = await H('navigate', p)
    expect(first('navigate').args.slice(0, 2)).toEqual([100, p])
    expect(r).toEqual({ tabId: 100, output: 'went' })
    const rec = first('recordAction').args
    expect(rec[0]).toBe(sess())
    expect(rec.slice(1, 4)).toEqual([100, 'navigate', p])
    expect(rec[4]).toEqual({ output: 'went' })
  })
  test('navigate 失败：不记帧', async () => {
    f.over.navigate = async () => { throw new Error('x') }
    await caught(H('navigate', {}))
    expect(f.named('recordAction')).toHaveLength(0)
  })
  test('jev_observe 没给 max：不替观察模块填缺省值', async () => {
    await H('jev_observe', {})
    expect(first('observe').args[1].max).toBeUndefined()
  })
  test('jev_observe：只传 max，结果原样（不加 tabId）', async () => {
    const r = await H('jev_observe', { max: 12, junk: 1 })
    expect(first('observe').args.slice(0, 2)).toEqual([100, { max: 12 }])
    expect(first('observe').args[2]).toBe(f.state.calls[0].controller.signal)
    expect(r).toEqual({ observed: true })
  })
  test('gif_creator：交给录制模块，结果并上 tabId', async () => {
    const p = { action: 'export' }
    expect(await H('gif_creator', p)).toEqual({ tabId: 100, output: 'gif done' })
    expect(first('gifCreator').args).toEqual([p, sess(), 100])
  })
  test('batch_begin / batch_end：各开关一次批次，返回 {}', async () => {
    expect(await H('batch_begin', {})).toEqual({})
    expect(await H('batch_end', {})).toEqual({})
    expect(names().filter((n) => n === 'beginBatch' || n === 'endBatch')).toEqual(['beginBatch', 'endBatch'])
  })
})

describe('委托工具：结果原样返回', () => {
  const cases: [string, string, boolean][] = [
    ['javascript_tool', 'javascriptTool', true],
    ['file_upload', 'fileUpload', true],
    ['upload_image', 'uploadImage', true],
    ['read_console_messages', 'readConsole', true],
    ['read_network_requests', 'readNetwork', true],
    ['resize_window', 'resizeWindow', false],
    ['upload_stash', 'uploadStash', false],
  ]
  test.each(cases)('%s → %s', async (method, dep, withSession) => {
    const out = { marker: method }
    f.over[dep] = async () => out
    const p = { tabId: 100, k: 1 }
    expect(await H(method, p)).toEqual(out)
    const a = first(dep).args
    expect(a[0]).toEqual(p)
    if (withSession) expect(a[1]).toBe(sess())
  })
  test('委托工具的错误原样透传', async () => {
    const boom = Object.assign(new Error('js died'), { code: 'js_timeout' })
    f.over.javascriptTool = async () => { throw boom }
    expect(await caught(H('javascript_tool', {}))).toBe(boom)
  })
})

// ---------- computer ----------
const C = (p: any) => H('computer', p)
const expectBad = async (p: any) => {
  const e = await caught(C(p))
  expect(e).toBeInstanceOf(Error)
  expect(e.code).toBe('invalid_params')
  return e
}

describe('computer：公共', () => {
  test('未知动作 → invalid_params，message 含动作名', async () => {
    expect((await expectBad({ action: 'moonwalk' })).message).toContain('moonwalk')
  })
  test('没给动作 → invalid_params', async () => {
    await expectBad({})
    expect(f.named('recordAction')).toHaveLength(0)
  })
  test('非 wait 动作先以动作名复查；wait 不复查', async () => {
    await C({ action: 'scroll_to', ref: 'ref_1' })
    expectChecks(1)
    f.reset()
    await C({ action: 'wait', duration: 1 })
    expectChecks(0)
  })
  test('复查失败：透传，不做动作', async () => {
    const no = Object.assign(new Error('moved'), { code: 'navigated_away' })
    f.over['guard.check'] = async () => { throw no }
    expect(await caught(C({ action: 'left_click', coordinate: [1, 1] }))).toBe(no)
    expect(f.named('input.click')).toHaveLength(0)
  })
  test('成功后记一帧：(会话, tabId, computer, 参数, 不含 tabId 的结果)', async () => {
    const p = { action: 'hover', coordinate: [3, 4] }
    const r = await C(p)
    const rec = first('recordAction').args
    expect(rec[0]).toBe(sess())
    expect(rec.slice(1, 4)).toEqual([100, 'computer', p])
    const { tabId, ...rest } = r
    expect(rec[4]).toEqual(rest)
    expect(tabId).toBe(100)
  })
  test('失败不记帧', async () => {
    await expectBad({ action: 'hover' })
    expect(f.named('recordAction')).toHaveLength(0)
  })
})

describe('computer：点击', () => {
  test.each([
    ['left_click', 'left', 1],
    ['double_click', 'left', 2],
    ['triple_click', 'left', 3],
  ])('%s 坐标点击：换成视口坐标，指示、拦新标签、后台执行', async (action, button, n) => {
    const r = await C({ action, coordinate: [10.4, 20.6] })
    expect(first('toViewport').args.slice(0, 2)).toEqual([100, [10.4, 20.6]])
    expectLabel(first('toViewport').args[2])
    expect(first('pointIndicator').args).toEqual([100, 20.8, 41.2])
    expect(first('beginClickInterception').args).toEqual([100])
    expect(first('withBackground').args[0]).toBe(100)
    const c = first('input.click').args
    expect(c.slice(0, 6)).toEqual([100, 20.8, 41.2, button, n, 0])
    expect(first('finishClickInterception').args).toEqual([{ armedOn: 100 }, sess()])
    expect(r.output).toMatch(/\b10\b/)
    expect(r.output).toMatch(/\b21\b/)
    expect(r.output).not.toContain('10.4')
    expect(Object.keys(r).sort()).toEqual(['output', 'tabId'])
  })
  test('right_click：右键单击，不拦新标签', async () => {
    await C({ action: 'right_click', coordinate: [1, 2] })
    expect(first('input.click').args.slice(3, 5)).toEqual(['right', 1])
    expect(f.named('beginClickInterception')).toHaveLength(0)
  })
  test('点击前复查两次：动作开始前一次，按下前（经交给输入模块的回调）一次', async () => {
    await C({ action: 'left_click', coordinate: [1, 2] })
    expectChecks(2)
  })
  test('按下前的回调同时检查停止信号：此时已 Stop → stopped，撤销拦截', async () => {
    f.over['input.click'] = async (...a: any[]) => {
      f.state.calls[0].controller.abort()
      await a[6]()
    }
    const e = await caught(C({ action: 'left_click', coordinate: [1, 2] }))
    expect(e.code).toBe('stopped')
    expect(f.named('abortClickInterception')).toHaveLength(1)
  })
  test('修饰键交给 modifierMask，结果作为掩码', async () => {
    await C({ action: 'left_click', coordinate: [1, 2], modifiers: 'shift' })
    expect(first('input.modifierMask').args[0]).toBe('shift')
    expect(first('input.click').args[5]).toBe(9)
  })
  test('ref 点击：用 locateRef 的点，不经坐标换算；output 含 ref', async () => {
    const r = await C({ action: 'left_click', ref: 'f1:ref_4' })
    expect(first('locateRef').args).toEqual([100, 'f1:ref_4'])
    expect(f.named('toViewport')).toHaveLength(0)
    expect(first('input.click').args.slice(1, 3)).toEqual([40.4, 50.6])
    expect(r.output).toContain('f1:ref_4')
  })
  test('ref 为空串：视同没给，走 coordinate', async () => {
    await C({ action: 'left_click', ref: '', coordinate: [1, 1] })
    expect(f.named('locateRef')).toHaveLength(0)
    expect(f.named('toViewport')).toHaveLength(1)
  })
  test('ref 与 coordinate 都给：以 ref 为准', async () => {
    await C({ action: 'left_click', ref: 'ref_2', coordinate: [1, 1] })
    expect(f.named('toViewport')).toHaveLength(0)
  })
  test.each([[{}], [{ coordinate: [1] }], [{ coordinate: 'a,b' }], [{ coordinate: [1, 2, 3] }]])('缺定位 %p → invalid_params', async (p) => {
    await expectBad({ action: 'left_click', ...p })
    expect(f.named('input.click')).toHaveLength(0)
  })
  test('坐标越界：toViewport 的错误原样透传', async () => {
    const oob = Object.assign(new Error('out'), { code: 'coordinate_out_of_bounds' })
    f.over.toViewport = () => { throw oob }
    expect(await caught(C({ action: 'left_click', coordinate: [9e9, 1] }))).toBe(oob)
  })
  test('新开的标签：output 以 newTabNote(ids) 结尾', async () => {
    f.state.newTabs = [201, 202]
    const r = await C({ action: 'left_click', coordinate: [1, 2] })
    expect(first('newTabNote').args[0]).toEqual([201, 202])
    expect(r.output.endsWith(' ~NOTE[201/202]~')).toBe(true)
  })
  test('点击失败（无 code）：computer_action_failed，message 含原文；撤销拦截，不收尾', async () => {
    f.over['input.click'] = async () => { throw new Error('pointer jammed') }
    const e = await caught(C({ action: 'left_click', coordinate: [1, 2] }))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('computer_action_failed')
    expect(e.message).toContain('pointer jammed')
    expect(first('abortClickInterception').args).toEqual([{ armedOn: 100 }])
    expect(f.named('finishClickInterception')).toHaveLength(0)
  })
  test('点击失败（有 code）：保留原 code', async () => {
    f.over['input.click'] = async () => { throw Object.assign(new Error('moved'), { code: 'navigated_away' }) }
    expect((await caught(C({ action: 'double_click', coordinate: [1, 2] }))).code).toBe('navigated_away')
  })
})

describe('computer：hover / type', () => {
  test('hover：动作名 hover 换算，指示，后台悬停，不拦新标签', async () => {
    const r = await C({ action: 'hover', coordinate: [5.5, 6] })
    expectLabel(first('toViewport').args[2])
    expect(first('pointIndicator').args).toEqual([100, 11, 12])
    expect(first('input.hover').args).toEqual([100, 11, 12])
    expect(f.named('beginClickInterception')).toHaveLength(0)
    expect(r.output).toMatch(/\b6\b/)
  })
  test('hover 用 ref：output 含 ref', async () => {
    expect((await C({ action: 'hover', ref: 'ref_3' })).output).toContain('ref_3')
  })
  test('hover 失败：包装', async () => {
    f.over['input.hover'] = async () => { throw new Error('no mouse') }
    const e = await caught(C({ action: 'hover', coordinate: [1, 1] }))
    expect(e.code).toBe('computer_action_failed')
    expect(e.message).toContain('no mouse')
  })
  test.each([[{}], [{ text: '' }], [{ text: 5 }]])('type 参数不对 %p → invalid_params', async (p) => {
    await expectBad({ action: 'type', ...p })
  })
  test('type：后台输入，传 signal；output 含文本', async () => {
    const r = await C({ action: 'type', text: 'héllo' })
    const a = first('input.type').args
    expect(a.slice(0, 2)).toEqual([100, 'héllo'])
    expect(a[2]).toBe(f.state.calls[0].controller.signal)
    expect(first('withBackground').args[0]).toBe(100)
    expect(r.output).toContain('héllo')
  })
  test('type 失败：保留原 code', async () => {
    f.over['input.type'] = async () => { throw Object.assign(new Error('x'), { code: 'stopped' }) }
    expect((await caught(C({ action: 'type', text: 'a' }))).code).toBe('stopped')
  })
})

describe('computer：key', () => {
  const keys = () => f.named('input.key').map((e) => e.args[1])
  test.each([[{}], [{ text: '' }], [{ text: 3 }]])('text 不对 %p → invalid_params', async (p) => {
    await expectBad({ action: 'key', ...p })
  })
  test.each([[0], [-1], [1.5], [101], ['2']])('repeat=%p → invalid_params', async (n) => {
    await expectBad({ action: 'key', text: 'a', repeat: n })
    expect(keys()).toEqual([])
  })
  test('按空白拆键，整组重复 repeat 次；output 含各键', async () => {
    const r = await C({ action: 'key', text: '  Enter   Tab ', repeat: 2 })
    expect(keys()).toEqual(['Enter', 'Tab', 'Enter', 'Tab'])
    expect(first('input.key').args[0]).toBe(100)
    expect(r.output).toContain('Enter')
    expect(r.output).toContain('Tab')
  })
  test('repeat 100 放行', async () => {
    await C({ action: 'key', text: 'a', repeat: 100 })
    expect(keys()).toHaveLength(100)
  })
  test.each([['f5', false], ['ctrl+r', false], ['CMD+R', false], ['cmd+shift+r', true], ['ctrl+f5', true], ['Shift+F5', true]])(
    '单个刷新组合键 %p → 刷新标签（绕过缓存=%p），不按键',
    async (k, hard) => {
      const r = await C({ action: 'key', text: k, repeat: 3 })
      expect(f.named('tabs.reload').map((e) => e.args)).toEqual([[100, { bypassCache: hard }]])
      expect(keys()).toEqual([])
      expect(r.output).toContain(k)
    },
  )
  test('刷新键混在多键里：当普通键按', async () => {
    await C({ action: 'key', text: 'f5 a' })
    expect(f.named('tabs.reload')).toHaveLength(0)
    expect(keys()).toEqual(['f5', 'a'])
  })
  test('含页面缩放组合键：invalid_params，message 含该键，一个键都不按', async () => {
    f.state.zoomKeys.add('ctrl+=')
    const e = await expectBad({ action: 'key', text: 'a ctrl+=' })
    expect(e.message).toContain('ctrl+=')
    expect(keys()).toEqual([])
  })
  test('按到一半被 Stop：stopped，后面的键不再按', async () => {
    let n = 0
    f.over['input.key'] = async () => {
      if (++n === 2) f.state.calls[0].controller.abort()
    }
    const e = await caught(C({ action: 'key', text: 'a b c d' }))
    expect(e.code).toBe('stopped')
    expect(n).toBe(2)
  })
  test('按键失败：包装', async () => {
    f.over['input.key'] = async () => { throw new Error('unknown chord') }
    const e = await caught(C({ action: 'key', text: 'zz' }))
    expect(e.code).toBe('computer_action_failed')
    expect(e.message).toContain('unknown chord')
  })
})

describe('computer：scroll / scroll_to', () => {
  const wheelArgs = () => first('input.wheel').args
  test('缺省方向 down、格数 3，每格 100 像素；output 含方向与格数', async () => {
    const r = await C({ action: 'scroll', coordinate: [7, 8] })
    expect(first('toViewport').args.slice(0, 2)).toEqual([100, [7, 8]])
    expectLabel(first('toViewport').args[2])
    expect(wheelArgs()).toEqual([100, 14, 16, 0, 300])
    expect(r.output).toContain('down')
    expect(r.output).toContain('3')
  })
  test.each([
    ['up', 2, [0, -200]],
    ['down', 1, [0, 100]],
    ['left', 1, [-100, 0]],
    ['right', 4, [400, 0]],
  ])('%s × %p', async (dir, amount, delta) => {
    await C({ action: 'scroll', coordinate: [0, 0], scroll_direction: dir, scroll_amount: amount })
    expect(wheelArgs().slice(3)).toEqual(delta)
  })
  test('格数 0 按缺省 3', async () => {
    await C({ action: 'scroll', coordinate: [0, 0], scroll_amount: 0 })
    expect(wheelArgs()[4]).toBe(300)
  })
  test('方向不认识 → invalid_params；缺坐标 → invalid_params', async () => {
    expect((await expectBad({ action: 'scroll', coordinate: [1, 1], scroll_direction: 'sideways' })).message).toContain('sideways')
    await expectBad({ action: 'scroll' })
    expect(f.named('input.wheel')).toHaveLength(0)
  })
  test('滚轮失败：退到页内滚动（主 frame），整体成功', async () => {
    f.over['input.wheel'] = async () => { throw new Error('wheel off') }
    const r = await C({ action: 'scroll', coordinate: [1, 2], scroll_direction: 'up' })
    const a = first('inPage').args
    expect(a.slice(0, 3)).toEqual([100, 'scrollFallback', [2, 4, 0, -300]])
    expect(a[3] ?? 0).toBe(0)
    expect(r.output).toContain('up')
  })
  test('滚轮成功：不走页内滚动', async () => {
    await C({ action: 'scroll', coordinate: [1, 2] })
    expect(f.named('inPage')).toHaveLength(0)
  })
  test(
    '滚轮一直不返回：到 6 秒上限后退到页内滚动',
    async () => {
      const realSetTimeout = globalThis.setTimeout
      ;(globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => realSetTimeout(fn, ms === 6000 ? 5 : ms, ...rest)
      try {
        f.over['input.wheel'] = () => new Promise(() => {})
        await C({ action: 'scroll', coordinate: [1, 2] })
        expect(f.named('inPage')).toHaveLength(1)
      } finally {
        globalThis.setTimeout = realSetTimeout
      }
    },
    10000,
  )
  test('滚轮正常返回后，6 秒的兜底计时器被清除', async () => {
    const realSet = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    const live = new Set<unknown>()
    ;(globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => {
      const id = realSet(fn, ms, ...rest)
      if (ms === 6000) live.add(id)
      return id
    }
    ;(globalThis as any).clearTimeout = (id: any) => {
      live.delete(id)
      return realClear(id)
    }
    try {
      await C({ action: 'scroll', coordinate: [1, 2] })
      expect(live.size).toBe(0)
    } finally {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    }
  })
  test('页内滚动也失败：包装', async () => {
    f.over['input.wheel'] = async () => { throw new Error('a') }
    f.over.inPage = async () => { throw new Error('page refused') }
    const e = await caught(C({ action: 'scroll', coordinate: [1, 2] }))
    expect(e.code).toBe('computer_action_failed')
    expect(e.message).toContain('page refused')
  })
  test('scroll_to：要 ref；按 ref 定位（滚进视口）；output 含 ref', async () => {
    await expectBad({ action: 'scroll_to' })
    const r = await C({ action: 'scroll_to', ref: 'f3:ref_1' })
    expect(first('locateRef').args).toEqual([100, 'f3:ref_1'])
    expect(r.output).toContain('f3:ref_1')
  })
  test('scroll_to 定位失败：原样透传', async () => {
    const nf = Object.assign(new Error('nf'), { code: 'locate_failed' })
    f.over.locateRef = async () => { throw nf }
    expect(await caught(C({ action: 'scroll_to', ref: 'ref_1' }))).toBe(nf)
  })
})

describe('computer：left_click_drag', () => {
  test.each([
    [{ coordinate: [1, 1] }],
    [{ start_coordinate: [1], coordinate: [1, 1] }],
    [{ start_coordinate: [1, 1] }],
    [{ start_coordinate: [1, 1], coordinate: [2] }],
  ])('缺端点 %p → invalid_params', async (p) => {
    await expectBad({ action: 'left_click_drag', ...p })
    expect(f.named('input.drag')).toHaveLength(0)
  })
  test('两端换算、起点指示、后台拖动；output 含两端取整坐标', async () => {
    const r = await C({ action: 'left_click_drag', start_coordinate: [1.2, 3.7], coordinate: [30, 41.5] })
    expect(f.named('toViewport')).toHaveLength(2)
    for (const e of f.named('toViewport')) expectLabel(e.args[2])
    expect(first('pointIndicator').args).toEqual([100, 2.4, 7.4])
    const d = first('input.drag').args
    expect(d.slice(0, 3)).toEqual([100, [2.4, 7.4], [60, 83]])
    expect(d[3]).toBe(f.state.calls[0].controller.signal)
    for (const n of ['1', '4', '30', '42']) expect(r.output).toMatch(new RegExp(`\\b${n}\\b`))
  })
  test('拖动失败：包装', async () => {
    f.over['input.drag'] = async () => { throw new Error('stuck') }
    const e = await caught(C({ action: 'left_click_drag', start_coordinate: [1, 1], coordinate: [2, 2] }))
    expect(e.code).toBe('computer_action_failed')
    expect(e.message).toContain('stuck')
  })
})

describe('computer：wait', () => {
  test.each([[undefined], [0], [-1], [11]])('duration=%p → invalid_params', async (d) => {
    await expectBad({ action: 'wait', duration: d })
    expect(f.named('abortableSleep')).toHaveLength(0)
  })
  test('按秒换成毫秒交给可中断等待；10 秒放行；output 含秒数', async () => {
    const r = await C({ action: 'wait', duration: 0.5 })
    expect(first('abortableSleep').args[0]).toBe(500)
    expect(first('abortableSleep').args[1]).toBe(f.state.calls[0].controller.signal)
    expect(r.output).toContain('0.5')
    await C({ action: 'wait', duration: 10 })
    expect(f.named('abortableSleep')[1].args[0]).toBe(10000)
  })
  test('等待被 Stop：stopped 透传', async () => {
    f.over.abortableSleep = async () => { throw Object.assign(new Error('s'), { code: 'stopped' }) }
    expect((await caught(C({ action: 'wait', duration: 1 }))).code).toBe('stopped')
  })
})

describe('computer：screenshot / zoom', () => {
  test('截图：后台执行、先唤醒再截；缓存到会话名下；返回图片字段', async () => {
    const r = await C({ action: 'screenshot', scale: 0.5 })
    const n = names()
    expect(n.indexOf('wakeHidden')).toBeGreaterThan(-1)
    expect(n.indexOf('wakeHidden')).toBeLessThan(n.indexOf('screenshot'))
    expect(first('wakeHidden').args[0]).toBe(100)
    expect(first('withBackground').args[0]).toBe(100)
    const s = first('screenshot').args
    expect(s.slice(0, 2)).toEqual([100, 0.5])
    expect(typeof s[2].check).toBe('function')
    expect(first('cacheImage').args).toEqual(['name-S1', 'SHOTB64', 'jpeg'])
    expect(r.imageId).toBe('pic_1')
    expect(r.base64Image).toBe('SHOTB64')
    expect(r.imageFormat).toBe('jpeg')
    expect(r.tabId).toBe(100)
    expect(r.output).toContain('pic_1')
    expect(r.output).toContain('1280x960')
    expect(r.output).toContain('640x480')
  })
  test('zoom：区域与缩放交给 zoom；output 含 imageId 与出图尺寸', async () => {
    const r = await C({ action: 'zoom', region: [0, 0, 10.4, 20], scale: 1 })
    const z = first('zoom').args
    expect(z.slice(0, 3)).toEqual([100, [0, 0, 10.4, 20], 1])
    expect(typeof z[3].check).toBe('function')
    expect(r.imageFormat).toBe('png')
    expect(r.base64Image).toBe('ZOOMB64')
    expect(r.output).toContain(r.imageId)
    expect(r.output).toContain('321x123')
  })
  test('记帧时结果是返回值去掉 tabId（含 imageId 与图片字段）', async () => {
    const { tabId, ...rest } = await C({ action: 'screenshot' })
    expect(tabId).toBe(100)
    expect(first('recordAction').args[4]).toEqual(rest)
    expect(rest.imageId).toBe('pic_1')
  })
  test('截图失败：包装（无 code → computer_action_failed，有 code 保留）', async () => {
    f.over.screenshot = async () => { throw new Error('gpu asleep') }
    const e = await caught(C({ action: 'screenshot' }))
    expect(e.code).toBe('computer_action_failed')
    expect(e.message).toContain('gpu asleep')
    f.over.zoom = async () => { throw Object.assign(new Error('bad region'), { code: 'invalid_params' }) }
    expect((await caught(C({ action: 'zoom', region: [0, 0, 1, 1] }))).code).toBe('invalid_params')
    expect(f.named('cacheImage')).toHaveLength(0)
  })
})
