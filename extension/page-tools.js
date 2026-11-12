// page-tools：javascript_tool / resize_window / file_upload / upload_image 的扩展侧执行，
// 外加分段暂存 upload_stash 与纯函数 filterValue（脱敏 + 截短）。行为见 specs/page-tools.md。
import { withDebugger, send } from './debugger.js'
import { callOnRef, inPage, locateRef } from './frames.js'
import { getImage, toViewport } from './screenshot.js'
import { resolveTabId } from './sessions.js'

// 导入副作用：上传上限钩子（字节），端到端测试会在运行中改写
globalThis.__jevUpload = { upload: 10485760 }

// ---------- 公共小工具 ----------

/** 造一个带 code 的 Error */
function fail(code, message) {
  const e = new Error(message)
  if (code !== undefined) e.code = code
  return e
}
const badParams = (msg) => fail('invalid_params', msg)

// ---------- filterValue ----------

const MAX_DEPTH = 5
const MAX_STR = 1000
const MAX_ITEMS = 100

const MARK_DEEP = '[thundermcp: nested too deep]'
const MARK_SECRET = '[thundermcp: redacted]'
const MARK_CUT = '…[thundermcp: string truncated]'
const markOmitted = (n) => `[thundermcp: ${n} more items omitted]`

// 敏感键：先把键名压成「只剩小写字母数字」，再查子串。这样 api_key / X-Api-Key / apikey 归一成 apikey
const SENSITIVE_KEY_PARTS = ['password', 'token', 'secret', 'authorization', 'credential', 'bearer', 'oauth', 'session', 'apikey', 'privatekey', 'accesskey']
const COOKIE_KEYS = new Set(['cookie', 'cookies'])

function isSensitiveKey(key) {
  const lower = key.toLowerCase()
  if (COOKIE_KEYS.has(lower)) return true
  const squashed = lower.replace(/[^a-z0-9]/g, '')
  return SENSITIVE_KEY_PARTS.some((part) => squashed.includes(part))
}

// 凭证形态识别：每个识别器是一个独立判断，任一命中即屏蔽
// cookie 串 / 查询串：至少两段，用 ; 或 & 分隔，每段都是 名=值
function pairList(s) {
  if (!/[;&]/.test(s)) return false
  const pieces = s.split(/[;&]/).map((x) => x.trim()).filter(Boolean)
  return pieces.length >= 2 && pieces.every((x) => /^[^=\s]+=[^\s]*$/.test(x))
}

const tokenShapes = [
  // JWT：三段 base64url，且首段解出来是 JSON 对象（真实 JWT 的头部）
  function jwt(s) {
    const parts = s.split('.')
    if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]*$/.test(p))) return false
    if (!parts[0] || !parts[1]) return false
    try {
      const head = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')))
      return head !== null && typeof head === 'object'
    } catch {
      return false
    }
  },
  // 标准 base64：≥ 20 字符，且至少含一个数字或 + / =（排除纯字母长单词）
  (s) => s.length >= 20 && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && /[0-9+/=]/.test(s),
  // 十六进制密钥：≥ 32 字符
  (s) => s.length >= 32 && /^[0-9a-fA-F]+$/.test(s),
]

// cookie 串允许 `; ` 里的空格；其余形态含空白即视为普通文字
const looksLikeCredential = (s) => pairList(s) || (!/\s/.test(s) && tokenShapes.some((check) => check(s)))

function filterString(s) {
  if (looksLikeCredential(s)) return MARK_SECRET
  return s.length > MAX_STR ? s.slice(0, MAX_STR) + MARK_CUT : s
}

function walk(v, depth) {
  if (depth > MAX_DEPTH) return MARK_DEEP
  if (typeof v === 'string') return filterString(v)
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) {
    const kept = v.slice(0, MAX_ITEMS).map((x) => walk(x, depth + 1))
    if (v.length > MAX_ITEMS) kept.push(markOmitted(v.length - MAX_ITEMS))
    return kept
  }
  const out = {}
  for (const [k, x] of Object.entries(v)) out[k] = isSensitiveKey(k) ? MARK_SECRET : walk(x, depth + 1)
  return out
}

export function filterValue(v) {
  return walk(v, 0)
}

// ---------- javascriptTool ----------

const JS_TIMEOUT_MS = 40000
const CHANNEL_SLACK_MS = 5000
const MAX_OUTPUT = 51200
const PROTECTED_SCHEMES = new Set(['chrome:', 'chrome-extension:', 'devtools:', 'edge:'])

// 第一次：块包裹，让顶层 let/const 不进全局；完成值即块内最后一句的值；换行防末行 // 注释吞掉右括号
const replExpression = (code) => `{\n${code}\n}`
// 重跑：当作异步函数体
const asyncBodyExpression = (code) => `(async () => {\n${code}\n})()`

const evalParams = (expression, repl) => ({
  expression,
  returnByValue: true,
  awaitPromise: true,
  timeout: JS_TIMEOUT_MS,
  ...(repl && { replMode: true }),
})

/** 编译期的顶层 return 错误（无调用栈 + V8 原生文案） */
function isTopLevelReturn(resp) {
  const d = resp?.exceptionDetails
  if (!d || d.stackTrace) return false
  return String(d.exception?.description ?? '').includes('Illegal return statement')
}

/** 把 CDP 的异常详情转成本模块的错误 */
function exceptionToError(details) {
  const ex = details.exception
  const desc = ex?.description
  if (typeof desc === 'string' && desc.includes('execution was terminated')) {
    return fail('js_timeout', `Script timed out after ${JS_TIMEOUT_MS / 1000} seconds and was terminated.`)
  }
  let what
  if (desc !== undefined && desc !== null && desc !== '') what = String(desc)
  else if (ex && 'value' in ex) what = typeof ex.value === 'string' ? ex.value : JSON.stringify(ex.value)
  else what = details.text || 'unknown exception'
  return fail('js_execution_error', `Page script threw: ${what}`)
}

/** 把调试通道的失败转成本模块的错误 */
function channelToError(err) {
  let msg = (err && err.message) || 'Debugger command failed'
  if (/navigated or closed/i.test(msg)) {
    msg += ' (The page navigated or the tab closed during evaluation; re-check the tab and retry.)'
  }
  return fail(err && err.code !== undefined ? err.code : 'js_exception', msg)
}

/** RemoteObject → 文字 */
function remoteToText(r) {
  if (!r || r.type === 'undefined') return 'undefined'
  const describe = () => r.description || `[${r.className || r.type}]`
  if (r.type === 'object' && r.subtype === 'null') return 'null'
  if (r.type === 'function' || r.subtype === 'node') return describe()
  if (r.type === 'object') return 'value' in r ? JSON.stringify(filterValue(r.value), null, 2) : describe()
  if (!('value' in r)) return describe()
  const clean = filterValue(r.value)
  return typeof clean === 'string' ? clean : JSON.stringify(clean)
}

function capOutput(text) {
  if (text.length <= MAX_OUTPUT) return text
  return `${text.slice(0, MAX_OUTPUT)}\n[thundermcp: output truncated, ${text.length - MAX_OUTPUT} characters omitted]`
}

export async function javascriptTool(p, s, g) {
  if (p?.action !== 'javascript_exec') throw badParams('action must be "javascript_exec"')
  if (!p.text || typeof p.text !== 'string') throw badParams('text must be a non-empty script')
  const code = p.text
  const tabId = resolveTabId(p, s)
  const tab = await chrome.tabs.get(tabId)
  if (!tab?.url) throw fail(undefined, `Tab ${tabId} has no readable URL`)
  let scheme = ''
  try {
    scheme = new URL(tab.url).protocol
  } catch {}
  if (PROTECTED_SCHEMES.has(scheme)) {
    throw fail('chrome_protected_page', `Cannot run scripts on ${scheme}// pages.`)
  }
  if (g) await g.check('javascript_tool')

  const ms = JS_TIMEOUT_MS + CHANNEL_SLACK_MS
  let resp
  try {
    resp = await withDebugger(tabId, async () => {
      const first = await send(tabId, 'Runtime.evaluate', evalParams(replExpression(code), true), ms)
      if (!isTopLevelReturn(first)) return first
      return send(tabId, 'Runtime.evaluate', evalParams(asyncBodyExpression(code), false), ms)
    })
  } catch (err) {
    throw channelToError(err)
  }
  if (resp?.exceptionDetails) throw exceptionToError(resp.exceptionDetails)
  return { tabId, output: capOutput(remoteToText(resp?.result)) }
}

// ---------- resizeWindow ----------

const MAX_W = 7680
const MAX_H = 4320

function checkDimension(name, v, max) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) throw badParams(`${name} must be a finite number >= 1`)
  if (v > max) throw badParams(`${name} too large; maximum window size is ${MAX_W}x${MAX_H}`)
  return Math.floor(v)
}

export async function resizeWindow(p) {
  const width = checkDimension('width', p?.width, MAX_W)
  const height = checkDimension('height', p?.height, MAX_H)
  const tabId = p.tabId
  if (!tabId) throw badParams('tabId is required')
  const tab = await chrome.tabs.get(tabId)
  if (tab?.windowId === undefined || tab.windowId === null) throw fail(undefined, `Tab ${tabId} has no window`)
  await chrome.windows.update(tab.windowId, { width, height })
  return { tabId, output: `Resized window to ${width}x${height}` }
}

// ---------- 暂存 ----------

const STASH_TTL_MS = 5 * 60 * 1000
/** key → { parts: string[], at: 最后追加时间 } */
const stash = new Map()

const expired = (entry) => Date.now() - entry.at > STASH_TTL_MS

export async function uploadStash(p) {
  if (typeof p?.key !== 'string' || typeof p?.data !== 'string') throw badParams('key and data must be strings')
  let entry = stash.get(p.key)
  if (!entry || expired(entry)) {
    entry = { parts: [] }
    stash.set(p.key, entry)
  }
  entry.parts.push(p.data)
  entry.at = Date.now()
  return {}
}

/** 取走并清空；取不到返回 undefined */
function takeStash(key) {
  const entry = stash.get(key)
  stash.delete(key)
  if (!entry || expired(entry)) return undefined
  return entry.parts.join('')
}

// ---------- 上传公共 ----------

/** 标准 base64 解码后的字节数（只看长度与末尾填充） */
function decodedBytes(b64) {
  if (!b64) return 0
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

function checkTotal(bytes) {
  if (bytes > globalThis.__jevUpload.upload) throw fail('input_invalid', 'Upload exceeds the 10 MB total size limit')
}

/** 页面结果：error 为非空字符串即失败 */
function pageOutcome(res) {
  if (typeof res?.error === 'string' && res.error !== '') throw fail(res.errorCode, `Page reported: ${res.error}`)
  return res?.output
}

// ---------- fileUpload ----------

function cleanName(name) {
  if (typeof name !== 'string' || name === '') throw badParams('each file needs a non-empty name')
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  if (base === '' || base === '.' || base === '..' || base.length > 255) throw badParams(`invalid file name: ${JSON.stringify(name)}`)
  return base
}

export async function fileUpload(p, s, g) {
  const files = Array.isArray(p?.files) ? p.files : []
  if (files.length === 0) {
    if (Array.isArray(p?.paths) && p.paths.length > 0) {
      throw fail('upload_caller_outdated', 'file_upload no longer accepts local paths; the caller must send file contents')
    }
    throw badParams('files must be a non-empty array')
  }
  // 先把本次引用的暂存键全部取走：无论后面哪步失败，都算已消耗
  const fromStash = files.map((f) => (typeof f?.stash === 'string' ? { hit: true, data: takeStash(f.stash), key: f.stash } : { hit: false }))

  const payload = []
  let total = 0
  files.forEach((f, i) => {
    const st = fromStash[i]
    if (st.hit && st.data === undefined) throw fail('input_invalid', `Upload stash "${st.key}" is missing or expired; re-upload it`)
    const data = st.hit ? st.data : f?.data
    if (typeof data !== 'string') throw badParams(`file #${i + 1} data must be a base64 string`)
    const item = { data, name: cleanName(f.name) }
    if (typeof f.mimeType === 'string') item.mimeType = f.mimeType
    total += decodedBytes(data)
    payload.push(item)
  })
  checkTotal(total)
  if (!p.ref) throw badParams('ref is required')

  const tabId = resolveTabId(p, s)
  if (g) await g.check('file_upload')
  const res = await callOnRef(tabId, p.ref, 'uploadFiles', [payload])
  return { tabId, output: pageOutcome(res) }
}

// ---------- uploadImage ----------

export async function uploadImage(p, s, g) {
  if (!p?.imageId) throw badParams('imageId is required')
  const hasRef = !!p.ref
  const hasPoint = p.coordinate !== undefined && p.coordinate !== null
  if (hasRef === hasPoint) throw badParams('provide exactly one of ref or coordinate')

  const image = getImage(s?.name ?? '', p.imageId)
  if (!image) throw fail('screenshot_bytes_unavailable', `No screenshot bytes for imageId ${p.imageId}`)
  checkTotal(decodedBytes(image.base64))

  const ext = image.format === 'jpeg' ? 'jpg' : image.format
  const file = { data: image.base64, name: p.filename || `image.${ext}`, mimeType: `image/${image.format}` }

  const tabId = resolveTabId(p, s)
  if (g) await g.check('upload_image')

  let res
  if (hasRef) {
    res = await callOnRef(tabId, p.ref, 'uploadFiles', [[file]])
    if (res?.errorCode === 'element_unsupported' && res.error) {
      const [x, y] = await locateRef(tabId, p.ref)
      res = await inPage(tabId, 'dropFiles', [x, y, [file], [x, y]], 0)
    }
  } else {
    const [x, y] = toViewport(tabId, p.coordinate, 'upload_image')
    res = await inPage(tabId, 'dropFiles', [x, y, [file], p.coordinate], 0)
  }
  return { tabId, output: pageOutcome(res) }
}
