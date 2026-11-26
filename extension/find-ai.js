// find 的可选小模型：用户在设置页配了接口地址 + 密钥才启用；没配返回 { enabled: false }，服务端走本地打分。
// 密钥只存在 chrome.storage.local，请求由扩展自己发；错误文字里的密钥一律抹掉。

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
export const REQUEST_TIMEOUT_MS = 30000
export const MAX_RESULTS = 20
// 存储键与缺省值集中在一处
const SETTINGS = { findAiBaseUrl: '', findAiKey: '', findAiModel: DEFAULT_MODEL }
export const STORAGE_KEYS = Object.keys(SETTINGS)

const blank = (v) => String(v ?? '').trim()

// baseUrl 和 key 都非空白才启用
export const isEnabled = (cfg) => [cfg?.baseUrl, cfg?.key].every((v) => blank(v) !== '')

export async function loadConfig(storage = chrome.storage.local) {
  const saved = await storage.get(STORAGE_KEYS)
  const [baseUrl, key, model] = STORAGE_KEYS.map((k) => blank(saved[k]))
  return { baseUrl, key, model: model || DEFAULT_MODEL }
}

export function buildPrompt(query, tree) {
  return [
    `A user is looking for this on a web page: ${query}`,
    '',
    'Below is the page accessibility tree. Every element line carries a marker like [ref_12].',
    '',
    tree,
    '',
    `Pick every element that matches what the user wants, best match first, and return at most ${MAX_RESULTS}.`,
    'Only use refs that appear in the tree; never invent one.',
    'Reply with plain text in exactly this layout, one matching element per line, and nothing else:',
    'FOUND: <total number of matches>',
    `SHOWING: <number listed, at most ${MAX_RESULTS}>`,
    '---',
    'ref_X | role | name | type | why it matches',
    'ref_Y | role | name | type | why it matches',
    '',
    `When the match count goes beyond ${MAX_RESULTS}, finish the list with one extra line reading: MORE: Use a more specific query to see additional results`,
    'If nothing matches, reply only with these two lines:',
    'FOUND: 0',
    'ERROR: <why nothing was found>',
  ].join('\n')
}

// 一行归一类：{ kind, payload }；认不出的归 skip
const LINE_KINDS = [
  ['found', (l) => l.startsWith('FOUND:') && l.slice(6)],
  ['error', (l) => l.startsWith('ERROR:') && l.slice(6).trim()],
  ['more', (l) => l.startsWith('MORE:') && true],
  ['row', (l) => l.includes('|') && /^(?:f\d+:)?ref_/.test(l) && l.split('|').map((c) => c.trim())],
]
const classify = (line) => {
  for (const [kind, probe] of LINE_KINDS) {
    const payload = probe(line)
    if (payload !== false) return { kind, payload }
  }
  return { kind: 'skip' }
}

// 解析模型输出；只收页面树里真实存在的 ref
export function parseModelOutput(text, tree) {
  const known = new Set(Array.from(String(tree).matchAll(/\[((?:f\d+:)?ref_\d+)\]/g), (m) => m[1]))
  const start = { total: 0, items: [], more: false, errorText: '' }
  return String(text)
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(classify)
    .reduce((acc, { kind, payload }) => {
      if (kind === 'found') return { ...acc, total: parseInt(payload.trim(), 10) || 0 }
      if (kind === 'error') return { ...acc, errorText: payload }
      if (kind === 'more') return { ...acc, more: true }
      if (kind !== 'row' || payload.length < 4 || !known.has(payload[0])) return acc
      const [ref, role, name, type, description] = payload
      return { ...acc, items: [...acc.items, { ref, role, name, type: type || undefined, description: description || undefined }] }
    }, start)
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const itemLine = ({ ref, role, name, type, description }) =>
  [`- ${ref}: ${role}`, name && ` "${name}"`, type && ` (${type})`, description && ` - ${description}`].filter(Boolean).join('')

export function formatOutput({ total, items, more, errorText }) {
  if (!total || !items.length) return { ok: false, code: 'find_no_match', error: errorText || 'No matching elements found' }
  const head = `Found ${plural(total, 'matching element')}` + (more ? ` (showing first ${items.length}, use a more specific query to narrow results)` : '')
  const rows = items.map(itemLine)
  return { ok: true, text: [head, '', ...rows].join('\n') }
}

const scrub = (s, key) => (key ? String(s).split(key).join('***') : String(s))

// 发一次模型请求，返回模型文本；失败抛 Error（message 已抹密钥）
export async function askModel(cfg, prompt, fetchImpl = globalThis.fetch) {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
      signal: ctl.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`model request failed with HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('model response contained no text')
    return content
  } catch (e) {
    const msg = ctl.signal.aborted ? `model request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : String(e?.message ?? e)
    throw new Error(scrub(msg, cfg.key))
  } finally {
    clearTimeout(timer)
  }
}

const withCode = (code, message) => Object.assign(new Error(message), { code })

// 入口：{ enabled: false } 或 { enabled: true, text }；失败抛 find_exception / find_no_match
export async function findAi({ query, pageContent }, deps = {}) {
  const cfg = await loadConfig(deps.storage)
  if (!isEnabled(cfg)) return { enabled: false }
  let out
  try {
    out = await askModel(cfg, buildPrompt(query, pageContent), deps.fetch)
  } catch (e) {
    throw withCode('find_exception', `Failed to find element: ${scrub(e?.message ?? e, cfg.key)}`)
  }
  const r = formatOutput(parseModelOutput(out, pageContent))
  if (!r.ok) throw withCode(r.code, r.error)
  return { enabled: true, text: r.text }
}
