import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { makeDeps } from './fakes/input-deps'

// 模块加载时会读存储、挂存储监听，所以先挂假 chrome 和替身，再动态导入
const fake = makeDeps()
;(globalThis as any).chrome = fake.chrome
mock.module('../../extension/debugger.js', () => fake.debuggerModule)
mock.module('../../extension/keys.js', () => fake.keysModule)
mock.module('../../extension/abort.js', () => fake.abortModule)
mock.module('../../extension/dom-input.js', () => fake.domModule)
const mod: any = await import('../../extension/input.js')
const { isMac, modifierMask, drag, isZoomChord, click, hover, wheel, type, key, insertText } = mod
const { state } = fake

// CDP Input 域的修饰位
const ALT = 1, CTRL = 2, META = 4, SHIFT = 8
const MOUSE = 'Input.dispatchMouseEvent'
const KEY = 'Input.dispatchKeyEvent'
const INSERT = 'Input.insertText'
const T = 7

const sent = (m?: string) => state.sent.filter((c) => !m || c.method === m)
const mouse = () => sent(MOUSE).map((c) => c.params)
const keys = () => sent(KEY).map((c) => c.params)
const errOf = async (p: Promise<unknown>) => p.then(() => null, (e) => e)
const attachFailed = () => Object.assign(new Error('no attach'), { code: 'debugger_attach_failed' })
const isDown = (t: string) => t === 'keyDown' || t === 'rawKeyDown'

beforeEach(() => {
  state.sent.length = 0
  state.dom.length = 0
  state.failWith = undefined
  state.onSend = undefined
  fake.fireStorage({ clickMode: { newValue: 'debugger' } }, 'local')
})

describe('导出面与加载副作用', () => {
  test('导出清单冻结', () => {
    expect(Object.keys(mod).sort()).toEqual(['click', 'drag', 'hover', 'insertText', 'isMac', 'isZoomChord', 'key', 'modifierMask', 'type', 'wheel'].sort())
  })
  test('加载时挂了存储变化监听', () => expect(fake.listeners.length).toBeGreaterThanOrEqual(1))
})

describe('isMac', () => {
  test('Mac 平台为 true，平台只查一次', async () => {
    expect(await isMac()).toBe(true)
    const n = state.platformCalls
    expect(await isMac()).toBe(true)
    expect(state.platformCalls).toBe(n)
  })
})

describe('modifierMask', () => {
  test.each([
    ['ctrl', CTRL], ['Control', CTRL], ['alt', ALT], ['shift', SHIFT],
    ['cmd', META], ['META', META], ['command', META], ['win', META], ['windows', META],
    ['ctrl+shift', CTRL | SHIFT], [' alt + ctrl ', ALT | CTRL], ['Ctrl+Alt+Shift+Cmd', 15],
    ['ctrl+ctrl', CTRL], ['ctrl+x', CTRL], ['banana', 0], ['', 0],
  ])('%p → %p', (s, m) => expect(modifierMask(s)).toBe(m))
})

describe('isZoomChord', () => {
  test.each([
    ['ctrl+=', true], ['cmd+-', true], ['ctrl+0', true], ['CTRL+PLUS', true], ['ctrl++', true],
    ['meta+numpadadd', true], ['ctrl+numpad0', true], ['ctrl+minus', true], ['ctrl+shift+=', true], ['shift+cmd+plus', true],
    ['ctrl+shift+-', false], ['ctrl+shift+0', false], ['alt+=', false], ['=', false], ['ctrl+a', false],
    ['ctrl+', false], ['', false], ['ctrl+alt+=', false],
  ])('%p → %p', (s, v) => expect(isZoomChord(s)).toBe(v))
})

describe('click（调试器路径）', () => {
  test('单击：先移动到点，再一次按下 + 抬起，按钮与点击次数正确', async () => {
    await click(T, 10.6, 20.2)
    const ev = mouse()
    expect(sent().every((c) => c.tabId === T)).toBe(true)
    expect(ev.map((e) => e.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    for (const e of ev) {
      expect([e.x, e.y]).toEqual([11, 20])
      expect(e.modifiers).toBe(0)
    }
    expect(ev[1]).toMatchObject({ button: 'left', buttons: 1, clickCount: 1 })
    expect(ev[2]).toMatchObject({ button: 'left', buttons: 0, clickCount: 1 })
  })

  test('双击：两对按下/抬起，点击次数依次 1、2', async () => {
    await click(T, 5, 5, 'left', 2)
    const ev = mouse()
    expect(ev.map((e) => e.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased'])
    expect(ev.slice(1).map((e) => e.clickCount)).toEqual([1, 1, 2, 2])
  })

  test.each([['right', 2], ['middle', 4]])('%s 键：按下时按钮名与按键掩码对应', async (b, mask) => {
    await click(T, 1, 1, b)
    const ev = mouse()
    expect(ev[1]).toMatchObject({ type: 'mousePressed', button: b, buttons: mask })
    expect(ev[2]).toMatchObject({ type: 'mouseReleased', button: b, buttons: 0 })
  })

  test('修饰位带在每个事件上', async () => {
    await click(T, 1, 1, 'left', 1, CTRL | SHIFT)
    expect(mouse().every((e) => e.modifiers === (CTRL | SHIFT))).toBe(true)
  })

  test('before 在每次按下前各调一次', async () => {
    const order: string[] = []
    state.onSend = (c) => order.push(c.params.type)
    await click(T, 1, 1, 'left', 3, 0, async () => void order.push('before'))
    const presses = order.map((x, i) => (x === 'mousePressed' ? order[i - 1] : null)).filter((x) => x !== null)
    expect(presses).toEqual(['before', 'before', 'before'])
    expect(order.filter((x) => x === 'before').length).toBe(3)
  })

  test('before 失败：错误透传，不发按下', async () => {
    const boom = Object.assign(new Error('moved'), { code: 'navigated_away' })
    const e = await errOf(click(T, 1, 1, 'left', 1, 0, async () => { throw boom }))
    expect(e).toBe(boom)
    expect(mouse().some((x) => x.type === 'mousePressed')).toBe(false)
  })
})

describe('hover / wheel', () => {
  test('hover：只有一次移动，不按任何键', async () => {
    await hover(T, 3.4, 4.6)
    const ev = mouse()
    expect(ev.length).toBe(1)
    expect(ev[0]).toMatchObject({ type: 'mouseMoved', x: 3, y: 5 })
    expect(ev[0].buttons ?? 0).toBe(0)
  })
  test('wheel：一次滚轮事件带两个方向增量', async () => {
    await wheel(T, 10, 20, -30, 120)
    const ev = mouse()
    expect(ev.length).toBe(1)
    expect(ev[0]).toMatchObject({ type: 'mouseWheel', x: 10, y: 20, deltaX: -30, deltaY: 120 })
  })
})

describe('drag', () => {
  test('起点按下、按住左键经过线段上的点、终点抬起', async () => {
    await drag(T, [0, 0], [100, 50])
    const ev = mouse()
    const pi = ev.findIndex((e) => e.type === 'mousePressed')
    const ri = ev.findIndex((e) => e.type === 'mouseReleased')
    expect(pi).toBeGreaterThanOrEqual(0)
    expect(ev.filter((e) => e.type === 'mousePressed').length).toBe(1)
    expect(ev.filter((e) => e.type === 'mouseReleased').length).toBe(1)
    expect(ev[pi]).toMatchObject({ x: 0, y: 0, button: 'left', buttons: 1 })
    expect(ev[ri]).toMatchObject({ x: 100, y: 50, button: 'left', buttons: 0 })
    expect(ri).toBe(ev.length - 1)
    const mid = ev.slice(pi + 1, ri)
    expect(mid.length).toBeGreaterThanOrEqual(1)
    let last = 0
    for (const m of mid) {
      expect(m.type).toBe('mouseMoved')
      expect(m.buttons).toBe(1)
      expect(Math.abs(m.y - m.x / 2)).toBeLessThanOrEqual(1) // 在线段上（允许取整）
      expect(m.x).toBeGreaterThanOrEqual(last)
      last = m.x
    }
    expect(mid.at(-1)).toMatchObject({ x: 100, y: 50 })
  })

  test('开始前已中止：抛 stopped，不发任何事件', async () => {
    const ac = new AbortController()
    ac.abort()
    expect((await errOf(drag(T, [0, 0], [10, 10], ac.signal)))?.code).toBe('stopped')
    expect(mouse().length).toBe(0)
  })

  test('中途中止：补发一次松开按键的抬起，再抛 stopped', async () => {
    const ac = new AbortController()
    state.onSend = (c) => { if (c.params.type === 'mousePressed') ac.abort() }
    expect((await errOf(drag(T, [0, 0], [10, 10], ac.signal)))?.code).toBe('stopped')
    const ev = mouse()
    expect(ev.at(-1)).toMatchObject({ type: 'mouseReleased', buttons: 0 })
  })

  test('中途中止且补发抬起也失败：抛出的仍是 stopped', async () => {
    const ac = new AbortController()
    state.onSend = (c) => { if (c.params.type === 'mousePressed') ac.abort() }
    state.failWith = (c) => (c.params.type === 'mouseReleased' ? new Error('release failed') : undefined)
    expect((await errOf(drag(T, [0, 0], [10, 10], ac.signal)))?.code).toBe('stopped')
  })

  test('调试器挂不上：错误透传，不退到页面内模拟', async () => {
    state.failWith = () => attachFailed()
    expect((await errOf(drag(T, [0, 0], [10, 10])))?.code).toBe('debugger_attach_failed')
    expect(state.dom.length).toBe(0)
  })
})

describe('type：输入 → 事件结果', () => {
  // 每个字符对应 [按下事件类型, key, code, keyCode, 修饰位, text]；null 表示走文本插入
  const pairs = () => {
    const out: any[] = []
    for (const c of state.sent) {
      if (c.method === INSERT) out.push({ insert: c.params.text })
      else if (isDown(c.params.type)) out.push({ down: c.params })
      else out.at(-1).up = c.params
    }
    return out
  }

  test.each([
    ['a', 'a', 'KeyA', 65, 0],
    ['z', 'z', 'KeyZ', 90, 0],
    ['A', 'A', 'KeyA', 65, SHIFT],
    ['Q', 'Q', 'KeyQ', 81, SHIFT],
    ['7', '7', 'Digit7', 55, 0],
    ['!', '!', 'Digit1', 49, SHIFT],
    ['?', '?', 'Slash', 191, SHIFT],
    ['/', '/', 'Slash', 191, 0],
    [' ', ' ', 'Space', 32, 0],
  ])('%p → 一次按下+抬起，key=%p code=%p keyCode=%p 修饰=%p', async (ch, k, code, kc, m) => {
    await type(T, ch)
    const p = pairs()
    expect(p.length).toBe(1)
    expect(p[0].down).toMatchObject({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: kc, modifiers: m, text: ch, unmodifiedText: ch })
    expect(p[0].up).toMatchObject({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: kc, modifiers: m })
    expect(p[0].up.text ?? '').toBe('')
  })

  test.each([['\n'], ['\r']])('换行 %p → 回车键，文字为回车符', async (ch) => {
    await type(T, ch)
    const p = pairs()
    expect(p.length).toBe(1)
    expect(p[0].down).toMatchObject({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers: 0 })
  })

  test('"\\r\\n" → 两次回车', async () => {
    await type(T, '\r\n')
    expect(pairs().map((p) => p.down?.key)).toEqual(['Enter', 'Enter'])
  })

  test.each([['é'], ['中'], ['😀']])('键表外字符 %p → 一次文本插入，整字符不被切开', async (ch) => {
    await type(T, ch)
    expect(pairs()).toEqual([{ insert: ch }])
  })

  test('混合串逐字按顺序', async () => {
    await type(T, 'aB中\n')
    const p = pairs()
    expect(p.map((x) => x.insert ?? x.down.key)).toEqual(['a', 'B', '中', 'Enter'])
    expect(p.map((x) => x.down?.modifiers ?? null)).toEqual([0, SHIFT, null, 0])
  })

  test('空串不发事件', async () => {
    await type(T, '')
    expect(state.sent.length).toBe(0)
  })

  test('中途中止：后面的字不再发，抛 stopped', async () => {
    const ac = new AbortController()
    state.onSend = (_c, n) => { if (n === 2) ac.abort() } // 第一个字的按下 + 抬起之后
    expect((await errOf(type(T, 'abcd', ac.signal)))?.code).toBe('stopped')
    expect(pairs().length).toBe(1)
  })
})

describe('key：输入 → 事件结果', () => {
  test.each([
    ['Enter', 'keyDown', 'Enter', 13, '\r'],
    ['enter', 'keyDown', 'Enter', 13, '\r'],
    ['Tab', 'rawKeyDown', 'Tab', 9, ''],
    ['LEFT', 'rawKeyDown', 'ArrowLeft', 37, ''],
    ['space', 'keyDown', ' ', 32, ' '],
    ['a', 'keyDown', 'a', 65, 'a'],
  ])('单键 %p → 按下类型 %p、key %p', async (input, t, k, kc, text) => {
    await key(T, input)
    const ev = keys()
    expect(ev.map((e) => e.type)).toEqual([t, 'keyUp'])
    expect(ev[0]).toMatchObject({ key: k, windowsVirtualKeyCode: kc, modifiers: 0, text })
    if (text) expect(ev[0].unmodifiedText).toBe(text)
    expect(ev[1]).toMatchObject({ key: k, windowsVirtualKeyCode: kc, modifiers: 0 })
  })

  test('单键大写字母不自动加 Shift', async () => {
    await key(T, 'A')
    expect(keys()[0].modifiers).toBe(0)
  })

  test('单键即使在 Mac 命令表里也不附带编辑命令', async () => {
    await key(T, 'Enter')
    expect(keys()[0].commands ?? []).toEqual([])
  })

  test('小键盘条目：位置与小键盘标记体现在事件上', async () => {
    await key(T, 'padfive')
    const [d, u] = keys()
    expect(d).toMatchObject({ code: 'Numpad5', isKeypad: true, location: 3 })
    expect(u).toMatchObject({ code: 'Numpad5', location: 3 })
  })

  test.each([['hello'], ['é']])('键表外的单键 %p → 当文本插入', async (s) => {
    await key(T, s)
    expect(sent(KEY).length).toBe(0)
    expect(sent(INSERT).map((c) => c.params.text)).toEqual([s])
  })

  test.each([
    ['ctrl+a', CTRL, 'KeyA', ['cmdA']],
    ['CTRL+A', CTRL, 'KeyA', ['cmdA']],
    ['ctrl+o', CTRL, 'KeyO', ['c1', 'c2']],
    ['alt+ctrl+q', ALT | CTRL, 'KeyQ', ['cmdQ']],
    ['ctrl+alt+q', ALT | CTRL, 'KeyQ', []], // 整串原样查表，不重排
    ['cmd+shift+z', META | SHIFT, 'KeyZ', []],
    ['alt+left', ALT, 'ArrowLeft', []],
    ['ctrl+enter', CTRL, 'Enter', []],
  ])('Mac 组合键 %p → 修饰 %p、code %p、编辑命令 %p', async (chord, m, code, cmds) => {
    await key(T, chord)
    const [d, u] = keys()
    expect(keys().length).toBe(2)
    expect(isDown(d.type)).toBe(true)
    expect(d).toMatchObject({ code, modifiers: m })
    expect(d.commands ?? []).toEqual(cmds)
    expect(u).toMatchObject({ type: 'keyUp', code, modifiers: m })
  })

  test.each([['ctrl+'], ['ctrl+shift'], ['+'], ['ctrl++'], ['ctrl+nosuchkey'], ['alt+中']])('组合键 %p 非法 → invalid_params，不发事件', async (chord) => {
    const e = await errOf(key(T, chord))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('invalid_params')
    expect(String(e.message).toLowerCase()).toContain(chord.toLowerCase())
    expect(state.sent.length).toBe(0)
  })
})

describe('insertText', () => {
  test('整段一次插入', async () => {
    await insertText(T, 'hello 世界\n')
    expect(state.sent).toEqual([{ tabId: T, method: INSERT, params: { text: 'hello 世界\n' } }])
  })
})

describe('退到页面内模拟', () => {
  test('调试器挂不上：click 改走页面内点击，参数去掉修饰位，before 仍被调用', async () => {
    state.failWith = () => attachFailed()
    let called = 0
    const before = async () => void called++
    expect(await click(T, 3, 4, 'right', 2, CTRL, before)).toBe('dom-ok')
    const d = state.dom.find((x) => x.fn === 'domClick')!
    expect(d.args.slice(0, 5)).toEqual([T, 3, 4, 'right', 2])
    expect(d.args[5]).toBe(before)
    expect(called).toBeGreaterThanOrEqual(1)
  })

  test.each([
    ['hover', () => hover(T, 1, 2), 'domHover', [T, 1, 2]],
    ['wheel', () => wheel(T, 1, 2, 3, 4), 'domWheel', [T, 1, 2, 3, 4]],
    ['type', () => type(T, 'hi'), 'domText', [T, 'hi']],
    ['key', () => key(T, 'ctrl+a'), 'domKey', [T, 'ctrl+a']],
    ['insertText', () => insertText(T, 'x'), 'domText', [T, 'x']],
  ])('%s 挂不上调试器 → 对应页面内函数，参数原样', async (_n, run, fn, args) => {
    state.failWith = () => attachFailed()
    await run()
    expect(state.dom.map((x) => x.fn)).toEqual([fn])
    expect(state.dom[0].args.slice(0, args.length)).toEqual(args)
  })

  test('其他调试器错误原样抛出，不退', async () => {
    const boom = Object.assign(new Error('gone'), { code: 'debugger_detached' })
    state.failWith = () => boom
    expect(await errOf(click(T, 1, 1))).toBe(boom)
    expect(await errOf(key(T, 'a'))).toBe(boom)
    expect(state.dom.length).toBe(0)
  })

  test('设置切到页面内模式：不碰调试器；切回后恢复', async () => {
    fake.fireStorage({ clickMode: { newValue: 'dom' } }, 'local')
    await click(T, 1, 1)
    await type(T, 'x')
    expect(state.sent.length).toBe(0)
    expect(state.dom.map((x) => x.fn)).toEqual(['domClick', 'domText'])
    fake.fireStorage({ clickMode: { newValue: 'debugger' } }, 'local')
    state.dom.length = 0
    await click(T, 1, 1)
    expect(state.dom.length).toBe(0)
    expect(mouse().length).toBe(3)
  })

  test('非 local 区或无关键的存储变化不影响', async () => {
    fake.fireStorage({ clickMode: { newValue: 'dom' } }, 'sync')
    fake.fireStorage({ other: { newValue: 'dom' } }, 'local')
    await hover(T, 1, 1)
    expect(state.dom.length).toBe(0)
    expect(mouse().length).toBe(1)
  })
})

describe('另一平台 + 加载时已设页面内模式（新模块实例）', () => {
  let other: any
  test('加载即读存储：页面内模式生效', async () => {
    state.platform = 'linux'
    state.initialMode = 'dom'
    const second = '../../extension/input.js?second' // 带查询串得到新的模块实例
    other = await import(second)
    state.initialMode = undefined
    await other.hover(T, 1, 1)
    expect(state.sent.length).toBe(0)
    expect(state.dom.map((x) => x.fn)).toEqual(['domHover'])
  })
  test('非 Mac：isMac 为 false，组合键不附带编辑命令', async () => {
    fake.fireStorage({ clickMode: { newValue: 'debugger' } }, 'local')
    expect(await other.isMac()).toBe(false)
    await other.key(T, 'ctrl+a')
    const [d] = keys()
    expect(d).toMatchObject({ code: 'KeyA', modifiers: CTRL })
    expect(d.commands ?? []).toEqual([])
  })
})
