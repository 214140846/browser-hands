import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { makeFakes } from './fakes/navigate-chrome'

// 计时压缩：模块用全局 setTimeout 计时；≥1 秒的等待按 1/20 执行，让「上限到了」类用例秒级跑完
const SPEED = 20
const realSetTimeout = globalThis.setTimeout
;(globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) =>
  realSetTimeout(fn, ms && ms >= 1000 ? ms / SPEED : ms, ...rest)
afterAll(() => {
  globalThis.setTimeout = realSetTimeout
})
const DIALOG_CAP = 2000 / SPEED // 等「离开确认」/ 页面切换的兜底上限（压缩后）
const LOAD_CAP = 30000 / SPEED // 等加载完成的上限（压缩后）

const f = makeFakes()
;(globalThis as any).chrome = f.chrome
mock.module('../../extension/debugger.js', () => f.debuggerModule)
mock.module('../../extension/abort.js', () => f.abortModule)
mock.module('../../extension/redact.js', () => f.redactModule)
const mod = await import('../../extension/navigate.js')
const { navigate } = mod as any

let tab = 500
const freshTab = () => ++tab
const sleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms))
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected rejection') }, (e) => e)
const timed = async <T>(p: Promise<T>) => {
  const t0 = performance.now()
  const v = await p
  return { v, ms: performance.now() - t0 }
}
// 动作期间：主 frame 提交 + 加载完成，同步发出
const happyPath = (t: number) => {
  f.cdp.mainFrameCommitted(t)
  f.cdp.loadComplete(t)
}

beforeEach(() => {
  f.state.attachFails = false
  f.state.withDebuggerCalls.length = 0
  f.state.sent.length = 0
  f.state.sendFails = false
  f.state.tabActs.length = 0
  f.state.onAct = happyPath
  f.state.actError = undefined
})

describe('导出面', () => {
  test('只导出 navigate', () => expect(Object.keys(mod)).toEqual(['navigate']))
  test('返回 Promise', () => {
    const p = navigate(freshTab(), { url: 'example.com' })
    expect(p).toBeInstanceOf(Promise)
    return p
  })
})

describe('参数校验', () => {
  test.each([[undefined], [''], [null]])('url=%p → invalid_params，不发起导航', async (url) => {
    const e = await caught(navigate(freshTab(), { url }))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('invalid_params')
    expect(f.state.tabActs).toHaveLength(0)
  })
  test.each([['foo bar'], ['javascript:alert(1)'], [' back']])('补前缀后仍解析不了 %p → invalid_params', async (url) => {
    const e = await caught(navigate(freshTab(), { url }))
    expect(e.code).toBe('invalid_params')
    expect(typeof e.message).toBe('string')
    expect(e.message.length).toBeGreaterThan(0)
    expect(f.state.tabActs).toHaveLength(0)
  })
  test('非字符串真值 → 失败（形状不约束）', async () => {
    await caught(navigate(freshTab(), { url: 123 }))
    expect(f.state.tabActs).toHaveLength(0)
  })
  test('已停止 + 非法参数 → 报参数错', async () => {
    const c = new AbortController()
    c.abort()
    expect((await caught(navigate(freshTab(), { url: '' }, c.signal))).code).toBe('invalid_params')
  })
  test('已停止 + 合法参数 → stopped，不发起导航', async () => {
    const c = new AbortController()
    c.abort()
    expect((await caught(navigate(freshTab(), { url: 'example.com' }, c.signal))).code).toBe('stopped')
    expect(f.state.tabActs).toHaveLength(0)
  })
})

describe('目标地址', () => {
  test.each([
    ['example.com', 'https://example.com'],
    ['http://a.test/x?y=1', 'http://a.test/x?y=1'],
    ['HTTPS://A.test', 'HTTPS://A.test'],
    ['ftp://x', 'https://ftp://x'],
  ])('%p → 打开 %p，输出含其脱敏结果', async (input, target) => {
    const t = freshTab()
    const r = await navigate(t, { url: input })
    expect(f.state.tabActs).toEqual([{ tabId: t, kind: 'url', url: target }])
    expect(Object.keys(r)).toEqual(['output'])
    expect(r.output).toContain(f.masked(target))
  })
  test.each([['back', 'back'], ['BACK', 'back'], ['Forward', 'forward'], ['forward', 'forward']])('%p → 历史%p', async (input, kind) => {
    const t = freshTab()
    f.state.tabInfo.set(t, { url: 'https://prev.test/p' })
    const r = await navigate(t, { url: input })
    expect(f.state.tabActs).toEqual([{ tabId: t, kind, url: undefined }])
    expect(r.output).toContain(f.masked('https://prev.test/p'))
  })
  test('后退后地址未知 → 输出不带地址', async () => {
    const r = await navigate(freshTab(), { url: 'back' })
    expect(r.output).not.toContain('[masked:')
    expect(r.output.length).toBeGreaterThan(0)
  })
  test('后退时优先报正在去往的地址', async () => {
    const t = freshTab()
    f.state.tabInfo.set(t, { url: 'https://old.test/', pendingUrl: 'https://going.test/' })
    expect((await navigate(t, { url: 'back' })).output).toContain(f.masked('https://going.test/'))
  })
  test('浏览器动作报错原样透传，且不残留监听', async () => {
    const boom = new Error('no history')
    f.state.actError = boom
    expect(await caught(navigate(freshTab(), { url: 'back' }))).toBe(boom)
    expect(f.onUpdated.count).toBe(0)
  })
})

describe('打不开的页面', () => {
  test('正在去往错误页 → navigate_load_failed，报目标地址', async () => {
    const t = freshTab()
    f.state.tabInfo.set(t, { url: 'https://old.test/', pendingUrl: 'chrome-error://chromewebdata/' })
    const e = await caught(navigate(t, { url: 'nope.test' }))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('navigate_load_failed')
    expect(e.message).toContain(f.masked('https://nope.test'))
  })
  test('没有待去地址、当前地址是错误页 → navigate_load_failed', async () => {
    const t = freshTab()
    f.state.tabInfo.set(t, { url: 'chrome-error://chromewebdata/' })
    expect((await caught(navigate(t, { url: 'nope.test' }))).code).toBe('navigate_load_failed')
  })
  test('后退落到错误页 → 报当前地址', async () => {
    const t = freshTab()
    f.state.tabInfo.set(t, { url: 'chrome-error://chromewebdata/' })
    const e = await caught(navigate(t, { url: 'back' }))
    expect(e.code).toBe('navigate_load_failed')
    expect(e.message).toContain(f.masked('chrome-error://chromewebdata/'))
  })
  test('正在去往正常页（旧地址是错误页）→ 成功', async () => {
    const t = freshTab()
    f.state.tabInfo.set(t, { url: 'chrome-error://chromewebdata/', pendingUrl: 'https://ok.test/' })
    await navigate(t, { url: 'ok.test' })
  })
})

describe('等待页面切换与加载', () => {
  test('动作期间同步发出的主 frame 提交和加载完成都算数 → 很快返回', async () => {
    const { ms } = await timed(navigate(freshTab(), { url: 'a.test' }))
    expect(ms).toBeLessThan(DIALOG_CAP * 0.6)
  })
  test('同文档跳转也算页面切换', async () => {
    f.state.onAct = (t) => (f.cdp.sameDocument(t), f.cdp.loadComplete(t))
    expect((await timed(navigate(freshTab(), { url: 'a.test' }))).ms).toBeLessThan(DIALOG_CAP * 0.6)
  })
  test('调试器断开也结束等待', async () => {
    f.state.onAct = (t) => (f.cdp.debuggerGone(t), f.cdp.loadComplete(t))
    expect((await timed(navigate(freshTab(), { url: 'a.test' }))).ms).toBeLessThan(DIALOG_CAP * 0.6)
  })
  test('子 frame 跳转不算 → 等到兜底上限', async () => {
    f.state.onAct = (t) => (f.cdp.subFrameCommitted(t), f.cdp.loadComplete(t))
    const { v, ms } = await timed(navigate(freshTab(), { url: 'a.test' }))
    expect(ms).toBeGreaterThanOrEqual(DIALOG_CAP * 0.9)
    expect(ms).toBeLessThan(LOAD_CAP * 0.5)
    expect(v.output).toContain(f.masked('https://a.test'))
  })
  test('别的标签的切换事件不算', async () => {
    f.state.onAct = (t) => (f.cdp.mainFrameCommitted(t + 10000), f.cdp.loadComplete(t))
    expect((await timed(navigate(freshTab(), { url: 'a.test' }))).ms).toBeGreaterThanOrEqual(DIALOG_CAP * 0.9)
  })
  test('一直没有加载完成 → 到上限后仍成功，输出与已加载时不同', async () => {
    const t1 = freshTab()
    const loaded = await navigate(t1, { url: 'slow.test' })
    f.state.onAct = (t) => {
      f.cdp.mainFrameCommitted(t)
      f.cdp.loading(t) // 非完成状态不算
      f.cdp.loadComplete(t + 10000) // 别的标签完成不算
    }
    const t2 = freshTab()
    const { v, ms } = await timed(navigate(t2, { url: 'slow.test' }))
    expect(ms).toBeGreaterThanOrEqual(LOAD_CAP * 0.9)
    expect(v.output).not.toBe(loaded.output)
    expect(v.output).toContain(f.masked('https://slow.test'))
    expect(f.onUpdated.count).toBe(0)
  })
  test('加载完成稍后异步到来 → 等到它就返回', async () => {
    f.state.onAct = (t) => {
      f.cdp.mainFrameCommitted(t)
      realSetTimeout(() => f.cdp.loadComplete(t), 40)
    }
    const { ms } = await timed(navigate(freshTab(), { url: 'a.test' }))
    expect(ms).toBeGreaterThanOrEqual(35)
    expect(ms).toBeLessThan(LOAD_CAP * 0.5)
  })
})

describe('离开确认对话框', () => {
  test('不强制 + 弹框 → 拒绝，navigate_beforeunload_blocked，报弹框页地址，不等加载', async () => {
    const t = freshTab()
    f.state.onAct = (tt) => f.cdp.leaveDialog(tt, 'https://dirty.test/form')
    const { v: e, ms } = await timed(caught(navigate(t, { url: 'elsewhere.test' })))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('navigate_beforeunload_blocked')
    expect(e.message).toContain(f.masked('https://dirty.test/form'))
    expect(e.message).not.toContain('elsewhere.test')
    expect(f.answers()).toEqual([{ tabId: t, method: 'Page.handleJavaScriptDialog', params: { accept: false } }])
    expect(ms).toBeLessThan(DIALOG_CAP * 0.6)
    expect(f.onUpdated.count).toBe(0)
  })
  test.each([[false], [undefined], [0], ['']])('force=%p 视为不强制', async (force) => {
    f.state.onAct = (tt) => f.cdp.leaveDialog(tt, 'https://dirty.test/')
    expect((await caught(navigate(freshTab(), { url: 'x.test', force }))).code).toBe('navigate_beforeunload_blocked')
  })
  test.each([[true], ['yes'], [1]])('force=%p + 弹框 → 接受，成功，输出与无弹框时不同', async (force) => {
    const plain = await navigate(freshTab(), { url: 'x.test', force })
    const t = freshTab()
    f.state.onAct = (tt) => {
      f.cdp.leaveDialog(tt, 'https://dirty.test/')
      happyPath(tt)
    }
    const r = await navigate(t, { url: 'x.test', force })
    expect(f.answers()).toEqual([{ tabId: t, method: 'Page.handleJavaScriptDialog', params: { accept: true } }])
    expect(r.output).toContain(f.masked('https://x.test'))
    expect(r.output).not.toBe(plain.output)
  })
  test('接受后页面没离开 → 继续等到兜底上限，不提前返回', async () => {
    f.state.onAct = (tt) => (f.cdp.leaveDialog(tt, 'https://dirty.test/'), f.cdp.loadComplete(tt))
    const { ms } = await timed(navigate(freshTab(), { url: 'x.test', force: true }))
    expect(ms).toBeGreaterThanOrEqual(DIALOG_CAP * 0.9)
  })
  test('同一次强制导航里第二个确认框 → 拒绝并视为被拦下', async () => {
    const t = freshTab()
    f.state.onAct = (tt) => (f.cdp.leaveDialog(tt, 'https://d1.test/'), f.cdp.leaveDialog(tt, 'https://d2.test/'))
    expect((await caught(navigate(t, { url: 'x.test', force: true }))).code).toBe('navigate_beforeunload_blocked')
    expect(f.answers().map((a) => a.params.accept)).toEqual([true, false])
  })
  test('处理命令失败不影响结果', async () => {
    f.state.sendFails = true
    f.state.onAct = (tt) => f.cdp.leaveDialog(tt, 'https://dirty.test/')
    expect((await caught(navigate(freshTab(), { url: 'x.test' }))).code).toBe('navigate_beforeunload_blocked')
    f.state.onAct = (tt) => (f.cdp.leaveDialog(tt, 'https://dirty.test/'), happyPath(tt))
    await navigate(freshTab(), { url: 'x.test', force: true })
  })
  test('标签上没有进行中的导航（如点链接触发）→ 拒绝', () => {
    const t = freshTab()
    f.cdp.leaveDialog(t, 'https://idle.test/')
    expect(f.answers()).toEqual([{ tabId: t, method: 'Page.handleJavaScriptDialog', params: { accept: false } }])
  })
  test('强制导航结束后再弹框 → 拒绝', async () => {
    const t = freshTab()
    await navigate(t, { url: 'x.test', force: true })
    f.cdp.leaveDialog(t, 'https://later.test/')
    expect(f.answers().map((a) => a.params.accept)).toEqual([false])
  })
  test('别的标签在强制导航，本标签弹框 → 本标签拒绝，那次导航不受影响', async () => {
    const other = freshTab()
    const t = freshTab()
    f.state.onAct = (tt) => {
      f.cdp.leaveDialog(other, 'https://other.test/')
      happyPath(tt)
    }
    await navigate(t, { url: 'x.test', force: true })
    expect(f.answers()).toEqual([{ tabId: other, method: 'Page.handleJavaScriptDialog', params: { accept: false } }])
  })
  test('不是离开确认的对话框 → 不处理', async () => {
    const t = freshTab()
    f.state.onAct = (tt) => {
      f.cdp.otherDialog(tt, 'alert')
      f.cdp.otherDialog(tt, 'confirm')
      happyPath(tt)
    }
    await navigate(t, { url: 'x.test' })
    expect(f.answers()).toEqual([])
  })
})

describe('调试器', () => {
  test('挂得上 → 在占用调试器期间导航', async () => {
    const t = freshTab()
    await navigate(t, { url: 'x.test' })
    expect(f.state.withDebuggerCalls).toEqual([t])
  })
  test('挂不上 → 不占用调试器，照常导航成功', async () => {
    f.state.attachFails = true
    const t = freshTab()
    const r = await navigate(t, { url: 'x.test' })
    expect(f.state.withDebuggerCalls).toEqual([])
    expect(f.state.tabActs).toHaveLength(1)
    expect(r.output).toContain(f.masked('https://x.test'))
  })
})

describe('停止（Stop）', () => {
  test('等页面切换时停止 → 很快 stopped，不残留监听', async () => {
    f.state.onAct = () => {}
    const c = new AbortController()
    realSetTimeout(() => c.abort(), 15)
    const { v: e, ms } = await timed(caught(navigate(freshTab(), { url: 'x.test' }, c.signal)))
    expect(e.code).toBe('stopped')
    expect(ms).toBeLessThan(DIALOG_CAP * 0.6)
    expect(f.onUpdated.count).toBe(0)
  })
  test('等加载时停止 → 等待结束时报 stopped（不要求提前结束），不残留监听', async () => {
    f.state.onAct = (t) => {
      f.cdp.mainFrameCommitted(t)
      realSetTimeout(() => f.cdp.loadComplete(t), 60)
    }
    const c = new AbortController()
    realSetTimeout(() => c.abort(), 20)
    const e = await caught(navigate(freshTab(), { url: 'x.test' }, c.signal))
    expect(e.code).toBe('stopped')
    expect(f.onUpdated.count).toBe(0)
  })
})

describe('不残留监听', () => {
  test('成功 / 拦截 / 打不开之后加载监听数都归零', async () => {
    await navigate(freshTab(), { url: 'x.test' })
    expect(f.onUpdated.count).toBe(0)
    f.state.onAct = (tt) => f.cdp.leaveDialog(tt, 'https://d.test/')
    await caught(navigate(freshTab(), { url: 'x.test' }))
    expect(f.onUpdated.count).toBe(0)
    const t = freshTab()
    f.state.onAct = happyPath
    f.state.tabInfo.set(t, { url: 'chrome-error://chromewebdata/' })
    await caught(navigate(t, { url: 'x.test' }))
    expect(f.onUpdated.count).toBe(0)
  })
})
