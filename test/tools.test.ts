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
const work = mkdtempSync(TEST_TMP + '/jev-tools-')
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

const html = `<title>工具</title><body style="margin:0">
<button id="b" style="width:100px;height:40px">点</button>
<input id="f" type="file" multiple>
<div id="drop" style="width:200px;height:100px;background:#ccc">拖到这里</div>
<script>
window.got = []
document.getElementById('f').addEventListener('change', (e) => { window.got = [...e.target.files].map((f) => f.name + ':' + f.size + ':' + f.type) })
document.getElementById('drop').addEventListener('dragover', (e) => e.preventDefault())
document.getElementById('drop').addEventListener('drop', (e) => { e.preventDefault(); window.dropped = [...e.dataTransfer.files].map((f) => f.name + ':' + f.type) })
</script></body>`

let ctx: BrowserContext
let site: ReturnType<typeof Bun.serve>
let client: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]
const swEval = (expr: string) => sw().evaluate(`(async () => { ${expr} })()`)
const page = () => ctx.pages().find((p) => p.url().startsWith(`http://localhost:${site.port}`))!
const callRaw = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as any
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await callRaw(name, args)
  return { err: !!r.isError, text: r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') as string, content: r.content as any[] }
}
const refOf = async (...words: string[]) => {
  const r = await call('read_page', { tabId: mainTab, filter: 'all' })
  return r.text.split('\n').find((l) => words.every((w) => l.includes(w)))?.match(/\[(ref_\d+)\]/)?.[1]!
}
const b64 = (s: string) => Buffer.from(s).toString('base64')

beforeAll(async () => {
  site = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url)
      if (u.pathname === '/ping') return new Response('pong')
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'tools', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env }))
  const r = await call('tabs_context_mcp', {})
  mainTab = firstJson(r.text).availableTabs[0].tabId
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${site.port}/`])
  await until(async () => (await sw().evaluate((t) => chrome.tabs.get(t), mainTab)).status === 'complete' && page())
}, 60000)

afterAll(async () => {
  await client?.close()
  await ctx?.close()
  site?.stop(true)
  rmSync(work, { recursive: true, force: true })
}, 30000)

test('javascript_tool：表达式、return 重跑、脱敏、受保护页拒绝', async () => {
  expect((await call('javascript_tool', { tabId: mainTab, action: 'javascript_exec', text: '1 + 2' })).text).toContain('3\n')
  expect((await call('javascript_tool', { tabId: mainTab, action: 'javascript_exec', text: 'return 5 * 5' })).text).toContain('25')
  expect((await call('javascript_tool', { tabId: mainTab, action: 'javascript_exec', text: 'await Promise.resolve("awaited")' })).text).toContain('awaited')
  const secret = await call('javascript_tool', { tabId: mainTab, action: 'javascript_exec', text: '({ password: "hunter2", ok: 1, list: [1, 2] })' })
  expect(secret.text).not.toContain('hunter2')
  expect(secret.text).toContain('"ok": 1')
  expect((await call('javascript_tool', { tabId: mainTab, action: 'javascript_exec', text: '[10, 20]' })).text).toContain('20')
  const long = await call('javascript_tool', { tabId: mainTab, action: 'javascript_exec', text: '"x ".repeat(800)' })
  expect(long.text.split('\n\n')[0].length).toBeLessThan(1600) // 1600 字符的结果被截短（截断标记文案自定）
  const boom = await call('javascript_tool', { tabId: mainTab, action: 'javascript_exec', text: 'throw new Error("oops")' })
  expect(boom.err).toBe(true)
  expect(boom.text).toContain('oops')

  const before = firstJson((await call('tabs_context_mcp', {})).text).availableTabs.map((x: any) => x.tabId)
  const created = await call('tabs_create_mcp', {})
  const tab = String(firstJson(created.text).availableTabs.map((x: any) => x.tabId).find((id: number) => !before.includes(id)))
  expect(created.text).toContain(tab) // 文字里含新标签 id
  await sw().evaluate(([t]) => chrome.tabs.update(t as number, { url: 'chrome://version' }), [Number(tab)])
  await until(async () => ((await sw().evaluate((t) => chrome.tabs.get(t), Number(tab))).url ?? '').startsWith('chrome://'))
  const prot = await call('javascript_tool', { tabId: Number(tab), action: 'javascript_exec', text: '1' })
  expect(prot.err).toBe(true)
  expect(prot.text).toContain('chrome:// pages')
}, 60000)

test('resize_window：改窗口大小，超过 7680×4320 报错', async () => {
  const r = await call('resize_window', { tabId: mainTab, width: 900, height: 700 })
  expect(r.err).toBe(false)
  expect(r.text).toContain('900x700')
  const w = await sw().evaluate((t) => chrome.tabs.get(t).then((x) => chrome.windows.get(x.windowId)), mainTab)
  expect(w.width).toBe(900)
  const big = await call('resize_window', { tabId: mainTab, width: 8000, height: 100 })
  expect(big.err).toBe(true)
  expect(big.text).toContain('7680x4320')
})

test('browser_batch：顺序执行、图片交错、遇错即停、不能嵌套', async () => {
  const ok = await call('browser_batch', {
    actions: [
      { name: 'javascript_tool', input: { tabId: mainTab, action: 'javascript_exec', text: '1 + 1' } },
      { name: 'computer', input: { tabId: mainTab, action: 'screenshot' } },
      { name: 'javascript_tool', input: { tabId: mainTab, action: 'javascript_exec', text: '2 + 2' } },
    ],
  })
  expect(ok.err).toBe(false)
  const kinds = ok.content.map((c) => c.type)
  expect(kinds.indexOf('image')).toBeGreaterThan(0)
  expect(kinds.indexOf('image')).toBeLessThan(kinds.lastIndexOf('text'))
  expect(ok.text).toContain('2')
  expect(ok.text).toContain('4')
  expect(ok.text.split('"availableTabs"').length - 1).toBe(1) // 标签块只在批末附一次

  const stop = await call('browser_batch', {
    actions: [
      { name: 'javascript_tool', input: { tabId: mainTab, action: 'javascript_exec', text: 'throw new Error("halt")' } },
      { name: 'javascript_tool', input: { tabId: mainTab, action: 'javascript_exec', text: '"never"' } },
    ],
  })
  expect(stop.err).toBe(true)
  expect(stop.text).toContain('halt')
  expect(stop.text).toMatch(/\b1\b/) // 未执行条数
  expect(stop.text).not.toContain('never')

  const nested = await call('browser_batch', { actions: [{ name: 'browser_batch', input: { actions: [] } }] })
  expect(nested.err).toBe(true)
  expect(nested.text).toContain('batch_invalid_input')
})

test('browser_batch：批内截图的坐标上下文到批末才生效', async () => {
  const r = await swEval(`
    const s = globalThis.__jevShot
    const A = { viewportWidth: 1, viewportHeight: 1, screenshotWidth: 1, screenshotHeight: 1 }
    const B = { viewportWidth: 2, viewportHeight: 2, screenshotWidth: 2, screenshotHeight: 2 }
    s.setContext(999, A)
    s.beginBatch()
    s.setContext(999, B)
    const during = s.getContext(999).viewportWidth
    s.endBatch()
    return [during, s.getContext(999).viewportWidth]`)
  expect(r).toEqual([1, 2])
})

test('日志：第一次读才监听，按标签存，换网站清空，空闲自动关', async () => {
  const logs = (expr: string) => swEval(`const l = globalThis.__jevLogs; return ${expr}`)
  expect(await logs(`l.isListening(${mainTab})`)).toBe(false)
  const first = await call('read_console_messages', { tabId: mainTab, pattern: 'zzz-none' })
  expect(first.err).toBe(false)
  expect(first.text).toMatch(/\b(no|nothing)\b/i) // 空结果（文案不限）
  expect(await logs(`l.isListening(${mainTab})`)).toBe(true)

  await page().evaluate(async () => {
    console.log('hello-log', { a: 1 })
    console.error('bad-thing')
    await fetch('/ping?token=abc123secret')
  })
  await until(async () => (await logs(`l.counts(${mainTab}).network`)) >= 1)
  const all = await call('read_console_messages', { tabId: mainTab, pattern: 'hello-log|bad-thing' })
  expect(all.text).toMatch(/\bLOG\b/)
  expect(all.text).toContain('bad-thing')
  const errs = await call('read_console_messages', { tabId: mainTab, onlyErrors: true })
  expect(errs.text).toContain('bad-thing')
  expect(errs.text).not.toContain('hello-log')
  const net = await call('read_network_requests', { tabId: mainTab, urlPattern: '/ping' })
  expect(net.text).toContain('/ping')
  expect(net.text).toContain('GET')
  expect(net.text).toMatch(/\b200\b/)
  expect(net.text).not.toContain('abc123secret')

  const cleared = await call('read_console_messages', { tabId: mainTab, pattern: 'hello-log', clear: true })
  expect(cleared.text).toContain('hello-log')
  expect(cleared.text).toMatch(/\b1\b/)
  expect((await call('read_console_messages', { tabId: mainTab, pattern: 'hello-log' })).text).toMatch(/\b(no|nothing)\b/i) // 清空后为空

  // 换网站：清空
  await page().evaluate(() => console.log('before-nav'))
  await until(async () => (await logs(`l.counts(${mainTab}).console`)) >= 1)
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://127.0.0.1:${site.port}/`])
  await until(async () => (await logs(`l.counts(${mainTab}).console`)) === 0)
  expect((await logs(`l.counts(${mainTab}).network`)) <= 2).toBe(true)

  // 空闲自动关监听；再读重新打开
  await logs(`l.setIdleMs(300)`)
  await call('read_console_messages', { tabId: mainTab, pattern: 'zzz-none' })
  await until(async () => !(await logs(`l.isListening(${mainTab})`)), 5000)
  await logs(`l.setIdleMs(60000)`)
  await call('read_console_messages', { tabId: mainTab, pattern: 'zzz-none' })
  expect(await logs(`l.isListening(${mainTab})`)).toBe(true)
  await logs(`l.stop(${mainTab})`)

  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${site.port}/`])
  await until(async () => (await sw().evaluate((t) => chrome.tabs.get(t), mainTab)).status === 'complete' && page())
}, 60000)

test('file_upload：按编号塞进 file input；路径名、超 10MB、非 file input 报错', async () => {
  const ref = await refOf('button', 'file')
  expect(ref).toBeTruthy()
  const r = await call('file_upload', { tabId: mainTab, ref, files: [{ data: b64('hello'), name: 'a.txt', mimeType: 'text/plain' }, { data: b64('xy'), name: 'b.bin' }] })
  expect(r.err).toBe(false)
  expect(r.text).toMatch(/\b2\b/) // 文案自定，只要求带文件数
  expect(await page().evaluate(() => (window as any).got)).toEqual(['a.txt:5:text/plain', 'b.bin:2:application/octet-stream'])

  const dir = await call('file_upload', { tabId: mainTab, ref, files: [{ data: b64('x'), name: '../../etc/passwd' }] })
  expect(dir.err).toBe(false) // 目录部分被丢掉，只剩文件名
  expect(await page().evaluate(() => (window as any).got)).toEqual(['passwd:1:application/octet-stream'])
  const dots = await call('file_upload', { tabId: mainTab, ref, files: [{ data: b64('x'), name: '..' }] })
  expect(dots.err).toBe(true)

  // 超过单条消息上限（1MB）的文件：分段送进插件再拼起来
  const mid = Buffer.alloc(3_000_000, 'a').toString('base64')
  const chunked = await call('file_upload', { tabId: mainTab, ref, files: [{ data: mid, name: 'mid.bin' }] })
  expect(chunked.err).toBe(false)
  expect(await page().evaluate(() => (window as any).got)).toEqual(['mid.bin:3000000:application/octet-stream'])

  // 总大小上限 10MB（MCP 的 stdio 传不动 12MB 以上的单条消息，这里把插件侧上限临时改小来测拒绝逻辑）
  await swEval('globalThis.__jevUpload.upload = 100')
  const big = await call('file_upload', { tabId: mainTab, ref, files: [{ data: Buffer.alloc(200, 'a').toString('base64'), name: 'big.bin' }] })
  await swEval('globalThis.__jevUpload.upload = 10485760')
  expect(big.err).toBe(true)
  expect(big.text).toContain('10 MB')

  const btn = await refOf('button', '点')
  const notInput = await call('file_upload', { tabId: mainTab, ref: btn, files: [{ data: b64('x'), name: 'x.txt' }] })
  expect(notInput.err).toBe(true)
  expect(notInput.text).toContain('element_unsupported')
}, 60000)

test('upload_image：截图 ID 按编号塞 file input，按坐标拖放到目标', async () => {
  const shot = await call('computer', { tabId: mainTab, action: 'screenshot' })
  const id = (shot.text.match(/ID: (\S+)/)?.[1] ?? shot.text.match(/img_\w+/)![0])
  const ref = await refOf('button', 'file')
  const r = await call('upload_image', { tabId: mainTab, imageId: id, ref, filename: 'shot.jpg' })
  expect(r.err).toBe(false)
  expect((await page().evaluate(() => (window as any).got))[0]).toMatch(/^shot\.jpg:\d+:image\/jpeg$/)

  const box = (await page().locator('#drop').boundingBox())!
  const d = await call('upload_image', { tabId: mainTab, imageId: id, coordinate: [box.x + 20, box.y + 20] })
  expect(d.err).toBe(false)
  expect(await page().evaluate(() => (window as any).dropped)).toEqual(['image.jpg:image/jpeg'])

  const both = await call('upload_image', { tabId: mainTab, imageId: id, ref, coordinate: [1, 1] })
  expect(both.err).toBe(true)
  const missing = await call('upload_image', { tabId: mainTab, imageId: 'no_such_image_99999', ref })
  expect(missing.err).toBe(true)
  expect(missing.text).toContain('screenshot_bytes_unavailable')
}, 60000)
