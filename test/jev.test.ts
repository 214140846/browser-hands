const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { BrowserContext } from 'playwright'
import { launchBrowser, firstJson } from './launch'
import { writeHostManifest } from '../server/install'
import { costOf, loadSettings, makeProvider, saveSettings, settingsInfo } from '../server/jev'
import { formatFind, parseTree, rank } from '../server/jev-tools'

const root = resolve(import.meta.dir, '..')
mkdirSync(TEST_TMP, { recursive: true })
const work = mkdtempSync(TEST_TMP + '/jev-jev-')
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

const cfgPath = join(work, 'config.json')
process.env.JEV_CONFIG_PATH = cfgPath
for (const k of ['JEV_PROVIDER', 'JEV_MODEL', 'JEV_OPENROUTER_KEY', 'JEV_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'JEV_TYPESAFE_API_KEY', 'TYPESAFE_API_KEY']) delete process.env[k]
const fakePath = join(work, 'fake-jev.ts')
const logPath = join(work, 'fake-jev.log')
writeFileSync(
  fakePath,
  `import { appendFileSync } from 'node:fs'
export default (body: any) => {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(body) + '\\n')
  const q = body.questions
  if (q.claim) return { answers: { claim: { noul: body.state.page.text.includes('保存') ? 0.93 : 0.05 } } }
  const c = q.match.criteria
  const idx = Object.keys(c).find((k) => k !== 'none' && c[k].element.includes('保存'))
  return { answers: { match: { probabilities: { [idx!]: 0.8, '999': 0.15, ref_9999: 0.04, none: 0.01 }, confidence: 0.8 } } }
}`,
)
const fakeEnv = { ...env, JEV_FAKE_MODULE: fakePath }

const pages: Record<string, string> = {
  '/f': `<title>找元素</title><main><h1>标题</h1><button>保存</button><button>取消</button><a href="/x">链接</a><input placeholder="用户名"></main>`,
}

let ctx: BrowserContext
let site: ReturnType<typeof Bun.serve>
let client: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]
const tool = async (name: string, args: any = {}) => {
  const r: any = await client.callTool({ name, arguments: args })
  return { err: !!r.isError, text: r.content[0].text as string }
}
async function open(path: string) {
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${site.port}${path}`])
  await until(async () => (await sw().evaluate((t) => chrome.tabs.get(t), mainTab)).status === 'complete' && (await sw().evaluate((t) => chrome.tabs.get(t), mainTab)).url?.endsWith(path))
}

beforeAll(async () => {
  site = Bun.serve({ port: 0, fetch: (r) => new Response(pages[new URL(r.url).pathname] ?? 'x', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'jev', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env: fakeEnv }))
  const r: any = await client.callTool({ name: 'tabs_context_mcp', arguments: {} })
  mainTab = firstJson(r.content[0].text).availableTabs[0].tabId
  await open('/f')
}, 60000)

afterAll(async () => {
  await client?.close()
  await ctx?.close()
  site?.stop(true)
  rmSync(work, { recursive: true, force: true })
}, 30000)

test('find：丢掉编造的序号，只返回树里真实的 ref，格式照 Claude', async () => {
  const r = await tool('find', { query: '保存按钮', tabId: mainTab })
  expect(r.err).toBe(false)
  expect(r.text).toMatch(/^Found 1 matching element\n\n- ref_\d+: button "保存" - probability 0.8/)
  expect(r.text.split('[Tab context]')[0]).not.toContain('999')
  expect(r.text).not.toContain('ref_9999')
})

test('find：本地粗筛后才问 Jev，提问里带命中的行和 none', async () => {
  const last = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').pop()!)
  const c = last.questions.match.criteria
  expect(Object.values(c).some((v: any) => v.element?.includes('保存'))).toBe(true)
  expect(c.none).toBeDefined()
  expect(Object.keys(c).length).toBeLessThan(30)
})

test('jev_find：返回候选和概率，编造的被丢，none 保留', async () => {
  const r = await tool('quick_find', { description: '保存', tabId: mainTab })
  const j = firstJson(r.text)
  expect(j.choice.label).toBe('保存')
  expect(j.choice.p).toBe(0.8)
  expect(j.candidates.map((c: any) => c.ref ?? 'none').every((x: string) => x === 'none' || /^ref_\d+$/.test(x))).toBe(true)
  expect(j.candidates.length).toBe(2)
  expect(j.model).toBe('fake-jev')
})

test('jev_check：返回为真概率', async () => {
  const yes = firstJson((await tool('quick_check', { statement: '页面上有保存按钮', tabId: mainTab })).text)
  expect(yes.probability_true).toBe(0.93)
  expect(yes.title).toBe('找元素')
})

test('Jev 只返回编造的序号时 find 报无匹配（单元）', async () => {
  const rows = parseTree('button "保存" [ref_1]\nlink "链接" [ref_2] href="/x"')
  const jev = { text: async () => ({ text: null }), decide: async () => ({ answers: { match: { probabilities: { '77': 0.9, ref_5: 0.1 }, confidence: 0.9 } } }) }
  const r = await rank(jev, { description: '保存', rows, url: '', title: '' })
  expect(r.candidates).toEqual([])
  expect(formatFind(r.candidates, r.none)).toEqual({ ok: false, error: 'No matching elements found' })
})

// 临时目录里的 jev-mcp 格式配置，绝不碰真实配置文件；返回解析后的设置
const cfg = (provider: string, providers: Record<string, any>) => {
  writeFileSync(cfgPath, JSON.stringify({ provider, providers }), { mode: 0o600 })
  return loadSettings()
}

test('provider：429 重试后成功、计费累加；401 给出明确错误；没 key 报 no_key', async () => {
  let n = 0
  const fetchImpl = (async () => (++n === 1 ? new Response('busy', { status: 429 }) : new Response(JSON.stringify({ answers: {}, usage: { cost: 0.002 } })))) as any
  const p = makeProvider(cfg('openrouter', { openrouter: { apiKey: 'k' } }), { fetchImpl })
  const r = await p.decide({ state: {}, questions: {} })
  expect(n).toBe(2)
  expect(costOf(r)).toBe(0.002) // 每次调用自己带本次费用
  const bad = makeProvider(cfg('typesafe', { typesafe: { apiKey: 'k' } }), { fetchImpl: (async () => new Response('{}', { status: 401 })) as any })
  await expect(bad.decide({ state: {}, questions: {} })).rejects.toMatchObject({ info: { code: 'bad_key' } })
  const none = makeProvider(cfg('openrouter', {}))
  await expect(none.decide({ state: {}, questions: {} })).rejects.toMatchObject({ info: { code: 'no_key' } })
})

test('配置读取（jev-mcp 格式）：openrouter / typesafe 各读一次，端点、key、模型各取各的', async () => {
  const seen: any[] = []
  const fetchImpl = (async (url: string, init: any) => (seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }), new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 1000000 } })))) as any
  const or = makeProvider(cfg('openrouter', { openrouter: { apiKey: 'or-k' }, typesafe: { apiKey: 'ts-k' } }), { fetchImpl })
  await or.decide({ state: {}, questions: {} })
  expect(seen[0]).toMatchObject({ url: 'https://openrouter.ai/api/v1/systemone', auth: 'Bearer or-k', body: { model: 'typesafe/jev-1.13' } })
  const ts = makeProvider(cfg('typesafe', { openrouter: { apiKey: 'or-k' }, typesafe: { apiKey: 'ts-k', baseUrl: 'http://x.test/v1/', model: 'jev-9' } }), { fetchImpl })
  const r = await ts.decide({ state: {}, questions: {} })
  expect(seen[1]).toMatchObject({ url: 'http://x.test/v1/systemone', auth: 'Bearer ts-k', body: { model: 'jev-9' } })
  expect(costOf(r)).toBeCloseTo(0.042, 6) // typesafe 不回 cost：按输入 token 估
  process.env.JEV_TYPESAFE_API_KEY = 'env-k' // 环境变量覆盖配置文件里的 key
  expect(loadSettings().apiKey).toBe('env-k')
  delete process.env.JEV_TYPESAFE_API_KEY
})

test('text()：typesafe 打 /systemone 选择题（带 typesafe key），挑出候选里的值；无值返回 null；openrouter 走自己的 chat', async () => {
  const seen: any[] = []
  let pick = 'v1'
  const fetchImpl = (async (url: string, init: any) => {
    const body = JSON.parse(init.body)
    seen.push({ url, auth: init.headers.Authorization, body })
    if (url.endsWith('/systemone')) return new Response(JSON.stringify({ answers: { value: { choice: pick, probabilities: { [pick]: 0.9 }, confidence: 0.9 } }, usage: { input_tokens: 1000000 } }))
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"OR1"}' } }] }))
  }) as any
  const ts = makeProvider(cfg('typesafe', { openrouter: { apiKey: 'or-k' }, typesafe: { apiKey: 'ts-k', baseUrl: 'http://x.test/v1/', model: 'jev-9' } }), { fetchImpl })
  const ctx = { goal: 'Exchange an order', details: 'Order number: A-10086, email ann@example.com', field: { label: 'Order number' } }
  const r = await ts.text(ctx)
  expect(seen[0]).toMatchObject({ url: 'http://x.test/v1/systemone', auth: 'Bearer ts-k', body: { model: 'jev-9' } })
  expect(Object.values(seen[0].body.questions.value.criteria)).toContain('The value is exactly: A-10086')
  expect(r.text).toBe('A-10086') // v1 = 第二个候选；候选顺序：邮箱、引号串、「标签: 值」、带数字的串
  expect(costOf(r)).toBeCloseTo(0.042, 6)
  pick = 'none'
  expect((await ts.text(ctx)).text).toBeNull()
  expect((await ts.text({ goal: 'Open the page', field: {} })).text).toBeNull() // 目标里没有任何候选，不打接口
  expect(seen).toHaveLength(2)
  const or = makeProvider(cfg('openrouter', { openrouter: { apiKey: 'or-k' } }), { fetchImpl })
  expect((await or.text({})).text).toBe('OR1')
  expect(seen[2]).toMatchObject({ url: 'https://openrouter.ai/api/v1/chat/completions', auth: 'Bearer or-k' })
})

test('设置页保存：只改 provider / key / model，其他键原样保留，权限 0600', async () => {
  const other = { failover: true, confidence: { preset: 'cautious', act: 0.9 }, domains: { 'a.com': { irreversible: 'allow' } }, providers: { openrouter: { apiKey: 'keep-or', baseUrl: 'http://o.test/v1' }, typesafe: { baseUrl: 'http://t.test/v1', extra: 1 } } }
  writeFileSync(cfgPath, JSON.stringify({ provider: 'openrouter', ...other }), { mode: 0o644 })
  const info = saveSettings({ provider: 'typesafe', key: ' new-ts ', model: 'jev-x' })
  expect(info.provider).toBe('typesafe')
  expect(info.hasKey).toEqual({ openrouter: true, typesafe: true })
  const saved = JSON.parse(readFileSync(cfgPath, 'utf8'))
  expect(saved.providers.typesafe).toEqual({ baseUrl: 'http://t.test/v1', extra: 1, apiKey: 'new-ts', model: 'jev-x' })
  expect(saved.providers.openrouter).toEqual(other.providers.openrouter)
  expect({ failover: saved.failover, confidence: saved.confidence, domains: saved.domains }).toEqual({ failover: other.failover, confidence: other.confidence, domains: other.domains })
  expect(statSync(cfgPath).mode & 0o777).toBe(0o600)
  expect(JSON.stringify(settingsInfo())).not.toContain('new-ts')
  const bad = readFileSync(cfgPath, 'utf8')
  writeFileSync(cfgPath, '{坏的', { mode: 0o600 })
  expect(saveSettings({ key: 'x' }).error).toContain('is not valid JSON')
  expect(readFileSync(cfgPath, 'utf8')).toBe('{坏的') // 解析不了就不覆盖
  writeFileSync(cfgPath, bad, { mode: 0o600 })
})

test('find 阈值：按真 Jev 回归数据，none 偏高也能认出匹配，0.03 以下判无匹配', () => {
  const c = (p: number) => [{ ref: 'ref_5', role: 'button', label: 'Sign in', p }]
  expect(formatFind(c(0.26), 0.74).ok).toBe(true) // login / sign in：真匹配 0.26，none 0.74
  expect(formatFind(c(0.08), 0.92).ok).toBe(true) // zh / 登录：真匹配里最低的 0.08
  expect(formatFind(c(0.03), 0.97)).toEqual({ ok: false, error: 'No matching elements found' }) // 无匹配里最高的 0.03
})
