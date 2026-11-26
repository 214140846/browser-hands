import { describe, expect, test } from 'bun:test'
import { DEFAULT_MODEL, buildPrompt, findAi, formatOutput, isEnabled, parseModelOutput } from '../../extension/find-ai.js'

const TREE = ['button "Sign in" [ref_1]', 'link "Help" [ref_2]', 'textbox "Email" [ref_3]'].join('\n')
const KEY = 'sk-secret-123'
const store = (o: Record<string, string>) => ({ get: async () => o })
const cfg = { findAiBaseUrl: 'https://api.test/v1/', findAiKey: KEY }
const reply = (content: unknown, init: { ok?: boolean; status?: number; body?: string } = {}) => {
  const calls: any[] = []
  const fetch = async (url: string, opts: any) => {
    calls.push({ url, opts })
    return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => init.body ?? '' }
  }
  return { calls, fetch }
}

describe('isEnabled', () => {
  test('两项都非空才启用', () => {
    expect(isEnabled({ baseUrl: 'u', key: 'k' })).toBe(true)
    expect(isEnabled({ baseUrl: 'u', key: '' })).toBe(false)
    expect(isEnabled({ baseUrl: '  ', key: 'k' })).toBe(false)
    expect(isEnabled({ baseUrl: '', key: '' })).toBe(false)
  })
  test('findAi：缺 key / 缺 baseUrl / 全空 → enabled:false 且不发请求', async () => {
    for (const s of [{ findAiBaseUrl: 'u' }, { findAiKey: 'k' }, {}]) {
      const r = reply('x')
      expect(await findAi({ query: 'q', pageContent: TREE }, { storage: store(s), fetch: r.fetch })).toEqual({ enabled: false })
      expect(r.calls).toHaveLength(0)
    }
  })
})

describe('请求', () => {
  test('地址去末尾斜杠、头、体、默认模型', async () => {
    const r = reply('FOUND: 1\nSHOWING: 1\n---\nref_1 | button | Sign in | | x')
    await findAi({ query: 'sign in', pageContent: TREE }, { storage: store(cfg), fetch: r.fetch })
    const { url, opts } = r.calls[0]
    expect(url).toBe('https://api.test/v1/chat/completions')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(opts.body)
    expect(body.model).toBe(DEFAULT_MODEL)
    expect(body.max_tokens).toBe(800)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content).toContain('sign in')
    expect(body.messages[0].content).toContain(TREE)
  })
  test('自定义模型名', async () => {
    const r = reply('FOUND: 0\nERROR: none')
    await findAi({ query: 'q', pageContent: TREE }, { storage: store({ ...cfg, findAiModel: 'm-x' }), fetch: r.fetch }).catch(() => {})
    expect(JSON.parse(r.calls[0].opts.body).model).toBe('m-x')
  })
  test('提示词含格式要求', () => {
    const p = buildPrompt('q', TREE)
    for (const s of ['FOUND:', 'SHOWING:', '---', 'ref_X | role | name | type', 'MORE: Use a more specific query to see additional results', 'ERROR:', '20']) expect(p).toContain(s)
  })
})

describe('解析与输出', () => {
  const run = (t: string) => formatOutput(parseModelOutput(t, TREE))
  test('各类行；字段缺省', () => {
    const p = parseModelOutput('  FOUND: 3 \nSHOWING: 3\n---\nref_1 | button | Sign in | submit | main action\nref_2 | link | Help | \nref_3 | textbox | Email | input | ', TREE)
    expect(p.total).toBe(3)
    expect(p.items).toEqual([
      { ref: 'ref_1', role: 'button', name: 'Sign in', type: 'submit', description: 'main action' },
      { ref: 'ref_2', role: 'link', name: 'Help', type: undefined, description: undefined },
      { ref: 'ref_3', role: 'textbox', name: 'Email', type: 'input', description: undefined },
    ])
  })
  test('丢弃不存在的 ref 和段数不足的行', () => {
    const p = parseModelOutput('FOUND: 2\nref_99 | button | Fake | t | x\nref_1 | button | Only three', TREE)
    expect(p.items).toEqual([])
  })
  test('完整输出格式；plural / singular', () => {
    expect(run('FOUND: 1\nSHOWING: 1\n---\nref_1 | button | Sign in | submit | why')).toEqual({ ok: true, text: 'Found 1 matching element\n\n- ref_1: button "Sign in" (submit) - why' })
    const r = run('FOUND: 2\n---\nref_1 | button | Sign in | |\nref_2 | link |  | link | y') as any
    expect(r.text).toBe('Found 2 matching elements\n\n- ref_1: button "Sign in"\n- ref_2: link (link) - y')
  })
  test('MORE：标题追加展示数', () => {
    const r = run('FOUND: 45\nref_1 | button | A | | \nref_2 | link | B | | \nMORE: Use a more specific query to see additional results') as any
    expect(r.text.split('\n')[0]).toBe('Found 45 matching elements (showing first 2, use a more specific query to narrow results)')
  })
  test('total 为 0 / 无有效行 → find_no_match', () => {
    expect(run('FOUND: 0\nERROR: nothing here')).toEqual({ ok: false, code: 'find_no_match', error: 'nothing here' })
    expect(run('FOUND: 0')).toEqual({ ok: false, code: 'find_no_match', error: 'No matching elements found' })
    expect(run('FOUND: abc\nref_1 | a | b | c')).toMatchObject({ ok: false })
    expect(run('FOUND: 2\nref_77 | a | b | c')).toMatchObject({ ok: false, code: 'find_no_match' })
  })
})

describe('失败', () => {
  const go = (fetch: any, s = cfg) => findAi({ query: 'q', pageContent: TREE }, { storage: store(s), fetch }).then(() => null, (e) => e)
  test('非 2xx：find_exception，不含密钥', async () => {
    const e = await go(reply('x', { ok: false, status: 401, body: `bad key ${KEY}` }).fetch)
    expect(e.code).toBe('find_exception')
    expect(e.message).toStartWith('Failed to find element: ')
    expect(e.message).toContain('401')
    expect(e.message).not.toContain(KEY)
  })
  test('网络错误含密钥也被抹掉', async () => {
    const e = await go(async () => { throw new Error(`boom ${KEY}`) })
    expect(e.code).toBe('find_exception')
    expect(e.message).not.toContain(KEY)
  })
  test('响应没有文本', async () => {
    for (const c of [undefined, '', '   ', 5]) expect((await go(reply(c).fetch)).code).toBe('find_exception')
  })
  test('无匹配走 find_no_match', async () => {
    const e = await go(reply('FOUND: 0\nERROR: no login button').fetch)
    expect(e.code).toBe('find_no_match')
    expect(e.message).toBe('no login button')
  })
})
