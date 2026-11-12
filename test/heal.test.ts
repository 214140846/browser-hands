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
const work = mkdtempSync(TEST_TMP + '/jev-heal-')
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

const html = `<title>自愈</title><body style="margin:0"><button id="b" style="width:100px;height:40px" onclick="window.clicks=(window.clicks||0)+1">点</button></body>`

let ctx: BrowserContext
let site: ReturnType<typeof Bun.serve>
let client: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]
const dbg = (expr: string, arg?: unknown) => sw().evaluate(`(async () => { const d = globalThis.__jevDebugger; return ${expr} })()`)
const page = () => ctx.pages().find((p) => p.url().startsWith(`http://localhost:${site.port}`))!
const click = async () => {
  const b = (await page().locator('#b').boundingBox())!
  const r: any = await client.callTool({ name: 'computer', arguments: { tabId: mainTab, action: 'left_click', coordinate: [b.x + 10, b.y + 10] } })
  return { err: !!r.isError, text: r.content[0].text as string }
}
const clicks = () => page().evaluate(() => (window as any).clicks ?? 0)

beforeAll(async () => {
  site = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'heal', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env }))
  const r: any = await client.callTool({ name: 'tabs_context_mcp', arguments: {} })
  mainTab = firstJson(r.content[0].text).availableTabs[0].tabId
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${site.port}/`])
  await until(async () => (await sw().evaluate((t) => chrome.tabs.get(t), mainTab)).status === 'complete' && page())
}, 60000)

afterAll(async () => {
  await client?.close()
  await ctx?.close()
  site?.stop(true)
  rmSync(work, { recursive: true, force: true })
}, 30000)

test('手动 detach 后下一次调用自动恢复', async () => {
  expect((await click()).err).toBe(false)
  await until(async () => (await clicks()) === 1)
  expect(await dbg('d.isAttached(' + mainTab + ')')).toBe(true)
  // 绕过单例直接断开：单例的 onDetach 会清掉记录，这里再造「记录还在但实际没挂」的情况
  await sw().evaluate((t) => new Promise((r) => chrome.debugger.detach({ tabId: t as number }, () => r(null))), mainTab)
  expect((await click()).err).toBe(false)
  await until(async () => (await clicks()) === 2)
  expect(await dbg('d.isAttached(' + mainTab + ')')).toBe(true)
}, 40000)

test('挂载报「不能访问别的插件页面」：清掉别的插件的 iframe 后重试成功', async () => {
  await dbg('d.detach(' + mainTab + ')')
  await page().evaluate(() => {
    const f = document.createElement('iframe')
    f.id = 'foreign'
    f.src = 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/x.html'
    document.body.append(f)
  })
  await dbg(`(d.inject.msg = 'Cannot access a chrome-extension:// URL of different extension', d.inject.times = 1)`)
  expect((await click()).err).toBe(false)
  expect(await page().locator('#foreign').count()).toBe(0)
  expect(await dbg('d.isAttached(' + mainTab + ')')).toBe(true)
}, 40000)

test('实在挂不上：退回模拟事件，点击照样生效', async () => {
  await dbg('d.detach(' + mainTab + ')')
  const before = await clicks()
  await dbg(`(d.inject.msg = 'Another debugger is attached elsewhere', d.inject.times = 100)`)
  const r = await click()
  await dbg('(d.inject.times = 0)')
  expect(r.err).toBe(false)
  await until(async () => (await clicks()) === before + 1)
  expect(await dbg('d.isAttached(' + mainTab + ')')).toBe(false)
}, 40000)

test('挂载失败后记 30 秒：第二次输入直接退回模拟事件，不再重试挂载', async () => {
  await dbg('d.detach(' + mainTab + ')')
  await dbg('d.forgetFailure(' + mainTab + ')')
  const before = await clicks()
  // 每次挂载尝试 1.5 秒后报错，余量 4 次：若第二次还去挂载，余量会再少 1
  await dbg(`(d.inject.msg = 'Another debugger is attached elsewhere', d.inject.delayMs = 1500, d.inject.times = 4)`)
  const t1 = Date.now()
  expect((await click()).err).toBe(false)
  const first = Date.now() - t1
  const t2 = Date.now()
  expect((await click()).err).toBe(false)
  const second = Date.now() - t2
  const left = await dbg('d.inject.times')
  await dbg(`(d.inject.times = 0, d.inject.delayMs = 0)`)
  await dbg('d.forgetFailure(' + mainTab + ')')
  await until(async () => (await clicks()) === before + 2)
  expect(first).toBeGreaterThanOrEqual(1400)
  expect(second).toBeLessThan(1200)
  expect(left).toBe(3) // 只有第一次尝试过挂载
}, 40000)
