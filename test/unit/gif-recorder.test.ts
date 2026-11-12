import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { GIF_B64, GIF_H, GIF_W, makeFakes } from './fakes/gif-recorder-fakes'

// 计时压缩：模块用全局 setTimeout 计时；所有等待按 1/200 执行，让「超时」类用例秒级跑完，实现里的短暂等待也不拖慢用例
const SPEED = 200
const realSetTimeout = globalThis.setTimeout
;(globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => realSetTimeout(fn, ms && ms > 0 ? ms / SPEED : ms, ...rest)
afterAll(() => {
  globalThis.setTimeout = realSetTimeout
})
const COMPOSE_CAP = 120000 / SPEED // 合成等待上限（压缩后）
const DL_CAP = 30000 / SPEED // 下载等待上限（压缩后）

const f = makeFakes()
;(globalThis as any).chrome = f.chrome
mock.module('../../extension/screenshot.js', () => f.screenshotModule)
mock.module('../../extension/background-tab.js', () => f.backgroundTabModule)
mock.module('../../extension/debugger.js', () => f.debuggerModule)
mock.module('../../extension/sessions.js', () => f.sessionsModule)
const mod = await import('../../extension/gif-recorder.js')
const hooksAfterImport = f.sessionsModule.sessionClosedHooks.length
const { gifCreator, isRecording, recordAction } = mod as any

let seq = 0
const fresh = () => ({ name: `sess-${++seq}` })
const TAB = 7
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected rejection') }, (e) => e)
const gif = (s: any, action: string, extra: any = {}) => gifCreator({ action, ...extra }, s, TAB)
const start = (s: any) => gif(s, 'start_recording')
const shotResult = (img = 'agent-shot', imageFormat?: string) => ({ base64Image: img, ...(imageFormat ? { imageFormat } : {}) })
const act = (s: any, action: string, extra: any = {}, result: any = {}) => recordAction(s, TAB, 'computer', { action, ...extra }, result)
// 取帧：让合成失败（不清帧），从合成请求里读出帧
async function framesOf(s: any) {
  const before = f.composeMessages().length
  const prev = f.state.compose
  f.state.compose = 'fail'
  await caught(gif(s, 'export', { download: true }))
  f.state.compose = prev
  const msgs = f.composeMessages()
  return msgs.length > before ? msgs[msgs.length - 1].frames : []
}
const hasNumber = (text: string, n: number) => expect(text).toMatch(new RegExp(`(^|\\D)${n}(\\D|$)`))
const CTX_A = { viewportWidth: 1000, viewportHeight: 500, screenshotWidth: 2000, screenshotHeight: 1000 }

beforeEach(() => f.reset())

describe('导出面与导入副作用', () => {
  test('只导出三个函数', () => expect(Object.keys(mod).sort()).toEqual(['gifCreator', 'isRecording', 'recordAction']))
  test('导入时往会话关闭钩子推入一个回调', () => {
    expect(hooksAfterImport).toBe(1)
    expect(typeof f.sessionsModule.sessionClosedHooks[0]).toBe('function')
  })
  test('gifCreator / recordAction 返回 Promise', async () => {
    const s = fresh()
    const a = gif(s, 'stop_recording')
    const b = recordAction(s, TAB, 'computer', { action: 'key' }, {})
    expect(a).toBeInstanceOf(Promise)
    expect(b).toBeInstanceOf(Promise)
    await a
    await b
  })
})

describe('gifCreator 参数', () => {
  test.each([[undefined], [null], [{}], [{ action: '' }]])('p=%p → invalid_params', async (p) => {
    const e = await caught(gifCreator(p, fresh(), TAB))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('invalid_params')
  })
  test.each([['START_RECORDING'], ['pause'], [5]])('未知动作 %p → invalid_params，message 列出合法动作', async (action) => {
    const e = await caught(gifCreator({ action }, fresh(), TAB))
    expect(e.code).toBe('invalid_params')
    for (const a of ['start_recording', 'stop_recording', 'export', 'clear']) expect(e.message).toContain(a)
  })
  test('返回只有 output 一个键', async () => {
    const r = await start(fresh())
    expect(Object.keys(r)).toEqual(['output'])
    expect(typeof r.output).toBe('string')
    expect(r.output.length).toBeGreaterThan(0)
  })
})

describe('录制状态', () => {
  test('开始 → 在录；停止 → 不在录，输出含帧数', async () => {
    const s = fresh()
    expect(isRecording(s.name)).toBe(false)
    await start(s)
    expect(isRecording(s.name)).toBe(true)
    for (let i = 0; i < 3; i++) await act(s, 'key', { text: 'a' })
    const r = await gif(s, 'stop_recording')
    expect(isRecording(s.name)).toBe(false)
    hasNumber(r.output, 3)
    expect(await framesOf(s)).toHaveLength(3) // 停止后帧保留
  })
  test('没在录时停止 → 不报错，状态不变', async () => {
    const s = fresh()
    const r = await gif(s, 'stop_recording')
    expect(typeof r.output).toBe('string')
    expect(isRecording(s.name)).toBe(false)
  })
  test('已在录再开始 → 不报错，帧保留，仍在录', async () => {
    const s = fresh()
    await start(s)
    await act(s, 'key', { text: 'a' })
    await act(s, 'key', { text: 'b' })
    const r = await start(s)
    expect(typeof r.output).toBe('string')
    expect(isRecording(s.name)).toBe(true)
    expect(await framesOf(s)).toHaveLength(2)
  })
  test('停止后重新开始 → 丢掉旧帧', async () => {
    const s = fresh()
    await start(s)
    await act(s, 'key', { text: 'a' })
    await gif(s, 'stop_recording')
    await start(s)
    const r = await gif(s, 'stop_recording')
    hasNumber(r.output, 0)
    expect((await caught(gif(s, 'export', { download: true }))).code).toBe('invalid_params')
  })
  test('clear 有帧 → 丢帧、停止录制，输出含丢掉的帧数', async () => {
    const s = fresh()
    await start(s)
    for (let i = 0; i < 4; i++) await act(s, 'key', { text: 'a' })
    const r = await gif(s, 'clear')
    hasNumber(r.output, 4)
    expect(isRecording(s.name)).toBe(false)
    expect((await caught(gif(s, 'export', { download: true }))).code).toBe('invalid_params')
  })
  test('clear 无帧 → 不报错', async () => {
    const r = await gif(fresh(), 'clear')
    expect(typeof r.output).toBe('string')
  })
  test('会话之间互不影响', async () => {
    const a = fresh()
    const b = fresh()
    await start(a)
    await act(a, 'key', { text: 'x' })
    await act(b, 'key', { text: 'y' })
    expect(isRecording(b.name)).toBe(false)
    expect(await framesOf(a)).toHaveLength(1)
    expect((await caught(gif(b, 'export', { download: true }))).code).toBe('invalid_params')
  })
  test('会话关闭钩子只清该会话', async () => {
    const a = fresh()
    const b = fresh()
    await start(a)
    await start(b)
    await act(a, 'key', { text: 'x' })
    await act(b, 'key', { text: 'y' })
    for (const h of f.sessionsModule.sessionClosedHooks) await h([TAB], a.name)
    expect(isRecording(a.name)).toBe(false)
    expect((await caught(gif(a, 'export', { download: true }))).code).toBe('invalid_params')
    expect(isRecording(b.name)).toBe(true)
    expect(await framesOf(b)).toHaveLength(1)
  })
  test.each([['nobody'], [undefined], [42]])('isRecording(%p) → false', (n) => expect(isRecording(n)).toBe(false))
  test('最多 50 帧，超了丢最早的', async () => {
    const s = fresh()
    await start(s)
    const first = f.state.shotSeq + 1
    for (let i = 0; i < 53; i++) await act(s, 'key', { text: 'a' })
    const fr = await framesOf(s)
    expect(fr).toHaveLength(50)
    expect(fr[0].base64).toBe(`shot-${first + 3}`)
    expect(fr[49].base64).toBe(`shot-${first + 52}`)
  })
})

describe('recordAction：何时不做事', () => {
  test('没在录 → 不调用任何依赖', async () => {
    const s = fresh()
    await act(s, 'left_click', { coordinate: [10, 10] })
    await recordAction(s, TAB, 'navigate', { url: 'https://a.test/' }, {})
    expect(f.state.shotCalls).toHaveLength(0)
    expect(f.state.toViewportCalls).toHaveLength(0)
    expect(f.state.sent).toHaveLength(0)
    expect(f.state.bgCalls).toHaveLength(0)
  })
  test.each([[undefined], [{}], [{ name: '' }]])('s=%p → 正常完成，不做事', async (s) => {
    await recordAction(s, TAB, 'computer', { action: 'key' }, {})
    expect(f.state.shotCalls).toHaveLength(0)
  })
  test('computer 没有 action / navigate 没有 url → 不存帧', async () => {
    const s = fresh()
    await start(s)
    await recordAction(s, TAB, 'computer', {}, {})
    await recordAction(s, TAB, 'navigate', {}, {})
    expect(f.state.shotCalls).toHaveLength(0)
    expect((await caught(gif(s, 'export', { download: true }))).code).toBe('invalid_params')
  })
})

describe('recordAction：截图与 zoom 帧', () => {
  test('screenshot → 直接用代理拿到的图，格式缺省 jpeg，视口取当前上下文，不再截图', async () => {
    const s = fresh()
    await start(s)
    f.state.ctx.set(TAB, { ...CTX_A })
    await act(s, 'screenshot', {}, shotResult('agent-1'))
    expect(f.state.shotCalls).toHaveLength(0)
    const [fr] = await framesOf(s)
    expect(fr.base64).toBe('agent-1')
    expect(fr.format).toBe('jpeg')
    expect(fr.action).toBeUndefined()
    expect(fr.viewportWidth).toBe(1000)
    expect(fr.viewportHeight).toBe(500)
  })
  test('screenshot 带 imageFormat → 用它；没上下文 → 无视口尺寸', async () => {
    const s = fresh()
    await start(s)
    await act(s, 'screenshot', {}, shotResult('agent-2', 'png'))
    const [fr] = await framesOf(s)
    expect(fr.format).toBe('png')
    expect(fr.viewportWidth).toBeUndefined()
  })
  test('zoom → 直接用图，格式缺省 png，带动作，无视口尺寸', async () => {
    const s = fresh()
    await start(s)
    f.state.ctx.set(TAB, { ...CTX_A })
    await act(s, 'zoom', { region: [0, 0, 10, 10] }, shotResult('zoomed'))
    expect(f.state.shotCalls).toHaveLength(0)
    const [fr] = await framesOf(s)
    expect(fr.base64).toBe('zoomed')
    expect(fr.format).toBe('png')
    expect(fr.action.type).toBe('zoom')
    expect(fr.viewportWidth).toBeUndefined()
  })
  test('screenshot / zoom 没有图 → 不存帧', async () => {
    const s = fresh()
    await start(s)
    await act(s, 'screenshot', {}, {})
    await act(s, 'zoom', {}, undefined)
    expect(f.state.shotCalls).toHaveLength(0)
    expect((await caught(gif(s, 'export', { download: true }))).code).toBe('invalid_params')
  })
})

describe('recordAction：动作后截图', () => {
  test('按键 → 一帧新截图；缩放 1，后台包裹内且已唤醒；视口取截图后的上下文', async () => {
    const s = fresh()
    await start(s)
    await act(s, 'key', { text: 'Enter' })
    expect(f.state.shotCalls).toHaveLength(1)
    const c = f.state.shotCalls[0]
    expect(c.tabId).toBe(TAB)
    expect(c.scale === undefined || c.scale === 1).toBe(true)
    expect(c.inBackground).toBe(true)
    expect(c.woken).toBe(true)
    expect(f.state.bgCalls).toEqual([TAB])
    const [fr] = await framesOf(s)
    expect(fr.base64).toMatch(/^shot-/)
    expect(fr.format).toBe('jpeg')
    expect(fr.viewportWidth).toBe(1111)
    expect(fr.viewportHeight).toBe(555)
    expect(fr.action.type).toBe('key')
    expect(typeof fr.action.description).toBe('string')
    expect(fr.action.description.length).toBeGreaterThan(0)
  })
  test('录制截图不改变代理的坐标上下文', async () => {
    const s = fresh()
    await start(s)
    f.state.ctx.set(TAB, { ...CTX_A })
    await act(s, 'scroll', { coordinate: [100, 100] })
    expect(f.state.shotCalls).toHaveLength(1)
    expect(f.state.ctx.get(TAB)).toEqual(CTX_A)
  })
  test('截图后上下文读不到 → 视口尺寸用截图宽高', async () => {
    const s = fresh()
    await start(s)
    f.state.ctxHidden = true
    await act(s, 'key', { text: 'a' })
    f.state.ctxHidden = false
    const [fr] = await framesOf(s)
    expect(fr.viewportWidth).toBe(1500)
    expect(fr.viewportHeight).toBe(750)
  })
  test('navigate → 一帧，type 为 navigate', async () => {
    const s = fresh()
    await start(s)
    await recordAction(s, TAB, 'navigate', { url: 'https://two.test/' }, { output: 'ok' })
    const [fr] = await framesOf(s)
    expect(fr.action.type).toBe('navigate')
    expect(fr.action.description.length).toBeGreaterThan(0)
    expect(fr.action.coordinate).toBeUndefined()
    expect(fr.base64).toMatch(/^shot-/)
  })
  test('各类动作都有非空描述', async () => {
    const s = fresh()
    await start(s)
    for (const a of ['type', 'key', 'scroll', 'wait', 'hover', 'scroll_to']) await act(s, a, { text: 'hi' })
    const fr = await framesOf(s)
    expect(fr.map((x: any) => x.action.type)).toEqual(['type', 'key', 'scroll', 'wait', 'hover', 'scroll_to'])
    for (const x of fr) expect(typeof x.action.description === 'string' && x.action.description.length > 0).toBe(true)
  })
})

describe('recordAction：点击类', () => {
  test('有上一帧（带视口）→ 两帧：上一帧画面 + 标注，再动作后画面；坐标换成视口坐标', async () => {
    const s = fresh()
    await start(s)
    f.state.ctx.set(TAB, { ...CTX_A })
    await act(s, 'screenshot', {}, shotResult('before-img'))
    await act(s, 'left_click', { coordinate: [400, 200] })
    const fr = await framesOf(s)
    expect(fr).toHaveLength(3)
    expect(fr[1].base64).toBe('before-img')
    expect(fr[1].format).toBe('jpeg')
    expect(fr[1].viewportWidth).toBe(1000)
    expect(fr[1].viewportHeight).toBe(500)
    expect(fr[1].action.type).toBe('left_click')
    expect(fr[1].action.coordinate).toEqual([200, 100])
    expect(fr[2].base64).toMatch(/^shot-/)
    expect(fr[2].action.type).toBe('left_click')
    expect(fr[2].action.coordinate).toEqual([200, 100])
  })
  test.each([['right_click'], ['double_click'], ['triple_click']])('%p 也算点击类', async (a) => {
    const s = fresh()
    await start(s)
    f.state.ctx.set(TAB, { ...CTX_A })
    await act(s, 'screenshot', {}, shotResult('b'))
    await act(s, a, { coordinate: [10, 10] })
    expect(await framesOf(s)).toHaveLength(3)
  })
  test('拖拽：起点终点都换算，前后两帧', async () => {
    const s = fresh()
    await start(s)
    f.state.ctx.set(TAB, { ...CTX_A })
    await act(s, 'screenshot', {}, shotResult('b'))
    await act(s, 'left_click_drag', { start_coordinate: [100, 100], coordinate: [600, 300] })
    const fr = await framesOf(s)
    expect(fr).toHaveLength(3)
    for (const x of fr.slice(1)) {
      expect(x.action.type).toBe('left_click_drag')
      expect(x.action.start_coordinate).toEqual([50, 50])
      expect(x.action.coordinate).toEqual([300, 150])
    }
  })
  test('没有上一帧 → 只有动作后一帧', async () => {
    const s = fresh()
    await start(s)
    await act(s, 'left_click', { coordinate: [10, 10] })
    expect(await framesOf(s)).toHaveLength(1)
  })
  test('上一帧没有视口尺寸（zoom 帧）→ 只有动作后一帧', async () => {
    const s = fresh()
    await start(s)
    await act(s, 'zoom', {}, shotResult('z'))
    await act(s, 'left_click', { coordinate: [10, 10] })
    const fr = await framesOf(s)
    expect(fr).toHaveLength(2)
    expect(fr[1].base64).toMatch(/^shot-/)
  })
  test('坐标换算失败 / 形状不对 → 照常存帧，坐标缺省', async () => {
    const s = fresh()
    await start(s)
    f.state.ctx.set(TAB, { ...CTX_A })
    await act(s, 'left_click', { coordinate: [999999, 5] })
    await act(s, 'left_click', { coordinate: [1, 2, 3] })
    await act(s, 'left_click', { coordinate: 'x' })
    const fr = await framesOf(s)
    expect(fr.length).toBeGreaterThanOrEqual(3)
    for (const x of fr) expect(x.action.coordinate).toBeUndefined()
  })
})

describe('recordAction：失败不外溢', () => {
  test('截图失败 → 正常完成，不存动作后那帧', async () => {
    const s = fresh()
    await start(s)
    f.state.shotFails = true
    await act(s, 'key', { text: 'a' })
    expect((await caught(gif(s, 'export', { download: true }))).code).toBe('invalid_params')
  })
  test('点击时截图失败 → 「点之前」那帧保留', async () => {
    const s = fresh()
    await start(s)
    f.state.ctx.set(TAB, { ...CTX_A })
    await act(s, 'screenshot', {}, shotResult('b'))
    f.state.shotFails = true
    await act(s, 'left_click', { coordinate: [10, 10] })
    f.state.shotFails = false
    const fr = await framesOf(s)
    expect(fr).toHaveLength(2)
    expect(fr[1].action.type).toBe('left_click')
  })
  test('调试命令失败（等画面稳定）→ 照常存帧', async () => {
    const s = fresh()
    await start(s)
    f.state.sendFails = true
    await act(s, 'key', { text: 'a' })
    expect(await framesOf(s)).toHaveLength(1)
  })
  test('后台包裹抛错 → 正常完成', async () => {
    const s = fresh()
    await start(s)
    f.state.bgFails = true
    await act(s, 'key', { text: 'a' })
    expect(f.state.shotCalls).toHaveLength(0)
  })
})

// 录 n 帧按键，返回会话
async function recorded(n = 2) {
  const s = fresh()
  await start(s)
  for (let i = 0; i < n; i++) await act(s, 'key', { text: 'a' })
  f.state.log.length = 0
  f.state.messages.length = 0
  f.state.created.length = 0
  return s
}

describe('export：前置校验', () => {
  test.each([[{}], [{ coordinate: [1] }], [{ coordinate: 'x' }], [{ download: 'yes' }], [{ download: 1 }]])('%p → invalid_params，不建合成页', async (extra) => {
    const s = await recorded()
    const e = await caught(gif(s, 'export', extra))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('invalid_params')
    expect(f.state.created).toHaveLength(0)
  })
  test('0 帧 → invalid_params，不建合成页', async () => {
    const s = fresh()
    await start(s)
    expect((await caught(gif(s, 'export', { download: true }))).code).toBe('invalid_params')
    expect((await caught(gif(s, 'export', { coordinate: [1, 1] }))).code).toBe('invalid_params')
    expect(f.state.created).toHaveLength(0)
  })
  test.each([[false], [true]])('坐标越界（download=%p）→ 透传 coordinate_out_of_bounds，不建合成页，帧保留', async (download) => {
    const s = await recorded(2)
    f.state.ctx.set(TAB, { ...CTX_A })
    const e = await caught(gif(s, 'export', { coordinate: [-5, 3], download }))
    expect(e.code).toBe('coordinate_out_of_bounds')
    expect(f.state.created).toHaveLength(0)
    expect(await framesOf(s)).toHaveLength(2)
  })
})

describe('export：合成请求', () => {
  test('建合成页：offscreen.html + BLOBS 理由 + 非空说明', async () => {
    const s = await recorded()
    await gif(s, 'export', { download: true })
    expect(f.state.created).toHaveLength(1)
    const o = f.state.created[0]
    expect(String(o.url).endsWith('offscreen.html')).toBe(true)
    expect(o.reasons).toContain('BLOBS')
    expect(typeof o.justification).toBe('string')
    expect(o.justification.length).toBeGreaterThan(0)
  })
  test('选项缺省全开、质量 10', async () => {
    const s = await recorded()
    await gif(s, 'export', { download: true })
    const [m] = f.composeMessages()
    expect(typeof m.type).toBe('string')
    expect(m.options).toEqual({ showClickIndicators: true, showDragPaths: true, showActionLabels: true, showProgressBar: true, quality: 10 })
  })
  test('给了的选项原样转交，null 视为缺省', async () => {
    const s = await recorded()
    await gif(s, 'export', { download: true, options: { showProgressBar: false, showClickIndicators: null, quality: 42 } })
    const [m] = f.composeMessages()
    expect(m.options).toEqual({ showClickIndicators: true, showDragPaths: true, showActionLabels: true, showProgressBar: false, quality: 42 })
  })
  test('帧按顺序全部发出，字段齐全，帧时长按动作分类', async () => {
    const s = fresh()
    await start(s)
    f.state.ctx.set(TAB, { ...CTX_A })
    await act(s, 'screenshot', {}, shotResult('s0'))
    await act(s, 'wait', { duration: 1 })
    await act(s, 'left_click', { coordinate: [10, 10] })
    await act(s, 'type', { text: 'hi' })
    await act(s, 'key', { text: 'a' })
    await recordAction(s, TAB, 'navigate', { url: 'https://n.test/' }, {})
    await act(s, 'zoom', {}, shotResult('z'))
    await act(s, 'hover', { coordinate: [5, 5] })
    f.state.messages.length = 0
    await gif(s, 'export', { download: true })
    const [m] = f.composeMessages()
    const kinds = m.frames.map((x: any) => x.action?.type ?? null)
    expect(kinds).toEqual([null, 'wait', 'left_click', 'left_click', 'type', 'key', 'navigate', 'zoom', 'hover'])
    expect(m.frames.map((x: any) => x.delay)).toEqual([800, 300, 1500, 1500, 800, 800, 800, 800, 800])
    expect(m.frames[0]).toEqual({ base64: 's0', format: 'jpeg', delay: 800, viewportWidth: 1000, viewportHeight: 500 })
    const allowed = { base64: 0, format: 0, action: 0, delay: 0, viewportWidth: 0, viewportHeight: 0 }
    for (const x of m.frames) {
      expect(Object.keys(x).filter((k) => !(k in allowed))).toEqual([]) // 帧不得带其他字段
      expect(typeof x.base64).toBe('string')
      expect(['jpeg', 'png']).toContain(x.format)
    }
  })
  test.each([['right_click'], ['double_click'], ['triple_click'], ['left_click_drag']])('%p 帧时长 1500', async (a) => {
    const s = fresh()
    await start(s)
    await act(s, a, { coordinate: [1, 1], start_coordinate: [0, 0] })
    await gif(s, 'export', { download: true })
    const [m] = f.composeMessages().slice(-1)
    expect(m.frames.map((x: any) => x.delay)).toEqual([1500])
  })
})

describe('export：下载', () => {
  test('成功：用合成结果的 blob 地址下载、不弹框；下完再关页；输出含帧数 / 尺寸 / 落盘路径；之后清空并停录', async () => {
    const s = await recorded(3)
    const r = await gif(s, 'export', { download: true, filename: 'my-run.gif' })
    expect(Object.keys(r)).toEqual(['output'])
    expect(f.state.downloads).toEqual([{ url: 'blob:fake/gif-1', filename: 'my-run.gif', saveAs: false }])
    hasNumber(r.output, 3)
    expect(r.output).toContain(`${GIF_W}x${GIF_H}`)
    expect(r.output).toContain('/fake-downloads/my-run.gif')
    const L = f.state.log
    expect(L.indexOf('create')).toBeLessThan(L.indexOf('compose'))
    expect(L.indexOf('complete')).toBeGreaterThan(-1)
    expect(L.indexOf('complete')).toBeLessThan(L.indexOf('close'))
    expect(L.indexOf('release')).toBeGreaterThan(-1)
    expect(L.indexOf('release')).toBeLessThan(L.indexOf('close'))
    expect(L.filter((x) => x === 'close')).toHaveLength(1)
    expect(f.releaseMessages()).toHaveLength(1)
    expect(f.releaseMessages()[0].blobUrl).toBe('blob:fake/gif-1')
    expect(f.onChanged.count).toBe(0)
    expect(isRecording(s.name)).toBe(false)
    expect((await caught(gif(s, 'export', { download: true }))).code).toBe('invalid_params')
  })
  test('录制中导出成功 → 也停录', async () => {
    const s = await recorded(1)
    expect(isRecording(s.name)).toBe(true)
    await gif(s, 'export', { download: true })
    expect(isRecording(s.name)).toBe(false)
  })
  test('发起时已下完（没有事件）→ 很快成功', async () => {
    const s = await recorded()
    f.state.download = 'already'
    const t0 = performance.now()
    await gif(s, 'export', { download: true })
    expect(performance.now() - t0).toBeLessThan(DL_CAP * 0.5)
    expect(f.onChanged.count).toBe(0)
  })
  test('查不到下载条目 → 输出含文件名', async () => {
    const s = await recorded()
    f.state.searchEmpty = true
    f.state.download = 'event'
    // 查不到时只能靠事件知道下完
    const r = await gif(s, 'export', { download: true, filename: 'fallback-name.gif' })
    expect(r.output).toContain('fallback-name.gif')
  })
  test('默认文件名：.gif 结尾、不含冒号；空字符串也走默认', async () => {
    for (const filename of [undefined, '']) {
      const s = await recorded(1)
      await gif(s, 'export', { download: true, filename })
      const name = f.state.downloads.at(-1).filename
      expect(typeof name).toBe('string')
      expect(name.endsWith('.gif')).toBe(true)
      expect(name.length).toBeGreaterThan(4)
      expect(name).not.toContain(':')
    }
  })
  test('下载中断 → 普通 Error，关页，帧与录制状态保留，不残留监听', async () => {
    const s = await recorded(2)
    f.state.download = 'interrupted'
    const e = await caught(gif(s, 'export', { download: true }))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBeUndefined()
    expect(f.state.log).toContain('close')
    expect(f.onChanged.count).toBe(0)
    expect(isRecording(s.name)).toBe(true)
    expect(await framesOf(s)).toHaveLength(2)
  })
  test('一直没下完 → 到上限失败，关页，不残留监听', async () => {
    const s = await recorded(1)
    f.state.download = 'hang'
    const t0 = performance.now()
    const e = await caught(gif(s, 'export', { download: true }))
    const ms = performance.now() - t0
    expect(e).toBeInstanceOf(Error)
    expect(ms).toBeGreaterThanOrEqual(DL_CAP * 0.9)
    expect(ms).toBeLessThan(COMPOSE_CAP)
    expect(f.state.log).toContain('close')
    expect(f.onChanged.count).toBe(0)
  })
  test('下载接口自己 reject → 原样透传，关页', async () => {
    const s = await recorded(1)
    f.state.download = 'reject'
    expect(await caught(gif(s, 'export', { download: true }))).toBe(f.state.downloadError)
    expect(f.state.log).toContain('close')
    expect(f.onChanged.count).toBe(0)
  })
  test('download 与坐标都给 → 下载，不拖放', async () => {
    const s = await recorded(1)
    f.state.dropTarget = f.makeTarget()
    await gif(s, 'export', { download: true, coordinate: [10, 10] })
    expect(f.state.downloads).toHaveLength(1)
    expect(f.state.injections).toHaveLength(0)
  })
})

describe('export：合成失败', () => {
  test('合成页回了错误 → Error 含原文，关页，帧保留，不下载', async () => {
    const s = await recorded(2)
    f.state.compose = 'fail'
    const e = await caught(gif(s, 'export', { download: true }))
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toContain(f.state.composeError)
    expect(f.state.log).toContain('close')
    expect(f.state.downloads).toHaveLength(0)
    expect(isRecording(s.name)).toBe(true)
    expect(await framesOf(s)).toHaveLength(2)
  })
  test('合成页回了失败但没原因 → 非空 message', async () => {
    const s = await recorded(1)
    f.state.compose = 'failNoText'
    const e = await caught(gif(s, 'export', { download: true }))
    expect(e).toBeInstanceOf(Error)
    expect(e.message.length).toBeGreaterThan(0)
  })
  test('消息传输失败 → Error 含浏览器给的原文', async () => {
    const s = await recorded(1)
    f.state.compose = 'lastError'
    const e = await caught(gif(s, 'export', { download: true }))
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toContain(f.state.lastErrorText)
    expect(f.state.log).toContain('close')
  })
  test('一直不回 → 到上限失败，关页', async () => {
    const s = await recorded(1)
    f.state.compose = 'silent'
    const t0 = performance.now()
    const e = await caught(gif(s, 'export', { download: true }))
    expect(e).toBeInstanceOf(Error)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(COMPOSE_CAP * 0.9)
    expect(f.state.log).toContain('close')
  }, 10000)
  test('回收通知失败、关页失败 → 都不影响成功', async () => {
    const s = await recorded(1)
    f.state.releaseRejects = true
    f.state.closeFails = true
    const r = await gif(s, 'export', { download: true })
    expect(r.output).toContain(`${GIF_W}x${GIF_H}`)
  })
})

describe('export：拖放到页面', () => {
  test('成功：注入到目标标签，在换算后的视口坐标处元素上派发拖入 / 悬停 / 放下，携带 GIF 文件', async () => {
    const s = await recorded(2)
    f.state.ctx.set(TAB, { ...CTX_A })
    const el = f.makeTarget()
    f.state.dropTarget = el
    const r = await gif(s, 'export', { coordinate: [700, 350], filename: 'drop-me.gif' })
    expect(f.state.injections).toHaveLength(1)
    const inj = f.state.injections[0]
    expect(inj.target.tabId).toBe(TAB)
    expect(typeof inj.func).toBe('function')
    expect(f.state.pointQueries.at(-1)).toEqual([350, 175])
    expect(el.got.map((e: any) => e.type)).toEqual(['dragenter', 'dragover', 'drop'])
    const want = Uint8Array.from(atob(GIF_B64), (c) => c.charCodeAt(0))
    for (const e of el.got) {
      expect(e.bubbles).toBe(true)
      expect(e.cancelable).toBe(true)
      expect(e.clientX).toBe(350)
      expect(e.clientY).toBe(175)
      const files = e.dataTransfer.files
      expect(files).toHaveLength(1)
      expect(files[0].name).toBe('drop-me.gif')
      expect(files[0].type).toBe('image/gif')
      expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(want)
    }
    hasNumber(r.output, 2)
    expect(r.output).toContain(`${GIF_W}x${GIF_H}`)
    expect(r.output).toContain('drop-me.gif')
    expect(f.state.downloads).toHaveLength(0)
    expect(f.releaseMessages()).toHaveLength(1)
    expect(f.state.log.at(-1)).toBe('close')
    expect((await caught(gif(s, 'export', { download: true }))).code).toBe('invalid_params')
  })
  test('无上下文时坐标原样当视口坐标', async () => {
    const s = await recorded(1)
    f.state.ctx.delete(TAB)
    f.state.dropTarget = f.makeTarget()
    await gif(s, 'export', { coordinate: [12, 34] })
    expect(f.state.pointQueries.at(-1)).toEqual([12, 34])
  })
  test('该处没有元素 → 普通 Error，关页，帧保留', async () => {
    const s = await recorded(2)
    f.state.dropTarget = null
    const e = await caught(gif(s, 'export', { coordinate: [5, 5] }))
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBeUndefined()
    expect(f.state.log).toContain('close')
    expect(f.releaseMessages()).toHaveLength(1)
    expect(await framesOf(s)).toHaveLength(2)
  })
  test('注入接口 reject → 原样透传，关页', async () => {
    const s = await recorded(1)
    f.state.inject = 'reject'
    expect(await caught(gif(s, 'export', { coordinate: [5, 5] }))).toBe(f.state.injectError)
    expect(f.state.log).toContain('close')
  })
})
