const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { BrowserContext } from 'playwright'
import { launchBrowser, firstJson } from './launch'
import { writeHostManifest } from '../server/install'

const root = resolve(import.meta.dir, '..')
mkdirSync(TEST_TMP, { recursive: true })
const work = mkdtempSync(TEST_TMP + '/jev-gif-')
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
  '/rec': `<title>录制</title><body style="margin:0;background:#eef">
    <div id="t" style="position:absolute;left:300px;top:200px;width:120px;height:50px;background:#c00" onclick="this.dataset.c='1'">点我</div>
    <div id="drop" style="position:absolute;left:600px;top:300px;width:200px;height:100px;background:#0a0">drop</div>
    <script>document.getElementById('drop').addEventListener('drop',e=>{e.preventDefault();const f=e.dataTransfer.files[0];document.title='dropped:'+f.name+':'+f.type+':'+f.size})
    document.getElementById('drop').addEventListener('dragover',e=>e.preventDefault())</script></body>`,
  '/two': '<title>第二页</title><body style="margin:0">two</body>',
}

let ctx: BrowserContext
let site: ReturnType<typeof Bun.serve>
let client: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]

const tool = async (name: string, args: any) => {
  const r: any = await client.callTool({ name, arguments: { tabId: mainTab, ...args } })
  return { err: !!r.isError, text: r.content[0].text as string, image: r.content.find((c: any) => c.type === 'image') as { data: string } | undefined }
}
const sizeOf = (b64: string) => {
  const b = Buffer.from(b64, 'base64')
  for (let i = 2; i < b.length; ) {
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]
    i += 2 + b.readUInt16BE(i + 2)
  }
  throw new Error('不是 JPEG')
}
const gif = (action: string, extra: any = {}) => tool('gif_creator', { action, ...extra })
async function open(path: string) {
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string, active: true }), [mainTab, `http://localhost:${site.port}${path}`])
  await until(async () => {
    const t = await sw().evaluate((t) => chrome.tabs.get(t), mainTab)
    return t.status === 'complete' && t.url?.endsWith(path)
  })
}
const page = () => ctx.pages().find((p) => p.url().startsWith(`http://localhost:${site.port}`))!

// 解析 GIF：尺寸、每帧延迟（1/100 秒）
function parseGif(b: Buffer) {
  expect(b.subarray(0, 6).toString()).toBe('GIF89a')
  const width = b.readUInt16LE(6)
  const height = b.readUInt16LE(8)
  let i = 13
  if (b[10] & 0x80) i += 3 * (1 << ((b[10] & 7) + 1))
  const delays: number[] = []
  const skip = () => {
    for (;;) {
      const n = b[i++]
      if (!n) return
      i += n
    }
  }
  while (i < b.length && b[i] !== 0x3b) {
    if (b[i] === 0x21) {
      if (b[i + 1] === 0xf9) delays.push(b.readUInt16LE(i + 4))
      i += 2
      skip()
    } else if (b[i] === 0x2c) {
      const flags = b[i + 9]
      i += 10
      if (flags & 0x80) i += 3 * (1 << ((flags & 7) + 1))
      i++ // LZW 最小码长
      skip()
    } else throw new Error(`GIF 解析出错 @${i}`)
  }
  return { width, height, delays }
}

beforeAll(async () => {
  site = Bun.serve({ port: 0, fetch: (r) => new Response(pages[new URL(r.url).pathname] ?? 'x', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'gif', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env }))
  const r: any = await client.callTool({ name: 'tabs_context_mcp', arguments: {} })
  mainTab = firstJson(r.content[0].text).availableTabs[0].tabId
}, 60000)

afterAll(async () => {
  await client?.close()
  await ctx?.close()
  rmSync(work, { recursive: true, force: true })
})

test('录 3 个动作（截图、点击、按键）→ 下载 GIF：帧数、尺寸、帧时长都对', async () => {
  await open('/rec')
  // 窗口刚开时视口还在调整，先等截图尺寸稳定
  let prev = ''
  await until(async () => {
    const sz = sizeOf((await tool('computer', { action: 'screenshot' })).image!.data).join('x')
    const same = sz === prev
    prev = sz
    return same
  })
  expect((await gif('start_recording')).err).toBe(false)
  const shot = await tool('computer', { action: 'screenshot' })
  const [fw, fh] = sizeOf(shot.image!.data) // 截图实际出图尺寸，GIF 尺寸应与之相同
  await tool('computer', { action: 'left_click', coordinate: [360, 225] })
  await tool('computer', { action: 'key', text: 'a' })
  expect((await gif('stop_recording')).text).toMatch(/\b4\b/) // 截图 1 + 点击 2（复制上一帧 + 动作后）+ 按键 1

  const r = await gif('export', { download: true, filename: 'jev-test.gif' })
  expect(r.err).toBe(false)
  expect(r.text).toMatch(/\b4\b/)
  // 输出里带落盘路径（Playwright 会把下载改存成 GUID 文件名）：取文中实际存在的绝对路径
  const path = (r.text.match(/\/[^\s"'`,;]+/g) ?? []).map((x: string) => x.replace(/[.)\]]+$/, '')).find((x: string) => existsSync(x))!
  expect(path).toBeTruthy()
  const g = parseGif(readFileSync(path))
  expect(g.delays.length).toBe(4)
  expect([g.width, g.height]).toEqual([fw, fh])
  expect(r.text).toContain(`${fw}x${fh}`)
  // 截图 800 / 点击 1500 ×2 / 按键 800（单位 1/100 秒）；末帧额外停留由合成页自定，只要求不短于本帧
  expect(g.delays.slice(0, 3)).toEqual([80, 150, 150])
  expect(g.delays[3]).toBeGreaterThanOrEqual(80)

  // 导出后帧已清空，offscreen 页已关
  const empty = await gif('export', { download: true })
  expect(empty.err).toBe(true)
  expect(empty.text).toContain('invalid_params')
  const docs = await sw().evaluate(() => (chrome as any).runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))
  expect(docs.length).toBe(0)
}, 60000)

test('导航帧 + 拖放导出到页面元素', async () => {
  await open('/rec')
  await gif('start_recording')
  await tool('computer', { action: 'screenshot' })
  const nav = await tool('navigate', { url: `http://localhost:${site.port}/two` })
  expect(nav.err).toBe(false)
  await gif('stop_recording')
  await open('/rec')
  const shot = await tool('computer', { action: 'screenshot' }) // 拿坐标上下文
  expect(shot.err).toBe(false)
  const r = await gif('export', { coordinate: [700, 350], filename: 'drop.gif', options: { showProgressBar: false } })
  expect(r.err).toBe(false)
  expect(r.text).toMatch(/\b2\b/)
  expect(r.text).toContain('drop.gif')
  await until(async () => (await page().title()).startsWith('dropped:drop.gif:image/gif:'))
}, 60000)

test('clear 丢弃帧；没录制时的提示；没坐标也没 download 报错', async () => {
  await open('/rec')
  expect((await gif('stop_recording')).err).toBe(false) // 没在录：不报错，文案自定
  await gif('start_recording')
  await tool('computer', { action: 'screenshot' })
  const noTarget = await gif('export')
  expect(noTarget.err).toBe(true)
  expect(noTarget.text).toContain('invalid_params')
  const cleared = await gif('clear')
  expect(cleared.err).toBe(false)
  expect(cleared.text).toMatch(/\b1\b/) // 丢掉 1 帧
  const again = await gif('clear')
  expect(again.err).toBe(false) // 已清空，第二次不报错
  expect((await gif('export', { download: true })).err).toBe(true) // 确实没帧了
})

test('帧最多 50 张，超了丢最早的', async () => {
  await open('/rec')
  await gif('start_recording')
  for (let i = 0; i < 53; i++) await tool('computer', { action: 'key', text: 'a' })
  expect((await gif('stop_recording')).text).toMatch(/\b50\b/)
  await gif('clear')
}, 120000)
