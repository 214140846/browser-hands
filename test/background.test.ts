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
const work = mkdtempSync(TEST_TMP + '/jev-bg-')
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
  '/bg': `<title>后台</title><body style="margin:0;background:#0a0">
    <div id="t" style="position:absolute;left:100px;top:100px;width:120px;height:60px;background:#c00" onclick="this.dataset.c='1'">点我</div>
    <input id="i" style="position:absolute;left:100px;top:200px;width:200px" autofocus>
    <a id="l" href="/child" target="_blank" style="position:absolute;left:100px;top:300px;font-size:30px">新标签链接</a></body>`,
  '/child': '<title>子页</title><body>child</body>',
}

let ctx: BrowserContext
let site: ReturnType<typeof Bun.serve>
let client: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]
const tool = async (name: string, args: any) => {
  const r: any = await client.callTool({ name, arguments: args })
  return { err: !!r.isError, text: r.content[0].text as string, image: r.content.find((c: any) => c.type === 'image') as { data: string } | undefined }
}
const computer = (args: any) => tool('computer', { tabId: mainTab, ...args })
const tabsInGroup = async () => firstJson((await tool('tabs_context_mcp', {})).text).availableTabs as { tabId: number }[]
// 视口坐标 → 最近一次截图的帧坐标
let frame = [0, 0]
const pt = async (x: number, y: number) => {
  const vp = await page().evaluate(() => [innerWidth, innerHeight])
  return frame[0] ? [(x * frame[0]) / vp[0], (y * frame[1]) / vp[1]] : [x, y]
}
const page = () => ctx.pages().find((p) => p.url() === `http://localhost:${site.port}/bg`)!

beforeAll(async () => {
  site = Bun.serve({ port: 0, fetch: (r) => new Response(pages[new URL(r.url).pathname] ?? 'x', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'bg', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env }))
  mainTab = (await tabsInGroup())[0].tabId
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${site.port}/bg`])
  await until(async () => (await sw().evaluate((t) => chrome.tabs.get(t), mainTab)).status === 'complete')
}, 60000)

afterAll(async () => {
  await client?.close()
  await ctx?.close()
  site?.stop(true)
  rmSync(work, { recursive: true, force: true })
}, 30000)

// 在同窗口另开一个前台标签，让主标签变成后台
async function backgroundMain() {
  const wid = (await sw().evaluate((t) => chrome.tabs.get(t), mainTab)).windowId
  await sw().evaluate((w) => chrome.tabs.create({ windowId: w, active: true, url: 'about:blank' }), wid)
  await until(async () => !(await sw().evaluate((t) => chrome.tabs.get(t), mainTab)).active)
}

test('后台标签：截图非空、输入生效，焦点模拟用完即关、静音只解自己加的', async () => {
  await backgroundMain()
  const s = await computer({ action: 'screenshot' })
  expect(s.err).toBe(false)
  expect(s.image!.data.length).toBeGreaterThan(500)
  frame = (s.text.match(/viewport (\d+)x(\d+)/) ?? s.text.match(/(\d+)x(\d+)/))!.slice(1).map(Number)
  const c = await computer({ action: 'left_click', coordinate: await pt(160, 130) })
  expect(c.err).toBe(false)
  await until(async () => (await page().getAttribute('#t', 'data-c')) === '1')
  await computer({ action: 'left_click', coordinate: await pt(200, 210) })
  const ty = await computer({ action: 'type', text: 'hello' })
  expect(ty.err).toBe(false)
  await until(async () => (await page().inputValue('#i')) === 'hello')
  // 用完不留：静音已解除；焦点模拟已关（插件里没有残留的模拟记录）
  const t = await sw().evaluate((t) => chrome.tabs.get(t), mainTab)
  expect(t.mutedInfo?.muted ?? false).toBe(false)
  expect(await sw().evaluate(() => (globalThis as any).__jevBg.activeCount())).toBe(0)
}, 60000)

test('用户自己静音的标签：任务后仍保持静音', async () => {
  await sw().evaluate((t) => chrome.tabs.update(t, { muted: true }), mainTab)
  await computer({ action: 'screenshot' })
  const t = await sw().evaluate((t) => chrome.tabs.get(t), mainTab)
  expect(t.mutedInfo?.muted).toBe(true)
  await sw().evaluate((t) => chrome.tabs.update(t, { muted: false }), mainTab)
}, 30000)

test('点 target=_blank 链接开出的新标签自动入组', async () => {
  const before = (await tabsInGroup()).length
  await sw().evaluate((t) => chrome.tabs.update(t, { active: true }), mainTab)
  const c = await computer({ action: 'left_click', coordinate: await pt(140, 320) })
  expect(c.err).toBe(false)
  const tabs = await until(async () => {
    const x = await tabsInGroup()
    return x.length === before + 1 && x
  })
  expect(tabs.length).toBe(before + 1)
}, 30000)

test('窗口最小化：拦截 _blank，插件后台同组开标签并告知 tabId', async () => {
  const before = await tabsInGroup()
  const wid = (await sw().evaluate((t) => chrome.tabs.get(t), mainTab)).windowId
  await sw().evaluate((t) => chrome.tabs.update(t, { active: true }), mainTab)
  await sw().evaluate((w) => chrome.windows.update(w, { state: 'minimized' }), wid)
  await until(async () => (await sw().evaluate((w) => chrome.windows.get(w), wid)).state === 'minimized')
  const c = await computer({ action: 'left_click', coordinate: await pt(140, 320) })
  expect(c.err).toBe(false)
  const m = c.text.match(/tab id\D{0,3}(\d+)/i)
  expect(m).not.toBeNull()
  const id = Number(m![1])
  const after = (await tabsInGroup()).map((t) => t.tabId)
  expect(after).toContain(id)
  expect(before.map((t) => t.tabId)).not.toContain(id)
  const t = await sw().evaluate((i) => chrome.tabs.get(i), id)
  expect(t.active).toBe(false)
}, 60000)
