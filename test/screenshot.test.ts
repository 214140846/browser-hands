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
const work = mkdtempSync(TEST_TMP + '/jev-shot-')
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
  '/hit': `<title>命中</title><body style="margin:0">
    <div id="t" style="position:absolute;left:600px;top:300px;width:80px;height:40px;background:#c00" onclick="this.dataset.c='1'">点我</div>
    <div id="edge" style="position:absolute;left:0;top:0;width:60px;height:60px;background:#06c" onclick="this.dataset.e='1'"></div></body>`,
}

let ctx: BrowserContext
let site: ReturnType<typeof Bun.serve>
let client: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]

const callRaw = async (args: any) => {
  const r: any = await client.callTool({ name: 'computer', arguments: { tabId: mainTab, ...args } })
  return { err: !!r.isError, text: r.content[0].text as string, image: r.content.find((c: any) => c.type === 'image') as { data: string; mimeType: string } | undefined }
}
async function open(path: string) {
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string, active: true }), [mainTab, `http://localhost:${site.port}${path}`])
  await until(async () => {
    const t = await sw().evaluate((t) => chrome.tabs.get(t), mainTab)
    return t.status === 'complete' && t.url?.endsWith(path)
  })
}
const page = () => ctx.pages().find((p) => p.url().startsWith(`http://localhost:${site.port}`))!
const sizeOf = (b64: string) => {
  const b = Buffer.from(b64, 'base64')
  if (b[0] === 0x89) return [b.readUInt32BE(16), b.readUInt32BE(20)]
  for (let i = 2; i < b.length; ) {
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]
    i += 2 + b.readUInt16BE(i + 2)
  }
  throw new Error('不是图片')
}
const frameOf = (t: string) => (t.match(/viewport (\d+)x(\d+)/) ?? t.match(/(\d+)x(\d+)/))!.slice(1).map(Number)

beforeAll(async () => {
  site = Bun.serve({ port: 0, fetch: (r) => new Response(pages[new URL(r.url).pathname] ?? 'x', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'shot', version: '0' })
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

test('截图尺寸符合 28px 块预算，带 imageId，真的是图片', async () => {
  await open('/hit')
  const r = await callRaw({ action: 'screenshot' })
  expect(r.err).toBe(false)
  expect(r.text).toMatch(/img_\w+|ID: \S+/)
  expect(r.image?.mimeType).toBe('image/jpeg')
  const [fw, fh] = frameOf(r.text)
  const [w, h] = sizeOf(r.image!.data)
  expect(Math.abs(w - fw)).toBeLessThanOrEqual(1)
  expect(Math.abs(h - fh)).toBeLessThanOrEqual(1)
  const blocks = (n: number) => Math.floor((n - 1) / 28) + 1
  expect(w).toBeLessThanOrEqual(1568)
  expect(h).toBeLessThanOrEqual(1568)
  expect(blocks(w) * blocks(h)).toBeLessThanOrEqual(1568)
}, 30000)

test('scale 只缩返回图，坐标仍按完整帧：用帧坐标点得中', async () => {
  await open('/hit')
  await callRaw({ action: 'screenshot' }) // 先让窗口尺寸稳定
  const half = await callRaw({ action: 'screenshot', scale: 0.5 })
  const [fw, fh] = frameOf(half.text)
  const [hw, hh] = sizeOf(half.image!.data)
  expect(Math.abs(hw - Math.round(fw * 0.5))).toBeLessThanOrEqual(1)
  expect(Math.abs(hh - Math.round(fh * 0.5))).toBeLessThanOrEqual(1)
  // 方块在视口 (640,320)，换成帧坐标点击
  const vp = await page().evaluate(() => [innerWidth, innerHeight])
  expect(Math.abs(fw / fh - vp[0] / vp[1])).toBeLessThan(0.02)
  const c = await callRaw({ action: 'left_click', coordinate: [(640 * fw) / vp[0], (320 * fh) / vp[1]] })
  expect(c.err).toBe(false)
  await until(async () => (await page().getAttribute('#t', 'data-c')) === '1')
}, 30000)

test('越界报错并提示重新截图（容差 2px 内放行）', async () => {
  await open('/hit')
  const s = await callRaw({ action: 'screenshot' })
  const [fw, fh] = frameOf(s.text)
  const bad = await callRaw({ action: 'left_click', coordinate: [fw + 10, 5] })
  expect(bad.err).toBe(true)
  expect(bad.text).toContain('coordinate_out_of_bounds')
  expect(bad.text).toContain('take a new screenshot')
  const neg = await callRaw({ action: 'left_click', coordinate: [-1, 5] })
  expect(neg.err).toBe(true)
  const ok = await callRaw({ action: 'left_click', coordinate: [fw + 1, fh + 1] })
  expect(ok.err).toBe(false)
}, 30000)

test('zoom 截区域：尺寸合理、越界报错', async () => {
  await open('/hit')
  const s = await callRaw({ action: 'screenshot' })
  const [fw, fh] = frameOf(s.text)
  const vp = await page().evaluate(() => [innerWidth, innerHeight])
  const region = [(590 * fw) / vp[0], (290 * fh) / vp[1], (700 * fw) / vp[0], (350 * fh) / vp[1]]
  const z = await callRaw({ action: 'zoom', region })
  expect(z.err).toBe(false)
  expect(z.image?.mimeType).toBe('image/png')
  const [w, h] = sizeOf(z.image!.data)
  expect(w).toBeGreaterThan(50)
  expect(Math.abs(w / h - 110 / 60)).toBeLessThan(0.1)
  const half = await callRaw({ action: 'zoom', region, scale: 0.5 })
  expect(sizeOf(half.image!.data)[0]).toBeLessThan(w)
  const bad = await callRaw({ action: 'zoom', region: [0, 0, fw * 3, fh * 3] })
  expect(bad.err).toBe(true)
  expect(bad.text).toContain('coordinate_out_of_bounds')
}, 30000)
