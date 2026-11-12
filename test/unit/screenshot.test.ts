import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { makeChrome } from './fakes/screenshot-chrome'

// 模块加载时就会注册 chrome 监听，所以先挂假 chrome 再动态导入
const fake = makeChrome()
;(globalThis as any).chrome = fake.chrome
mock.module('../../extension/debugger.js', () => fake.debuggerModule)
mock.module('../../extension/sessions.js', () => fake.sessionsModule)
const mod = await import('../../extension/screenshot.js')
const { sessionClosedHooks } = fake.sessionsModule
const { targetSize, beginBatch, endBatch, setContext, getContext, toViewport, cacheImage, getImage, recheckBeforeCapture, imageSize, screenshot, zoom } = mod as any

const EDGE = 1568 // 长边上限
const TILE = 28 // 切块边长
const TILES = 1568 // 块数上限
const tiles = (w: number, h: number) => Math.ceil(w / TILE) * Math.ceil(h / TILE)
const fits = (w: number, h: number) => w <= EDGE && h <= EDGE && tiles(w, h) <= TILES
const near = (a: number, b: number, tol = 1) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol)
const codeOf = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e))?.code
let tab = 100
const freshTab = () => ++tab

beforeEach(() => {
  fake.state.calls.length = 0
  fake.state.viewport = { width: 1280, height: 800, dpr: 1, x: 0, y: 0 }
  fake.state.realDpr = undefined
  fake.state.oversizeAtQuality = undefined
  fake.state.noData = false
  fake.state.override = undefined
  endBatch()
})

describe('导出面', () => {
  test('导出清单冻结', () => {
    expect(Object.keys(mod).sort()).toEqual(
      ['beginBatch', 'cacheImage', 'endBatch', 'getContext', 'getImage', 'imageSize', 'recheckBeforeCapture', 'screenshot', 'setContext', 'targetSize', 'toViewport', 'zoom'].sort(),
    )
  })
  test('全局测试钩子暴露批次与上下文四个函数', () => {
    const h = (globalThis as any).__jevShot
    expect(h.beginBatch).toBe(beginBatch)
    expect(h.endBatch).toBe(endBatch)
    expect(h.getContext).toBe(getContext)
    expect(h.setContext).toBe(setContext)
  })
})

describe('targetSize', () => {
  test.each([[1280, 800], [1568, 784], [100, 100], [1, 1], [1092, 1092]])('已满足约束 %ix%i → 原样', (w, h) => {
    expect(fits(w, h)).toBe(true)
    expect(targetSize(w, h)).toEqual([w, h])
  })

  const BIG: [number, number][] = [[2560, 1600], [3840, 2160], [1600, 1600], [1569, 10], [5000, 3000], [2000, 1999], [1920, 1080], [2880, 1800], [10000, 7]]
  test.each(BIG)('%ix%i 缩小后满足全部约束、等比、取到最大', (w, h) => {
    const [tw, th] = targetSize(w, h)
    expect(Number.isInteger(tw) && Number.isInteger(th)).toBe(true)
    expect(fits(tw, th)).toBe(true)
    expect(tw).toBeLessThanOrEqual(w)
    expect(th).toBe(Math.max(1, Math.round((tw * h) / w)))
    const w2 = tw + 1
    expect(fits(w2, Math.max(1, Math.round((w2 * h) / w)))).toBe(false)
  })

  test('竖图与横图对称', () => {
    for (const [w, h] of BIG) expect(targetSize(h, w)).toEqual(targetSize(w, h).slice().reverse())
  })

  test('极端比例短边至少 1', () => {
    const [, th] = targetSize(20000, 3)
    expect(th).toBeGreaterThanOrEqual(1)
  })
})

describe('imageSize', () => {
  const { fakePng, fakeJpeg } = require('./fakes/screenshot-chrome')
  test('读 PNG 宽高', () => expect(imageSize(fakePng(321, 123))).toEqual({ width: 321, height: 123 }))
  test('读 JPEG 宽高，跳过非尺寸段', () => expect(imageSize(fakeJpeg(640, 480))).toEqual({ width: 640, height: 480 }))
  test('不认识的格式 → null', () => expect(imageSize(btoa('GIF89a----------------------'))).toBeNull())
})

describe('坐标上下文与批次', () => {
  const C = { viewportWidth: 1280, viewportHeight: 800, screenshotWidth: 640, screenshotHeight: 400 }
  test('设了就能取，取到的是同样字段', () => {
    const t = freshTab()
    expect(getContext(t)).toBeUndefined()
    setContext(t, C)
    expect(getContext(t)).toEqual(C)
  })
  test('批内设置延后到批结束才生效；重复开批不清掉暂存', () => {
    const t = freshTab()
    setContext(t, C)
    beginBatch()
    const C2 = { ...C, screenshotWidth: 320 }
    setContext(t, C2)
    beginBatch()
    expect(getContext(t)).toEqual(C)
    endBatch()
    expect(getContext(t)).toEqual(C2)
    endBatch() // 无批时调用无副作用
    expect(getContext(t)).toEqual(C2)
  })
  test('标签关闭后上下文清掉', () => {
    const t = freshTab()
    setContext(t, C)
    fake.chrome.tabs.onRemoved.fire(t)
    expect(getContext(t)).toBeUndefined()
  })
  test('会话关闭会结束未结束的批次', async () => {
    const t = freshTab()
    beginBatch()
    setContext(t, C)
    for (const h of sessionClosedHooks) await h([], 'whatever')
    expect(getContext(t)).toEqual(C)
  })
})

describe('toViewport', () => {
  test('无上下文：原样返回', () => {
    expect(toViewport(freshTab(), [12.5, 30], 'click')).toEqual([12.5, 30])
  })
  test.each([[-1, 0], [0, -1], [NaN, 1], [1, Infinity]])('无上下文非法坐标 (%d,%d) → coordinate_out_of_bounds', (x, y) => {
    let e: any
    try { toViewport(freshTab(), [x, y], 'click') } catch (err) { e = err }
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('coordinate_out_of_bounds')
  })
  test('有上下文：按视口/帧比例换算并四舍五入', () => {
    const t = freshTab()
    setContext(t, { viewportWidth: 1280, viewportHeight: 800, screenshotWidth: 640, screenshotHeight: 400 })
    expect(toViewport(t, [100, 50], 'click')).toEqual([200, 100])
    expect(toViewport(t, [10.3, 0.2], 'click')).toEqual([21, 0])
    setContext(t, { viewportWidth: 1000, viewportHeight: 600, screenshotWidth: 300, screenshotHeight: 200 })
    expect(toViewport(t, [1, 1], 'click')).toEqual([3, 3])
  })
  test('越界容差 2 帧像素：恰好不足 2 可接受，达到 2 拒绝；报错带动作名', () => {
    const t = freshTab()
    setContext(t, { viewportWidth: 1280, viewportHeight: 800, screenshotWidth: 640, screenshotHeight: 400 })
    expect(() => toViewport(t, [641.9, 401.9], 'click')).not.toThrow()
    for (const p of [[642, 0], [0, 402]]) {
      let e: any
      try { toViewport(t, p, 'left_click_here') } catch (err) { e = err }
      expect(e.code).toBe('coordinate_out_of_bounds')
      expect(e.message).toContain('left_click_here')
    }
  })
})

describe('图片缓存', () => {
  test('每张图拿到唯一 id，按会话隔离', () => {
    const a = cacheImage('s1', 'AAAA', 'png')
    const b = cacheImage('s1', 'BBBB', 'jpeg')
    expect(a).not.toBe(b)
    expect(getImage('s1', a)).toEqual({ base64: 'AAAA', format: 'png' })
    expect(getImage('s1', b)).toEqual({ base64: 'BBBB', format: 'jpeg' })
    expect(getImage('s2', a)).toBeUndefined()
    const c = cacheImage('s2', 'CCCC', 'png')
    expect([a, b]).not.toContain(c)
  })
  test('每会话最多 30 张，超出淘汰最早的', () => {
    const ids = Array.from({ length: 31 }, (_, i) => cacheImage('cap', String(i), 'png'))
    expect(getImage('cap', ids[0])).toBeUndefined()
    for (const id of ids.slice(1)) expect(getImage('cap', id)).toBeDefined()
  })
  test('会话关闭清空该会话缓存', async () => {
    const id = cacheImage('gone', 'X', 'png')
    const keep = cacheImage('stay', 'Y', 'png')
    for (const h of sessionClosedHooks) await h([], 'gone')
    expect(getImage('gone', id)).toBeUndefined()
    expect(getImage('stay', keep)).toBeDefined()
  })
})

describe('recheckBeforeCapture', () => {
  test('无守卫直接通过；有守卫以 screenshot 调用并透传失败', async () => {
    await recheckBeforeCapture(undefined)
    const seen: string[] = []
    await recheckBeforeCapture({ check: async (a: string) => void seen.push(a) })
    expect(seen).toEqual(['screenshot'])
    const err = Object.assign(new Error('x'), { code: 'navigated_away' })
    expect(await codeOf(recheckBeforeCapture({ check: async () => { throw err } }))).toBe('navigated_away')
  })
})

describe('screenshot', () => {
  test('普通视口：JPEG，帧=物理像素，上下文记视口与帧', async () => {
    const t = freshTab()
    fake.state.viewport = { width: 1280, height: 800, dpr: 1, x: 5, y: 700 }
    const r = await screenshot(t, undefined, undefined)
    expect(r.format).toBe('jpeg')
    expect(typeof r.base64).toBe('string')
    expect([r.width, r.height, r.frameWidth, r.frameHeight]).toEqual([1280, 800, 1280, 800])
    expect(getContext(t)).toEqual({ viewportWidth: 1280, viewportHeight: 800, screenshotWidth: 1280, screenshotHeight: 800 })
    const [s] = fake.shots()
    expect(s.params.format).toBe('jpeg')
    expect(s.params.clip).toMatchObject({ x: 5, y: 700, width: 1280, height: 800 })
    expect(s.params.captureBeyondViewport).toBe(false)
  })

  test('高像素比：帧按尺寸约束缩小，返回图与帧一致', async () => {
    const t = freshTab()
    fake.state.viewport = { width: 1280, height: 800, dpr: 2, x: 0, y: 0 }
    const r = await screenshot(t)
    const [fw] = targetSize(2560, 1600)
    expect(r.frameWidth).toBe(fw)
    expect(fits(r.frameWidth, r.frameHeight)).toBe(true)
    near(r.frameHeight, (fw * 1600) / 2560)
    near(r.width, r.frameWidth)
    near(r.height, r.frameHeight)
    expect(getContext(t)).toMatchObject({ viewportWidth: 1280, viewportHeight: 800, screenshotWidth: r.frameWidth, screenshotHeight: r.frameHeight })
    expect(fake.shots()).toHaveLength(1)
  })

  test('scale 只缩返回图，不改帧和上下文', async () => {
    const t = freshTab()
    const r = await screenshot(t, 0.5)
    near(r.width, 640)
    near(r.height, 400)
    expect([r.frameWidth, r.frameHeight]).toEqual([1280, 800])
    expect(getContext(t)!.screenshotWidth).toBe(1280)
  })

  test.each([0.05, 1.5, NaN, -1])('scale=%d 超出 [0.1,1] 视为 1', async (s) => {
    const r = await screenshot(freshTab(), s)
    expect(r.width).toBe(1280)
  })

  test('实际出图尺寸与预期不符：修正后再截一次，最终尺寸贴近预期', async () => {
    fake.state.realDpr = 2 // 页面报 1，浏览器实际按 2 出图
    const r = await screenshot(freshTab(), 0.5)
    expect(fake.shots()).toHaveLength(2)
    near(r.width, 640)
    near(r.height, 400)
  })

  test('JPEG 过大：降低质量重截一次，不再循环', async () => {
    fake.state.oversizeAtQuality = 75
    await screenshot(freshTab())
    const q = fake.shots().map((c) => c.params.quality)
    expect(q).toHaveLength(2)
    expect(q[1]).toBeLessThan(q[0])
  })

  test('批内截图：上下文等批结束才更新', async () => {
    const t = freshTab()
    setContext(t, { viewportWidth: 1, viewportHeight: 1, screenshotWidth: 1, screenshotHeight: 1 })
    beginBatch()
    await screenshot(t)
    expect(getContext(t)!.screenshotWidth).toBe(1)
    endBatch()
    expect(getContext(t)!.screenshotWidth).toBe(1280)
  })

  test('守卫拒绝：不截图', async () => {
    const g = { check: async () => { throw Object.assign(new Error('x'), { code: 'navigated_away' }) } }
    expect(await codeOf(screenshot(freshTab(), 1, g))).toBe('navigated_away')
    expect(fake.shots()).toHaveLength(0)
  })

  test('拿不到视口 / 没出图数据 → 失败', async () => {
    fake.state.viewport = { width: 0, height: 800, dpr: 1, x: 0, y: 0 }
    expect(await screenshot(freshTab()).then(() => 'ok', () => 'fail')).toBe('fail')
    fake.state.viewport = { width: 1280, height: 800, dpr: 1, x: 0, y: 0 }
    fake.state.noData = true
    expect(await screenshot(freshTab()).then(() => 'ok', () => 'fail')).toBe('fail')
  })
})

describe('zoom', () => {
  test.each([[undefined], [[1, 2, 3]], ['0,0,1,1']])('region 不是四元数组 → invalid_params，且不发命令', async (region) => {
    expect(await codeOf(zoom(freshTab(), region, 1))).toBe('invalid_params')
    expect(fake.state.calls).toHaveLength(0)
  })

  test.each([[[10, 10, 10, 20]], [[10, 20, 30, 5]], [[-1, 0, 5, 5]], [[0, 0, NaN, 5]]])('非法区域 %j → invalid_params', async (region) => {
    expect(await codeOf(zoom(freshTab(), region, 1))).toBe('invalid_params')
  })

  test('无上下文：区域即视口像素，PNG，裁剪框加滚动偏移', async () => {
    fake.state.viewport = { width: 1280, height: 800, dpr: 1, x: 3, y: 400 }
    const r = await zoom(freshTab(), [100, 50, 300, 150], 1)
    expect(r.format).toBe('png')
    expect([r.width, r.height]).toEqual([200, 100])
    expect(Object.keys(r).sort()).toEqual(['base64', 'format', 'height', 'width'])
    const [s] = fake.shots()
    expect(s.params.format).toBe('png')
    expect(s.params.clip).toMatchObject({ x: 103, y: 450, width: 200, height: 100 })
  })

  test('有上下文：区域按帧→视口比例换算', async () => {
    const t = freshTab()
    setContext(t, { viewportWidth: 1280, viewportHeight: 800, screenshotWidth: 640, screenshotHeight: 400 })
    await zoom(t, [10, 10, 60, 30], 1)
    expect(fake.shots()[0].params.clip).toMatchObject({ x: 20, y: 20, width: 100, height: 40 })
  })

  test('scale 缩小输出；大区域输出受尺寸约束', async () => {
    const r = await zoom(freshTab(), [0, 0, 400, 200], 0.5)
    near(r.width, 200)
    near(r.height, 100)
    fake.state.viewport = { width: 1280, height: 800, dpr: 2, x: 0, y: 0 }
    const big = await zoom(freshTab(), [0, 0, 1280, 800], 1)
    expect(fits(big.width, big.height)).toBe(true)
  })

  test('超出视口（含 2 帧像素容差）→ coordinate_out_of_bounds', async () => {
    expect(await codeOf(zoom(freshTab(), [0, 0, 1283, 10], 1))).toBe('coordinate_out_of_bounds')
    expect(await zoom(freshTab(), [0, 0, 1281, 10], 1).then(() => 'ok')).toBe('ok')
  })

  test('守卫拒绝：不截图', async () => {
    const g = { check: async () => { throw Object.assign(new Error('x'), { code: 'navigated_away' }) } }
    expect(await codeOf(zoom(freshTab(), [0, 0, 5, 5], 1, g))).toBe('navigated_away')
    expect(fake.shots()).toHaveLength(0)
  })
})
