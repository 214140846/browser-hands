import { afterAll, describe, expect, mock, test } from 'bun:test'
import { installClock, makeDebuggerChrome } from './fakes/debugger-chrome'

// 被测模块导入时就往 chrome 上挂监听、往会话模块的回调表里登记，所以先装假 chrome / 假时钟再动态导入。
// 会话模块用替身：被测模块只用到它的回调表。
const clock = installClock()
const fake = makeDebuggerChrome()
;(globalThis as any).chrome = fake.api
mock.module('../../extension/sessions.js', () => fake.sessionsModule)
const mod = await import('../../extension/debugger.js')
const { attach, detach, send, withDebugger, holdDebugger, releaseDebugger, isAttached, onDebuggerEvent, onDebuggerAttached } = mod
const hook = () => (globalThis as any).__jevDebugger

afterAll(() => clock.restore())

const IDLE = 60000
const ATTACH_LIMIT = 8000
const CMD_LIMIT = 30000
const FAIL_MEMORY = 30000

// Chrome 自己的报错原话（测试输入）
const FOREIGN = 'Cannot access a chrome-extension:// URL of different extension'
const NOT_ATTACHED = (t: number) => `Debugger is not attached to the tab with id: ${t}.`
const DETACHED_MID = 'Detached while handling command.'
const ALREADY = (t: number) => `Another debugger is already attached to the tab with id: ${t}.`
const REFUSED = 'Cannot attach to this target.'

let seq = 100
function tab(url?: string) {
  const id = ++seq
  fake.addTab(id, url ?? 'https://example.com/page')
  return id
}
/** 记下 promise 的结局，不 await（用于配合假时钟观察「还没结束」） */
function track<T>(p: Promise<T>) {
  const s: { done: boolean; value?: T; error?: any } = { done: false }
  p.then(
    (v) => Object.assign(s, { done: true, value: v }),
    (e) => Object.assign(s, { done: true, error: e }),
  )
  return s
}
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e: any) {
    return e
  }
  throw new Error('expected rejection')
}

describe('导出面与导入副作用', () => {
  test('恰好九个导出', () => {
    expect(Object.keys(mod).sort()).toEqual(
      ['attach', 'detach', 'holdDebugger', 'isAttached', 'onDebuggerAttached', 'onDebuggerEvent', 'releaseDebugger', 'send', 'withDebugger'].sort(),
    )
  })
  test('全局测试钩子', () => {
    const h = hook()
    for (const k of ['attach', 'detach', 'isAttached', 'forgetFailure']) expect(typeof h[k]).toBe('function')
    expect(h.inject).toMatchObject({ msg: expect.any(String), times: 0, delayMs: 0 })
  })
  test('导入时登记了三个 chrome 监听和一个会话关闭回调', () => {
    expect(fake.api.debugger.onEvent.subs.length).toBe(1)
    expect(fake.api.debugger.onDetach.subs.length).toBe(1)
    expect(fake.api.tabs.onRemoved.subs.length).toBe(1)
    expect(fake.sessionsModule.sessionClosedHooks.length).toBe(1)
  })
})

describe('attach', () => {
  test('成功：挂上、用协议版本 1.3、开启 Page 域', async () => {
    const t = tab()
    expect(isAttached(t)).toBe(false)
    await attach(t)
    expect(isAttached(t)).toBe(true)
    expect(fake.attachCalls.filter((c) => c.tabId === t)).toEqual([{ tabId: t, version: '1.3' }])
    expect(fake.cmdsFor(t)).toContain('Page.enable')
  })
  test('已挂上再调：不再找 Chrome', async () => {
    const t = tab()
    await attach(t)
    await attach(t)
    expect(fake.attachesFor(t)).toBe(1)
  })
  test('并发调用合并为一次挂载', async () => {
    const t = tab()
    await Promise.all([attach(t), attach(t), attach(t)])
    expect(fake.attachesFor(t)).toBe(1)
  })
  test('受保护页：报 chrome_protected_page，不尝试挂载，也不记失败', async () => {
    for (const url of ['chrome://settings/', 'chrome-extension://abc/page.html', 'devtools://devtools/x.html', 'edge://flags', 'about:srcdoc']) {
      const t = tab(url)
      const e = await codeOf(attach(t))
      expect(e).toBeInstanceOf(Error)
      expect(e.code).toBe('chrome_protected_page')
      expect(fake.attachesFor(t)).toBe(0)
      fake.addTab(t, 'https://example.com/')
      await attach(t) // 换成普通页后立即可挂，说明没记失败
      expect(isAttached(t)).toBe(true)
    }
  })
  test('about:blank 与没有地址的标签照常挂载', async () => {
    const a = tab('about:blank')
    await attach(a)
    expect(isAttached(a)).toBe(true)
    const b = ++seq
    fake.addTab(b, undefined)
    await attach(b)
    expect(isAttached(b)).toBe(true)
  })
  test('取标签信息失败：原错误透传、不带码、不记失败', async () => {
    const t = ++seq
    const e = await codeOf(attach(t))
    expect(e.code).toBeUndefined()
    fake.addTab(t)
    await attach(t)
    expect(isAttached(t)).toBe(true)
  })
  test('Chrome 报「已挂上」（不区分大小写）按成功处理', async () => {
    const a = tab()
    fake.planAttach(a, { error: ALREADY(a) })
    await attach(a)
    expect(isAttached(a)).toBe(true)
    expect(fake.cmdsFor(a)).toContain('Page.enable')
    const b = tab()
    fake.planAttach(b, { error: 'TARGET ALREADY ATTACHED' })
    await attach(b)
    expect(isAttached(b)).toBe(true)
  })
  test('其他挂载报错：Error、debugger_attach_failed、消息含 Chrome 原话、不等待', async () => {
    const t = tab()
    fake.planAttach(t, { error: REFUSED })
    const s = track(attach(t))
    await clock.flush()
    expect(s.done).toBe(true)
    expect(s.error).toBeInstanceOf(Error)
    expect(s.error.code).toBe('debugger_attach_failed')
    expect(s.error.message).toContain(REFUSED)
    expect(isAttached(t)).toBe(false)
  })
  test('失败记忆：30 秒内直接报同码不再挂载，过期后重新尝试', async () => {
    const t = tab()
    fake.planAttach(t, { error: REFUSED })
    await codeOf(attach(t))
    await clock.advance(FAIL_MEMORY - 1)
    const e = await codeOf(attach(t))
    expect(e.code).toBe('debugger_attach_failed')
    expect(fake.attachesFor(t)).toBe(1)
    await clock.advance(1)
    await attach(t)
    expect(fake.attachesFor(t)).toBe(2)
    expect(isAttached(t)).toBe(true)
  })
  test('forgetFailure 与标签关闭都会清掉失败记忆', async () => {
    const a = tab()
    fake.planAttach(a, { error: REFUSED })
    await codeOf(attach(a))
    hook().forgetFailure(a)
    await attach(a)
    expect(isAttached(a)).toBe(true)

    const b = tab()
    fake.planAttach(b, { error: REFUSED })
    await codeOf(attach(b))
    fake.closeTab(b)
    fake.addTab(b)
    await attach(b)
    expect(isAttached(b)).toBe(true)
  })
  test('挂载超时：8 秒没回应报 debugger_attach_failed，并计入失败记忆', async () => {
    const t = tab()
    fake.planAttach(t, 'hang')
    const s = track(attach(t))
    await clock.advance(ATTACH_LIMIT - 1)
    expect(s.done).toBe(false)
    await clock.advance(1)
    expect(s.done).toBe(true)
    expect(s.error.code).toBe('debugger_attach_failed')
    const again = await codeOf(attach(t))
    expect(again.code).toBe('debugger_attach_failed')
    expect(fake.attachesFor(t)).toBe(1)
  })
  test('开启 Page 域失败不影响挂载结果', async () => {
    const t = tab()
    fake.planCommand(t, 'Page.enable', { error: 'boom' })
    await attach(t)
    expect(isAttached(t)).toBe(true)
  })
  test('挂上回调：拿到 tabId，此时 Page 域已开；回调抛错不影响其他回调与挂载', async () => {
    const seen: [number, boolean][] = []
    onDebuggerAttached(() => {
      throw new Error('bad hook')
    })
    onDebuggerAttached((id: number) => seen.push([id, fake.cmdsFor(id).includes('Page.enable')]))
    const t = tab()
    await attach(t)
    expect(seen).toContainEqual([t, true])
    expect(isAttached(t)).toBe(true)
  })
})

describe('外部扩展 iframe 挡住挂载', () => {
  test('清到东西：清理后重试成功', async () => {
    const t = tab()
    fake.setScriptResult(() => [{ result: 2 }, { result: 1 }])
    fake.planAttach(t, { error: FOREIGN }, 'ok')
    const s = track(attach(t))
    await clock.advance(1000)
    expect(s.done).toBe(true)
    expect(s.error).toBeUndefined()
    expect(isAttached(t)).toBe(true)
    const call = fake.scriptCalls.at(-1)
    expect(call.target).toMatchObject({ tabId: t, allFrames: true })
    expect(typeof call.func).toBe('function')
    fake.setScriptResult(undefined)
  })
  test('清到东西但一直被挡：共 5 次尝试，1 秒内结束，报 debugger_attach_failed', async () => {
    const t = tab()
    fake.setScriptResult(() => [{ result: 1 }])
    fake.planAttach(t, ...Array(8).fill({ error: FOREIGN }))
    const s = track(attach(t))
    await clock.advance(1000)
    expect(s.done).toBe(true)
    expect(s.error.code).toBe('debugger_attach_failed')
    expect(fake.attachesFor(t)).toBe(5)
    fake.setScriptResult(undefined)
  })
  test('没清到东西：只再试 1 次', async () => {
    const t = tab()
    fake.setScriptResult(() => [{ result: 0 }, {}])
    fake.planAttach(t, ...Array(8).fill({ error: FOREIGN }))
    const s = track(attach(t))
    await clock.advance(1000)
    expect(s.error.code).toBe('debugger_attach_failed')
    expect(fake.attachesFor(t)).toBe(2)
    fake.setScriptResult(undefined)
  })
  test('清理脚本注入失败：只再试 1 次', async () => {
    const t = tab()
    fake.setScriptResult(() => {
      throw new Error('Cannot access contents of the page.')
    })
    fake.planAttach(t, ...Array(8).fill({ error: FOREIGN }))
    const s = track(attach(t))
    await clock.advance(1000)
    expect(s.error.code).toBe('debugger_attach_failed')
    expect(fake.attachesFor(t)).toBe(2)
    fake.setScriptResult(undefined)
  })
  test('重试中遇到别的报错立刻停止', async () => {
    const t = tab()
    fake.setScriptResult(() => [{ result: 3 }])
    fake.planAttach(t, { error: FOREIGN }, { error: REFUSED }, { error: FOREIGN })
    const s = track(attach(t))
    await clock.advance(1000)
    expect(s.error.code).toBe('debugger_attach_failed')
    expect(s.error.message).toContain(REFUSED)
    expect(fake.attachesFor(t)).toBe(2)
    fake.setScriptResult(undefined)
  })
  test('重试时报「已挂上」按成功处理', async () => {
    const t = tab()
    fake.planAttach(t, { error: FOREIGN }, { error: ALREADY(t) })
    const s = track(attach(t))
    await clock.advance(1000)
    expect(s.error).toBeUndefined()
    expect(isAttached(t)).toBe(true)
  })
  test('清理只在首次被拦截时做一次', async () => {
    const t = tab()
    const before = fake.scriptCalls.length
    fake.setScriptResult(() => [{ result: 1 }])
    fake.planAttach(t, ...Array(8).fill({ error: FOREIGN }))
    track(attach(t))
    await clock.advance(1000)
    expect(fake.scriptCalls.length - before).toBe(1)
    fake.setScriptResult(undefined)
  })
  test('挂载超时按每次尝试单独计；重试超时即结束', async () => {
    const t = tab()
    fake.planAttach(t, { error: FOREIGN }, 'hang', 'ok')
    const s = track(attach(t))
    await clock.advance(ATTACH_LIMIT) // 整体 8 秒的话此刻已结束
    expect(s.done).toBe(false)
    await clock.advance(1000)
    expect(s.error.code).toBe('debugger_attach_failed')
    expect(fake.attachesFor(t)).toBe(2)
  })
  test('别的报错不触发清理', async () => {
    const t = tab()
    const before = fake.scriptCalls.length
    fake.planAttach(t, { error: REFUSED })
    await codeOf(attach(t))
    expect(fake.scriptCalls.length).toBe(before)
  })
})

describe('测试钩子 inject', () => {
  test('接下来 N 次挂载尝试按指定消息失败，不找 Chrome，次数递减', async () => {
    const t = tab()
    Object.assign(hook().inject, { msg: REFUSED, times: 1, delayMs: 0 })
    const s = track(attach(t))
    await clock.advance(10)
    const e = s.error
    expect(e.code).toBe('debugger_attach_failed')
    expect(fake.attachesFor(t)).toBe(0)
    expect(hook().inject.times).toBe(0)
  })
  test('delayMs 之后才失败；并发挂载只消耗一次', async () => {
    const t = tab()
    Object.assign(hook().inject, { msg: REFUSED, times: 3, delayMs: 1500 })
    const a = track(attach(t))
    const b = track(attach(t))
    await clock.advance(1499)
    expect(a.done || b.done).toBe(false)
    await clock.advance(1)
    expect(a.error.code).toBe('debugger_attach_failed')
    expect(b.error.code).toBe('debugger_attach_failed')
    expect(hook().inject.times).toBe(2)
    Object.assign(hook().inject, { times: 0, delayMs: 0 })
  })
  test('注入外部扩展报错：走清理重试后挂上', async () => {
    const t = tab()
    Object.assign(hook().inject, { msg: FOREIGN, times: 1, delayMs: 0 })
    const s = track(attach(t))
    await clock.advance(1000)
    expect(s.error).toBeUndefined()
    expect(isAttached(t)).toBe(true)
    expect(fake.attachesFor(t)).toBe(1)
  })
})

describe('detach', () => {
  test('解除挂载；Chrome 报错也正常结束', async () => {
    const t = tab()
    await attach(t)
    await detach(t)
    expect(isAttached(t)).toBe(false)
    expect(fake.detachCalls).toContain(t)
  })
  test('取消待执行的空闲断开', async () => {
    const t = tab()
    await withDebugger(t, async () => {})
    await detach(t)
    await clock.advance(IDLE * 2)
    expect(fake.detachCalls.filter((x) => x === t).length).toBe(1)
  })
})

describe('send', () => {
  test('没挂就先挂，返回 CDP 响应对象，参数原样传给 Chrome', async () => {
    const t = tab()
    fake.planCommand(t, 'X.do', { result: { ok: 42 } })
    const r = await send(t, 'X.do', { a: 1 })
    expect(r).toEqual({ ok: 42 })
    expect(isAttached(t)).toBe(true)
    expect(fake.commands.find((c) => c.tabId === t && c.method === 'X.do')?.params).toEqual({ a: 1 })
  })
  test('Chrome 报普通错误：Error、消息为 Chrome 原话、不带码', async () => {
    const t = tab()
    fake.planCommand(t, 'X.do', { error: 'Some CDP failure' })
    const e = await codeOf(send(t, 'X.do'))
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('Some CDP failure')
    expect(e.code).toBeUndefined()
  })
  test('报「没挂上」：重挂一次再发', async () => {
    const t = tab()
    await attach(t)
    fake.planCommand(t, 'X.do', { error: NOT_ATTACHED(t) }, { result: { v: 1 } })
    expect(await send(t, 'X.do')).toEqual({ v: 1 })
    expect(fake.attachesFor(t)).toBe(2)
    expect(isAttached(t)).toBe(true)
  })
  test('报「处理中被断开」（不区分大小写）：同样重挂一次', async () => {
    const t = tab()
    await attach(t)
    fake.planCommand(t, 'X.do', { error: DETACHED_MID.toUpperCase() }, { result: { v: 2 } })
    expect(await send(t, 'X.do')).toEqual({ v: 2 })
    expect(fake.attachesFor(t)).toBe(2)
  })
  test('重挂后仍失败：抛第二次的错，只重挂一次', async () => {
    const t = tab()
    await attach(t)
    fake.planCommand(t, 'X.do', { error: NOT_ATTACHED(t) }, { error: NOT_ATTACHED(t) }, { result: {} })
    const e = await codeOf(send(t, 'X.do'))
    expect(e.message).toBe(NOT_ATTACHED(t))
    expect(fake.attachesFor(t)).toBe(2)
  })
  test('重挂失败：以重挂的错误原样失败，不重发', async () => {
    const t = tab()
    await attach(t)
    fake.planCommand(t, 'X.do', { error: NOT_ATTACHED(t) }, { result: {} })
    fake.planAttach(t, { error: REFUSED })
    const e = await codeOf(send(t, 'X.do'))
    expect(e.code).toBe('debugger_attach_failed')
    expect(e.message).toContain(REFUSED)
    expect(fake.cmdsFor(t).filter((m) => m === 'X.do').length).toBe(1)
  })
  test('超时不含自动挂载时间；重发重新计时', async () => {
    const t = tab()
    Object.assign(hook().inject, { msg: ALREADY(t), times: 1, delayMs: 5000 })
    fake.planCommand(t, 'X.slow', 'hang')
    const s = track(send(t, 'X.slow', {}, 1000))
    await clock.advance(5000 + 999)
    expect(s.done).toBe(false)
    await clock.advance(1)
    expect(s.error.code).toBe('cdp_timeout')
    Object.assign(hook().inject, { times: 0, delayMs: 0 })

    const u = tab()
    await attach(u)
    fake.planCommand(u, 'X.slow', { error: NOT_ATTACHED(u) }, 'hang')
    const r = track(send(u, 'X.slow', {}, 1000))
    await clock.advance(999)
    expect(r.done).toBe(false)
    await clock.advance(1)
    expect(r.error.code).toBe('cdp_timeout')
  })
  test('默认 30 秒超时报 cdp_timeout', async () => {
    const t = tab()
    await attach(t)
    fake.planCommand(t, 'X.slow', 'hang')
    const s = track(send(t, 'X.slow'))
    await clock.advance(CMD_LIMIT - 1)
    expect(s.done).toBe(false)
    await clock.advance(1)
    expect(s.error).toBeInstanceOf(Error)
    expect(s.error.code).toBe('cdp_timeout')
  })
  test('ms 参数覆盖超时', async () => {
    const t = tab()
    await attach(t)
    fake.planCommand(t, 'X.slow', 'hang')
    const s = track(send(t, 'X.slow', {}, 500))
    await clock.advance(499)
    expect(s.done).toBe(false)
    await clock.advance(1)
    expect(s.error.code).toBe('cdp_timeout')
  })
  test('挂不上：带挂载错误码失败，不发命令', async () => {
    const t = tab()
    fake.planAttach(t, { error: REFUSED })
    expect((await codeOf(send(t, 'X.do'))).code).toBe('debugger_attach_failed')
    const p = tab('chrome://newtab/')
    expect((await codeOf(send(p, 'X.do'))).code).toBe('chrome_protected_page')
    expect(fake.cmdsFor(t)).not.toContain('X.do')
  })
  test('只经 send 挂上的标签不会因空闲断开', async () => {
    const t = tab()
    await send(t, 'X.do')
    await clock.advance(IDLE * 3)
    expect(isAttached(t)).toBe(true)
  })
})

describe('withDebugger 与空闲断开', () => {
  test('先挂上再执行 fn，返回 fn 的结果；fn 抛错原样抛出', async () => {
    const t = tab()
    expect(await withDebugger(t, async () => isAttached(t))).toBe(true)
    const boom = new Error('fn failed')
    expect(await codeOf(withDebugger(t, async () => Promise.reject(boom)))).toBe(boom)
  })
  test('挂不上（debugger_attach_failed）仍执行 fn', async () => {
    const t = tab()
    fake.planAttach(t, { error: REFUSED })
    expect(await withDebugger(t, async () => 'ran')).toBe('ran')
    await clock.advance(IDLE * 2)
    expect(fake.detachCalls).not.toContain(t)
  })
  test('其他挂载错误：直接失败，不执行 fn', async () => {
    const t = tab('chrome://settings/')
    let ran = false
    const e = await codeOf(withDebugger(t, async () => void (ran = true)))
    expect(e.code).toBe('chrome_protected_page')
    expect(ran).toBe(false)
  })
  test('最后一次使用结束后满 60 秒自动断开', async () => {
    const t = tab()
    await withDebugger(t, async () => {})
    await clock.advance(IDLE - 1)
    expect(isAttached(t)).toBe(true)
    await clock.advance(1)
    expect(isAttached(t)).toBe(false)
    expect(fake.detachCalls).toContain(t)
  })
  test('并发使用：最后一个结束才开始计时', async () => {
    const t = tab()
    let release!: () => void
    const long = withDebugger(t, () => new Promise<void>((r) => (release = r)))
    await clock.flush()
    await withDebugger(t, async () => {})
    await clock.advance(IDLE * 2)
    expect(isAttached(t)).toBe(true)
    release()
    await long
    await clock.advance(IDLE)
    expect(isAttached(t)).toBe(false)
  })
  test('再次使用会取消正在走的计时', async () => {
    const t = tab()
    await withDebugger(t, async () => {})
    await clock.advance(IDLE / 2)
    await withDebugger(t, async () => {})
    await clock.advance(IDLE / 2 + 1000)
    expect(isAttached(t)).toBe(true)
    await clock.advance(IDLE / 2)
    expect(isAttached(t)).toBe(false)
  })
  test('hold 期间不计时；release 后满 60 秒断开', async () => {
    const t = tab()
    holdDebugger(t)
    await withDebugger(t, async () => {})
    await clock.advance(IDLE * 2)
    expect(isAttached(t)).toBe(true)
    releaseDebugger(t)
    await clock.advance(IDLE - 1)
    expect(isAttached(t)).toBe(true)
    await clock.advance(1)
    expect(isAttached(t)).toBe(false)
  })
  test('hold 不撤销已经在走的计时', async () => {
    const t = tab()
    await withDebugger(t, async () => {})
    holdDebugger(t)
    await clock.advance(IDLE)
    expect(isAttached(t)).toBe(false)
    releaseDebugger(t)
  })
  test('没 hold 过就 release：什么都不做', async () => {
    const t = tab()
    await send(t, 'X.do')
    releaseDebugger(t)
    await clock.advance(IDLE * 2)
    expect(isAttached(t)).toBe(true)
  })
  test('还有任务在用时 release：不计时，任务结束才计时', async () => {
    const t = tab()
    holdDebugger(t)
    let release!: () => void
    const job = withDebugger(t, () => new Promise<void>((r) => (release = r)))
    await clock.flush()
    releaseDebugger(t)
    await clock.advance(IDLE * 2)
    expect(isAttached(t)).toBe(true)
    release()
    await job
    await clock.advance(IDLE)
    expect(isAttached(t)).toBe(false)
  })
  test('没挂着的标签 release：不计时', async () => {
    const t = tab()
    holdDebugger(t)
    releaseDebugger(t)
    await clock.advance(IDLE * 2)
    expect(fake.detachCalls).not.toContain(t)
  })
})

describe('Chrome 事件', () => {
  test('CDP 事件同步分发给所有订阅者；无 tabId 的忽略；订阅者抛错互不影响', () => {
    const got: unknown[][] = []
    onDebuggerEvent(() => {
      throw new Error('bad handler')
    })
    onDebuggerEvent((...a: unknown[]) => got.push(a))
    fake.fireEvent({ tabId: 7 }, 'Some.event', { x: 1 })
    fake.fireEvent({ extensionId: 'e' }, 'Other.event', {})
    expect(got).toEqual([[7, 'Some.event', { x: 1 }]])
  })
  test('Chrome 报断开：isAttached 变 false，空闲计时取消，下次 send 重新挂载', async () => {
    const t = tab()
    await withDebugger(t, async () => {})
    fake.fireDetach(t)
    expect(isAttached(t)).toBe(false)
    await clock.advance(IDLE * 2)
    expect(fake.detachCalls).not.toContain(t)
    await send(t, 'X.do')
    expect(fake.attachesFor(t)).toBe(2)
  })
  test('无 tabId 的断开事件不影响任何标签', async () => {
    const t = tab()
    await attach(t)
    fake.api.debugger.onDetach.fire({ targetId: 'x' }, 'target_closed')
    expect(isAttached(t)).toBe(true)
  })
  test('标签关闭：忘掉 hold（不动挂载记录）', async () => {
    const t = tab()
    holdDebugger(t)
    await withDebugger(t, async () => {})
    fake.closeTab(t)
    expect(isAttached(t)).toBe(true)
    fake.addTab(t)
    await withDebugger(t, async () => {})
    await clock.advance(IDLE)
    expect(isAttached(t)).toBe(false)
  })
})

describe('会话关闭', () => {
  test('只断开本模块记着挂上的标签', async () => {
    const a = tab()
    const b = tab()
    const c = tab()
    await attach(a)
    await attach(c)
    await fake.closeSession([a, b])
    expect(isAttached(a)).toBe(false)
    expect(isAttached(c)).toBe(true)
    expect(fake.detachCalls).toContain(a)
    expect(fake.detachCalls).not.toContain(b)
    expect(fake.detachCalls).not.toContain(c)
  })
})
