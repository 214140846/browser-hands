const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { BrowserContext } from 'playwright'
import { launchBrowser, firstJson } from './launch'
import { writeHostManifest } from '../server/install'

const root = resolve(import.meta.dir, '..')
mkdirSync(TEST_TMP, { recursive: true })
const work = mkdtempSync(TEST_TMP + '/jev-indicator-')
const userDataDir = join(work, 'profile')
const socketDir = join(work, 'sockets')
const env = { ...process.env, JEV_SOCKET_DIR: socketDir } as Record<string, string>
const socks = () => (existsSync(socketDir) ? readdirSync(socketDir).filter((f) => f.endsWith('.sock')) : [])

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 20000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('等待超时')
    await Bun.sleep(100) // 仅测试里轮询
  }
}

const pages: Record<string, string> = {
  '/a': `<title>A</title><body style="margin:0"><button id="b" onclick="this.dataset.n=1">按钮</button></body>`,
  '/b': `<title>B</title><body>B</body>`,
}

let ctx: BrowserContext
let site: ReturnType<typeof Bun.serve>
let client: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]

const call = async (name: string, args: any) => {
  const r: any = await client.callTool({ name, arguments: args })
  return { err: !!r.isError, text: r.content[0].text as string }
}
async function open(path: string) {
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${site.port}${path}`])
  await until(async () => {
    const t = await sw().evaluate((t) => chrome.tabs.get(t), mainTab)
    return t.status === 'complete' && t.url?.endsWith(path)
  })
}
const page = () => ctx.pages().find((p) => p.url().startsWith(`http://localhost:${site.port}`))!
// 读隔离世界里的指示器状态（页面脚本看不到它）
const indicator = (op: 'state' | 'stopCenter' | 'moveCenter' | 'suppress' | 'restore', ...args: number[]) =>
  sw().evaluate(
    ([t, o, args]) => chrome.scripting.executeScript({ target: { tabId: t as number }, func: (o, a) => (window as any).__jevIndicator?.[o as string](...(a as number[])) ?? null, args: [o, args] }).then((r) => r[0]?.result),
    [mainTab, op, args] as const,
  )
const plan = (...a: number[]) => indicator('plan' as any, ...a)
const waitCall = () => call('computer', { tabId: mainTab, action: 'wait', duration: 9 })

beforeAll(async () => {
  site = Bun.serve({ port: 0, fetch: (r) => new Response(pages[new URL(r.url).pathname] ?? 'x', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'indicator', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env }))
  const r: any = await client.callTool({ name: 'tabs_context_mcp', arguments: {} })
  mainTab = firstJson(r.content[0].text).availableTabs[0].tabId
}, 60000)

afterAll(async () => {
  await client?.close()
  await ctx?.close()
  site?.stop(true)
  rmSync(work, { recursive: true, force: true })
}, 30000)

test('调用进行时出现边框和 Stop 按钮；脚本伪造点击无效，真点击让调用返回 stopped；之后指示器撤掉', async () => {
  await open('/a')
  const t0 = Date.now()
  let settled = false
  const running = waitCall().then((r) => ((settled = true), r))
  await until(async () => ((await indicator('state')) as any)?.stop)
  expect(((await indicator('state')) as any).border).toBe(true)

  // 页面脚本在 Stop 按钮位置能碰到的所有元素上伪造点击：closed shadow root，碰不到按钮
  const [x, y] = (await indicator('stopCenter')) as number[]
  await page().evaluate(([x, y]) => {
    for (const el of document.elementsFromPoint(x, y)) el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    document.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: x, clientY: y }))
  }, [x, y])
  await Bun.sleep(500) // 反向断言：给伪造点击一个生效的机会
  expect(settled).toBe(false)

  await page().mouse.click(x, y) // 真实点击（isTrusted）
  const r = await running
  expect(r.err).toBe(true)
  expect(r.text).toContain('stopped')
  expect(Date.now() - t0).toBeLessThan(7000)
  await until(async () => !((await indicator('state')) as any)?.border) // 空闲后撤掉
}, 40000)

test('导航后重画；状态小窗列出会话和标签，全部停止让进行中的调用返回 stopped', async () => {
  await open('/a')
  const running = waitCall()
  await until(async () => ((await indicator('state')) as any)?.border)
  await open('/b') // 文档换了，指示器要被重画
  await until(async () => ((await indicator('state')) as any)?.stop)

  const extId = new URL(sw().url()).host
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/popup.html`)
  await popup.waitForSelector('.session')
  expect(await popup.locator('.session li').allTextContents()).toContain(`#${mainTab} B`)
  expect(await popup.locator('.session b').first().textContent()).toContain('⌛')
  await popup.click('#stopAll')
  const r = await running
  expect(r.err).toBe(true)
  expect(r.text).toContain('stopped')
  await popup.close()
}, 40000)

test('点击期间光框和条瞬间隐藏（点在 Stop 上也点不到它），点完恢复；光标常驻不淡出', async () => {
  await open('/a')
  const running = waitCall()
  await until(async () => ((await indicator('state')) as any)?.stop)
  await Bun.sleep(400) // 等滑入结束
  const [x, y] = (await indicator('stopCenter')) as number[]
  const before = ((await indicator('state')) as any).hideCount
  const c = await call('computer', { tabId: mainTab, action: 'left_click', coordinate: [x, y] })
  expect(c.err).toBe(false)
  const st = (await indicator('state')) as any
  expect(st.hideCount).toBe(before + 1) // 点击前隐藏过一次
  expect(st.captured).toBe(false) // 点完已恢复
  expect(st.stop).toBe(true)
  expect(st.border).toBe(true)
  expect(st.cursor).toBe(true)
  await Bun.sleep(1200) // 旧行为 600ms 就淡出；现在常驻
  expect(((await indicator('state')) as any).cursor).toBe(true)
  expect((await running).err).toBe(false) // 没被误 Stop，wait 自然结束
}, 40000)

test('截图时光框和条不透明度为 0 但仍在 DOM，截完恢复', async () => {
  await open('/a')
  const running = waitCall()
  await until(async () => ((await indicator('state')) as any)?.stop)
  await Bun.sleep(400)
  const before = ((await indicator('state')) as any).hideCount
  const shot = await call('computer', { tabId: mainTab, action: 'screenshot' })
  expect(shot.err).toBe(false)
  const st = (await indicator('state')) as any
  expect(st.hideCount).toBe(before + 1)
  expect(st.captured).toBe(false)
  expect(st.stop && st.border).toBe(true)
  await running
}, 40000)

test('光标时长公式：D=24→150ms、100→246、300→343、>=444→380、小距离钳 140、<0.5 为 0', async () => {
  await open('/a')
  const running = waitCall()
  await until(async () => ((await indicator('state')) as any)?.stop)
  const T = async (d: number) => ((await plan(0, 0, d, 0)) as any).T
  expect(await T(24)).toBe(150)
  expect(await T(100)).toBe(246)
  expect(await T(300)).toBe(343)
  expect(await T(444)).toBe(380)
  expect(await T(900)).toBe(380)
  expect(await T(10)).toBe(140)
  expect(await T(0.4)).toBe(0)
  await running
}, 40000)

test('光标轨迹：17 个关键帧，起点、中点、终点；终点等于目标，倾斜两端为 0 且不超过 9 度', async () => {
  await open('/a')
  const running = waitCall()
  await until(async () => ((await indicator('state')) as any)?.stop)
  const [x0, y0, x1, y1] = [10, 20, 310, 420]
  const p = (await plan(x0, y0, x1, y1)) as any
  expect(p.points.length).toBe(17)
  expect(p.points[0]).toEqual([x0, y0])
  expect(p.points[16]).toEqual([x1, y1])
  // 中点（i=8，s=0.5）：按规格公式在测试里独立手算
  const dx = x1 - x0
  const dy = y1 - y0
  const D = Math.hypot(dx, dy)
  const S = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t ** 3 * (10 - 15 * t + 6 * t * t))
  const h = Math.min(0.03 * D, 4)
  const c = ((D + h) * S(0.5 / 0.8) - h * S((0.5 - 0.66) / 0.34)) / D
  const A = (0.8 * dx - 0.6 * dy > 0 ? -1 : 1) * Math.min(0.1 * D, 30)
  const l = (A * Math.sin(Math.PI * c)) / D
  expect(p.points[8][0]).toBeCloseTo(x0 + dx * c - dy * l, 6)
  expect(p.points[8][1]).toBeCloseTo(y0 + dy * c + dx * l, 6)
  // 弧线：中点偏离直线，最大侧偏不超过 min(0.1D, 30)
  const off = Math.abs((p.points[8][0] - x0) * dy - (p.points[8][1] - y0) * dx) / D
  expect(off).toBeGreaterThan(1)
  expect(off).toBeLessThanOrEqual(Math.min(0.1 * D, 30) + 1e-6)
  expect(p.leans[0]).toBe(0)
  expect(p.leans[16]).toBe(0)
  for (const a of p.leans) expect(Math.abs(a)).toBeLessThanOrEqual(9)
  await running
}, 40000)

test('光标真实移动：第一次就位，第二次走完后停在目标整数坐标；移动期间不会消失', async () => {
  await open('/a')
  const running = waitCall()
  await until(async () => ((await indicator('state')) as any)?.stop)
  await call('computer', { tabId: mainTab, action: 'hover', coordinate: [100, 100] })
  expect(((await indicator('state')) as any).cursorPos).toEqual([100, 100])
  await call('computer', { tabId: mainTab, action: 'hover', coordinate: [400, 300] }) // 等光标落点后才返回
  // 光标时长 380ms 大于工具侧最多等的 250ms，这里轮询到落点
  await until(async () => {
    const p = ((await indicator('state')) as any).cursorPos
    return Math.abs(p[0] - 400) < 0.5 && Math.abs(p[1] - 300) < 0.5
  })
  const st = (await indicator('state')) as any
  expect(st.cursorPos[0]).toBeCloseTo(400, 0)
  expect(st.cursorPos[1]).toBeCloseTo(300, 0)
  expect(st.cursor).toBe(true)
  await running
}, 40000)

test('顶部状态条：在顶部、高 47px、含 Stop 与「移到另一边」；点击翻转后在底部，再点回顶部', async () => {
  await open('/a')
  const running = waitCall()
  await until(async () => ((await indicator('state')) as any)?.stop)
  await Bun.sleep(400)
  let st = (await indicator('state')) as any
  expect(st.side).toBe('top')
  expect(st.stripTop).toBe(0)
  expect(st.stripHeight).toBe(47)
  expect(st.hasStop && st.hasMove).toBe(true)
  const [mx, my] = (await indicator('moveCenter')) as number[]
  await page().mouse.click(mx, my) // 真实点击「移到另一边」
  st = (await indicator('state')) as any
  expect(st.side).toBe('bottom')
  expect(st.stripTop + st.stripHeight).toBeCloseTo(await page().evaluate(() => innerHeight), 0)
  const [m2x, m2y] = (await indicator('moveCenter')) as number[]
  await page().mouse.click(m2x, m2y)
  expect(((await indicator('state')) as any).side).toBe('top')
  await running
}, 40000)

test('截图隐藏：条与光框不透明度立即 0 且仍在 DOM；恢复后 300ms 内回到 1', async () => {
  await open('/a')
  const running = waitCall()
  await until(async () => ((await indicator('state')) as any)?.stop)
  await Bun.sleep(400)
  expect(((await indicator('state')) as any).edgeOpacity).toBe(1)
  await indicator('suppress')
  let st = (await indicator('state')) as any
  expect(st.edgeOpacity).toBe(0)
  expect(st.hasStop && st.hasMove && st.border).toBe(true) // 仍在 DOM 里
  await indicator('restore')
  await Bun.sleep(450)
  st = (await indicator('state')) as any
  expect(st.edgeOpacity).toBe(1)
  expect(st.captured).toBe(false)
  await running
}, 40000)
