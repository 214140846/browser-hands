const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { BrowserContext } from 'playwright'
import { launchBrowser, firstJson } from './launch'
import { writeHostManifest } from '../server/install'

const root = resolve(import.meta.dir, '..')
mkdirSync(TEST_TMP, { recursive: true })
const work = mkdtempSync(TEST_TMP + '/jev-task-bg-')
const userDataDir = join(work, 'profile')
const socketDir = join(work, 'sockets')
const configPath = join(work, 'config.json')
// 清掉本机可能有的 Jev 配置，余额用例自己写 config
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

// 假 Jev：按页面网址决定怎么答；概率表必须正好覆盖提供的选项、和为 1、选中的最大（循环会校验）
const fakePath = join(work, 'fake-jev.ts')
const logPath = join(work, 'fake-jev.log')
writeFileSync(
  fakePath,
  `import { appendFileSync } from 'node:fs'
const pick = (c: any, key: string) => {
  const keys = Object.keys(c)
  const p: any = {}
  for (const k of keys) p[k] = keys.length === 1 ? 1 : k === key ? 0.9 : 0.1 / (keys.length - 1)
  return { choice: key, probabilities: p, confidence: 0.9 }
}
const find = (c: any, word: string) => Object.keys(c).find((k) => String(c[k].element ?? c[k]).includes(word))
export default async (body: any) => {
  const q = body.questions
  const page = body.state.page
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ url: page.url }) + '\\n')
  if (q.claim) return { answers: { claim: { noul: 0.9 } }, usage: { cost: 0.003 } }
  if (q.match) {
    await Bun.sleep(300)
    const idx = find(q.match.criteria, '保存')!
    return { answers: { match: { probabilities: { [idx]: 0.9, none: 0.1 }, confidence: 0.9 } }, usage: { cost: 0.001 } }
  }
  const ans: any = { goal_done: { noul: 0.1 } }
  const op = (name: string) => (ans.operation = pick(q.operation.criteria, name))
  const tgt = (opName: string, word: string) => {
    const k = opName.toLowerCase() + '_target'
    ans[k] = pick(q[k].criteria, find(q[k].criteria, word)!)
  }
  const done = () => {
    op('DONE')
    ans.goal_done = { noul: 0.95 }
  }
  let cost = 0.01
  const url: string = page.url
  const text: string = page.text
  if (url.endsWith('/task-save')) {
    if (text.includes('已保存')) done()
    else (op('CLICK'), tgt('CLICK', '保存'))
  } else if (url.endsWith('/task-buy')) {
    if (text.includes('订单已提交')) done()
    else (op('CLICK'), tgt('CLICK', '立即购买'))
  } else if (url.endsWith('/task-form')) {
    op('TYPE_TEXT')
    tgt('TYPE_TEXT', 'Email')
  } else if (url.endsWith('/task-budget')) {
    cost = 0.06
    op('CLICK')
    tgt('CLICK', '加一')
  } else if (url.endsWith('/task-slow')) {
    await Bun.sleep(20000)
    done()
  }
  return { answers: ans, usage: { cost } }
}
export const text = async () => ({ text: null, usage: { cost: 0.002 } })`,
)
const fakeEnv = { ...env, JEV_FAKE_MODULE: fakePath }

const pages: Record<string, string> = {
  '/f': `<title>找元素</title><main><h1>标题</h1><button>保存</button><button>取消</button></main>`,
  '/task-save': `<title>保存页</title><main><button onclick="document.getElementById('s').textContent='已保存'">保存</button><button>取消</button><p id="s">未保存</p></main>`,
  '/task-buy': `<title>购物车</title><main><button onclick="document.getElementById('s').textContent='订单已提交'">立即购买</button><p id="s">购物车</p></main>`,
  '/task-form': `<title>表单</title><main><input placeholder="Email"><button>下一步</button></main>`,
  '/task-budget': `<title>计数</title><main><button onclick="this.dataset.n=(+this.dataset.n||0)+1;document.getElementById('c').textContent='次数'+this.dataset.n">加一</button><p id="c">次数0</p></main>`,
  '/task-slow': `<title>慢</title><main><button>保存</button></main>`,
  // 每个字符触发的 input 事件里空转 3 毫秒，让长文本打字有足够长的窗口给 Stop
  '/type': `<title>打字</title><input id="i" oninput="const t=performance.now();while(performance.now()-t<3);">`,
}

let ctx: BrowserContext
let site: ReturnType<typeof Bun.serve>
let bank: ReturnType<typeof Bun.serve>
let client: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]
const tool = async (name: string, args: any = {}) => {
  const r: any = await client.callTool({ name, arguments: args })
  return { err: !!r.isError, text: r.content[0].text as string }
}
const json = (t: string) => firstJson(t)
async function open(path: string) {
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${site.port}${path}`])
  await until(async () => {
    const t = await sw().evaluate((t) => chrome.tabs.get(t), mainTab)
    return t.status === 'complete' && t.url?.endsWith(path)
  })
}
const page = () => ctx.pages().find((p) => p.url().startsWith(`http://localhost:${site.port}`))!
const indicator = (op: 'state' | 'stopCenter') =>
  sw().evaluate(
    ([t, o]) => chrome.scripting.executeScript({ target: { tabId: t as number }, func: (o) => (window as any).__jevIndicator?.[o as string]() ?? null, args: [o] }).then((r) => r[0]?.result),
    [mainTab, op] as const,
  )
const decideCalls = (suffix: string) => readFileSync(logPath, 'utf8').trim().split('\n').filter((l) => l && JSON.parse(l).url.endsWith(suffix)).length

beforeAll(async () => {
  site = Bun.serve({ port: 0, fetch: (r) => new Response(pages[new URL(r.url).pathname] ?? 'x', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  bank = Bun.serve({ port: 0, fetch: () => Response.json({ balance_usd: 1.2345 }) })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'task', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env: fakeEnv }))
  const r: any = await client.callTool({ name: 'tabs_context_mcp', arguments: {} })
  mainTab = firstJson(r.content[0].text).availableTabs[0].tabId
}, 60000)

afterAll(async () => {
  await client?.close()
  await ctx?.close()
  site?.stop(true)
  bank?.stop(true)
  rmSync(work, { recursive: true, force: true })
}, 30000)

test('后台跑：立刻返回 taskId，jev_status 查进度，结束后 jev_result 取到结果', async () => {
  await open('/task-save')
  const t0 = Date.now()
  const r = await tool('quick_task', { goal: '点保存', tabId: mainTab, background: true })
  const started = json(r.text)
  expect(r.err).toBe(false)
  expect(started.status).toBe('running')
  expect(started.taskId).toBeTruthy()
  const st = await until(async () => {
    const s = json((await tool('quick_task_status', { taskId: started.taskId })).text)
    return s.running ? false : s
  })
  expect(st.status).toBe('done')
  expect(st.steps).toBe(1)
  const res = json((await tool('quick_task_result', { taskId: started.taskId })).text)
  expect(res.status).toBe('done')
  expect(res.steps.length).toBe(1)
  expect(Date.now() - t0).toBeLessThan(20000)
  expect((await tool('quick_task_status', { taskId: 'nope' })).err).toBe(true)
}, 60000)

test('一个标签只跑一个任务：抢占报 tab_busy；jev_stop 中途停掉后标签空出来', async () => {
  await open('/task-slow')
  const t0 = Date.now()
  const started = json((await tool('quick_task', { goal: '点保存', tabId: mainTab, background: true })).text)
  await until(async () => decideCalls('/task-slow') >= 1)
  expect(json((await tool('quick_task_status', { taskId: started.taskId })).text).status).toBe('running')
  expect(json((await tool('quick_task_result', { taskId: started.taskId })).text).status).toBe('running')
  const busy = await tool('quick_task', { goal: '点保存', tabId: mainTab })
  expect(busy.err).toBe(true)
  expect(busy.text).toContain('tab_busy')
  const stopped = json((await tool('quick_task_stop', { taskId: started.taskId })).text)
  expect(stopped.status).toBe('stopped')
  expect(json((await tool('quick_task_result', { taskId: started.taskId })).text).status).toBe('stopped')
  expect(Date.now() - t0).toBeLessThan(15000)
  await open('/task-save')
  const again = await tool('quick_task', { goal: '点保存', tabId: mainTab })
  expect(json(again.text).status).toBe('done')
}, 60000)

test('页面 Stop 停掉该标签上的后台任务', async () => {
  await open('/task-slow')
  const started = json((await tool('quick_task', { goal: '点保存', tabId: mainTab, background: true })).text)
  await until(async () => ((await indicator('state')) as any)?.stop)
  const [x, y] = (await indicator('stopCenter')) as number[]
  await page().mouse.click(x, y)
  const st = await until(async () => {
    const s = json((await tool('quick_task_status', { taskId: started.taskId })).text)
    return s.running ? false : s
  })
  expect(st.status).toBe('stopped')
}, 60000)
