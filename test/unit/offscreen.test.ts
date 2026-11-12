import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { FakeCanvas, FakeGIF, FakeImage, inkCount, makeOffscreenEnv, near, placesAtOrigin, textsOf, within } from './fakes/offscreen-env'

// 合成页导入时就挂消息监听，且用到页面全局（GIF、Image、document、FileReader），所以先装环境再动态导入
const env = makeOffscreenEnv()
env.install()
const mod = await import('../../extension/offscreen.js')
afterAll(() => env.uninstall())

// 消息类型名以 gif-recorder 规格第 7 节为准
const GEN = 'gif.compose'
const REVOKE = 'gif.release'
const ALL_OFF = { showClickIndicators: false, showDragPaths: false, showActionLabels: false, showProgressBar: false }
const only = (k: keyof typeof ALL_OFF, extra: Record<string, unknown> = {}) => ({ ...ALL_OFF, [k]: true, ...extra })

// 登记几张假图：键是 base64 正文，值是解码后的像素尺寸
const IMG = { big: 'Qk1HMQ==', small: 'U01MMQ==', tall: 'VExMMQ==', broken: 'QlJLTg==' }
FakeImage.registry.set(IMG.big, { w: 400, h: 300 })
FakeImage.registry.set(IMG.small, { w: 200, h: 100 })
FakeImage.registry.set(IMG.tall, { w: 150, h: 500 })
FakeImage.registry.set(IMG.broken, 'broken')

type Frame = Record<string, unknown>
const frame = (over: Frame = {}): Frame => ({ base64: IMG.big, format: 'png', delay: 500, ...over })
const quiet = { setTimeout }

async function run(frames: Frame[], options?: Record<string, unknown>) {
  const before = FakeGIF.all.length
  const st = env.deliver(options === undefined ? { type: GEN, frames } : { type: GEN, frames, options })
  const res = await Promise.race([st.reply, new Promise((r) => quiet.setTimeout(() => r('__timeout__'), 3000))])
  const gif = FakeGIF.all[before] as FakeGIF | undefined
  const added = (gif?.added ?? []).map((a) => a.image as FakeCanvas)
  return { st, res: res as any, gif, added }
}
const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  FakeGIF.mode = 'ok'
  FakeImage.sources.length = 0
})

describe('加载与导出面', () => {
  test('没有导出', () => {
    expect(Object.keys(mod)).toEqual([])
  })
  test('导入时恰好挂一个运行时消息监听', () => {
    expect(env.listeners.length).toBe(1)
  })
})

describe('消息来源与类型', () => {
  test('别的扩展发来的消息：不应答，监听返回值不是 true', async () => {
    const st = env.deliver({ type: GEN, frames: [frame()] }, { id: 'someone-else' })
    expect(st.returned[0]).not.toBe(true)
    await waitMs(30)
    expect(st.count).toBe(0)
    const st2 = env.deliver({ type: REVOKE, blobUrl: 'blob:x' }, { id: 'someone-else' })
    expect(st2.count).toBe(0)
    expect(env.revoked).not.toContain('blob:x')
  })
  test('没有 id 的发送方同样忽略', async () => {
    const st = env.deliver({ type: REVOKE, blobUrl: 'blob:y' }, {})
    expect(st.count).toBe(0)
    expect(env.revoked).not.toContain('blob:y')
  })
  test('不认识的类型：不应答，监听返回值不是 true', async () => {
    const st = env.deliver({ type: 'SOMETHING_ELSE' })
    expect(st.returned[0]).not.toBe(true)
    await waitMs(30)
    expect(st.count).toBe(0)
  })
})

describe('释放对象地址', () => {
  test('按给定地址释放一次；发送方不等回复，应答的话只能是成功', async () => {
    const url = 'blob:chrome-extension://fake-ext/release-me'
    const before = env.revoked.length
    const st = env.deliver({ type: REVOKE, blobUrl: url })
    expect(st.returned[0]).not.toBe(true)
    await waitMs(20)
    expect(env.revoked.slice(before)).toEqual([url])
    expect(st.count).toBeLessThanOrEqual(1)
    if (st.count === 1) expect(await st.reply).toEqual({ success: true })
  })
})

describe('合成：应答与结果', () => {
  test('监听返回 true（异步应答），之后应答一次成功结果', async () => {
    const { st, res } = await run([frame(), frame()], ALL_OFF)
    expect(st.returned[0]).toBe(true)
    expect(st.sync).toBe(false)
    expect(res.success).toBe(true)
    await waitMs(10)
    expect(st.count).toBe(1)
  })
  test('结果字段：base64 解码即编码器产出的字节；地址来自对象地址；大小、宽高', async () => {
    const { res } = await run([frame({ base64: IMG.small }), frame(), frame({ base64: IMG.small })], ALL_OFF)
    const r = res.result
    expect(typeof r.base64).toBe('string')
    expect(r.base64.startsWith('data:')).toBe(false)
    expect([...Buffer.from(r.base64, 'base64')]).toEqual([...FakeGIF.bytes])
    expect(env.created).toContain(r.blobUrl)
    expect(r.size).toBe(FakeGIF.bytes.length)
    expect(r.width).toBe(400)
    expect(r.height).toBe(300)
  })
  test('宽高分别取所有帧的最大值', async () => {
    const { res, gif } = await run([frame({ base64: IMG.small }), frame({ base64: IMG.tall })], ALL_OFF)
    expect(res.result.width).toBe(200)
    expect(res.result.height).toBe(500)
    expect(gif!.opts.width).toBe(200)
    expect(gif!.opts.height).toBe(500)
  })
  test('编码失败（编码器中止）：应答失败，带字符串说明', async () => {
    FakeGIF.mode = 'abort'
    const { res } = await run([frame()], ALL_OFF)
    expect(res.success).toBe(false)
    expect(typeof res.error).toBe('string')
    expect(res.error.length).toBeGreaterThan(0)
  })
  test('有一帧图片解不开：应答失败', async () => {
    const { res } = await run([frame(), frame({ base64: IMG.broken })], ALL_OFF)
    expect(res.success).toBe(false)
  })
})

describe('合成：编码器参数与帧', () => {
  test('无限循环、工作线程脚本取扩展内地址、画质透传', async () => {
    const { gif } = await run([frame()], { ...ALL_OFF, quality: 4 })
    expect(gif!.opts.repeat).toBe(0)
    expect(gif!.opts.workerScript).toBe(env.chrome.runtime.getURL('gif.worker.js'))
    expect(gif!.opts.quality).toBe(4)
    if (gif!.opts.workers !== undefined) {
      expect(Number.isInteger(gif!.opts.workers)).toBe(true)
      expect(gif!.opts.workers).toBeGreaterThanOrEqual(1)
    }
  })
  test('画质缺省为 10', async () => {
    const a = await run([frame()], ALL_OFF)
    expect(a.gif!.opts.quality).toBe(10)
    const b = await run([frame()])
    expect(b.gif!.opts.quality).toBe(10)
  })
  test('每帧一张画布，按顺序交给编码器，尺寸都是统一的最大尺寸', async () => {
    const { added } = await run([frame({ base64: IMG.small }), frame(), frame({ base64: IMG.tall })], ALL_OFF)
    expect(added.length).toBe(3)
    for (const c of added) {
      expect(c).toBeInstanceOf(FakeCanvas)
      expect([c.width, c.height]).toEqual([400, 500])
    }
  })
  test('小帧的原图贴在左上角', async () => {
    const before = FakeImage.sources.length
    const { added } = await run([frame({ base64: IMG.small }), frame()], ALL_OFF)
    expect(added.length).toBe(2)
    // 找到解出这两帧的假图实例：按画布追溯
    for (const c of added) {
      const imgs = collectImages(c)
      expect(imgs.length).toBeGreaterThan(0)
      expect(imgs.some((img) => placesAtOrigin(c, img))).toBe(true)
    }
    expect(FakeImage.sources.length - before).toBe(2)
  })
  test('每帧图片恰好解码一次', async () => {
    const before = FakeImage.sources.length
    await run([frame(), frame({ base64: IMG.small }), frame({ base64: IMG.tall })], { showClickIndicators: true, showActionLabels: true, showDragPaths: true, showProgressBar: true })
    expect(FakeImage.sources.length - before).toBe(3)
  })
  test('帧序与图片对应：第 k 张画布来自第 k 帧', async () => {
    const { added } = await run([frame({ base64: IMG.small }), frame({ base64: IMG.tall }), frame()], ALL_OFF)
    const dims = added.map((c) => collectImages(c).map((i) => [i.width, i.height])[0])
    expect(dims).toEqual([
      [200, 100],
      [150, 500],
      [400, 300],
    ])
  })
  test('停留时长：非末帧等于给定值，末帧不短于给定值；没给时为正数', async () => {
    const { gif } = await run([frame({ delay: 300 }), frame({ delay: 1500 }), frame({ delay: 700 })], ALL_OFF)
    const d = gif!.added.map((a) => a.opts?.delay)
    expect(d[0]).toBe(300)
    expect(d[1]).toBe(1500)
    expect(d[2]).toBeGreaterThanOrEqual(700)
    const g2 = await run([frame({ delay: undefined }), frame({ delay: undefined })], ALL_OFF)
    for (const a of g2.gif!.added) expect(a.opts?.delay).toBeGreaterThan(0)
  })
  test('图片按 data URL 解码：给了格式用给定格式，没给按 png', async () => {
    await run([frame({ format: 'jpeg' }), frame({ format: undefined, base64: IMG.small })], ALL_OFF)
    expect(FakeImage.sources).toContain(`data:image/jpeg;base64,${IMG.big}`)
    expect(FakeImage.sources).toContain(`data:image/png;base64,${IMG.small}`)
  })
})

// 找出画布（含贴上来的中间画布）里贴过的假图
function collectImages(c: FakeCanvas): FakeImage[] {
  const out: FakeImage[] = []
  for (const op of c.ops) {
    if (op.name !== 'drawImage') continue
    if (op.args[0] instanceof FakeImage) out.push(op.args[0])
    else if (op.args[0] instanceof FakeCanvas) out.push(...collectImages(op.args[0]))
  }
  return out
}

describe('标注：开关', () => {
  const click = { type: 'left_click', coordinate: [100, 80], description: 'Pressed the Save button' }
  test('全部关掉且没有动作、帧尺寸一致：除贴原图外没有任何填充、描边、清除、写字', async () => {
    const { added } = await run([frame(), frame()], ALL_OFF)
    for (const c of added) {
      expect(inkCount(c)).toBe(0)
      for (const op of c.ops) expect(['fill', 'fillRect', 'clearRect', 'stroke', 'strokeRect', 'fillText', 'strokeText']).not.toContain(op.name)
    }
  })
  test('全部关掉但有动作：同样什么都不画', async () => {
    const { added } = await run([frame({ action: click })], ALL_OFF)
    expect(inkCount(added[0])).toBe(0)
  })
  test('只开进度条：每帧都有绘制', async () => {
    const { added } = await run([frame(), frame(), frame()], only('showProgressBar'))
    for (const c of added) expect(inkCount(c)).toBeGreaterThan(0)
  })
  test('不传 options：四类标注默认都开（点击标注、文字、进度条都有）', async () => {
    const { added } = await run([frame({ action: click, viewportWidth: 400 })])
    expect(inkCount(added[0])).toBeGreaterThan(0)
    expect(textsOf(added[0])).toContain(click.description)
    expect(near(added[0], 100, 80, 1)).toBe(true)
  })
  test('options 为空对象时同样默认全开', async () => {
    const { added } = await run([frame({ action: click, viewportWidth: 400 })], {})
    expect(textsOf(added[0])).toContain(click.description)
    expect(near(added[0], 100, 80, 1)).toBe(true)
  })
  test('关掉文字标签：仍画点击标注，但不出现说明文字', async () => {
    const { added } = await run([frame({ action: click, viewportWidth: 400 })], { ...ALL_OFF, showClickIndicators: true })
    expect(inkCount(added[0])).toBeGreaterThan(0)
    expect(textsOf(added[0])).not.toContain(click.description)
  })
  test('点击动作的文字标签依附点击标注：关掉点击标注时连文字也不画', async () => {
    const { added } = await run([frame({ action: click, viewportWidth: 400 })], only('showActionLabels'))
    expect(inkCount(added[0])).toBe(0)
  })
})

describe('标注：哪类动作画什么', () => {
  const T = 1
  test('点击类动作在坐标处有标注', async () => {
    for (const type of ['left_click', 'right_click', 'double_click', 'triple_click']) {
      const { added } = await run([frame({ action: { type, coordinate: [120, 90] }, viewportWidth: 400 })], only('showClickIndicators'))
      expect(inkCount(added[0])).toBeGreaterThan(0)
      expect(near(added[0], 120, 90, T)).toBe(true)
    }
  })
  test('滚动带坐标也在坐标处有标注', async () => {
    const { added } = await run([frame({ action: { type: 'scroll', coordinate: [250, 200] }, viewportWidth: 400 })], only('showClickIndicators'))
    expect(near(added[0], 250, 200, T)).toBe(true)
  })
  test('没有坐标的点击：不画点击标注', async () => {
    const { added } = await run([frame({ action: { type: 'left_click' } })], only('showClickIndicators'))
    expect(inkCount(added[0])).toBe(0)
  })
  test('输入 / 按键 / 等待即使带坐标也不画点位标注', async () => {
    for (const type of ['type', 'key', 'wait']) {
      const { added } = await run([frame({ action: { type, coordinate: [120, 90] }, viewportWidth: 400 })], only('showClickIndicators'))
      expect(inkCount(added[0])).toBe(0)
    }
  })
  test('拖拽：起点和终点附近都有标注', async () => {
    const drag = { type: 'left_click_drag', start_coordinate: [60, 50], coordinate: [300, 220] }
    const { added } = await run([frame({ action: drag, viewportWidth: 400 })], only('showDragPaths'))
    expect(inkCount(added[0])).toBeGreaterThan(0)
    expect(near(added[0], 60, 50, T)).toBe(true)
    expect(near(added[0], 300, 220, T)).toBe(true)
  })
  test('拖拽缺起点：不画拖拽路径', async () => {
    const { added } = await run([frame({ action: { type: 'left_click_drag', coordinate: [300, 220] }, viewportWidth: 400 })], only('showDragPaths'))
    expect(inkCount(added[0])).toBe(0)
  })
  test('拖拽带说明：开文字标签时说明可见', async () => {
    const drag = { type: 'left_click_drag', start_coordinate: [60, 50], coordinate: [300, 220], description: 'Moved the slider handle' }
    const { added } = await run([frame({ action: drag, viewportWidth: 400 })], { ...ALL_OFF, showDragPaths: true, showActionLabels: true })
    expect(textsOf(added[0])).toContain(drag.description)
  })
  test('输入 / 按键 / 等待且无坐标：开文字标签时画出说明', async () => {
    for (const type of ['type', 'key', 'wait']) {
      const description = `Did a ${type} step here`
      const { added } = await run([frame({ action: { type, description } })], only('showActionLabels'))
      expect(textsOf(added[0])).toContain(description)
    }
  })
  test('输入类带坐标：不画文字标签', async () => {
    const { added } = await run([frame({ action: { type: 'type', coordinate: [10, 10], description: 'Typed a long query' }, viewportWidth: 400 })], only('showActionLabels'))
    expect(inkCount(added[0])).toBe(0)
  })
  test('120 字符以内的长说明完整可见（只许在空格处换行）', async () => {
    const description = 'Typed the full shipping address into the second line of the checkout form and then moved focus to the city field'
    expect(description.length).toBeGreaterThan(100)
    expect(description.length).toBeLessThanOrEqual(120)
    const { added } = await run([frame({ action: { type: 'type', description } })], only('showActionLabels'))
    expect(textsOf(added[0])).toContain(description)
  })
  test('其他无坐标动作（如导航）：不画文字标签', async () => {
    const { added } = await run([frame({ action: { type: 'navigate', description: 'Opened the pricing page' } })], only('showActionLabels'))
    expect(inkCount(added[0])).toBe(0)
  })
  test('没有说明：不画文字标签', async () => {
    const { added } = await run([frame({ action: { type: 'key' } })], only('showActionLabels'))
    expect(inkCount(added[0])).toBe(0)
  })
})

describe('标注：外沿上限（22 × 比例）', () => {
  test('点击标注所有几何点都在换算后坐标的上限内', async () => {
    const { added } = await run([frame({ action: { type: 'left_click', coordinate: [100, 80] }, viewportWidth: 200 })], only('showClickIndicators'))
    expect(near(added[0], 200, 160, 1)).toBe(true)
    expect(within(added[0], [[200, 160]], 22 * 2 + 1)).toBe(true)
  })
  test('拖拽两端标注与连线：几何点都落在两端的上限内', async () => {
    const drag = { type: 'left_click_drag', start_coordinate: [30, 40], coordinate: [160, 120] }
    const { added } = await run([frame({ action: drag, viewportWidth: 200 })], only('showDragPaths'))
    expect(within(added[0], [[60, 80], [320, 240]], 22 * 2 + 1)).toBe(true)
  })
})

describe('标注：坐标换算', () => {
  test('图宽是视口宽两倍：标注落在坐标两倍处', async () => {
    const { added } = await run([frame({ action: { type: 'left_click', coordinate: [60, 50] }, viewportWidth: 200 })], only('showClickIndicators'))
    expect(near(added[0], 120, 100, 1)).toBe(true)
    expect(near(added[0], 60, 50, 20)).toBe(false)
  })
  test('拖拽两端同样换算', async () => {
    const drag = { type: 'left_click_drag', start_coordinate: [20, 30], coordinate: [150, 120] }
    const { added } = await run([frame({ action: drag, viewportWidth: 200 })], only('showDragPaths'))
    expect(near(added[0], 40, 60, 1)).toBe(true)
    expect(near(added[0], 300, 240, 1)).toBe(true)
  })
  test('没给视口宽：按 1:1', async () => {
    const { added } = await run([frame({ action: { type: 'left_click', coordinate: [60, 50] } })], only('showClickIndicators'))
    expect(near(added[0], 60, 50, 1)).toBe(true)
    expect(near(added[0], 120, 100, 20)).toBe(false)
  })
  test('比例按每帧自己的图宽算（小帧补白后也对）', async () => {
    const act = { type: 'left_click', coordinate: [50, 40] }
    const { added } = await run([frame({ action: act, viewportWidth: 100 }), frame({ base64: IMG.small, action: act, viewportWidth: 100 })], only('showClickIndicators'))
    expect(near(added[0], 200, 160, 1)).toBe(true)
    expect(near(added[1], 100, 80, 1)).toBe(true)
  })
})
