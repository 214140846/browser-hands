const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { BrowserContext } from 'playwright'
import { launchBrowser, firstJson } from './launch'
import { writeHostManifest } from '../server/install'
import { gate, hadEffect, mergeLooks, rollbackPlan, stepConfidence, thresholds, trialable } from '../server/jev-confidence'

const root = resolve(import.meta.dir, '..')
mkdirSync(TEST_TMP, { recursive: true })
const work = mkdtempSync(TEST_TMP + '/jev-conf-')
const userDataDir = join(work, 'profile')
const socketDir = join(work, 'sockets')
const env = { ...process.env, JEV_SOCKET_DIR: socketDir, JEV_CONFIG_PATH: join(work, 'config.json'), JEV_PROVIDER: '', JEV_OPENROUTER_KEY: '', JEV_OPENROUTER_API_KEY: '', OPENROUTER_API_KEY: '', JEV_TYPESAFE_API_KEY: '', TYPESAFE_API_KEY: '' } as Record<string, string>
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

// 假 Jev：每个页面按脚本给出操作 / 目标的概率和把握；记录每次 decide 的网址
const fakePath = join(work, 'fake-jev.ts')
const logPath = join(work, 'fake-jev.log')
writeFileSync(
  fakePath,
  `import { appendFileSync } from 'node:fs'
const dist = (c: any, probs: Record<string, number>, confidence: number, pickKey: string) => {
  const keys = Object.keys(c)
  const p: any = {}
  let left = 1
  for (const [k, v] of Object.entries(probs)) { p[k] = v; left -= v }
  const rest = keys.filter((k) => !(k in p))
  for (const k of rest) p[k] = Math.max(left, 0) / rest.length
  if (!rest.length) p[pickKey] += left
  return { choice: pickKey, probabilities: p, confidence }
}
const find = (c: any, word: string) => Object.keys(c).find((k) => String(c[k].element ?? c[k]).includes(word))!
const calls: Record<string, number> = {}
export default async (body: any) => {
  const q = body.questions
  const url: string = body.state.page.url
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ url }) + '\\n')
  const n = (calls[url] = (calls[url] ?? 0) + 1)
  const ans: any = { goal_done: { noul: 0.1 } }
  const op = (name: string, conf: number) => (ans.operation = dist(q.operation.criteria, { [name]: conf }, conf, name))
  const tgt = (opName: string, words: string[], probs: number[], conf: number) => {
    const k = opName.toLowerCase() + '_target'
    const keys = words.map((w) => find(q[k].criteria, w))
    ans[k] = dist(q[k].criteria, Object.fromEntries(keys.map((key, i) => [key, probs[i]])), conf, keys[0])
  }
  const done = () => { op('DONE', 0.95); ans.goal_done = { noul: 0.95 } }
  if (url.endsWith('/conf-low')) {
    op('CLICK', 0.9)
    tgt('CLICK', ['保存'], [0.9], 0.3)
  } else if (url.endsWith('/conf-mid-no')) {
    op('CLICK', 0.9)
    tgt('CLICK', ['保存'], [0.9], 0.7)
  } else if (url.endsWith('/conf-mid-yes')) {
    if (String(body.state.page.text).includes('已保存')) done()
    else {
      op('CLICK', 0.9)
      tgt('CLICK', ['保存'], [0.9], n === 1 ? 0.7 : 0.95)
    }
  } else if (url.endsWith('/conf-trial')) {
    if (n >= 2) done()
    else {
      op('TYPE_TEXT', 0.9)
      tgt('TYPE_TEXT', ['Decoy', 'Email'], [0.6, 0.4], 0.9)
    }
  }
  return { answers: ans, usage: { cost: 0.01 } }
}
export const text = async () => ({ text: 'a@b.co', usage: { cost: 0.002 } })`,
)

const pages: Record<string, string> = {
  '/conf-low': `<title>低把握</title><main><button onclick="document.getElementById('s').textContent='已保存'">保存</button><p id="s">未保存</p></main>`,
  '/conf-mid-no': `<title>中把握</title><main><button onclick="document.getElementById('s').textContent='已保存'">保存</button><p id="s">未保存</p></main>`,
  '/conf-mid-yes': `<title>中偏高</title><main><button onclick="document.getElementById('s').textContent='已保存'">保存</button><p id="s">未保存</p></main>`,
  // Decoy 输入框会吞掉输入（input 事件里清空），填它没有效果；Email 才是对的
  '/conf-trial': `<title>试错</title><main><input placeholder="Decoy" oninput="this.value=''"><input placeholder="Email"></main>`,
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
const json = (t: string) => firstJson(t)
async function open(path: string) {
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, `http://localhost:${site.port}${path}`])
  await until(async () => {
    const t = await sw().evaluate((t) => chrome.tabs.get(t), mainTab)
    return t.status === 'complete' && t.url?.endsWith(path)
  })
}
const page = () => ctx.pages().find((p) => p.url().startsWith(`http://localhost:${site.port}`))!
const decideCalls = (suffix: string) => readFileSync(logPath, 'utf8').trim().split('\n').filter((l) => l && JSON.parse(l).url.endsWith(suffix)).length

beforeAll(async () => {
  site = Bun.serve({ port: 0, fetch: (r) => new Response(pages[new URL(r.url).pathname] ?? 'x', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'conf', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/mcp.ts')], env: { ...env, JEV_FAKE_MODULE: fakePath } }))
  const r: any = await client.callTool({ name: 'tabs_context_mcp', arguments: {} })
  mainTab = firstJson(r.content[0].text).availableTabs[0].tabId
}, 60000)

afterAll(async () => {
  await client?.close()
  await ctx?.close()
  site?.stop(true)
  rmSync(work, { recursive: true, force: true })
}, 30000)

test('纯函数：三档闸门、再看一眼取平均、可撤回判断、撤回计划', () => {
  const th = thresholds({})
  expect(th).toEqual({ act: 0.75, escalate: 0.5 })
  expect(thresholds({ JEV_TASK_ACT: '0.9', JEV_TASK_ESCALATE: '0.4' })).toEqual({ act: 0.9, escalate: 0.4 })
  expect([0.9, 0.75, 0.6, 0.5, 0.49].map((c) => gate(c, th))).toEqual(['act', 'act', 'look', 'look', 'escalate'])
  expect(stepConfidence({ confidence: 0.9, target_confidence: 0.6 })).toBe(0.6)
  const a = { operation: 'CLICK', target: { ref: 'r1', label: '保存' } }
  expect(mergeLooks(a, 0.8, a, 0.9)).toBeCloseTo(0.85)
  expect(mergeLooks(a, 0.8, { operation: 'CLICK', target: { ref: 'r2', label: '取消' } }, 0.9)).toBe(0)
  const el = (role: string) => ({ role })
  expect(trialable({ kind: 'fill', element: el('textbox') })).toBe(true)
  expect(trialable({ kind: 'select', element: el('combobox') })).toBe(true)
  expect(trialable({ kind: 'click', element: el('checkbox') })).toBe(true)
  expect(trialable({ kind: 'click', element: el('button') })).toBe(false)
  const snap = (url: string, e: any[]) => ({ url, elements: e })
  expect(hadEffect(snap('u', [{ ref: 'a', value: '' }]), snap('u', [{ ref: 'a', value: '' }]), 'a', false)).toBe(false)
  expect(hadEffect(snap('u', [{ ref: 'a', value: '' }]), snap('u', [{ ref: 'a', value: 'x' }]), 'a', true)).toBe(true)
  expect(rollbackPlan(snap('u', [{ ref: 'a' }]), snap('v', [{ ref: 'a' }]), 'a', 'click')).toEqual([{ op: 'back' }])
  expect(rollbackPlan(snap('u', [{ ref: 'a', value: 'old' }]), snap('u', [{ ref: 'a', value: 'new' }]), 'a', 'fill')).toEqual([{ op: 'restore', ref: 'a', value: 'old' }])
  expect(rollbackPlan(snap('u', [{ ref: 'a', checked: false }]), snap('u', [{ ref: 'a', checked: true }]), 'a', 'click')).toEqual([{ op: 'reclick', ref: 'a' }])
})

test('低把握（0.3 < 0.5）：停下回报，不点，只问一次', async () => {
  await open('/conf-low')
  const j = json((await tool('quick_task', { goal: '点保存', tabId: mainTab })).text)
  expect(j.status).toBe('needs_help')
  expect(j.pending.label).toBe('保存')
  expect(j.pending.confidence).toBe(0.3)
  expect(j.steps.length).toBe(0)
  expect(await page().textContent('#s')).toBe('未保存')
  expect(decideCalls('/conf-low')).toBe(1)
}, 40000)

test('中把握：再看一眼；两次平均仍在中间且是点击 → 停下；平均过 0.75 → 做', async () => {
  await open('/conf-mid-no')
  const no = json((await tool('quick_task', { goal: '点保存', tabId: mainTab })).text)
  expect(no.status).toBe('needs_help')
  expect(decideCalls('/conf-mid-no')).toBe(2)
  expect(await page().textContent('#s')).toBe('未保存')

  await open('/conf-mid-yes')
  const yes = json((await tool('quick_task', { goal: '点保存', tabId: mainTab })).text)
  expect(yes.status).toBe('done')
  expect(yes.steps[0]).toMatchObject({ kind: 'click', action: '保存', step_confidence: 0.8 })
  expect(await page().textContent('#s')).toBe('已保存')
}, 60000)

test('试错：先填的输入框没效果 → 撤回 → 换下一个候选填成功', async () => {
  await open('/conf-trial')
  const j = json((await tool('quick_task', { goal: '填邮箱', tabId: mainTab })).text)
  expect(j.status).toBe('done')
  expect(j.steps[0].trials).toEqual([{ label: 'Decoy', outcome: 'no effect, rolled back' }])
  expect(j.steps[0].action).toBe('Email')
  expect(j.steps[0].outcome).toBe('done')
  expect(await page().inputValue('input[placeholder=Email]')).toBe('a@b.co')
  expect(await page().inputValue('input[placeholder=Decoy]')).toBe('')
}, 40000)
