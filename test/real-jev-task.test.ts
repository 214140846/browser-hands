const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
// 真 Jev 跑 jev_task（花钱）：默认跳过，JEV_REAL=1 才跑。把闸门关掉（act=0、escalate=0，每步都执行），
// 记录每一步选择题的概率分布和「选得对不对」，用来定 act / escalate 默认值。累计费用到 $0.9 立刻停（总上限 $1）。
// key 只由 real-jev-wrap.ts 里的 loadSettings() 取，不打印、不落盘。
//   JEV_REAL=1 bun test test/real-jev-task.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { BrowserContext } from 'playwright'
import { launchBrowser, firstJson } from './launch'
import { writeHostManifest } from '../server/install'
import { fixtureOf, fixtures } from './real-jev-fixtures'

const real = process.env.JEV_REAL === '1'
const LIMIT = 0.9
const root = resolve(import.meta.dir, '..')
mkdirSync(TEST_TMP, { recursive: true })
const work = mkdtempSync(TEST_TMP + '/jev-real-task-')
const userDataDir = join(work, 'profile')
const socketDir = join(work, 'sockets')
const tracePath = process.env.JEV_TRACE_OUT || join(TEST_TMP, `jev-real-task-trace-${Date.now()}.jsonl`)
// 不设 JEV_CONFIG_PATH：真 Jev 读本机真实配置（只读）
const env = { ...process.env, JEV_SOCKET_DIR: socketDir } as Record<string, string>
const mcpEnv = { ...env, JEV_FAKE_MODULE: join(root, 'test/real-jev-wrap.ts'), JEV_TRACE_PATH: tracePath, JEV_TASK_ACT: '0', JEV_TASK_ESCALATE: '0' }

let ctx: BrowserContext
let site: ReturnType<typeof Bun.serve>
let client: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 20000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('等待超时')
    await Bun.sleep(100) // 仅测试里轮询
  }
}
async function open(path: string) {
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${site.port}${path}`])
  await until(async () => {
    const t = await sw().evaluate((t) => chrome.tabs.get(t), mainTab)
    return t.status === 'complete' && t.url?.endsWith(path)
  })
}
const readTrace = () => (existsSync(tracePath) ? readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

beforeAll(async () => {
  if (!real) return
  site = Bun.serve({
    port: 0,
    fetch: (r) => {
      const u = new URL(r.url)
      const f = fixtureOf(u.pathname)
      const body = f ? (u.pathname.endsWith('-detail') ? `<title>详情</title><main><h1>${u.searchParams.get('r')} details</h1><p>You opened the ${u.searchParams.get('r')} page.</p></main>` : f.html(u)) : 'x'
      return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => existsSync(socketDir) && readdirSync(socketDir).some((f) => f.endsWith('.sock')))
  client = new Client({ name: 'real-task', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env: mcpEnv }))
  const r: any = await client.callTool({ name: 'tabs_context_mcp', arguments: {} })
  mainTab = firstJson(r.content[0].text).availableTabs[0].tabId
}, 60000)

afterAll(async () => {
  await client?.close()
  await ctx?.close()
  site?.stop(true)
  rmSync(work, { recursive: true, force: true })
}, 30000)

test.skipIf(!real)('真 Jev：jev_task 每步概率分布（闸门关掉，每步都执行）', async () => {
  const summary: any[] = []
  const reps = Number(process.env.JEV_REPS ?? 1)
  for (let rep = 1; rep <= reps; rep++)
    for (const f of fixtures) {
      if (process.env.JEV_ONLY && f.key !== process.env.JEV_ONLY) continue
      const spent = readTrace().at(-1)?.spent ?? 0
      if (spent >= LIMIT) break
      await open(f.start)
      const r: any = await client.callTool({ name: 'quick_task', arguments: { goal: f.goal, ...(f.details ? { details: f.details } : {}), tabId: mainTab } })
      const j = firstJson(r.content[0].text)
      const vals = f.key === 'exchange' ? await ctx.pages().find((pg) => pg.url().endsWith(f.start))?.evaluate(() => [...document.querySelectorAll('input')].map((i) => (i as HTMLInputElement).value)) : undefined
      summary.push({ rep, fixture: f.key, status: j.status, steps: j.steps?.length, cost: j.cost_usd, ...(vals ? { values: vals.join(' | ') } : {}) })
    }
  console.table(summary)
  const rows = readTrace()
  console.table(rows.map((r, i) => ({ n: i + 1, fixture: r.fixture, op: r.op, target: r.target, op_conf: r.op_conf, target_conf: r.target_conf, top: r.top, second: r.second, none: +r.none.toFixed(3), ok: r.ok })))
  const conf = (r: any) => Math.min(r.op_conf, r.target_conf ?? 1)
  const good = rows.filter((r) => r.ok).map(conf).sort((a, b) => a - b)
  const bad = rows.filter((r) => !r.ok).map(conf).sort((a, b) => a - b)
  console.log('对的步把握', JSON.stringify(good))
  console.log('错的步把握', JSON.stringify(bad))
  console.log(`trace: ${tracePath}，花费 $${(rows.at(-1)?.spent ?? 0).toFixed(4)}`)
  expect(rows.at(-1)?.spent ?? 0).toBeLessThan(1)
}, 900000)
