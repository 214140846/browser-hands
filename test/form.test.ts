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
const work = mkdtempSync(TEST_TMP + '/jev-form-')
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
  // 模拟 React 的值追踪：实例上盖一层 value 访问器记下"上次已知值"，input 事件里只在真实值与记录不同时才更新 state。
  // （隔离世界里的赋值碰不到这层，所以这里主要验证 input 事件确实触发了受控逻辑、页面 state 与输入框一致）
  '/react': `<title>受控</title><input id="c" placeholder="受控框"><div id="out"></div><script>
    const inp=document.getElementById('c');let tracked='';window.renders=0
    const proto=Object.getPrototypeOf(inp);const d=Object.getOwnPropertyDescriptor(proto,'value')
    Object.defineProperty(inp,'value',{get(){return d.get.call(this)},set(v){tracked=String(v);d.set.call(this,v)},configurable:true})
    inp.addEventListener('input',()=>{const cur=d.get.call(inp);if(cur===tracked)return;tracked=cur;window.state=cur;window.renders++;document.getElementById('out').textContent='state='+cur})</script>`,
  '/controls': `<title>控件</title><body>
    <select id="s"><option value="a">苹果</option><option value="b">香蕉</option></select>
    <input id="cb" type="checkbox"><input id="r1" type="radio" name="g" value="1"><input id="r2" type="radio" name="g" value="2">
    <input id="d" type="date"><input id="rg" type="range" min="0" max="10"><input id="n" type="number">
    <input id="dis" disabled placeholder="禁用框" value="x"><input id="ro" readonly placeholder="只读框" value="y"><input id="pw" type="password" placeholder="密码框">
    <textarea id="ta"></textarea><h2 id="dv">不是表单</h2>
    <script>window.ev=[];for(const id of ['s','cb','r1','r2','d','rg','n','ta'])for(const t of ['input','change'])document.getElementById(id).addEventListener(t,()=>ev.push(id+':'+t))</script></body>`,
  '/a': `<title>A</title><body>页面 A</body>`,
  '/b': `<title>B</title><body>页面 B</body>`,
  '/dirty': `<title>脏</title><input id="i" placeholder="未保存"><script>onbeforeunload=e=>{e.preventDefault();e.returnValue=''}</script>`,
  // 鼠标一移动就开始跳到另一个网站（慢响应，跳转会一直挂在 pendingUrl 上）
  '/jumpy': `<title>跳</title><body style="margin:0"><button id="b" style="width:200px;height:100px" onclick="window.clicked=1;navigator.sendBeacon('/clicked')">按钮</button>
    <script>document.addEventListener('mousemove',()=>{location.href=window.JUMP})</script></body>`,
}

let ctx: BrowserContext
let clicks = 0 // /jumpy 按钮被真正按下的次数（页面向 /clicked 报到）
let site: ReturnType<typeof Bun.serve>
let client: Client
let mainTab = 0
const sw = () => ctx.serviceWorkers()[0]

const call = async (name: string, args: any) => {
  const r: any = await client.callTool({ name, arguments: args })
  return { err: !!r.isError, text: r.content[0].text as string }
}
const url = (path: string, host = 'localhost') => `http://${host}:${site.port}${path}`
async function open(path: string) {
  await sw().evaluate(([t, u]) => chrome.tabs.update(t as number, { url: u as string }), [mainTab, url(path)])
  await until(async () => {
    const t = await sw().evaluate((t) => chrome.tabs.get(t), mainTab)
    return t.status === 'complete' && t.url?.endsWith(path)
  })
}
const page = () => ctx.pages().find((p) => p.url().startsWith(`http://localhost:${site.port}`))!
const refs = async (filter = 'all') => (await call('read_page', { tabId: mainTab, filter })).text.split('\n')
// 按行里的文字找 ref（label 可以是多个关键词，全包含才算）
const refOf = async (...words: string[]) => (await refs()).find((l) => words.every((w) => l.includes(w)))?.match(/\[(ref_\d+)\]/)?.[1]!
const set = async (value: any, ...words: string[]) => call('form_input', { tabId: mainTab, ref: await refOf(...words), value })
const ev = () => page().evaluate(() => (window as any).ev as string[])

beforeAll(async () => {
  site = Bun.serve({
    port: 0,
    async fetch(r) {
      const p = new URL(r.url).pathname
      if (p === '/clicked') {
        clicks++
        return new Response(null, { status: 204 })
      }
      if (p === '/other') await Bun.sleep(4000)
      return new Response(pages[p] ?? '<title>other</title>其他', { headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  writeHostManifest(join(userDataDir, 'NativeMessagingHosts'))
  ctx = await launchBrowser(userDataDir, env)
  await until(() => socks().length > 0)
  client = new Client({ name: 'form', version: '0' })
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

test('form_input：受控输入框填完 state 同步', async () => {
  await open('/react')
  const r = await set('hello 世界', '受控框')
  expect(r.err).toBe(false)
  expect(await page().evaluate(() => (window as any).state)).toBe('hello 世界')
  expect(await page().locator('#out').textContent()).toBe('state=hello 世界')
  await set('第二次', '受控框')
  expect(await page().evaluate(() => (window as any).state)).toBe('第二次')
})

test('form_input：select 按值或文字；匹配不到列出选项', async () => {
  await open('/controls')
  expect((await set('b', 'combobox')).err).toBe(false)
  expect(await page().locator('#s').inputValue()).toBe('b')
  expect((await set('苹果', 'combobox')).err).toBe(false)
  expect(await page().locator('#s').inputValue()).toBe('a')
  const miss = await set('橙子', 'combobox')
  expect(miss.err).toBe(true)
  expect(miss.text).toContain('input_invalid')
  expect(miss.text).toContain('香蕉') // 报错里列出可选项
  expect(await page().locator('#s').inputValue()).toBe('a') // 没被改
})

test('form_input：checkbox / radio / 日期 / range / number', async () => {
  await open('/controls')
  expect((await set(true, 'checkbox')).err).toBe(false)
  expect(await page().locator('#cb').isChecked()).toBe(true)
  const notBool = await set('yes', 'checkbox')
  expect(notBool.err).toBe(true)
  expect(notBool.text).toContain('input_invalid')
  expect((await set(false, 'checkbox')).err).toBe(false)
  expect(await page().locator('#cb').isChecked()).toBe(false)
  const radios = (await refs()).filter((l) => l.includes('radio'))
  expect(radios.length).toBe(2)
  const r2 = radios[1].match(/\[(ref_\d+)\]/)![1]
  expect((await call('form_input', { tabId: mainTab, ref: r2, value: true })).err).toBe(false)
  expect(await page().locator('#r2').isChecked()).toBe(true)
  expect((await set('2026-10-29', 'date')).err).toBe(false)
  expect(await page().locator('#d').inputValue()).toBe('2026-10-29')
  const badDate = await set('29/10/2026', 'date')
  expect(badDate.err).toBe(true)
  expect(badDate.text).toContain('input_invalid')
  expect((await set(7, 'type="range"')).err).toBe(false)
  expect(await page().locator('#rg').inputValue()).toBe('7')
  const badRange = await set('abc', 'type="range"')
  expect(badRange.err).toBe(true)
  expect(badRange.text).toContain('input_invalid')
  expect((await set(42, 'type="number"')).err).toBe(false)
  expect(await page().locator('#n').inputValue()).toBe('42')
  const badNum = await set('x', 'type="number"')
  expect(badNum.err).toBe(true)
  expect(badNum.text).toContain('input_invalid')
  expect((await ev()).filter((e) => e.startsWith('d:'))).toEqual(['d:input', 'd:change'])
})

test('form_input：禁用 / 只读 / 非表单元素 / 密码打码 / ref 过期', async () => {
  await open('/controls')
  const dis = await set('z', '禁用框')
  expect(dis.err).toBe(true)
  expect(dis.text).toContain('element_not_editable')
  expect((await set('z', '只读框')).text).toContain('element_not_editable')
  const notForm = await set('z', '不是表单')
  expect(notForm.err).toBe(true)
  expect(notForm.text).toContain('element_unsupported')
  const pw = await set('topsecret', '密码框')
  expect(pw.err).toBe(false)
  expect(pw.text).not.toContain('topsecret')
  expect(await page().locator('#pw').inputValue()).toBe('topsecret')
  const stale = await call('form_input', { tabId: mainTab, ref: 'ref_99999', value: 'z' })
  expect(stale.err).toBe(true)
  expect(stale.text).toContain('ref_stale')
  expect(stale.text).toContain('Hint:')
})

test('navigate：网址、back、forward', async () => {
  await open('/a')
  const go = await call('navigate', { tabId: mainTab, url: url('/b') })
  expect(go.err).toBe(false)
  expect(go.text).toContain(url('/b'))
  expect(page().url().endsWith('/b')).toBe(true)
  expect(await page().title()).toBe('B') // 返回时页面已加载完
  const back = await call('navigate', { tabId: mainTab, url: 'back' })
  expect(back.err).toBe(false)
  expect(back.text).toContain(url('/a'))
  expect(page().url().endsWith('/a')).toBe(true)
  const fwd = await call('navigate', { tabId: mainTab, url: 'forward' })
  expect(fwd.err).toBe(false)
  expect(fwd.text).toContain(url('/b'))
  expect(page().url().endsWith('/b')).toBe(true)
  expect((await call('navigate', { tabId: mainTab, url: 'http://' })).err).toBe(true)
})

test('navigate：beforeunload 默认留下', async () => {
  await open('/dirty')
  // 弹窗需要页面里有过真实用户操作：用 CDP 点一下输入框
  await call('computer', { tabId: mainTab, action: 'left_click', ref: await refOf('未保存') })
  const blocked = await call('navigate', { tabId: mainTab, url: url('/a') })
  expect(blocked.err).toBe(true)
  expect(blocked.text).toContain('navigate_beforeunload_blocked')
  expect(blocked.text).toContain('force: true')
  expect(page().url().endsWith('/dirty')).toBe(true)
  expect((await call('read_page', { tabId: mainTab })).err).toBe(false) // 页面没被弹窗卡住
})

test('navigate：force 丢弃未保存改动离开', async () => {
  await open('/dirty')
  await call('computer', { tabId: mainTab, action: 'left_click', ref: await refOf('未保存') })
  const forced = await call('navigate', { tabId: mainTab, url: url('/a'), force: true })
  expect(forced.err).toBe(false)
  expect(page().url().endsWith('/a')).toBe(true)
})

test('navigated_away：点击按下前发现标签已在跳往别的网站，不点', async () => {
  await open('/jumpy')
  await page().evaluate((j) => ((window as any).JUMP = j), url('/other', '127.0.0.1'))
  const ref = await refOf('按钮')
  const r = await call('computer', { tabId: mainTab, action: 'left_click', ref })
  expect(r.err).toBe(true)
  expect(r.text).toContain('navigated_away')
  expect(r.text).toContain('127.0.0.1')
  expect(r.text).toContain('Hint:')
  expect(clicks).toBe(0) // 没按下：按钮 onclick 会向测试站报到，计数仍为 0
})

test('navigated_away：调用开始后出现跳转目标，复查报错（含 pendingUrl）', async () => {
  await open('/a')
  const code = await sw().evaluate(async ([tab, u]) => {
    const g = await (globalThis as any).__jevGuard.startGuard(tab)
    await g.check('read_page') // 没变不报
    chrome.tabs.update(tab as number, { url: u }) // 慢响应：pendingUrl 会一直在
    for (let i = 0; i < 100 && !(await chrome.tabs.get(tab as number)).pendingUrl; i++) await new Promise((r) => setTimeout(r, 20))
    try {
      await g.check('screenshot')
      return 'no-error'
    } catch (e: any) {
      return e.code + '|' + e.message
    }
  }, [mainTab, url('/other', '127.0.0.1')] as const)
  expect(code).toMatch(/^navigated_away\|.*screenshot was not performed/)
})
