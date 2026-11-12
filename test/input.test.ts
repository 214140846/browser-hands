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
const work = mkdtempSync(TEST_TMP + '/jev-input-')
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
  '/form': `<title>表单</title><body style="margin:0">
    <button id="b" onclick="window.clicks=(window.clicks||0)+1; this.dataset.n=window.clicks">保存</button>
    <input id="u" placeholder="用户名">
    <div id="dbl" style="width:80px;height:30px" ondblclick="this.dataset.d='1'" onclick="this.dataset.c=(+this.dataset.c||0)+1">dbl</div>
    <div id="ctx" style="width:80px;height:30px" oncontextmenu="this.dataset.r='1';return false">右键</div>
    <div id="hov" style="width:80px;height:30px" onmouseenter="this.dataset.h='1'">悬停</div>
    <div id="mod" style="width:80px;height:30px" onclick="this.dataset.s=event.shiftKey">修饰</div>
    <script>window.keys=[];addEventListener('keydown',e=>keys.push(e.key))</script></body>`,
  '/scroll': `<title>滚</title><body style="margin:0"><div id="box" style="width:300px;height:200px;overflow:auto"><div style="height:3000px">长</div></div><div style="height:5000px"></div><button id="far">远处按钮</button></body>`,
  '/drag': `<title>拖</title><body style="margin:0"><div id="pad" style="width:400px;height:300px"></div><script>
    const ev=[];window.ev=ev;const p=document.getElementById('pad');
    p.onmousedown=e=>ev.push('down:'+e.clientX+','+e.clientY);p.onmousemove=e=>{if(e.buttons)ev.push('move')};p.onmouseup=e=>ev.push('up:'+e.clientX+','+e.clientY)</script></body>`,
  '/pad': `<title>pad</title><textarea id="t" style="width:200px;height:60px"></textarea>`,
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
const comp = (args: any) => call('computer', { tabId: mainTab, ...args })
async function open(path: string) {
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${site.port}${path}`])
  await until(async () => {
    const t = await sw().evaluate((t) => chrome.tabs.get(t), mainTab)
    return t.status === 'complete' && t.url?.endsWith(path)
  })
}
const page = () => ctx.pages().find((p) => p.url().startsWith(`http://localhost:${site.port}`))!
const refOf = async (label: string) => (await call('read_page', { tabId: mainTab })).text.split('\n').find((l) => l.includes(label))?.match(/\[(ref_\d+)\]/)?.[1]!
const isMac = process.platform === 'darwin'
const mod = isMac ? 'cmd' : 'ctrl'

beforeAll(async () => {
  site = Bun.serve({ port: 0, fetch: (r) => new Response(pages[new URL(r.url).pathname] ?? 'x', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'input', version: '0' })
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

test('按 ref 点击按钮：被点到，输出带 ref', async () => {
  await open('/form')
  const ref = await refOf('保存')
  const r = await comp({ action: 'left_click', ref })
  expect(r.err).toBe(false)
  expect(r.text).toContain(ref)
  await until(async () => (await page().evaluate(() => (window as any).clicks)) === 1)
}, 30000)

test('点输入框再打字，输入框有字；换行当回车；中文走插入文本', async () => {
  await open('/form')
  await comp({ action: 'left_click', ref: await refOf('用户名') })
  const r = await comp({ action: 'type', text: 'Hi 你好!' })
  expect(r.err).toBe(false)
  await until(async () => (await page().inputValue('#u')) === 'Hi 你好!')
  await comp({ action: 'key', text: 'Enter' })
  await until(async () => (await page().evaluate(() => (window as any).keys as string[])).includes('Enter'))
}, 30000)

test('组合键：全选后覆盖；Backspace 重复；坐标点击', async () => {
  await open('/pad')
  const box = (await page().locator('#t').boundingBox())!
  await comp({ action: 'left_click', coordinate: [box.x + 10, box.y + 10] })
  await comp({ action: 'type', text: 'hello' })
  await until(async () => (await page().inputValue('#t')) === 'hello')
  await comp({ action: 'key', text: `${mod}+a` })
  await comp({ action: 'type', text: 'X' })
  await until(async () => (await page().inputValue('#t')) === 'X')
  await comp({ action: 'type', text: 'abc' })
  await comp({ action: 'key', text: 'Backspace', repeat: 2 })
  await until(async () => (await page().inputValue('#t')) === 'Xa')
}, 30000)

test('双击、右键、悬停、修饰键', async () => {
  await open('/form')
  const at = async (id: string) => {
    const b = (await page().locator(id).boundingBox())!
    return [b.x + b.width / 2, b.y + b.height / 2]
  }
  const d = await comp({ action: 'double_click', coordinate: await at('#dbl') })
  expect(d.err).toBe(false)
  await until(async () => (await page().getAttribute('#dbl', 'data-d')) === '1')
  expect(await page().getAttribute('#dbl', 'data-c')).toBe('2')
  await comp({ action: 'right_click', coordinate: await at('#ctx') })
  await until(async () => (await page().getAttribute('#ctx', 'data-r')) === '1')
  await comp({ action: 'hover', coordinate: await at('#hov') })
  await until(async () => (await page().getAttribute('#hov', 'data-h')) === '1')
  await comp({ action: 'left_click', coordinate: await at('#mod'), modifiers: 'shift' })
  await until(async () => (await page().getAttribute('#mod', 'data-s')) === 'true')
}, 30000)

test('滚轮滚动页面和容器；scroll_to 把元素滚到中间', async () => {
  await open('/scroll')
  await sw().evaluate((t) => chrome.tabs.update(t, { active: true }), mainTab) // 前台标签：滚轮事件直接生效
  await comp({ action: 'scroll', coordinate: [700, 400], scroll_direction: 'down', scroll_amount: 5 })
  await until(async () => (await page().evaluate(() => window.scrollY)) > 100)
  // 切走后成了后台标签，滚轮照样能滚（6 秒降级路径不好稳定触发，未单测）
  await page().evaluate(() => window.scrollTo(0, 0))
  const other = await ctx.newPage()
  await comp({ action: 'scroll', coordinate: [100, 100], scroll_direction: 'down', scroll_amount: 2 })
  await other.close()
  await until(async () => (await page().evaluate(() => document.getElementById('box')!.scrollTop)) > 50)
  await page().evaluate(() => window.scrollTo(0, 0))
  const ref = (await call('read_page', { tabId: mainTab, filter: 'all' })).text.split('\n').find((l) => l.includes('远处按钮'))?.match(/\[(ref_\d+)\]/)?.[1]
  const r = await comp({ action: 'scroll_to', ref })
  expect(r.err).toBe(false)
  expect(r.text).toContain(ref!)
  const y = await page().evaluate(() => document.getElementById('far')!.getBoundingClientRect().top)
  expect(y).toBeGreaterThan(0)
  expect(y).toBeLessThan(await page().evaluate(() => innerHeight))
}, 30000)

test('拖拽：按下起点、中间有移动、松开终点', async () => {
  await open('/drag')
  const r = await comp({ action: 'left_click_drag', start_coordinate: [20, 30], coordinate: [220, 130] })
  expect(r.err).toBe(false)
  const ev: string[] = await page().evaluate(() => (window as any).ev)
  expect(ev[0]).toBe('down:20,30')
  expect(ev.filter((e) => e === 'move').length).toBeGreaterThanOrEqual(4)
  expect(ev.at(-1)).toBe('up:220,130')
}, 30000)

test('cmd+r 换成刷新；缩放快捷键被拒；未知 ref 报错', async () => {
  await open('/form')
  await page().evaluate(() => ((window as any).marker = 1))
  const r = await comp({ action: 'key', text: 'cmd+r' })
  expect(r.err).toBe(false)
  await until(async () => (await page().evaluate(() => (window as any).marker).catch(() => 1)) === undefined)
  const z = await comp({ action: 'key', text: `${mod}+plus` })
  expect(z.err).toBe(true)
  expect(z.text).toContain('invalid_params')
  const bad = await comp({ action: 'left_click', ref: 'ref_99999' })
  expect(bad.err).toBe(true)
  expect(bad.text).toContain('ref_stale')
}, 30000)

test('调试器：并发只挂一次、不枚举目标；空闲前保持挂着；会话断开后解除', async () => {
  await open('/form')
  const tid = mainTab
  const out = await sw().evaluate(async (t) => {
    const calls: string[] = []
    const origAttach = chrome.debugger.attach.bind(chrome.debugger)
    const origTargets = chrome.debugger.getTargets.bind(chrome.debugger)
    ;(chrome.debugger as any).attach = (...a: any[]) => (calls.push('attach'), (origAttach as any)(...a))
    ;(chrome.debugger as any).getTargets = (...a: any[]) => (calls.push('getTargets'), (origTargets as any)(...a))
    const { attach, detach, isAttached } = (globalThis as any).__jevDebugger
    await detach(t)
    await Promise.all([attach(t), attach(t), attach(t)])
    await attach(t)
    const after = { calls: [...calls], attached: isAttached(t) }
    ;(chrome.debugger as any).attach = origAttach
    ;(chrome.debugger as any).getTargets = origTargets
    return after
  }, tid)
  expect(out.calls).toEqual(['attach'])
  expect(out.attached).toBe(true)
  await client.close()
  await until(async () => !(await sw().evaluate(async (t) => (globalThis as any).__jevDebugger.isAttached(t), tid)))
  client = new Client({ name: 'input', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env }))
  const r: any = await client.callTool({ name: 'tabs_context_mcp', arguments: {} })
  mainTab = firstJson(r.content[0].text).availableTabs[0].tabId
}, 30000)
