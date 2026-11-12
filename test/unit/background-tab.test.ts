// background-tab 单测：按 specs/background-tab.md。依赖模块全部用替身，chrome 用假对象；
// 页内拦截守卫用 Playwright 真页面执行（假 executeScript 把注入函数序列化进页面）。
// 只断言结构、调用、数值与语义，不断言文案。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test'
import type { Page } from 'playwright'
import { EXT_ID, makeFakes, NO_GROUP } from './fakes/background-tab-chrome'
import { countPopups, openPage, OTHER, ORIGIN, startBrowser, stopBrowser } from './fakes/background-tab-page'

setDefaultTimeout(30_000)

const f = makeFakes()
;(globalThis as any).chrome = f.chrome
mock.module('../../extension/debugger.js', () => f.debuggerModule)
mock.module('../../extension/sessions.js', () => f.sessionsModule)
const mod = (await import('../../extension/background-tab.js')) as any
const chromeCallsAtImport = f.state.chromeCalls
const { withFocusEmulation, withBackground, wakeHidden, beginClickInterception, abortClickInterception, finishClickInterception, newTabNote } = mod

const FOCUS = 'Emulation.setFocusEmulationEnabled'
const SHOT = 'Page.captureScreenshot'
const BLANK = '_blank'
const S = f.state
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected rejection') }, (e) => e)
const activeCount = () => (globalThis as any).__jevBg.activeCount()
const focusCmds = (tabId: number) => S.sent.filter((c) => c.tabId === tabId && c.method === FOCUS).map((c) => c.params?.enabled)
const muted = (tabId: number) => !!S.tabs.get(tabId)!.mutedInfo?.muted
const bg = (o: Parameters<typeof f.addTab>[0] = {}) => f.addTab({ active: false, ...o })
const fg = (o: Parameters<typeof f.addTab>[0] = {}) => f.addTab({ active: true, focused: true, winState: 'normal', ...o })
const minimizedTab = (o: Parameters<typeof f.addTab>[0] = {}) => f.addTab({ winState: 'minimized', ...o })

beforeEach(() => f.reset())

describe('导出面与导入副作用', () => {
  test('恰好 7 个导出', () => {
    expect(Object.keys(mod).sort()).toEqual(
      ['abortClickInterception', 'beginClickInterception', 'finishClickInterception', 'newTabNote', 'wakeHidden', 'withBackground', 'withFocusEmulation'],
    )
  })
  test('导入时不调任何 chrome API', () => expect(chromeCallsAtImport).toBe(0))
  test('挂出 activeCount，初值 0', () => {
    expect(typeof (globalThis as any).__jevBg?.activeCount).toBe('function')
    expect(activeCount()).toBe(0)
  })
})

describe('前台判定', () => {
  test.each([
    ['非活动标签', { active: false }, true],
    ['活动标签、窗口无焦点', { active: true, focused: false }, true],
    ['活动标签、窗口最小化', { active: true, focused: true, winState: 'minimized' }, true],
    ['活动标签、窗口有焦点且正常', { active: true, focused: true, winState: 'normal' }, false],
    ['活动标签、窗口有焦点且最大化', { active: true, focused: true, winState: 'maximized' }, false],
    ['活动标签、读不到窗口', { active: true, windowId: 424242 }, true],
  ] as const)('%s → 模拟=%p', async (_n, o, emulated) => {
    const t = f.addTab(o as any)
    if ((o as any).windowId) S.windows.delete((o as any).windowId)
    expect(await withFocusEmulation(t.id, async () => 'ok')).toBe('ok')
    expect(focusCmds(t.id)).toEqual(emulated ? [true, false] : [])
  })
  test('读不到标签 → 直接执行 fn，不发命令', async () => {
    let ran = false
    expect(await withFocusEmulation(31337, () => ((ran = true), 5))).toBe(5)
    expect(ran).toBe(true)
    expect(S.sent).toHaveLength(0)
    expect(S.muteUpdates).toHaveLength(0)
  })
})

describe('结果透传', () => {
  test('后台：fn 的同步返回值 / 异步返回值', async () => {
    expect(await withFocusEmulation(bg().id, () => 7)).toBe(7)
    expect(await withFocusEmulation(bg().id, async () => ({ a: 1 }))).toEqual({ a: 1 })
  })
  test.each([['后台', bg], ['前台', fg]] as const)('%s：fn 的错误原样 reject（同一对象）', async (_n, mk) => {
    const boom = new Error('x')
    expect(await caught(withFocusEmulation(mk().id, async () => { throw boom }))).toBe(boom)
    expect(activeCount()).toBe(0)
  })
  test('withFocusEmulation 返回 Promise', async () => {
    const p = withFocusEmulation(fg().id, () => 1)
    expect(p).toBeInstanceOf(Promise)
    await p
  })
})

describe('模拟轮', () => {
  test('fn 执行时开启命令已有结果', async () => {
    const t = bg()
    let enableDone = false
    S.sendGate = async (_m, p) => {
      if (p?.enabled) {
        await sleep(30)
        enableDone = true
      }
    }
    let seen: boolean | undefined
    await withFocusEmulation(t.id, () => (seen = enableDone))
    expect(seen).toBe(true)
  })
  test('开启命令失败 → fn 照常执行，结束后无残留静音与计数', async () => {
    const t = bg()
    S.sendFails = (_m, p) => p?.enabled === true
    expect(await withFocusEmulation(t.id, () => 'still')).toBe('still')
    expect(muted(t.id)).toBe(false)
    expect(activeCount()).toBe(0)
  })
  test('同标签并发：只开一次，最后一个结束才关；计数按标签', async () => {
    const t = bg()
    const a = f.deferred()
    const b = f.deferred()
    const pa = withFocusEmulation(t.id, () => a.p.then(() => 'A'))
    await sleep(20) // 错开发起：同一瞬间并发的两个首次调用是否合并，规格不约束
    const pb = withFocusEmulation(t.id, () => b.p.then(() => 'B'))
    await sleep(20)
    expect(focusCmds(t.id)).toEqual([true])
    expect(activeCount()).toBe(1)
    a.resolve()
    expect(await pa).toBe('A')
    expect(focusCmds(t.id)).toEqual([true])
    expect(activeCount()).toBe(1)
    b.resolve()
    expect(await pb).toBe('B')
    expect(focusCmds(t.id)).toEqual([true, false])
    expect(activeCount()).toBe(0)
  })
  test('已有进行中的轮，标签转到前台后的新调用加入这一轮', async () => {
    const t = bg()
    const a = f.deferred()
    const pa = withFocusEmulation(t.id, () => a.p)
    await sleep(20)
    t.active = true
    let ranB = false
    await withFocusEmulation(t.id, () => (ranB = true))
    expect(ranB).toBe(true)
    expect(focusCmds(t.id)).toEqual([true])
    a.resolve()
    await pa
    expect(focusCmds(t.id)).toEqual([true, false])
  })
  test('不同标签各自成轮', async () => {
    const [t1, t2] = [bg(), bg()]
    const d = f.deferred()
    const ps = [withFocusEmulation(t1.id, () => d.p), withFocusEmulation(t2.id, () => d.p)]
    await sleep(20)
    expect(activeCount()).toBe(2)
    expect(focusCmds(t1.id)).toEqual([true])
    expect(focusCmds(t2.id)).toEqual([true])
    d.resolve()
    await Promise.all(ps)
    expect(focusCmds(t1.id)).toEqual([true, false])
    expect(focusCmds(t2.id)).toEqual([true, false])
    expect(activeCount()).toBe(0)
  })
  test('先后两次后台调用 → 两轮', async () => {
    const t = bg()
    await withFocusEmulation(t.id, () => 1)
    await withFocusEmulation(t.id, () => 2)
    expect(focusCmds(t.id)).toEqual([true, false, true, false])
  })
  test('前台调用不发命令、不碰静音', async () => {
    const t = fg()
    await withFocusEmulation(t.id, () => 1)
    expect(S.sent).toHaveLength(0)
    expect(S.muteUpdates).toHaveLength(0)
  })
})

describe('静音', () => {
  test('安静且未静音 → fn 时已静音，结束后解除', async () => {
    const t = bg()
    let during: boolean | undefined
    await withFocusEmulation(t.id, () => (during = muted(t.id)))
    expect(during).toBe(true)
    expect(muted(t.id)).toBe(false)
  })
  test('正在出声 → 不静音', async () => {
    const t = bg({ audible: true })
    await withFocusEmulation(t.id, () => 1)
    expect(S.muteUpdates).toHaveLength(0)
  })
  test('用户已静音 → 不动，结束后仍静音', async () => {
    const t = bg({ mutedInfo: { muted: true, reason: 'user' } })
    await withFocusEmulation(t.id, () => 1)
    expect(S.muteUpdates).toHaveLength(0)
    expect(muted(t.id)).toBe(true)
  })
  test('期间用户改成自己静音 → 结束后保持静音', async () => {
    const t = bg()
    await withFocusEmulation(t.id, () => {
      t.mutedInfo = { muted: true, reason: 'user' }
    })
    expect(muted(t.id)).toBe(true)
    expect(S.muteUpdates.filter((u) => !u.muted)).toHaveLength(0)
  })
  test('期间别的扩展静音 → 结束后保持静音', async () => {
    const t = bg()
    await withFocusEmulation(t.id, () => {
      t.mutedInfo = { muted: true, reason: 'extension', extensionId: 'someone-else' }
    })
    expect(muted(t.id)).toBe(true)
  })
  test('期间已被解除静音 → 不再发解除', async () => {
    const t = bg()
    await withFocusEmulation(t.id, () => {
      t.mutedInfo = { muted: false }
    })
    expect(S.muteUpdates.filter((u) => !u.muted)).toHaveLength(0)
  })
  test('关闭命令失败 → 仍解除静音并正常返回', async () => {
    const t = bg()
    S.sendFails = (_m, p) => p?.enabled === false
    expect(await withFocusEmulation(t.id, () => 'r')).toBe('r')
    expect(muted(t.id)).toBe(false)
  })
  test('静音接口失败 → 吞掉', async () => {
    const t = bg()
    S.updateFails = true
    expect(await withFocusEmulation(t.id, () => 'r')).toBe('r')
  })
  test('自己加的静音带本扩展 id', async () => {
    const t = bg()
    await withFocusEmulation(t.id, () => expect(S.tabs.get(t.id)!.mutedInfo?.extensionId).toBe(EXT_ID))
  })
})

describe('结束时机', () => {
  test('fn 成功 → 关闭命令与解除静音完成后才 resolve', async () => {
    const t = bg()
    let closed = false
    S.sendGate = async (_m, p) => {
      if (p?.enabled === false) {
        await sleep(60)
        closed = true
      }
    }
    await withFocusEmulation(t.id, () => 1)
    expect(closed).toBe(true)
    expect(muted(t.id)).toBe(false)
  })
  test('fn 失败 → 不等挂住的关闭命令，立即 reject', async () => {
    const t = bg()
    S.sendGate = (_m, p) => (p?.enabled === false ? new Promise<void>(() => {}) : undefined)
    const boom = new Error('nav')
    const t0 = performance.now()
    expect(await caught(withFocusEmulation(t.id, async () => { throw boom }))).toBe(boom)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(activeCount()).toBe(0)
  })
  test.each([['后台', false], ['前台', true]] as const)('上一轮关闭未完成时的%s新调用 → 等它完成才执行', async (_n, toFront) => {
    const t = bg()
    let closed = false
    S.sendGate = async (_m, p) => {
      if (p?.enabled === false && !closed) {
        await sleep(80)
        closed = true
      }
    }
    await caught(withFocusEmulation(t.id, async () => { throw new Error('first') }))
    expect(closed).toBe(false)
    if (toFront) t.active = true
    let seen: boolean | undefined
    await withFocusEmulation(t.id, () => (seen = closed))
    expect(seen).toBe(true)
    if (!toFront) {
      const reopen = S.sent.filter((c) => c.method === FOCUS && c.params?.enabled === true)
      expect(reopen).toHaveLength(2)
    }
  })
})

describe('fn 失败与活动计数', () => {
  test('最后一个 fn 失败 → 立即不再计入，关闭命令仍会发出', async () => {
    const t = bg()
    await caught(withFocusEmulation(t.id, async () => { throw new Error('x') }))
    expect(activeCount()).toBe(0)
    await sleep(20)
    expect(focusCmds(t.id)).toEqual([true, false])
    expect(muted(t.id)).toBe(false)
  })
  test('非最后一个 fn 失败 → 该调用 reject，这一轮继续，最后一个结束才关', async () => {
    const t = bg()
    const a = f.deferred()
    const pa = withFocusEmulation(t.id, () => a.p.then(() => 'A'))
    await sleep(20)
    const boom = new Error('b')
    expect(await caught(withFocusEmulation(t.id, async () => { throw boom }))).toBe(boom)
    expect(focusCmds(t.id)).toEqual([true])
    expect(activeCount()).toBe(1)
    a.resolve()
    expect(await pa).toBe('A')
    expect(focusCmds(t.id)).toEqual([true, false])
    expect(activeCount()).toBe(0)
    expect(muted(t.id)).toBe(false)
  })
})

describe('withBackground', () => {
  test('在 withDebugger 回调里执行，且后台标签照样模拟', async () => {
    const t = bg()
    let inside = 0
    expect(await withBackground(t.id, () => ((inside = S.insideDebugger), 'v'))).toBe('v')
    expect(S.withDebuggerCalls).toEqual([t.id])
    expect(inside).toBeGreaterThan(0)
    expect(focusCmds(t.id)).toEqual([true, false])
  })
  test('错误原样透传', async () => {
    const boom = new Error('b')
    expect(await caught(withBackground(fg().id, async () => { throw boom }))).toBe(boom)
  })
})

describe('wakeHidden', () => {
  test('后台 → 一次左上角 1×1 截图命令', async () => {
    const t = bg()
    expect(await wakeHidden(t.id)).toBeUndefined()
    expect(S.sent.map((c) => [c.tabId, c.method])).toEqual([[t.id, SHOT]])
    const { clip } = S.sent[0].params
    expect([clip.x, clip.y, clip.width, clip.height, clip.scale]).toEqual([0, 0, 1, 1, 1])
  })
  test('前台 / 读不到标签 → 不发命令', async () => {
    await wakeHidden(fg().id)
    await wakeHidden(8888)
    expect(S.sent).toHaveLength(0)
  })
  test('命令失败 → 正常结束', async () => {
    S.sendFails = () => true
    expect(await wakeHidden(bg().id)).toBeUndefined()
  })
})

describe('beginClickInterception', () => {
  test('窗口最小化 → 凭据；只注入顶层、立即执行', async () => {
    const t = minimizedTab()
    const c = await beginClickInterception(t.id)
    expect(c).not.toBeNull()
    expect(typeof c).toBe('object')
    expect(S.scripts).toHaveLength(1)
    const s = S.scripts[0]
    expect(s.tabId).toBe(t.id)
    expect(s.target.allFrames ?? false).toBe(false)
    expect(s.target.frameIds).toBeUndefined()
    expect(s.injectImmediately).toBe(true)
    expect(typeof s.func).toBe('function')
  })
  test.each([
    ['窗口正常、有焦点', { winState: 'normal', focused: true }],
    ['窗口正常、无焦点', { winState: 'normal', focused: false }],
    ['没有 windowId', { windowId: undefined }],
  ] as const)('%s → null，不注入', async (_n, o) => {
    expect(await beginClickInterception(f.addTab(o as any).id)).toBeNull()
    expect(S.scripts).toHaveLength(0)
  })
  test('读不到标签 / 窗口 → null', async () => {
    expect(await beginClickInterception(7777)).toBeNull()
    const t = minimizedTab()
    S.windows.delete(t.windowId!)
    expect(await beginClickInterception(t.id)).toBeNull()
  })
  test('注入失败 → null', async () => {
    S.scriptFails = true
    expect(await beginClickInterception(minimizedTab().id)).toBeNull()
  })
})

const tokenFor = async (o: Parameters<typeof f.addTab>[0] = {}) => {
  const t = minimizedTab(o)
  const c = await beginClickInterception(t.id)
  expect(c).not.toBeNull()
  S.scripts.length = 0
  return { t, c }
}
const drainGives = (hrefs: unknown) => {
  S.scriptResult = () => [{ result: hrefs }]
}

describe('abortClickInterception', () => {
  test('null → 不调 chrome', async () => {
    const before = S.chromeCalls
    expect(await abortClickInterception(null)).toBeUndefined()
    expect(S.chromeCalls).toBe(before)
  })
  test('三处注入的脚本：自包含、参数可 JSON 序列化', async () => {
    const t = minimizedTab()
    const c = await beginClickInterception(t.id)
    await abortClickInterception(c)
    drainGives([])
    await finishClickInterception(c, undefined)
    expect(S.scripts).toHaveLength(3)
    for (const s of S.scripts) {
      expect(JSON.parse(JSON.stringify(s.args ?? []))).toEqual(s.args ?? [])
      expect(typeof s.func).toBe('function')
    }
  })
  test('凭据 → 在原标签取回一次，不开标签', async () => {
    const { t, c } = await tokenFor()
    drainGives(['https://a.test/'])
    await abortClickInterception(c)
    expect(S.scripts.map((s) => s.tabId)).toEqual([t.id])
    expect(S.created).toHaveLength(0)
  })
  test('注入失败 → 正常结束', async () => {
    const { c } = await tokenFor()
    S.scriptFails = true
    expect(await abortClickInterception(c)).toBeUndefined()
  })
})

describe('finishClickInterception', () => {
  test('null → []，不调 chrome', async () => {
    const before = S.chromeCalls
    expect(await finishClickInterception(null, undefined)).toEqual([])
    expect(S.chromeCalls).toBe(before)
  })
  test('去重、只留 http(s)、最多 3 个；后台开在原标签右侧', async () => {
    const { t, c } = await tokenFor({ index: 6 })
    drainGives(['https://a.test/', 'https://a.test/', 'ftp://x.test/', 'mailto:z@x.test', 'HTTP://b.test/', 'https://c.test/', 'https://d.test/'])
    const ids = await finishClickInterception(c, undefined)
    expect(S.created.map((p) => p.url)).toEqual(['https://a.test/', 'HTTP://b.test/', 'https://c.test/'])
    for (const [i, p] of S.created.entries()) {
      expect(p.active).toBe(false)
      expect(p.windowId).toBe(t.windowId)
      expect(p.openerTabId).toBe(t.id)
      expect(p.index).toBe(7 + i)
    }
    expect(ids).toHaveLength(3)
    expect(ids.every((x: unknown) => typeof x === 'number')).toBe(true)
  })
  test('位置 / 组 / 窗口取自 begin 时：begin 后原标签变了不影响', async () => {
    const { t, c } = await tokenFor({ index: 2, groupId: 77 })
    t.index = 30
    t.groupId = 99
    drainGives(['https://a.test/'])
    await finishClickInterception(c, undefined)
    expect(S.created[0].index).toBe(3)
    expect(S.created[0].windowId).toBe(t.windowId)
    expect(S.grouped).toEqual([expect.objectContaining({ groupId: 77 })])
  })
  test('超过 3 个：被过滤掉的条目不占名额', async () => {
    const { c } = await tokenFor()
    drainGives(['ftp://x/', 'https://a/', 'https://a/', 'mailto:q@x', 'https://b/', 'https://c/', 'https://d/'])
    await finishClickInterception(c, undefined)
    expect(S.created.map((p) => p.url)).toEqual(['https://a/', 'https://b/', 'https://c/'])
  })
  test('合并多帧结果，忽略非数组', async () => {
    const { c } = await tokenFor()
    S.scriptResult = () => [{ result: ['https://a.test/'] }, { result: null }, { result: 'https://x.test/' }, { result: ['https://b.test/'] }]
    await finishClickInterception(c, undefined)
    expect(S.created.map((p) => p.url)).toEqual(['https://a.test/', 'https://b.test/'])
  })
  test('取回失败 → []', async () => {
    const { c } = await tokenFor()
    S.scriptFails = true
    expect(await finishClickInterception(c, undefined)).toEqual([])
    expect(S.created).toHaveLength(0)
  })
  test('首次创建失败 → 只带 url 与 active:false 再试；落在原窗口则计入', async () => {
    const { t, c } = await tokenFor()
    drainGives(['https://a.test/'])
    S.createImpl = (p, n) => {
      if (n === 1) throw new Error('no window')
      return { id: 501, windowId: t.windowId }
    }
    expect(await finishClickInterception(c, undefined)).toEqual([501])
    expect(Object.keys(S.created[1]).sort()).toEqual(['active', 'url'])
    expect(S.created[1].active).toBe(false)
  })
  test('新标签落在别的窗口 / 没有 id → 不计入', async () => {
    const { t, c } = await tokenFor()
    drainGives(['https://a.test/', 'https://b.test/', 'https://c.test/'])
    S.createImpl = (_p, n) => (n === 1 ? { id: 601, windowId: t.windowId! + 1 } : n === 2 ? { windowId: t.windowId } : { id: 603, windowId: t.windowId })
    expect(await finishClickInterception(c, undefined)).toEqual([603])
  })
  test('两次都失败 → 跳过，继续下一个', async () => {
    const { t, c } = await tokenFor()
    drainGives(['https://a.test/', 'https://b.test/'])
    S.createImpl = (p) => {
      if (p.url === 'https://a.test/') throw new Error('nope')
      return { id: 701, windowId: t.windowId }
    }
    expect(await finishClickInterception(c, undefined)).toEqual([701])
  })

  const groupTid = (o: any) => (Array.isArray(o.tabIds) ? o.tabIds : [o.tabIds])
  test.each([['NONE', NO_GROUP], ['缺省', undefined]] as const)('原标签不在组里（%s）→ 不入组，计入', async (_n, g) => {
    const { c } = await tokenFor({ groupId: g })
    drainGives(['https://a.test/'])
    const ids = await finishClickInterception(c, { groupId: 5 })
    expect(ids).toHaveLength(1)
    expect(S.grouped).toHaveLength(0)
    expect(S.joined).toHaveLength(0)
  })
  test('会话组即原组 → joinGroup', async () => {
    const { c } = await tokenFor({ groupId: 42 })
    drainGives(['https://a.test/'])
    const session = { groupId: 42, name: 's' }
    const ids = await finishClickInterception(c, session)
    expect(ids).toHaveLength(1)
    expect(S.joined).toEqual([{ session, tabId: ids[0] }])
    expect(S.grouped).toHaveLength(0)
  })
  test.each([['会话组不同', { groupId: 9 }], ['没有会话', undefined]] as const)('%s → chrome 入原组', async (_n, session) => {
    const { c } = await tokenFor({ groupId: 42 })
    drainGives(['https://a.test/'])
    const ids = await finishClickInterception(c, session)
    expect(ids).toHaveLength(1)
    expect(S.grouped).toHaveLength(1)
    expect(S.grouped[0].groupId).toBe(42)
    expect(groupTid(S.grouped[0])).toEqual(ids)
    expect(S.joined).toHaveLength(0)
  })
  test('入组失败 → 不计入', async () => {
    const { c } = await tokenFor({ groupId: 42 })
    drainGives(['https://a.test/'])
    S.groupFails = true
    expect(await finishClickInterception(c, undefined)).toEqual([])
    const r2 = await tokenFor({ groupId: 43 })
    drainGives(['https://a.test/'])
    S.joinFails = true
    expect(await finishClickInterception(r2.c, { groupId: 43 })).toEqual([])
  })
})

describe('newTabNote', () => {
  test('空 → 空串', () => expect(newTabNote([])).toBe(''))
  test('非空 → 同步字符串，空白开头，含每个 id', () => {
    const s = newTabNote([12, 345])
    expect(typeof s).toBe('string')
    expect(s).toMatch(/^\s/)
    expect(s).toMatch(/(^|\D)12(\D|$)/)
    expect(s).toMatch(/(^|\D)345(\D|$)/)
    expect(newTabNote([7])).toMatch(/(^|\D)7(\D|$)/)
  })
})

// ---- 页内拦截守卫：真页面 ----
describe('页内守卫', () => {
  let drainScript: { func: (...a: any[]) => any; args?: any[] }
  let pages: Page[] = []
  let popups: ReturnType<typeof countPopups>[] = []

  beforeAll(async () => {
    await startBrowser()
    // 取一份「取回」注入函数，后面直接在页面里跑它看原始记录
    f.reset()
    const { c } = await tokenFor()
    await abortClickInterception(c)
    drainScript = S.scripts.at(-1)!
  })
  afterAll(stopBrowser)
  afterEach(async () => {
    for (const p of popups) await p.close()
    for (const p of pages) await p.close().catch(() => {})
    pages = []
    popups = []
  })

  const setup = async (body: string, head = '') => {
    const page = await openPage(body, head)
    pages.push(page)
    const pop = countPopups(page)
    popups.push(pop)
    const t = minimizedTab({ groupId: NO_GROUP })
    S.pages.set(t.id, page)
    return { page, t, pop }
  }
  const arm = async (tabId: number) => {
    const c = await beginClickInterception(tabId)
    expect(c).not.toBeNull()
    return c
  }
  const raw = (page: Page): Promise<string[]> =>
    page.evaluate(`(${String(drainScript.func)})(...${JSON.stringify(drainScript.args ?? [])})`) as Promise<string[]>
  const link = (id: string, href: string, target?: string, extra = '') =>
    `<a id="${id}" href="${href}"${target === undefined ? '' : ` target="${target}"`} ${extra}>${id}</a> `
  const clickRaw = async (body: string, sel: string, head = '') => {
    const { page, t } = await setup(body, head)
    await arm(t.id)
    await page.click(sel)
    return raw(page)
  }

  test('拦下 _blank：不开新窗口，记录绝对地址', async () => {
    const { page, t, pop } = await setup(link('a', '/p1', BLANK))
    await arm(t.id)
    await page.click('#a')
    await sleep(300)
    expect(pop.count).toBe(0)
    expect(await raw(page)).toEqual([`${ORIGIN}/p1`])
  })
  test('begin → 点击 → finish：后台开出被拦的网址', async () => {
    const { page, t } = await setup(link('a', '/p1', BLANK) + link('b', `${OTHER}/q`, BLANK))
    const c = await arm(t.id)
    await page.click('#a')
    await page.click('#b')
    await page.click('#a')
    const ids = await finishClickInterception(c, undefined)
    expect(S.created.map((p) => p.url)).toEqual([`${ORIGIN}/p1`, `${OTHER}/q`])
    expect(ids).toHaveLength(2)
    expect(await raw(page)).toEqual([])
  })
  test('记录按顺序保留重复', async () => {
    const { page, t } = await setup(link('a', '/p1', BLANK) + link('b', '/p2', BLANK))
    await arm(t.id)
    for (const s of ['#a', '#b', '#a']) await page.click(s)
    expect(await raw(page)).toEqual([`${ORIGIN}/p1`, `${ORIGIN}/p2`, `${ORIGIN}/p1`])
  })
  test.each([['_BLANK'], [`  ${BLANK} `], ['newwin']])('目标 %p → 拦截', async (target) => {
    expect(await clickRaw(link('a', '/n', target), '#a')).toEqual([`${ORIGIN}/n`])
  })
  test.each([['_self'], ['_TOP'], ['_parent'], ['']])('目标 %p → 不拦截', async (target) => {
    expect(await clickRaw(link('a', '#x', target), '#a')).toEqual([])
  })
  test('base target=_blank、链接无 target → 拦截', async () => {
    expect(await clickRaw(link('a', '/bt'), '#a', `<base target="${BLANK}">`)).toEqual([`${ORIGIN}/bt`])
  })
  test('base target=_blank、链接 target 为空串 → 不拦截', async () => {
    expect(await clickRaw(link('a', '#e', ''), '#a', `<base target="${BLANK}">`)).toEqual([])
  })
  test('目标等于窗口名 → 不拦截', async () => {
    const { page, t } = await setup(link('a', '#w', 'me'))
    await page.evaluate(() => (window.name = 'me'))
    await arm(t.id)
    await page.click('#a')
    expect(await raw(page)).toEqual([])
  })
  test('目标是页面里的 iframe 名 → 不拦截', async () => {
    expect(await clickRaw(`<iframe name="frm" src="about:blank"></iframe>` + link('a', '/in-frame', 'frm'), '#a')).toEqual([])
  })
  test('点在链接的后代上 → 拦截', async () => {
    expect(await clickRaw(`<a id="a" href="/kid" target="${BLANK}"><span id="k">kid</span></a>`, '#k')).toEqual([`${ORIGIN}/kid`])
  })
  test('开放 shadow root 里的链接 → 拦截', async () => {
    const body = `<div id="host"></div><script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<a id="sa" href="/sh" target="${BLANK}">sh</a>'</script>`
    expect(await clickRaw(body, '#sa')).toEqual([`${ORIGIN}/sh`])
  })
  test.each([
    ['按钮', `<a href="/i1" target="${BLANK}"><button id="k">b</button></a>`],
    ['输入框', `<a href="/i2" target="${BLANK}"><input id="k" value="v"></a>`],
    ['可编辑元素', `<a href="/i3" target="${BLANK}"><span id="k" contenteditable="true">e</span></a>`],
    ['label', `<a href="/i4" target="${BLANK}"><label id="k">l</label></a>`],
  ])('点在链接内的%s上 → 不拦截', async (_n, body) => {
    expect(await clickRaw(body, '#k')).toEqual([])
  })
  test('链接处在可编辑区域内 → 不拦截', async () => {
    expect(await clickRaw(`<div contenteditable="true">${link('a', '/ce', BLANK)}</div>`, '#a')).toEqual([])
  })
  test.each([['mailto:z@x.test'], ['javascript:void 0']])('非 http(s) 地址 %p → 不拦截', async (href) => {
    expect(await clickRaw(link('a', href, BLANK), '#a')).toEqual([])
  })
  test('没有 href → 不拦截', async () => {
    expect(await clickRaw(`<a id="a" target="${BLANK}">no</a>`, '#a')).toEqual([])
  })
  test('同源 download → 不拦截；跨源 download → 拦截', async () => {
    expect(await clickRaw(link('a', '/dl', BLANK, 'download'), '#a')).toEqual([])
    expect(await clickRaw(link('a', `${OTHER}/dl`, BLANK, 'download'), '#a')).toEqual([`${OTHER}/dl`])
  })
  test('页面自己已阻止默认动作 → 不记录', async () => {
    expect(await clickRaw(link('a', '/pd', BLANK, 'onclick="event.preventDefault()"'), '#a')).toEqual([])
  })
  test('脚本合成的点击 → 不记录', async () => {
    const { page, t } = await setup(link('a', '/syn', BLANK))
    await arm(t.id)
    await page.evaluate(() => (document.getElementById('a') as HTMLElement).click())
    expect(await raw(page)).toEqual([])
  })
  test('未武装 / 取回之后 → 不拦，照常开新窗口', async () => {
    const { page, t, pop } = await setup(link('a', '/p1', BLANK))
    expect(await raw(page)).toEqual([])
    await arm(t.id)
    expect(await raw(page)).toEqual([])
    await page.click('#a')
    await page.waitForEvent('popup', { timeout: 5000 }).catch(() => {})
    expect(pop.count).toBe(1)
    expect(await raw(page)).toEqual([])
  })
  test('abort 之后不再拦截', async () => {
    const { page, t } = await setup(link('a', '/p1', BLANK))
    const c = await arm(t.id)
    await abortClickInterception(c)
    await page.click('#a')
    expect(await raw(page)).toEqual([])
  })
  test('再次武装：清空记录、不重复记', async () => {
    const { page, t } = await setup(link('a', '/p1', BLANK) + link('b', '/p2', BLANK))
    await arm(t.id)
    await page.click('#a')
    await arm(t.id)
    await page.click('#b')
    expect(await raw(page)).toEqual([`${ORIGIN}/p2`])
  })
  test('武装 10 秒内有效，超过后失效', async () => {
    const { page, t } = await setup(link('a', '/early', BLANK) + link('b', '/late', BLANK))
    await page.clock.install()
    await arm(t.id)
    await page.clock.fastForward(8_000)
    await page.click('#a')
    await page.clock.fastForward(2_500)
    await page.click('#b')
    expect(await raw(page)).toEqual([`${ORIGIN}/early`])
  })
})
