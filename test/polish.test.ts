const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { BrowserContext } from 'playwright'
import { writeHostManifest } from '../server/install'
import { estimateTokens, makeHinter, truncateOutput } from '../server/output'
import { launchBrowser, firstJson } from './launch'

const root = resolve(import.meta.dir, '..')
mkdirSync(TEST_TMP, { recursive: true })
const work = mkdtempSync(TEST_TMP + '/jev-polish-')
const userDataDir = join(work, 'profile')
const socketDir = join(work, 'sockets')
const configPath = join(work, 'config.json')
const env = { ...process.env, JEV_SOCKET_DIR: socketDir, JEV_CONFIG_PATH: configPath, JEV_PROVIDER: '', JEV_OPENROUTER_KEY: '', JEV_OPENROUTER_API_KEY: '', OPENROUTER_API_KEY: '', JEV_TYPESAFE_API_KEY: '', TYPESAFE_API_KEY: '' } as Record<string, string>
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

const CUT = /输出已截断|Output truncated/

// ---------- 纯函数 ----------

test('输出预算：没超不动；超了在行边界截断并说明怎么缩小', () => {
  expect(truncateOutput('hello', 100)).toBe('hello')
  const big = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
  const out = truncateOutput(big, 200)
  expect(estimateTokens(out.split('\n\n[')[0])).toBeLessThanOrEqual(200)
  expect(out).toMatch(CUT)
  expect(out).toContain('ref_id')
  expect(out).toContain('JEV_MAX_OUTPUT_TOKENS')
  expect(out.split('\n\n[')[0].split('\n').every((l) => /^line \d+ x{40}$/.test(l))).toBe(true) // 没把某一行切一半
  expect(truncateOutput('字'.repeat(1000), 100)).toMatch(CUT) // 中文按一字一 token 估
  expect(truncateOutput('x'.repeat(100000), 50)).toMatch(CUT) // 单行超长也能截
})

test('提示：连续两次单独调可批量工具提醒 browser_batch；批量、出错、不可批量的不提醒', () => {
  const h = makeHinter()
  expect(h.note('computer', { action: 'left_click', ref: 'ref_1' }, false)).toBeNull()
  expect(h.note('navigate', { url: 'x' }, false)).toContain('browser_batch')
  expect(h.note('navigate', { url: 'x' }, true)).toBeNull()
  const g = makeHinter()
  expect(g.note('computer', { action: 'key' }, false)).toBeNull()
  expect(g.note('read_page', {}, false)).toBeNull() // read_page 不在可批量清单里，断开连续
  expect(g.note('computer', { action: 'key' }, false)).toBeNull()
  expect(g.note('browser_batch', { actions: [{ name: 'computer', input: { action: 'type' } }] }, false)).toBeNull()
  expect(g.note('computer', { action: 'screenshot' }, false)).toBeNull() // 截图不算可批量
})

test('提示：连续 5 次简单点击提醒 jev_task；中间打字就重新数', () => {
  const h = makeHinter()
  const click = () => h.note('computer', { action: 'left_click' }, false)
  const seen = [click(), click(), click(), click(), click()].filter(Boolean).join('|')
  expect(seen).toContain('quick_task')
  const g = makeHinter()
  for (let i = 0; i < 3; i++) g.note('computer', { action: 'left_click' }, false)
  g.note('form_input', {}, false)
  expect([1, 2, 3, 4].map(() => g.note('computer', { action: 'left_click' }, false)).join('')).not.toContain('quick_task')
  const b = makeHinter()
  const batch = { actions: Array.from({ length: 5 }, () => ({ name: 'computer', input: { action: 'left_click' } })) }
  expect(b.note('browser_batch', batch, false)).toContain('quick_task')
})

// ---------- 真浏览器 ----------

let ctx: BrowserContext
let site: ReturnType<typeof Bun.serve>
let client: Client
let client2: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]
const extId = () => new URL(sw().url()).host
const pages: Record<string, string> = {
  '/btn': `<title>按钮</title><button id="b" onclick="document.title='trusted='+event.isTrusted">点我</button>`,
  '/long': `<title>长文</title><main>${Array.from({ length: 400 }, (_, i) => `<p>第 ${i} 段 lorem ipsum dolor sit amet consectetur</p>`).join('')}</main>`,
}
const text = (r: any) => r.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('\n')
const tool = async (c: Client, name: string, args: any = {}) => {
  const r: any = await c.callTool({ name, arguments: args })
  return { err: !!r.isError, text: text(r) }
}
async function open(path: string) {
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${site.port}${path}`])
  await until(async () => {
    const t = await sw().evaluate((t) => chrome.tabs.get(t), mainTab)
    return t.status === 'complete' && t.url?.endsWith(path)
  })
}
const mcp = (name: string, extra: Record<string, string> = {}) => {
  const c = new Client({ name, version: '0' })
  return c.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env: { ...env, ...extra } })).then(() => c)
}

beforeAll(async () => {
  site = Bun.serve({ port: 0, fetch: (r) => new Response(pages[new URL(r.url).pathname] ?? 'x', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = await mcp('polish')
  client2 = await mcp('small', { JEV_MAX_OUTPUT_TOKENS: '300' })
  const r = await tool(client, 'tabs_context_mcp')
  mainTab = firstJson(r.text).availableTabs[0].tabId
}, 60000)

afterAll(async () => {
  await client?.close()
  await client2?.close()
  await ctx?.close()
  site?.stop(true)
  rmSync(work, { recursive: true, force: true })
}, 30000)

test('工具输出超预算被截断，附怎么缩小；预算内的原样返回', async () => {
  await open('/long')
  // client2 是另一个会话，有自己的标签组：新开一个标签去同一页
  const smallTab = firstJson((await tool(client2, 'tabs_context_mcp')).text).availableTabs[0].tabId
  await tool(client2, 'navigate', { url: `http://localhost:${site.port}/long`, tabId: smallTab })
  const small = await tool(client2, 'get_page_text', { tabId: smallTab })
  expect(small.text).toMatch(CUT)
  expect(small.text).toContain('第 0 段')
  expect(small.text).not.toContain('第 399 段')
  const full = await tool(client, 'get_page_text', { tabId: mainTab })
  expect(full.text).toContain('第 399 段') // 默认 8000 token 装得下
  expect(full.text).not.toMatch(CUT)
})

test('只连续单独调可批量工具时提醒 browser_batch；连续点击提醒 jev_task', async () => {
  await open('/btn')
  const one = await tool(client, 'browser_batch', { actions: [{ name: 'computer', input: { action: 'wait', duration: 0.1, tabId: mainTab } }] })
  expect(one.text).not.toContain('system-reminder')
  const a = await tool(client, 'computer', { action: 'wait', duration: 0.1, tabId: mainTab })
  const b = await tool(client, 'computer', { action: 'wait', duration: 0.1, tabId: mainTab })
  expect(a.text).not.toContain('system-reminder')
  expect(b.text).toContain('system-reminder')
  expect(b.text).toContain('browser_batch')
  const tree = await tool(client, 'read_page', { tabId: mainTab })
  const ref = tree.text.match(/\[(ref_\d+)\]/)![1]
  const outs: string[] = []
  for (let i = 0; i < 5; i++) outs.push((await tool(client, 'computer', { action: 'left_click', ref, tabId: mainTab })).text)
  expect(outs.join('\n')).toContain('quick_task')
})

test('设置页：存 profile 名、模型来源、key（只显示是否已设置）、点击方式；点击方式切到模拟事件后点击不再是可信事件', async () => {
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId()}/options.html`)
  await p.waitForSelector('body[data-ready]')
  expect(await p.textContent('#keyState')).toContain('not set')
  await p.fill('#profileName', '测试号')
  await p.selectOption('#provider', 'typesafe')
  await p.fill('#key', 'sk-secret-123456')
  await p.fill('#model', 'my-model')
  await p.selectOption('#clickMode', 'dom')
  await p.click('#save')
  await p.waitForFunction(() => document.getElementById('saved')!.textContent === 'Saved')
  await until(() => existsSync(configPath))
  const saved = JSON.parse(readFileSync(configPath, 'utf8'))
  expect(saved).toMatchObject({ provider: 'typesafe', providers: { typesafe: { apiKey: 'sk-secret-123456', model: 'my-model' } } })
  expect(statSync(configPath).mode & 0o777).toBe(0o600)
  expect(await p.inputValue('#key')).toBe('') // 不回显
  expect(await p.textContent('#keyState')).toContain('Key: set')
  // 重新打开：还是只显示已设置，页面上找不到 key
  await p.reload()
  await p.waitForSelector('body[data-ready]')
  expect(await p.textContent('#keyState')).toContain('Key: set')
  expect(await p.inputValue('#provider')).toBe('typesafe')
  expect(await p.inputValue('#profileName')).toBe('测试号')
  expect(await p.content()).not.toContain('sk-secret-123456')
  expect(await sw().evaluate(() => chrome.storage.local.get(['profileName', 'clickMode']))).toEqual({ profileName: '测试号', clickMode: 'dom' })

  // 点击方式 = dom：事件不是可信的
  await open('/btn')
  const tree = await tool(client, 'read_page', { tabId: mainTab })
  const ref = tree.text.match(/\[(ref_\d+)\]/)![1]
  const r = await tool(client, 'computer', { action: 'left_click', ref, tabId: mainTab })
  expect(r.err).toBe(false)
  await until(async () => (await sw().evaluate((t) => chrome.tabs.get(t), mainTab)).title === 'trusted=false')

  // 改回调试器：可信事件
  await p.selectOption('#clickMode', 'debugger')
  await p.click('#save')
  await p.waitForFunction(() => document.getElementById('saved')!.textContent === 'Saved')
  await p.close()
  await open('/btn')
  const ref2 = (await tool(client, 'read_page', { tabId: mainTab })).text.match(/\[(ref_\d+)\]/)![1]
  const r2 = await tool(client, 'computer', { action: 'left_click', ref: ref2, tabId: mainTab })
  expect(r2.err).toBe(false)
  await until(async () => (await sw().evaluate((t) => chrome.tabs.get(t), mainTab)).title === 'trusted=true')
}, 60000)

test('空闲 10 秒：插件后台没有新定时器、只有看门狗 alarm、没有 offscreen 页', async () => {
  // 近似「空闲后台接近 0」：数 10 秒内 service worker 新建的 setTimeout / setInterval
  await Bun.sleep(1500) // 让上一个测试的收尾（指示器、调试器）先落定
  await sw().evaluate(() => {
    const g = globalThis as any
    g.__timers = 0
    for (const k of ['setTimeout', 'setInterval']) {
      const orig = g[k]
      g[k] = (...a: any[]) => (g.__timers++, orig(...a))
    }
  })
  await Bun.sleep(10000) // 测试：空闲观察窗
  const timers = await sw().evaluate(() => (globalThis as any).__timers)
  const alarms = await sw().evaluate(() => chrome.alarms.getAll().then((a) => a.map((x) => x.name)))
  const offscreen = await sw().evaluate(() => (chrome.runtime as any).getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then((c: any[]) => c.length))
  expect(timers).toBe(0)
  expect(alarms).toEqual(['watchdog'])
  expect(offscreen).toBe(0)
}, 30000)
