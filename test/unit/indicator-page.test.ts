// indicator-page 单测：注入网页的经典脚本，不能 import。读源码注入 Playwright 真页面，每条用例一张新页面。
// 只断言可观察行为：真 / 假点击的效果、发给扩展的消息、可访问树、像素「有没有变」、计时窗口。
// 不断言颜色、形状、尺寸、位置细节和任何文案。
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Page } from 'playwright'
import { axButtons, call, forgeClicks, inject, injectCounting, openPage, sent, startBrowser, stopBrowser, type SendMode } from './fakes/indicator-page-page'

setDefaultTimeout(30_000)
beforeAll(startBrowser)

let pages: Page[] = []
afterAll(async () => {
  for (const p of pages) await p.close().catch(() => {})
  pages = []
  await stopBrowser()
})

const fresh = async (body = '', opts: { mode?: SendMode; inject?: boolean } = {}) => {
  const o = await openPage(body, opts)
  pages.push(o.page)
  return o
}

type State = { border: boolean; stop: boolean; cursor: boolean }
const state = (p: Page): Promise<State> => call(p, 'state')
const center = (p: Page): Promise<[number, number] | null> => call(p, 'stopCenter')
const stops = async (p: Page) => (await sent(p)).filter((m) => m?.type === 'STOP').length
const settle = (p: Page, ms = 300) => p.waitForTimeout(ms)
const shot = (p: Page, clip?: { x: number; y: number; width: number; height: number }) =>
  p.screenshot({ clip, animations: 'allow' })
const same = (a: Buffer, b: Buffer) => Buffer.compare(a, b) === 0

// 页面中部一个会计数的按钮
const PAGE_BTN = `<button id="pb" style="position:fixed;left:350px;top:280px;width:100px;height:40px"
  onclick="this.dataset.n=(+(this.dataset.n||0))+1">page</button>`
const pageClicks = (p: Page) => p.evaluate(() => +(document.getElementById('pb')!.dataset.n || 0))

describe('脚本形态', () => {
  test('挂出恰好 5 个函数', async () => {
    const { page } = await fresh()
    const keys = await page.evaluate(() =>
      Object.entries((window as any).__jevIndicator).map(([k, v]) => [k, typeof v] as const),
    )
    expect(keys.map(([k]) => k).sort()).toEqual(['hide', 'moveCursor', 'show', 'state', 'stopCenter'])
    expect(keys.every(([, t]) => t === 'function')).toBe(true)
  })

  test('注入时不改 DOM、不挂 window/document 监听，初始什么都没显示', async () => {
    const { page } = await fresh('<p>x</p>', { inject: false })
    const before = await page.evaluate(() => document.documentElement.outerHTML)
    const img = await shot(page)
    expect(await injectCounting(page)).toBe(0)
    expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before)
    expect(await state(page)).toEqual({ border: false, stop: false, cursor: false })
    expect(await center(page)).toBeNull()
    expect(same(await shot(page), img)).toBe(true)
  })

  test('重复注入不替换对象、不影响已显示的指示器', async () => {
    const { page } = await fresh()
    await call(page, 'show')
    await page.evaluate(() => ((window as any).__jevIndicator.marker = 1))
    await inject(page)
    expect(await page.evaluate(() => (window as any).__jevIndicator.marker)).toBe(1)
    expect((await state(page)).stop).toBe(true)
    expect(await axButtons(page)).toHaveLength(1)
  })

  test('show / hide / moveCursor 同步返回 true', async () => {
    const { page } = await fresh()
    const r = await page.evaluate(() => {
      const I = (window as any).__jevIndicator
      return [I.show(), I.moveCursor(10, 10), I.hide(), I.hide()]
    })
    expect(r).toEqual([true, true, true, true])
  })
})

describe('show / hide', () => {
  test('show 后边框和 Stop 都在；画面有变化；hide 后画面复原', async () => {
    const { page, errors } = await fresh()
    const blank = await shot(page)
    await call(page, 'show')
    expect(await state(page)).toEqual({ border: true, stop: true, cursor: false })
    await settle(page)
    expect(same(await shot(page), blank)).toBe(false)
    await call(page, 'hide')
    expect(await state(page)).toEqual({ border: false, stop: false, cursor: false })
    expect(await center(page)).toBeNull()
    await settle(page)
    expect(same(await shot(page), blank)).toBe(true)
    expect(errors).toEqual([])
  })

  test('可访问树：show 后恰好一个有名字的按钮，连调 show 不重复，hide 后消失', async () => {
    const { page } = await fresh()
    expect(await axButtons(page)).toEqual([])
    await call(page, 'show')
    let names = await axButtons(page)
    expect(names).toHaveLength(1)
    expect(names[0].trim().length).toBeGreaterThan(0)
    await call(page, 'show')
    expect(await axButtons(page)).toHaveLength(1)
    await call(page, 'hide')
    expect(await axButtons(page)).toEqual([])
    await call(page, 'show')
    names = await axButtons(page)
    expect(names).toHaveLength(1)
  })

  test('页面脚本拿不到指示器内部：文档里没有新增按钮，也没有可读的 shadowRoot', async () => {
    const { page } = await fresh('<p>x</p>')
    await call(page, 'show')
    await call(page, 'moveCursor', 100, 100)
    const r = await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')]
      return { buttons: document.querySelectorAll('button').length, open: all.filter((e) => e.shadowRoot).length }
    })
    expect(r).toEqual({ buttons: 0, open: 0 })
  })

  test('hide 可以连调；没 show 过直接 hide 也不报错', async () => {
    const { page, errors } = await fresh()
    expect(await call(page, 'hide')).toBe(true)
    await call(page, 'show')
    expect(await call(page, 'hide')).toBe(true)
    expect(await call(page, 'hide')).toBe(true)
    expect(errors).toEqual([])
  })

  test('边框不挡页面：show 后真点页面中部按钮，页面收到点击', async () => {
    const { page } = await fresh(PAGE_BTN)
    await call(page, 'show')
    await page.mouse.click(400, 300)
    expect(await pageClicks(page)).toBe(1)
  })

  test('stopCenter 在视口内', async () => {
    const { page } = await fresh()
    await call(page, 'show')
    const c = await center(page)
    expect(c).not.toBeNull()
    const [x, y] = c!
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThanOrEqual(800)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(y).toBeLessThanOrEqual(600)
  })

  test('页面清空 body 后再 show，Stop 照常可用', async () => {
    const { page } = await fresh('<p>x</p>')
    await call(page, 'show')
    await page.evaluate(() => (document.body.innerHTML = ''))
    expect(await call(page, 'show')).toBe(true)
    expect((await state(page)).stop).toBe(true)
    const [x, y] = (await center(page))!
    await page.mouse.click(x, y)
    expect(await stops(page)).toBe(1)
  })

  test('文档没有 body 时 show 仍返回 true 且不抛错', async () => {
    const { page, errors } = await fresh()
    await page.evaluate(() => document.body.remove())
    expect(await call(page, 'show')).toBe(true)
    expect(await call(page, 'moveCursor', 5, 5)).toBe(true)
    expect(await call(page, 'hide')).toBe(true)
    expect(errors).toEqual([])
  })
})

describe('Stop 按钮', () => {
  test('真点击发一条 STOP 消息；每次真点击各一条；点击不改变显示状态', async () => {
    const { page } = await fresh()
    await call(page, 'show')
    const [x, y] = (await center(page))!
    await page.mouse.click(x, y)
    expect(await sent(page)).toEqual([{ type: 'STOP' }])
    expect(await state(page)).toEqual({ border: true, stop: true, cursor: false })
    await page.mouse.click(x, y)
    expect(await stops(page)).toBe(2)
  })

  test('页面脚本伪造的点击无效', async () => {
    const { page } = await fresh()
    await call(page, 'show')
    const [x, y] = (await center(page))!
    await page.evaluate(([x, y]) => {
      for (const el of document.elementsFromPoint(x, y)) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: x, clientY: y }))
        ;(el as HTMLElement).click?.()
      }
      document.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: x, clientY: y }))
    }, [x, y])
    await settle(page, 200)
    expect(await sent(page)).toEqual([])
  })

  test('穿透封装、直接对 Stop 按钮脚本派发的点击同样无效；真点击仍有效', async () => {
    const { page } = await fresh()
    await call(page, 'show')
    expect(await forgeClicks(page)).toBe(1)
    await settle(page, 200)
    expect(await sent(page)).toEqual([])
    const [x, y] = (await center(page))!
    await page.mouse.click(x, y)
    expect(await stops(page)).toBe(1)
  })

  test('页面上有全屏高层级遮罩时，真点 Stop 仍然有效', async () => {
    const { page } = await fresh(
      `<div style="position:fixed;inset:0;z-index:100000" onclick="this.dataset.n=1"></div>`,
    )
    await call(page, 'show')
    const [x, y] = (await center(page))!
    await page.mouse.click(x, y)
    expect(await stops(page)).toBe(1)
  })

  test('sendMessage 失败（没有接收方）时不产生页面未捕获错误', async () => {
    const { page, errors } = await fresh('', { mode: 'reject' })
    await call(page, 'show')
    const [x, y] = (await center(page))!
    await page.mouse.click(x, y)
    await settle(page, 300)
    expect(await stops(page)).toBe(1)
    expect(errors).toEqual([])
  })

  test('hide 后 Stop 原位置的真点击不发消息', async () => {
    const { page } = await fresh()
    await call(page, 'show')
    const [x, y] = (await center(page))!
    await call(page, 'hide')
    await page.mouse.click(x, y)
    expect(await sent(page)).toEqual([])
  })
})

describe('moveCursor', () => {
  test('没 show 也能单独出光标；边框和 Stop 不出现', async () => {
    const { page } = await fresh()
    await call(page, 'moveCursor', 200, 150)
    expect(await state(page)).toEqual({ border: false, stop: false, cursor: true })
    expect(await axButtons(page)).toEqual([])
  })

  test('光标画在坐标附近，不动远处画面', async () => {
    const { page } = await fresh()
    const near = { x: 170, y: 120, width: 60, height: 60 }
    const far = { x: 500, y: 350, width: 200, height: 150 }
    const n0 = await shot(page, near)
    const f0 = await shot(page, far)
    await call(page, 'moveCursor', 200, 150)
    await settle(page, 150)
    expect(same(await shot(page, near), n0)).toBe(false)
    expect(same(await shot(page, far), f0)).toBe(true)
  })

  test('停留窗口：调用后 300ms 仍可见，2500ms 内消失', async () => {
    const { page } = await fresh()
    const [a, b] = await page.evaluate(async () => {
      const I = (window as any).__jevIndicator
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      I.moveCursor(200, 150)
      await wait(300)
      const a = I.state().cursor
      await wait(2200)
      return [a, I.state().cursor]
    })
    expect(a).toBe(true)
    expect(b).toBe(false)
  })

  test('光标不挡点击：光标落在页面按钮上后立刻真点，页面收到', async () => {
    const { page } = await fresh(PAGE_BTN)
    await call(page, 'show')
    await call(page, 'moveCursor', 400, 300)
    await page.mouse.click(400, 300)
    expect(await pageClicks(page)).toBe(1)
  })

  test('坐标落在 Stop 上：Stop 收起，真点该处不发 STOP 而是落到页面；下次 show 恢复', async () => {
    const { page } = await fresh()
    await call(page, 'show')
    const [x, y] = (await center(page))!
    // 在 Stop 正下方放一个页面元素，记录点击
    await page.evaluate(([x, y]) => {
      const d = document.createElement('div')
      d.id = 'under'
      d.style.cssText = `position:fixed;left:${x - 5}px;top:${y - 5}px;width:10px;height:10px`
      d.onclick = () => (d.dataset.n = '1')
      document.body.appendChild(d)
    }, [x, y])
    await call(page, 'moveCursor', x, y)
    expect((await state(page)).stop).toBe(false)
    await page.mouse.click(x, y)
    expect(await sent(page)).toEqual([])
    expect(await page.evaluate(() => document.getElementById('under')!.dataset.n)).toBe('1')

    await call(page, 'show')
    expect((await state(page)).stop).toBe(true)
    const [x2, y2] = (await center(page))!
    await page.mouse.click(x2, y2)
    expect(await stops(page)).toBe(1)
  })

  test('Stop 被让位收起后，光标淡出也不自动恢复；show 才恢复', async () => {
    const { page } = await fresh()
    await call(page, 'show')
    const [x, y] = (await center(page))!
    await call(page, 'moveCursor', x, y)
    await settle(page, 2500)
    expect(await state(page)).toEqual({ border: true, stop: false, cursor: false })
    await call(page, 'show')
    expect((await state(page)).stop).toBe(true)
  })

  test('坐标不在 Stop 上时 Stop 保持', async () => {
    const { page } = await fresh()
    await call(page, 'show')
    await call(page, 'moveCursor', 20, 20)
    expect(await state(page)).toEqual({ border: true, stop: true, cursor: true })
  })

  test('hide 打断停留中的光标：之后计时到点也不报错，状态保持全关', async () => {
    const { page, errors } = await fresh()
    await call(page, 'show')
    await call(page, 'moveCursor', 100, 100)
    await call(page, 'hide')
    expect(await state(page)).toEqual({ border: false, stop: false, cursor: false })
    await settle(page, 1500)
    expect(await state(page)).toEqual({ border: false, stop: false, cursor: false })
    expect(errors).toEqual([])
  })

  test('非有限数字坐标不抛错，返回 true', async () => {
    const { page, errors } = await fresh()
    await call(page, 'show')
    const r = await page.evaluate(() => {
      const I = (window as any).__jevIndicator
      return [I.moveCursor(NaN, 1), I.moveCursor('a', 'b'), I.moveCursor(Infinity, -Infinity), I.moveCursor()]
    })
    expect(r).toEqual([true, true, true, true])
    expect((await state(page)).border).toBe(true)
    expect(errors).toEqual([])
  })
})
