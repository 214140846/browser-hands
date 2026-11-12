const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
require('node:fs').mkdirSync(TEST_TMP, { recursive: true })
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { BrowserContext } from 'playwright'
import { launchBrowser, firstJson } from './launch'
import { writeHostManifest } from '../server/install'

const root = resolve(import.meta.dir, '..')
const TMP = TEST_TMP
mkdirSync(TMP, { recursive: true })
const work = mkdtempSync(join(TMP, 'jev-e2e-'))
const userDataDir = join(work, 'profile')
const socketDir = join(work, 'sockets')
const env = { ...process.env, JEV_SOCKET_DIR: socketDir } as Record<string, string>

let ctx: BrowserContext
let site: ReturnType<typeof Bun.serve>
let client: Client
let nmhDir = ''

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 20000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('等待超时')
    await Bun.sleep(100) // 仅测试里轮询
  }
}
const socks = () => (existsSync(socketDir) ? readdirSync(socketDir).filter((f) => f.endsWith('.sock')) : [])

beforeAll(async () => {
  site = Bun.serve({
    port: 0,
    fetch: (r) => new Response(`<title>${new URL(r.url).pathname}</title><h1>hi</h1>`, { headers: { 'content-type': 'text/html' } }),
  })
  // 实测：Chromium 会读 user-data-dir/NativeMessagingHosts
  nmhDir = join(userDataDir, 'NativeMessagingHosts')
  writeHostManifest(nmhDir)
  ctx = await launchBrowser(userDataDir, env)
  await (await ctx.newPage()).goto(`http://localhost:${site.port}/one`)
  await (await ctx.newPage()).goto(`http://localhost:${site.port}/two`)
  await until(() => socks().length > 0)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env }))
}, 60000)

afterAll(async () => {
  await client?.close()
  await ctx?.close()
  site?.stop(true)
  await until(() => socks().length === 0, 10000).catch(() => {})
  expect(socks()).toEqual([]) // host 随 Chrome 退出并删 socket
  rmSync(work, { recursive: true, force: true })
}, 30000)

const parse = (r: any) => firstJson(r.content[0].text as string)
const sw = () => ctx.serviceWorkers()[0]
const groups = () => sw().evaluate(() => chrome.tabGroups.query({}))
const newClient = async (name: string) => {
  const c = new Client({ name, version: '0' })
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env }))
  return c
}

test('tabs_context_mcp 只看到本会话组里的标签', async () => {
  const r: any = await client.callTool({ name: 'tabs_context_mcp', arguments: {} })
  expect(r.isError).toBeFalsy()
  const t = r.content[0].text as string
  const { availableTabs, tabGroupId } = parse(r)
  const urls = availableTabs.map((x: any) => x.url)
  expect(availableTabs.length).toBe(1) // 主标签
  expect(urls).not.toContain(`http://localhost:${site.port}/one`)
  expect(urls).not.toContain(`http://localhost:${site.port}/two`)
  expect(t).toContain('tabId')
  const g = (await groups()).find((x) => x.id === tabGroupId)!
  expect(g.title).toMatch(/^(⌛|✅) test-/)
})

test('两个会话各有组，互相动标签被拒，一个断开另一个照跑', async () => {
  const A = await newClient('A')
  const B = await newClient('B')
  const ca = parse(await A.callTool({ name: 'tabs_context_mcp', arguments: {} }))
  const cb = parse(await B.callTool({ name: 'tabs_context_mcp', arguments: {} }))
  expect(ca.tabGroupId).not.toBe(cb.tabGroupId)
  const aTab = ca.availableTabs[0].tabId
  const bTab = cb.availableTabs[0].tabId
  const gs = await groups()
  const colorOf = (id: number) => gs.find((g) => g.id === id)!.color
  expect(colorOf(ca.tabGroupId)).not.toBe(colorOf(cb.tabGroupId))

  const bad: any = await A.callTool({ name: 'tabs_close_mcp', arguments: { tabId: bTab } })
  expect(bad.isError).toBe(true)
  expect(bad.content[0].text).toContain('tab_outside_group')
  expect(bad.content[0].text).toContain(String(aTab))

  // A 自己能新开标签
  const made: any = await A.callTool({ name: 'tabs_create_mcp', arguments: {} })
  expect(made.isError).toBeFalsy()
  expect(parse({ content: [{ text: made.content[0].text.split('\n\n')[1] }] }).availableTabs.length).toBe(2)

  await A.close()
  await until(async () => (await groups()).find((g) => g.id === ca.tabGroupId)?.title?.startsWith('✅ A-'))
  const left = await sw().evaluate((gid) => chrome.tabs.query({ groupId: gid }), ca.tabGroupId)
  expect(left.length).toBe(2) // 标签没关

  // B 照跑，组名不带 A 的 ✅ 被误改
  const again: any = await B.callTool({ name: 'tabs_create_mcp', arguments: {} })
  expect(again.isError).toBeFalsy()
  const bnow = (await groups()).find((g) => g.id === cb.tabGroupId)!
  expect(bnow.title).toContain('B-')
  await B.close()
})

test('组名被用户改掉会改回；组被关后下次重建', async () => {
  const C = await newClient('C')
  const c1 = parse(await C.callTool({ name: 'tabs_context_mcp', arguments: {} }))
  await sw().evaluate((gid) => chrome.tabGroups.update(gid, { title: 'hacked', color: 'grey' }), c1.tabGroupId)
  await until(async () => (await groups()).find((g) => g.id === c1.tabGroupId)?.title?.includes('C-'))
  await sw().evaluate((t) => chrome.tabs.remove(t), c1.availableTabs[0].tabId)
  const c2 = parse(await C.callTool({ name: 'tabs_context_mcp', arguments: {} }))
  expect(c2.availableTabs.length).toBe(1)
  expect(c2.availableTabs[0].tabId).not.toBe(c1.availableTabs[0].tabId)
  await C.close()
})

test('socket 目录 0700、socket 0600', async () => {
  const { statSync } = await import('node:fs')
  expect(statSync(socketDir).mode & 0o777).toBe(0o700)
  expect(statSync(join(socketDir, socks()[0])).mode & 0o777).toBe(0o600)
})

test('没有浏览器时报清楚原因', async () => {
  const c = new Client({ name: 'x', version: '0' })
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env: { ...env, JEV_SOCKET_DIR: join(work, 'empty') } }))
  const r: any = await c.callTool({ name: 'tabs_context_mcp', arguments: {} })
  expect(r.isError).toBe(true)
  expect(r.content[0].text).toContain('Cannot reach the browser')
  await c.close()
})
