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
const work = mkdtempSync(TEST_TMP + '/jev-task-')
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
  bank = Bun.serve({ port: 0, fetch: () => Response.json({ data: { total_credits: 2, total_usage: 0.7655 } }) })
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

test('费用不串账：并行的 jev_find 和 jev_check 各报各的', async () => {
  await open('/f')
  // find 睡 300 毫秒、费用 0.001；check 立刻返回、费用 0.003。旧的「前后累计值相减」会把 find 算成 0.004
  const [f, c] = await Promise.all([tool('quick_find', { description: '保存', tabId: mainTab }), tool('quick_check', { statement: '页面上有保存按钮', tabId: mainTab })])
  expect(json(f.text).cost_usd).toBe(0.001)
  expect(json(c.text).cost_usd).toBe(0.003)
})

test('jev_task 正常完成：点保存 → 看到已保存 → 两人都同意才算 done，费用是各次调用之和', async () => {
  await open('/task-save')
  const r = await tool('quick_task', { goal: '点保存', tabId: mainTab })
  expect(r.err).toBe(false)
  const j = json(r.text)
  expect(j.status).toBe('done')
  expect(j.steps.length).toBe(1)
  expect(j.steps[0]).toMatchObject({ kind: 'click', action: '保存', page_changed: true })
  expect(j.decisions).toBe(2)
  expect(j.cost_usd).toBe(0.02)
  expect(j.final.text).toContain('已保存')
  expect(await page().textContent('#s')).toBe('已保存')
}, 40000)

test('jev_task 碰到购买按钮停下，不点；带 allowIrreversible 才继续', async () => {
  await open('/task-buy')
  const stop = json((await tool('quick_task', { goal: '买下它', tabId: mainTab })).text)
  expect(stop.status).toBe('needs_confirmation')
  expect(stop.pending.label).toBe('立即购买')
  expect(stop.note).toContain('allowIrreversible')
  expect(await page().textContent('#s')).toBe('购物车') // 没点
  const go = json((await tool('quick_task', { goal: '买下它', tabId: mainTab, allowIrreversible: true })).text)
  expect(go.status).toBe('done')
  expect(await page().textContent('#s')).toBe('订单已提交')
}, 40000)

test('jev_task stopBefore 点名的按钮：allowIrreversible 也不点', async () => {
  await open('/task-save')
  const r = json((await tool('quick_task', { goal: '点保存', tabId: mainTab, stopBefore: ['保存'], allowIrreversible: true })).text)
  expect(r.status).toBe('needs_confirmation')
  expect(r.pending.label).toBe('保存')
  expect(await page().textContent('#s')).not.toBe('已保存') // 没点
}, 40000)

test('jev_task 缺信息：小模型说没有值 → 跳过一次，Jev 坚持再选就 needs_input，输入框保持空', async () => {
  await open('/task-form')
  const j = json((await tool('quick_task', { goal: '填邮箱', tabId: mainTab })).text)
  expect(j.status).toBe('needs_input')
  expect(j.pending.label).toBe('Email')
  expect(j.text_calls.length).toBe(1)
  expect(await page().inputValue('input')).toBe('')
  expect(j.cost_usd).toBe(0.022) // 两次 decide 各 0.01 + 一次 text 0.002
}, 40000)

test('jev_task 预算：每次 0.06，两步后超过 0.1 停下', async () => {
  await open('/task-budget')
  const j = json((await tool('quick_task', { goal: '一直点', tabId: mainTab })).text)
  expect(j.status).toBe('budget')
  expect(j.note).toContain('$0.1')
  expect(j.steps.length).toBe(2)
  expect(j.cost_usd).toBe(0.12)
}, 40000)

test('长文本打字中途点 Stop：页面上的字少于全文，Stop 之后不再增加', async () => {
  await open('/type')
  await page().evaluate(() => document.getElementById('i')!.focus())
  const full = 'abcdefghij'.repeat(300)
  const running = tool('computer', { action: 'type', text: full, tabId: mainTab })
  const len = () => page().evaluate(() => (document.getElementById('i') as HTMLInputElement).value.length)
  await until(async () => (await len()) >= 5)
  await until(async () => ((await indicator('state')) as any)?.stop)
  const [x, y] = (await indicator('stopCenter')) as number[]
  await page().mouse.click(x, y) // 真实点击
  const r = await running
  expect(r.err).toBe(true)
  expect(r.text).toContain('stopped')
  await Bun.sleep(300) // 让已发出的最后一个字落地（仅测试里等）
  const after = await len()
  expect(after).toBeLessThan(full.length)
  expect(after).toBeGreaterThan(0)
  await Bun.sleep(1000) // 反向断言：再给它一个继续打字的机会
  expect(await len()).toBe(after)
}, 60000)

test('Stop 停 jev_task：Jev 正在想时点 Stop，立刻返回 stopped，之后不再发请求也不再动页面', async () => {
  await open('/task-slow')
  const t0 = Date.now()
  const running = tool('quick_task', { goal: '点保存', tabId: mainTab })
  await until(async () => decideCalls('/task-slow') >= 1) // 已经在等 Jev 的答复
  await until(async () => ((await indicator('state')) as any)?.stop) // 步与步之间指示器也在
  const [x, y] = (await indicator('stopCenter')) as number[]
  await page().mouse.click(x, y)
  const r = await running
  expect(r.err).toBe(false)
  const j = json(r.text)
  expect(j.status).toBe('stopped')
  expect(Date.now() - t0).toBeLessThan(15000) // 没等完 Jev 那 20 秒
  expect(j.steps.length).toBe(0)
  await Bun.sleep(500)
  expect(decideCalls('/task-slow')).toBe(1)
}, 60000)

test('状态小窗显示 Jev 余额：没配 key 显示未配置；配了读到就显示；不轮询', async () => {
  const extId = new URL(sw().url()).host
  const open1 = async () => {
    const popup = await ctx.newPage()
    await popup.goto(`chrome-extension://${extId}/popup.html`)
    await until(async () => !(await popup.textContent('#balance'))!.includes('查询中'))
    const t = (await popup.textContent('#balance'))!
    await popup.close()
    return t
  }
  expect(await open1()).toContain('not configured')
  writeFileSync(configPath, JSON.stringify({ provider: 'openrouter', providers: { openrouter: { apiKey: 'k', baseUrl: `http://localhost:${bank.port}/v1` } } }))
  chmodSync(configPath, 0o600)
  expect(await open1()).toContain('$1.2345')
}, 40000)
