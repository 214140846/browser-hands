// MCP 服务器入口：导入即启动（stdio 传输）。没有任何导出。
// 设计：每个工具 = 「schema 形状 + 处理函数」，处理函数只产出 Out（文字 / 可选图片 / 是否要附标签块），
// 通用流程（选浏览器、会话标识、脱敏、截断、提示器、错误收口）与 browser_batch 都复用同一批处理函数。
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { escapeJson, sanitizeText } from '../extension/redact.js'
import { explainNoBrowser, type Conn } from './browsers'
import { getJev } from './jev'
import { jevResult, jevStatus, jevStop, startJevTask } from './jev-task'
import { check, formatFind, jevFindJson, parseTree, prefilter, rank } from './jev-tools'
import { makeHinter, truncateOutput } from './output'
import { PROTOCOL_VERSION } from './paths'
import { describe, online, pick, refresh, refreshInfo, select, switchBrowser } from './registry'

// ---------- 服务器说明：取自同目录 instructions.md，去掉独占首行的 HTML 注释 ----------
const INSTRUCTIONS = readFileSync(new URL('./instructions.md', import.meta.url), 'utf8')
  .replace(/^<!--.*-->[ \t]*\r?\n/, '')
  .trim()

// ---------- 小工具 ----------
type Img = { data: string; mimeType: string }
type Piece = { type: 'text'; text: string } | ({ type: 'image' } & Img)
// 处理函数的产出：tabs 为 false 时不附标签块；否则 exec 为「执行所在标签」
type Out = { text: string; image?: Img; tabs: false | { exec?: number } }
type Ctx = { conn: Conn; sid: string }
type Handler = (c: Ctx, a: any) => Promise<Out>

const msgOf = (e: unknown) => String((e as any)?.message ?? e)
const plug = (c: Ctx, method: string, params: unknown = {}) => c.conn.call(method, params, c.sid)
const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))
const json = (v: unknown) => JSON.stringify(v)

// 标签块：一行可 JSON.parse 的 JSON + 可读清单
async function tabBlock(c: Ctx, exec?: number): Promise<string> {
  const r = await plug(c, 'tabs_context_mcp', {})
  const tabs: any[] = r?.availableTabs ?? []
  const lines = ['[Tab context]']
  if (exec !== undefined) lines.push(`Executed in tabId: ${exec}`)
  lines.push('Available tabs:')
  for (const t of tabs) lines.push(`- tabId ${t.tabId}: ${escapeJson(String(t.title ?? ''))} (${escapeJson(String(t.url ?? ''))})`)
  lines.push(escapeJson(json({ availableTabs: tabs, tabGroupId: r?.tabGroupId, initialTabId: r?.initialTabId })))
  return lines.join('\n')
}

// 按 tabId 查标签的网址 / 标题，查不到为空串
async function tabMeta(c: Ctx, tabId: unknown) {
  const r = await plug(c, 'tabs_context_mcp', {})
  const t = (r?.availableTabs ?? []).find((x: any) => x.tabId === tabId)
  return { url: String(t?.url ?? ''), title: String(t?.title ?? '') }
}

// ---------- 处理函数 ----------
// 通用转发：参数原样给插件，返回 { output, tabId, base64Image?, imageFormat? }
const forward =
  (method: string, pre?: (c: Ctx, a: any) => Promise<any>): Handler =>
  async (c, a) => {
    const params = pre ? await pre(c, a) : a
    const r = await plug(c, method, params)
    const image = r?.base64Image ? { data: r.base64Image, mimeType: `image/${r.imageFormat}` } : undefined
    return { text: asText(r?.output ?? ''), image, tabs: { exec: r?.tabId } }
  }

const MAX_UPLOAD_BYTES = 10485760
const INLINE_LIMIT = 600000

// file_upload：先算总字节，再把超长文件分段暂存，发给插件的文件项只带 stash 引用
async function prepareUpload(c: Ctx, a: any) {
  if (!Array.isArray(a.files)) return a
  const decoded = (s: string) => Math.floor((s.length * 3) / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0)
  let total = 0
  for (const f of a.files) if (typeof f.data === 'string') total += decoded(f.data)
  if (total > MAX_UPLOAD_BYTES) throw new Error('input_invalid: uploads are limited to 10 MB in total; split the files across several calls.')
  const files: any[] = []
  for (const f of a.files) {
    if (typeof f.data !== 'string' || f.data.length <= INLINE_LIMIT) {
      files.push(f)
      continue
    }
    const key = randomUUID()
    for (let at = 0; at < f.data.length; at += INLINE_LIMIT) {
      await plug(c, 'upload_stash', { key, data: f.data.slice(at, at + INLINE_LIMIT) })
    }
    const { data: _drop, ...rest } = f
    files.push({ ...rest, stash: key })
  }
  return { ...a, files }
}

const tabsContext: Handler = async (c) => ({ text: '', tabs: {} })
const tabsCreate: Handler = async (c) => {
  const r = await plug(c, 'tabs_create_mcp', {})
  return { text: `Created a new tab, tabId ${r.tabId}.`, tabs: {} }
}
const tabsClose: Handler = async (c, a) => {
  const r = await plug(c, 'tabs_close_mcp', { tabId: a.tabId })
  return { text: `Closed tab ${r.tabId}.`, tabs: {} }
}
const readPage: Handler = async (c, a) => {
  const r = await plug(c, 'read_page', a)
  return { text: `${r.pageContent}\n\nViewport: ${r.viewport?.width}x${r.viewport?.height}`, tabs: { exec: r.tabId } }
}
const pageText: Handler = async (c, a) => {
  const r = await plug(c, 'get_page_text', a)
  const text = [`Title: ${escapeJson(String(r.title ?? ''))}`, `URL: ${r.url}`, `Source element: ${r.source}`, '', r.text].join('\n')
  return { text, tabs: { exec: r.tabId } }
}

// find / quick_find 共用：读页 → 预筛 → 小模型排序
async function ranked(c: Ctx, description: string, tabId: unknown) {
  const page = await plug(c, 'read_page', { filter: 'all', tabId })
  const meta = await tabMeta(c, page.tabId)
  const jev = await getJev()
  const rows = prefilter(parseTree(page.pageContent), description)
  const result = await rank(jev, { description, rows, url: meta.url, title: meta.title })
  return { result, exec: page.tabId as number }
}
const findHandler: Handler = async (c, a) => {
  const { result, exec } = await ranked(c, a.query, a.tabId)
  const f = formatFind(result.candidates, result.none)
  if (!f.ok) throw new Error(`find failed: ${f.error}`)
  return { text: f.text, tabs: { exec } }
}
const quickFind: Handler = async (c, a) => {
  const { result, exec } = await ranked(c, a.description, a.tabId)
  return { text: json(jevFindJson(result)), tabs: { exec } }
}
const quickCheck: Handler = async (c, a) => {
  let page: { url: string; title: string; text: string; tabId: number }
  try {
    const r = await plug(c, 'get_page_text', { tabId: a.tabId, max_chars: 20000 })
    page = { url: r.url, title: r.title, text: r.text, tabId: r.tabId }
  } catch (e) {
    if (!msgOf(e).includes('get_page_text_no_content')) throw e
    const r = await plug(c, 'read_page', { filter: 'all', tabId: a.tabId })
    page = { ...(await tabMeta(c, r.tabId)), text: r.pageContent, tabId: r.tabId }
  }
  const jev = await getJev()
  const v = await check(jev, { statement: a.statement, url: page.url, title: page.title, text: page.text })
  const line = { probability_true: Math.round(v.p * 1000) / 1000, url: page.url, title: page.title, cost_usd: Math.round(v.cost * 1e6) / 1e6, model: v.model }
  return { text: json(line), tabs: { exec: page.tabId } }
}
const quickTask: Handler = async (c, a) => {
  const jev = await getJev()
  const r = await startJevTask(c.conn, c.sid, a, jev)
  return { text: json(r), tabs: {} }
}
const taskQuery = (fn: (id: string) => unknown | Promise<unknown>): Handler => async (_c, a) => ({ text: json(await fn(a.taskId)), tabs: false })

// ---------- schema 零件 ----------
const num = z.number()
const str = z.string()
const bool = z.boolean()
const tabId = num
const xy = z.array(num).length(2)

// ---------- 工具表 ----------
type Def = { desc: string; shape: z.ZodRawShape; run: Handler; hint?: string; batch?: boolean }
const DEFS: Record<string, Def> = {
  tabs_context_mcp: {
    desc: 'List the tabs in your dedicated tab group (id, title, URL). Call this first in a session and whenever you lose track of which tab is which. Pass createIfEmpty to open a starter tab when the group has none.',
    shape: { createIfEmpty: bool.optional().describe('Create an initial tab if the group is empty.') },
    run: tabsContext,
    batch: true,
  },
  tabs_create_mcp: {
    desc: 'Open a new empty tab inside your tab group and return its tabId. Use it when you need a page of your own rather than borrowing an existing tab.',
    shape: {},
    run: tabsCreate,
    batch: true,
  },
  tabs_close_mcp: {
    desc: 'Close one tab from your tab group. Only close tabs you opened yourself.',
    shape: { tabId: tabId.describe('Tab to close.') },
    run: tabsClose,
    batch: true,
  },
  read_page: {
    desc: 'Return the accessibility tree of a page as text; each element carries a ref id usable by computer and form_input. Start with filter=interactive for controls only; use all when you need the surrounding content. Narrow big pages with ref_id, depth or max_chars.',
    shape: {
      filter: z.enum(['interactive', 'all']).optional().describe('interactive = clickable/typeable elements only; all = everything.'),
      tabId: tabId.optional().describe('Target tab; defaults to the active tab of your group.'),
      depth: num.optional().describe('Maximum tree depth to include.'),
      ref_id: str.optional().describe('Only return the subtree rooted at this ref.'),
      max_chars: num.optional().describe('Output budget in characters. Any number, including 0, turns off automatic truncation.'),
    },
    run: readPage,
    batch: true,
  },
  get_page_text: {
    desc: 'Extract the readable text of a page (the main article or content container) instead of its structure. Best for reading documents, articles and search results; use read_page when you need to interact.',
    shape: {
      tabId: tabId.optional().describe('Target tab.'),
      max_chars: num.optional().describe('Output budget in characters. Any number, including 0, turns off automatic truncation.'),
    },
    run: pageText,
    batch: true,
  },
  computer: {
    desc: 'Mouse, keyboard and screenshot control of a tab. Actions: left_click, right_click, double_click, triple_click, hover, left_click_drag, type, key, scroll, scroll_to, wait, screenshot, zoom. Aim with a ref (preferred) or a coordinate. Coordinates refer to the most recent screenshot, so take one first when using them.',
    shape: {
      action: z.enum(['left_click', 'right_click', 'type', 'screenshot', 'wait', 'scroll', 'key', 'left_click_drag', 'double_click', 'triple_click', 'zoom', 'scroll_to', 'hover']).describe('What to do.'),
      coordinate: xy.optional().describe('[x, y] in screenshot pixels. Target for clicks, hover and scroll; end point for drags.'),
      text: str.optional().describe('For type: the text. For key: space-separated key names, e.g. "ctrl+a Backspace".'),
      duration: num.min(0).max(30).optional().describe('Seconds to wait (action=wait), 0-30.'),
      scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Direction for scroll.'),
      scroll_amount: num.min(1).max(30).optional().describe('Scroll ticks, 1-30.'),
      start_coordinate: xy.optional().describe('[x, y] where a left_click_drag begins.'),
      region: z.array(num).length(4).optional().describe('[x0, y0, x1, y1] rectangle to capture for zoom.'),
      scale: num.optional().describe('Screenshot scale factor; smaller values return smaller, cheaper images.'),
      repeat: num.min(1).max(100).optional().describe('Repeat a key sequence this many times, 1-100.'),
      ref: str.optional().describe('Element ref from read_page/find; used instead of coordinate (also for scroll_to).'),
      modifiers: str.optional().describe('Modifier keys held during a click, joined with +, e.g. "ctrl+shift".'),
      tabId: tabId.describe('Tab to act on.'),
    },
    run: forward('computer'),
    batch: true,
  },
  find: {
    desc: 'Locate elements on the page from a plain-language description (for example "the login button" or "search box in the header") and return matching refs. Use when read_page output is too large to scan yourself.',
    shape: { query: str.describe('What you are looking for.'), tabId: tabId.optional().describe('Target tab.') },
    run: findHandler,
    batch: true,
  },
  quick_find: {
    desc: 'Like find, but returns structured JSON (candidate refs with confidence, plus the chance that nothing matches). Prefer it when you will act on the answer programmatically; "nothing found" is a normal result, not an error.',
    shape: { description: str.describe('The element to look for, in plain language.'), tabId: tabId.optional().describe('Target tab.') },
    run: quickFind,
    hint: 'jev_find',
    batch: true,
  },
  quick_check: {
    desc: 'Ask a fast helper model whether a statement about the current page is true (e.g. "the order was placed", "an error banner is visible"). Returns a probability, the page URL/title and the cost. Cheaper than reading the page yourself, but it is a judgement, not proof.',
    shape: { statement: str.describe('A claim about the page that can be true or false.'), tabId: tabId.optional().describe('Target tab.') },
    run: quickCheck,
    hint: 'jev_check',
    batch: true,
  },
  quick_task: {
    desc: 'Hand a multi-step browsing goal to a fast helper model that drives the tab for you. Works best with a concrete plan: exact values to enter, expected results after each step. Irreversible steps are blocked unless allowIrreversible is set. With background=true it returns a taskId at once; poll with quick_task_status and collect with quick_task_result.',
    shape: {
      goal: str.describe('What to accomplish.'),
      url: str.optional().describe('Page to open before starting.'),
      details: str.optional().describe('Extra context: values to type, the route to follow, success criteria.'),
      allowIrreversible: bool.optional().describe('Permit submit/pay/delete style actions. Leave off unless the user approved them.'),
      stopBefore: z.array(str).optional().describe('Describe actions at which the task must pause and report back.'),
      tabId: tabId.optional().describe('Tab to work in.'),
      background: bool.optional().describe('Run asynchronously and return a taskId.'),
    },
    run: quickTask,
    hint: 'jev_task',
  },
  quick_task_status: {
    desc: 'Progress of a background quick_task: state, steps taken, current URL and spend so far.',
    shape: { taskId: str.describe('Id returned by quick_task.') },
    run: taskQuery(jevStatus),
    hint: 'jev_status',
  },
  quick_task_result: {
    desc: 'Final outcome of a background quick_task (or why it failed). Call after quick_task_status reports it has finished.',
    shape: { taskId: str.describe('Id returned by quick_task.') },
    run: taskQuery(jevResult),
    hint: 'jev_result',
  },
  quick_task_stop: {
    desc: 'Abort a running background quick_task and return its final state.',
    shape: { taskId: str.describe('Id returned by quick_task.') },
    run: taskQuery(jevStop),
    hint: 'jev_stop',
  },
  form_input: {
    desc: 'Set the value of a form control by ref: text boxes, textareas, selects (option text or value), checkboxes and radios (boolean), sliders (number). More dependable than typing when clicks fail to register.',
    shape: {
      ref: str.describe('Element ref from read_page/find.'),
      value: z.union([str, bool, num]).describe('New value. Use a boolean for checkboxes.'),
      tabId: tabId.describe('Target tab.'),
    },
    run: forward('form_input'),
    batch: true,
  },
  navigate: {
    desc: 'Load a URL in a tab. Also accepts "back" and "forward" for history navigation. Waits for the page to settle and reports where it ended up.',
    shape: {
      url: str.describe('Address to open, or "back" / "forward".'),
      tabId: tabId.describe('Tab to navigate.'),
      force: bool.optional().describe('Proceed even if the tab has unsaved changes or a leave-page prompt.'),
    },
    run: forward('navigate'),
    batch: true,
  },
  browser_batch: {
    desc: 'Run several tool calls in one round trip, strictly in order. Each action is {name, input} with the same input you would pass to that tool when calling it alone. Allowed names: tabs_context_mcp, tabs_create_mcp, tabs_close_mcp (aliases tabs_context, tabs_create, tabs_close), read_page, get_page_text, computer, find, quick_find, quick_check, form_input, navigate, javascript_tool, resize_window, read_console_messages, read_network_requests, file_upload, upload_image, gif_creator. Execution stops at the first failure and reports how many actions were skipped. Tab context is appended once at the end. Click coordinates in a batch follow the last screenshot taken before the batch.',
    shape: {
      actions: z
        .array(z.object({ name: str.describe('Tool to run.'), input: z.record(z.string(), z.unknown()).describe('Arguments for that tool.') }))
        .describe('Ordered list of actions.'),
    },
    run: async () => {
      throw new Error('unreachable')
    },
  },
  resize_window: {
    desc: 'Resize the browser window that contains the tab, e.g. to test a responsive layout or fit a screenshot size.',
    shape: { width: num.describe('Width in pixels.'), height: num.describe('Height in pixels.'), tabId: tabId.describe('Tab whose window is resized.') },
    run: forward('resize_window'),
    batch: true,
  },
  javascript_tool: {
    desc: 'Evaluate JavaScript in the page context and return the value of the last expression. Best for bulk extraction, quick DOM checks or repeated work that would take many separate calls. The code runs with the page\'s own permissions, so keep it side-effect free unless a change is intended.',
    shape: {
      action: str.describe('Operation to perform; use "javascript_exec" to run code.'),
      text: str.describe('The JavaScript source to run.'),
      tabId: tabId.describe('Tab to run in.'),
    },
    run: forward('javascript_tool'),
    batch: true,
  },
  read_console_messages: {
    desc: 'Read the tab\'s browser console output (log, warn, error). Useful for diagnosing why a page misbehaves. Capture starts when this is first called for the tab, so call it early.',
    shape: {
      tabId: tabId.describe('Tab to inspect.'),
      onlyErrors: bool.optional().describe('Return only errors and exceptions.'),
      clear: bool.optional().describe('Empty the buffer after reading.'),
      pattern: str.optional().describe('Regular expression; keep only messages that match.'),
      limit: num.optional().describe('Maximum number of messages to return.'),
    },
    run: forward('read_console_messages'),
    batch: true,
  },
  read_network_requests: {
    desc: 'List HTTP requests the tab made (URL, method, status). Useful to find the API behind a page or to see failed loads. Recording starts when this is first called for the tab.',
    shape: {
      tabId: tabId.describe('Tab to inspect.'),
      urlPattern: str.optional().describe('Substring of the URL to filter by.'),
      clear: bool.optional().describe('Empty the buffer after reading.'),
      limit: num.optional().describe('Maximum number of requests to return.'),
    },
    run: forward('read_network_requests'),
    batch: true,
  },
  file_upload: {
    desc: 'Put files into a file input element. Provide the content inline in files (base64 data plus a name) or give absolute paths of files that exist on the user\'s machine. Inline content totals at most 10 MB per call; large files are streamed to the browser in pieces automatically.',
    shape: {
      files: z
        .array(z.object({ data: str.describe('Base64 file content.'), name: str.describe('File name shown to the page.'), mimeType: str.optional().describe('MIME type, e.g. image/png.') }))
        .optional()
        .describe('Files supplied inline.'),
      paths: z.array(str).optional().describe('Absolute local paths to upload.'),
      ref: str.describe('Ref of the file input element.'),
      tabId: tabId.describe('Target tab.'),
    },
    run: forward('file_upload', prepareUpload),
    batch: true,
  },
  upload_image: {
    desc: 'Upload an image you previously captured (by its imageId from a screenshot) into a file input or onto a drop target given by ref or coordinate.',
    shape: {
      imageId: str.describe('Id of a stored screenshot.'),
      ref: str.optional().describe('Ref of the file input or drop target.'),
      coordinate: xy.optional().describe('[x, y] drop position when no ref is used.'),
      tabId: tabId.describe('Target tab.'),
      filename: str.optional().describe('File name presented to the page.'),
    },
    run: forward('upload_image'),
    batch: true,
  },
  gif_creator: {
    desc: 'Record the actions you take in a tab as an animated GIF and export it. Typical flow: start_recording, take screenshots between actions, stop_recording, then export. Use clear to discard frames.',
    shape: {
      action: str.describe('Recorder command: start_recording, stop_recording, export or clear.'),
      tabId: tabId.describe('Tab being recorded.'),
      coordinate: xy.optional().describe('[x, y] drop position when exporting onto the page.'),
      download: bool.optional().describe('Save the GIF through the browser instead of dropping it on the page.'),
      filename: str.optional().describe('Name for the exported file.'),
      options: z
        .object({
          showClickIndicators: bool.optional().describe('Draw a marker at each click.'),
          showDragPaths: bool.optional().describe('Draw drag trajectories.'),
          showActionLabels: bool.optional().describe('Caption frames with the action performed.'),
          showProgressBar: bool.optional().describe('Show a progress bar along the bottom.'),
          quality: num.optional().describe('Encoding quality.'),
        })
        .optional()
        .describe('Rendering options for export.'),
    },
    run: forward('gif_creator'),
    batch: true,
  },
}

// ---------- 服务器与通用流程 ----------
const server = new McpServer({ name: 'thundermcp', version: '0.1.0' }, { instructions: INSTRUCTIONS })
const hinter = makeHinter()
let sessionId = ''

const T = (text: string): Piece => ({ type: 'text', text })
const hintName = (name: string) => DEFS[name]?.hint ?? name
// 先脱敏再截断；max_chars 为数字时不截断
const polish = (text: string, noTrunc: boolean) => (noTrunc ? sanitizeText(text) : truncateOutput(sanitizeText(text)))
const versionWarning = (info: { protocolVersion: number }) =>
  info.protocolVersion === PROTOCOL_VERSION
    ? ''
    : `Version mismatch: the browser extension speaks protocol ${info.protocolVersion} but this server expects ${PROTOCOL_VERSION}. Update the extension and restart the browser (or reload the extension) so both sides match.`

type Result = { content: Piece[]; isError: boolean }

// 选浏览器；失败直接给出可返回的结果
async function chooseBrowser(): Promise<{ ok: true; conn: Conn; info: any } | { ok: false; text: string }> {
  await refresh()
  const p = pick() as any
  if (p.browser) return { ok: true, conn: p.browser.conn, info: p.browser.info }
  return { ok: false, text: p.none ? await explainNoBrowser() : String(p.error) }
}

async function withBrowser(name: string, args: any, body: (c: Ctx, info: any) => Promise<{ pieces: Piece[]; isError?: boolean }>): Promise<Result> {
  const noTrunc = typeof args?.max_chars === 'number'
  const done = (content: Piece[], isError: boolean): Result => {
    const hint = hinter.note(hintName(name), args, isError)
    if (hint) content.push(T(hint))
    return { content, isError }
  }
  try {
    const b = await chooseBrowser()
    if (!b.ok) return done([T(polish(b.text, noTrunc))], true)
    if (!sessionId) sessionId = `${server.server.getClientVersion()?.name ?? 'agent'}-${randomUUID().slice(0, 8)}`
    const c: Ctx = { conn: b.conn, sid: sessionId }
    try {
      const r = await body(c, b.info)
      return done(r.pieces, r.isError === true)
    } catch (e) {
      const warn = versionWarning(b.info)
      return done([T(polish(msgOf(e), noTrunc) + (warn ? `\n\n${sanitizeText(warn)}` : ''))], true)
    }
  } catch (e) {
    return done([T(polish(msgOf(e), noTrunc))], true)
  }
}

async function runOne(name: string, args: any): Promise<Result> {
  const def = DEFS[name]
  const noTrunc = typeof args?.max_chars === 'number'
  return withBrowser(name, args, async (c, info) => {
    const out = await def.run(c, args)
    let text = out.text
    if (out.tabs) text += `${text ? '\n\n' : ''}${await tabBlock(c, out.tabs.exec)}`
    const warn = versionWarning(info)
    const body = polish(text, noTrunc) + (warn ? `\n\n${sanitizeText(warn)}` : '')
    const pieces: Piece[] = [T(body)]
    if (out.image) pieces.push({ type: 'image', ...out.image })
    return { pieces }
  })
}

// ---------- browser_batch ----------
const ALIAS: Record<string, string> = { tabs_context: 'tabs_context_mcp', tabs_create: 'tabs_create_mcp', tabs_close: 'tabs_close_mcp' }
const batchable = (n: string) => (ALIAS[n] ?? n) in DEFS && DEFS[ALIAS[n] ?? n].batch === true
const itemSchemas = new Map<string, z.ZodObject<any>>()
const itemSchema = (n: string) => itemSchemas.get(n) ?? itemSchemas.set(n, z.object(DEFS[n].shape)).get(n)!

async function runBatch(args: { actions: { name: string; input: Record<string, unknown> }[] }): Promise<Result> {
  return withBrowser('browser_batch', args, async (c, info) => {
    const { actions } = args
    if (!actions.length) throw new Error('batch_invalid_input: the actions list is empty.')
    for (const a of actions) {
      if (a.name === 'browser_batch') throw new Error('batch_invalid_input: browser_batch cannot be nested inside a batch.')
      if (!batchable(a.name)) throw new Error(`batch_invalid_input: "${a.name}" is not allowed inside a batch.`)
    }
    await plug(c, 'batch_begin', {})
    const pieces: Piece[] = []
    let failed = false
    try {
      for (let i = 0; i < actions.length; i++) {
        const { name, input } = actions[i]
        const real = ALIAS[name] ?? name
        try {
          const parsed = itemSchema(real).safeParse(input)
          if (!parsed.success) throw new Error(`invalid input for ${real}: ${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`)
          const out = await DEFS[real].run(c, parsed.data)
          pieces.push(T(polish(`${real}: ${out.text.trim() || 'done'}`, false)))
          if (out.image) pieces.push({ type: 'image', ...out.image })
        } catch (e) {
          failed = true
          const rest = actions.length - i - 1
          pieces.push(T(polish(`${real} failed: ${msgOf(e)}\nNot executed: ${rest} remaining action(s) after the failure.`, false)))
          break
        }
      }
    } finally {
      await plug(c, 'batch_end', {}).catch(() => {})
    }
    try {
      pieces.push(T(polish(await tabBlock(c), false)))
    } catch (e) {
      if (!failed) throw e
    }
    const warn = versionWarning(info)
    if (warn) pieces.push(T(sanitizeText(warn)))
    return { pieces, isError: failed }
  })
}
// ---------- 管理三工具（不走通用流程） ----------
const plain = (text: string, isError = false): Result => ({ content: [T(text)], isError })

async function listBrowsers(): Promise<Result> {
  await refresh()
  await refreshInfo()
  return plain(`Connected browsers:\n${describe()}`)
}
async function selectBrowser(a: { deviceId: string }): Promise<Result> {
  await refresh()
  await refreshInfo()
  try {
    select(a.deviceId)
  } catch (e) {
    return plain(`${msgOf(e)}\n${describe()}`, true)
  }
  return plain(`Selected browser ${a.deviceId}.\n${describe()}`)
}
async function switchBrowserTool(): Promise<Result> {
  await refresh()
  if (online().length === 0) return plain(await explainNoBrowser(), true)
  const n = Number(process.env.JEV_SWITCH_TIMEOUT_MS)
  const ms = Number.isFinite(n) && n > 0 ? n : 120000
  const won = await switchBrowser(ms)
  if (!won) return plain('timed_out: no browser was approved in time. Ask the user to click Connect in the browser they want, then try again.', true)
  return plain(`Switched browser.\n${describe()}`)
}

// ---------- 注册 ----------
const MANAGE: Record<string, { desc: string; shape: z.ZodRawShape; run: (a: any) => Promise<Result> }> = {
  list_connected_browsers: {
    desc: 'Show every browser (Chrome profile) currently connected to this server, with names and device ids. Use it when several browsers are open or when calls complain that no browser is selected.',
    shape: {},
    run: listBrowsers,
  },
  select_browser: {
    desc: 'Choose which connected browser all later tool calls go to. Needed only when more than one browser is connected.',
    shape: { deviceId: str.describe('Device id as listed by list_connected_browsers.') },
    run: selectBrowser,
  },
  switch_browser: {
    desc: 'Ask the user to pick a different browser: a Connect prompt appears in every connected browser and the first one the user accepts becomes active. Blocks until they respond or the wait times out.',
    shape: {},
    run: switchBrowserTool,
  },
}

for (const [name, d] of Object.entries(DEFS)) {
  const handler = name === 'browser_batch' ? (a: any) => runBatch(a) : (a: any) => runOne(name, a)
  server.registerTool(name, { description: d.desc, inputSchema: d.shape }, (async (a: any) => handler(a ?? {})) as any)
}
for (const [name, d] of Object.entries(MANAGE)) {
  server.registerTool(name, { description: d.desc, inputSchema: d.shape }, (async (a: any) => d.run(a ?? {})) as any)
}

process.stdin.on('close', () => process.exit(0))
await server.connect(new StdioServerTransport())
