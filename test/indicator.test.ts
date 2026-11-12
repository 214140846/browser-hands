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
const indicator = (op: 'state' | 'stopCenter') =>
  sw().evaluate(
    ([t, o]) => chrome.scripting.executeScript({ target: { tabId: t as number }, func: (o) => (window as any).__jevIndicator?.[o as string]() ?? null, args: [o] }).then((r) => r[0]?.result),
    [mainTab, op] as const,
  )
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

test('点击前光标出现一下，坐标落在 Stop 按钮上时按钮先收起', async () => {
  await open('/a')
  const running = waitCall()
  await until(async () => ((await indicator('state')) as any)?.stop)
  const [x, y] = (await indicator('stopCenter')) as number[]
  const c = await call('computer', { tabId: mainTab, action: 'left_click', coordinate: [x, y] })
  expect(c.err).toBe(false)
  expect(((await indicator('state')) as any).stop).toBe(false) // 被点的位置正好是按钮：已收起，没点到它
  expect(((await indicator('state')) as any).cursor).toBe(true)
  await until(async () => !((await indicator('state')) as any)?.cursor) // 淡出
  expect((await running).err).toBe(false) // 没被误 Stop，wait 自然结束
}, 40000)
