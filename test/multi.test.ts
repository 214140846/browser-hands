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
const work = mkdtempSync(TEST_TMP + '/jev-multi-')
const socketDir = join(work, 'sockets')
const env = { ...process.env, JEV_SOCKET_DIR: socketDir, JEV_SWITCH_TIMEOUT_MS: '60000' } as Record<string, string>
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

async function launch(name: string) {
  const dir = join(work, name)
  writeHostManifest(join(dir, 'NativeMessagingHosts'))
  const ctx = await launchBrowser(dir, env)
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  await sw.evaluate((n) => chrome.storage.local.set({ profileName: n }), name)
  return { ctx, sw }
}

let b1: { ctx: BrowserContext; sw: any }
let b2: { ctx: BrowserContext; sw: any }
let client: Client
let quick: Client // 确认超时调短的第二个 MCP 程序，只测「没人点」
const parse = (r: any) => firstJson(r.content[0].text as string)
const call = (name: string, args: any = {}): Promise<any> => client.callTool({ name, arguments: args })
const groupCount = (b: { sw: any }) => b.sw.evaluate(() => chrome.tabGroups.query({})).then((g: any[]) => g.length)

beforeAll(async () => {
  b1 = await launch('one')
  await until(() => socks().length === 1)
  b2 = await launch('two')
  await until(() => socks().length === 2)
  client = new Client({ name: 'M', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env }))
  quick = new Client({ name: 'Q', version: '0' })
  const quickEnv = { ...env, JEV_SWITCH_TIMEOUT_MS: '300' }
  await quick.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env: quickEnv }))
}, 90000)

afterAll(async () => {
  await client?.close()
  await quick?.close()
  await b1?.ctx.close().catch(() => {})
  await b2?.ctx.close().catch(() => {})
  rmSync(work, { recursive: true, force: true })
}, 30000)

test('两个浏览器在线，list 能列出；多个时不自动选', async () => {
  const r = parse(await call('list_connected_browsers'))
  expect(r.browsers.map((b: any) => b.name).sort()).toEqual(['one', 'two'])
  const bad = await call('tabs_context_mcp')
  expect(bad.isError).toBe(true)
  expect(bad.content[0].text).toContain('select_browser')
})

test('select / switch 后操作落到对的浏览器', async () => {
  const { browsers } = parse(await call('list_connected_browsers'))
  const id = (n: string) => browsers.find((b: any) => b.name === n).deviceId
  await call('select_browser', { deviceId: id('one') })
  expect((await call('tabs_context_mcp')).isError).toBeFalsy()
  expect(await groupCount(b1)).toBe(1)
  expect(await groupCount(b2)).toBe(0)
})

const popup = (b: { ctx: BrowserContext }) =>
  until(() => b.ctx.pages().find((p) => p.url().includes('connect.html')))

test('switch_browser：两边都弹确认窗，第一个点 Connect 的被选中，另一边被取消关窗', async () => {
  const pending = call('switch_browser')
  const p1 = await popup(b1)
  const p2 = await popup(b2)
  await p2.fill('#name', 'renamed')
  await p2.click('#connect')
  const r = await pending
  expect(r.isError).toBeFalsy()
  await until(() => p1.isClosed())
  const { browsers } = parse(await call('list_connected_browsers'))
  const two = browsers.find((b: any) => b.deviceId && b.inUse)
  expect(two.name).toBe('renamed')
  expect(two.osPlatform).toBeTruthy()
  expect(two.isLocal).toBe(true)
  expect(browsers.filter((b: any) => b.inUse).length).toBe(1)
  expect((await call('tabs_context_mcp')).isError).toBeFalsy()
  expect(await groupCount(b2)).toBe(1)
})

test('switch_browser 没人点：超时返回 timed_out，确认窗被关，选择不变', async () => {
  const q = (name: string, args: any = {}): Promise<any> => quick.callTool({ name, arguments: args })
  const before = parse(await q('list_connected_browsers')).browsers.find((b: any) => b.name === 'renamed')
  await q('select_browser', { deviceId: before.deviceId })
  const r = await q('switch_browser')
  expect(r.isError).toBe(true)
  expect(r.content[0].text).toContain('timed_out')
  // 两边的确认窗都关掉才算收尾，免得留到下一条测试
  await until(() => ![b1, b2].some((b) => b.ctx.pages().some((p) => p.url().includes('connect.html'))))
  const { browsers } = parse(await q('list_connected_browsers'))
  expect(browsers.find((b: any) => b.inUse).name).toBe('renamed')
})

test('选中的浏览器关了报 browser_gone 并附在线列表，之后剩一个自动选', async () => {
  await b2.ctx.close()
  const r: any = await until(async () => {
    const x = await call('tabs_context_mcp')
    return x.isError && x.content[0].text.includes('browser_gone') && x
  })
  expect(r.content[0].text).toContain('one')
  expect(r.content[0].text).not.toContain('renamed (')
  expect((await call('tabs_context_mcp')).isError).toBeFalsy()
})

test('list 带 email 字段，原有字段都在；改名称不重启就生效，清空后退到邮箱 / deviceId 前缀', async () => {
  const find = async (id: string) => parse(await call('list_connected_browsers')).browsers.find((b: any) => b.deviceId === id)
  const id = parse(await call('list_connected_browsers')).browsers.find((b: any) => b.name === 'one').deviceId
  const one = await find(id)
  for (const k of ['deviceId', 'name', 'osPlatform', 'isLocal', 'onThisComputer', 'inUse', 'extensionVersion', 'email']) expect(one).toHaveProperty(k)
  expect(typeof one.email).toBe('string')
  await b1.sw.evaluate(() => chrome.storage.local.set({ profileName: '工作' }))
  expect((await find(id)).name).toBe('工作')
  await b1.sw.evaluate(() => chrome.storage.local.remove('profileName'))
  const after = await find(id)
  expect(after.name).toBe(after.email || id.slice(0, 8))
  await b1.sw.evaluate(() => chrome.storage.local.set({ profileName: 'one' }))
  expect((await find(id)).name).toBe('one')
})
