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
const work = mkdtempSync(TEST_TMP + '/jev-iframe-')
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

const html = (b: string) => new Response(b, { headers: { 'content-type': 'text/html; charset=utf-8' } })
const inner = (id: string) => `<body style="margin:0"><button id="b" onclick="document.getElementById('o').textContent='clicked-${id}'">按钮${id}</button>
  <input id="i" placeholder="输入${id}"><div id="o"></div></body>`

let ctx: BrowserContext
let main: ReturnType<typeof Bun.serve>
let other: ReturnType<typeof Bun.serve>
let client: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]

const call = async (name: string, args: any = {}) => {
  const r: any = await client.callTool({ name, arguments: args })
  return { err: !!r.isError, text: r.content[0].text as string }
}
const refOf = (t: string, label: string) => t.split('\n').find((l) => l.includes(label))?.match(/\[((?:f\d+:)?ref_\d+)\]/)?.[1]!
const goto = (path: string) => sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${main.port}${path}`])
const pageAt = (path: string, frames: number) =>
  until(() => {
    const p = ctx.pages().find((x) => x.url() === `http://localhost:${main.port}${path}`)
    return p && p.frames().length === frames && p.frames().every((f) => f.url() !== 'about:blank' && f.url() !== '') && p
  })

beforeAll(async () => {
  other = Bun.serve({ port: 0, fetch: () => html(inner('跨源')) })
  main = Bun.serve({
    port: 0,
    fetch: (r) => {
      const p = new URL(r.url).pathname
      if (p === '/inner') return html(inner('同源'))
      if (p === '/nested')
        return html(`<body style="margin:0"><div style="height:30px"></div><iframe src="http://localhost:${other.port}/" style="margin-left:20px;border:2px solid #000;padding:0;width:300px;height:150px"></iframe></body>`)
      return html(`<title>外层</title><body style="margin:0"><div style="height:200px">顶部垫高</div>
        <iframe id="same" src="/inner" style="border:0;width:300px;height:100px"></iframe>
        <iframe id="cross" src="http://localhost:${other.port}/" style="border:0;margin-left:50px;width:300px;height:100px"></iframe>
        <button onclick="document.title='main-clicked'">外层按钮</button></body>`)
    },
  })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'iframe', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env }))
  const r: any = await client.callTool({ name: 'tabs_context_mcp', arguments: {} })
  mainTab = firstJson(r.content[0].text).availableTabs[0].tabId
  await goto('/')
  await pageAt('/', 3)
}, 60000)

afterAll(async () => {
  await client?.close()
  await ctx?.close()
  main?.stop(true)
  other?.stop(true)
  rmSync(work, { recursive: true, force: true })
}, 30000)

const frameBy = (p: any, sub: string) => p.frames().find((f: any) => f.url().includes(sub))

test('read_page 读到同源和跨源 iframe，编号带前缀，主 frame 不带', async () => {
  const { text } = await call('read_page', { tabId: mainTab })
  expect(text).toMatch(/button "外层按钮" \[ref_\d+\]/)
  expect(text).toMatch(/button "按钮同源" \[f\d+:ref_\d+\]/)
  expect(text).toMatch(/button "按钮跨源" \[f\d+:ref_\d+\]/)
})

test('按前缀编号点击同源 / 跨源 iframe 里的按钮', async () => {
  const p = await pageAt('/', 3)
  const { text } = await call('read_page', { tabId: mainTab })
  for (const [label, sub, want] of [['按钮同源', '/inner', 'clicked-同源'], ['按钮跨源', `:${other.port}`, 'clicked-跨源']] as const) {
    const r = await call('computer', { tabId: mainTab, action: 'left_click', ref: refOf(text, label) })
    expect(r.err).toBe(false)
    await until(async () => (await frameBy(p, sub).textContent('#o')) === want)
  }
  expect(await p.title()).toBe('外层') // 没点到外层
})

test('点击后在 iframe 的输入框里打字', async () => {
  const p = await pageAt('/', 3)
  const { text } = await call('read_page', { tabId: mainTab })
  for (const [label, sub] of [['输入同源', '/inner'], ['输入跨源', `:${other.port}`]] as const) {
    await call('computer', { tabId: mainTab, action: 'left_click', ref: refOf(text, label) })
    await call('computer', { tabId: mainTab, action: 'type', text: 'abc' })
    await until(async () => (await frameBy(p, sub).inputValue('#i')) === 'abc')
  }
})

test('read_page 用带前缀的 ref_id 只读那个 frame', async () => {
  const { text } = await call('read_page', { tabId: mainTab })
  const ref = refOf(text, '按钮跨源')
  const r = await call('read_page', { tabId: mainTab, ref_id: ref })
  expect(r.err).toBe(false)
  expect(r.text).toContain(`[${ref}]`)
  expect(r.text).not.toContain('外层按钮')
})

test('嵌套 iframe（带边框和外边距）坐标换算正确', async () => {
  await goto('/nested')
  const p = await pageAt('/nested', 2)
  const { text } = await call('read_page', { tabId: mainTab })
  const r = await call('computer', { tabId: mainTab, action: 'left_click', ref: refOf(text, '按钮跨源') })
  expect(r.err).toBe(false)
  await until(async () => (await frameBy(p, `:${other.port}`).textContent('#o')) === 'clicked-跨源')
})

test('iframe 删除后旧编号报 ref_stale', async () => {
  await goto('/')
  const p = await pageAt('/', 3)
  const { text } = await call('read_page', { tabId: mainTab })
  const ref = refOf(text, '按钮同源')
  await p.evaluate(() => document.getElementById('same')!.remove())
  const r = await call('computer', { tabId: mainTab, action: 'left_click', ref })
  expect(r.err).toBe(true)
  expect(r.text).toContain('ref_stale')
})
