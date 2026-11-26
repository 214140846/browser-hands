// find 的逻辑：本地关键词打分，只认树里真实存在的元素。不调任何模型。

// meta 是 find_meta 带来的节点线索（findData 才有）；line 是 read_page 风格的一行文字，不塞 meta
export type TreeRow = { ref: string; role: string; name: string; line: string; meta?: { texts?: Record<string, unknown> } }

// 本地打分的文本：名字 + meta 里的线索字段（缺失跳过）。role / ref 不参与
// texts.text / texts.container 只对可交互元素算：非交互祖先（main、div…）的这两项是整棵后代的汇总，
// 算进来等于把整页文字记在自己头上，会让祖先和真正的目标平分，本地判定因此放弃、退到模型。
function scoreText(row: TreeRow) {
  const texts = row.meta?.texts ?? {}
  const base = [row.name, texts.label, texts.aria, texts.placeholder, texts.title, texts.alt, texts.value, texts.ids, texts.href]
  if (INTERACTIVE.has(row.role)) base.push(texts.text, texts.container)
  return base.filter((v): v is string => typeof v === 'string' && v.length > 0).join(' ')
}

const ROW = /^\s*(\S+)(?: "((?:[^"\\]|\\.)*)")? \[((?:f\d+:)?ref_\d+)\](.*)$/

// read_page(filter: all) 的每一行 → 行对象；不是元素行（截断提示等）丢掉
export function parseTree(pageContent: string): TreeRow[] {
  const rows: TreeRow[] = []
  for (const l of pageContent.split('\n')) {
    const m = l.match(ROW)
    if (m) rows.push({ ref: m[3], role: m[1], name: (m[2] ?? '').replace(/\\"/g, '"'), line: `${m[1]}${m[2] !== undefined ? ` "${m[2]}"` : ''}${m[4]}` })
  }
  return rows
}

// 关键词：英文按词、中日韩按单字，转小写，去掉太短的英文词
function tokens(q: string): string[] {
  const t = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const out = new Set<string>()
  for (const w of t) {
    if (/[㐀-鿿぀-ヿ가-힯]/.test(w)) for (const c of w) out.add(c)
    else if (w.length > 1) out.add(w)
  }
  return [...out]
}

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'switch', 'searchbox', 'menuitem', 'tab', 'option', 'slider', 'spinbutton'])
// 地标 / 结构角色：比纯文本行更可能是目标，但排在可交互元素之后
const LANDMARK = new Set(['heading', 'main', 'navigation', 'region', 'banner', 'contentinfo', 'complementary', 'article', 'form', 'search', 'dialog', 'alertdialog', 'list', 'listitem', 'table', 'row', 'cell'])

// 候选优先级：可交互 0 > 地标 1 > 纯文本/其它 2
const rankOf = (role: string) => (INTERACTIVE.has(role) ? 0 : LANDMARK.has(role) ? 1 : 2)

// 本地粗筛：命中关键词的行进候选，最多 max 行。
// 排序规则：先按等级（可交互 > 地标 > 文本），同等级再按命中数。
// 这样可交互元素数量 ≥ max 时，前 max 名不会被同名文本行占满；文本节点只在还有空位时补位。
export function prefilter(rows: TreeRow[], query: string, max = 60): TreeRow[] {
  const tk = tokens(query)
  const scored = rows
    .map((r, i) => ({ r, i, s: tk.reduce((n, t) => n + (scoreText(r).toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => rankOf(a.r.role) - rankOf(b.r.role) || b.s - a.s || a.i - b.i)
    .slice(0, max)
    .map((x) => x.r)
  if (scored.length >= 8) return scored
  const seen = new Set(scored.map((r) => r.ref))
  for (const r of rows) {
    if (scored.length >= max) break
    if (!seen.has(r.ref) && INTERACTIVE.has(r.role)) scored.push(r)
  }
  return scored
}

export type Candidate = { ref: string; role: string; label: string; p: number }
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d

// find：按关键词命中数打分，最多取 max 个；命中数相同时可交互 > 地标 > 文本，再按页面顺序。
// p 是命中数相对最高分的比值（最高为 1），不是概率。没有任何命中返回空数组。
export function findLocal(rows: TreeRow[], query: string, max = 20): Candidate[] {
  const tk = tokens(query)
  if (!tk.length) return []
  const scored = rows
    .map((r, i) => ({ r, i, s: tk.reduce((n, t) => n + (scoreText(r).toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || rankOf(a.r.role) - rankOf(b.r.role) || a.i - b.i)
  if (!scored.length) return []
  const top = scored[0].s
  return scored.slice(0, max).map((x) => ({ ref: x.r.ref, role: x.r.role, label: x.r.name, p: round(x.s / top) }))
}

// find 的返回文字：Claude 格式 "Found N matching element(s)" + "- ref: role "name" - 说明"
export function formatFind(candidates: Candidate[]): { ok: true; text: string } | { ok: false; error: string } {
  if (!candidates.length) return { ok: false, error: 'No matching elements found' }
  const lines = candidates.map((c) => `- ${c.ref}: ${c.role}${c.label ? ` "${c.label}"` : ''} - match ${c.p}`)
  return { ok: true, text: `Found ${candidates.length} matching element${candidates.length === 1 ? '' : 's'}\n\n${lines.join('\n')}` }
}
