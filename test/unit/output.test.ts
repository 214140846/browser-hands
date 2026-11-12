import { afterEach, describe, expect, test } from 'bun:test'
import * as mod from '../../server/output.ts'
import { DEFAULT_MAX_OUTPUT_TOKENS, estimateTokens, isBatchable, makeHinter, maxOutputTokens, truncateOutput } from '../../server/output.ts'

const ENV = 'JEV_MAX_OUTPUT_TOKENS'
const saved = process.env[ENV]
afterEach(() => {
  if (saved === undefined) delete process.env[ENV]
  else process.env[ENV] = saved
})

const a = (n: number) => 'a'.repeat(n)

describe('导出面与常量', () => {
  test('恰好六个导出', () => {
    expect(Object.keys(mod).sort()).toEqual(['DEFAULT_MAX_OUTPUT_TOKENS', 'estimateTokens', 'isBatchable', 'makeHinter', 'maxOutputTokens', 'truncateOutput'])
  })
  test('默认上限为数字 8000', () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(8000)
  })
})

describe('estimateTokens', () => {
  test('空串为 0', () => expect(estimateTokens('')).toBe(0))
  test('ASCII 每 4 个 1 token，向上取整', () => {
    expect(estimateTokens(a(4))).toBe(1)
    expect(estimateTokens(a(5))).toBe(2)
    expect(estimateTokens(a(400))).toBe(100)
  })
  test('非 ASCII 每个码元 1 token', () => {
    expect(estimateTokens('你好')).toBe(2)
    expect(estimateTokens('你a')).toBe(2)
    expect(estimateTokens('ab你')).toBe(2)
    expect(estimateTokens(a(8) + '你你你')).toBe(5)
    expect(estimateTokens('😀')).toBe(2)
  })
  test('换行按 ASCII 计', () => {
    expect(estimateTokens('\n\n\n\n')).toBe(1)
  })
  test('127 属 ASCII，128 起不是', () => {
    expect(estimateTokens('\x7f'.repeat(4))).toBe(1)
    expect(estimateTokens('\x80'.repeat(4))).toBe(4)
  })
})

describe('maxOutputTokens', () => {
  test('未设置 / 空串 / 非数字 / 0 → 默认值', () => {
    delete process.env[ENV]
    expect(maxOutputTokens()).toBe(8000)
    for (const v of ['', 'abc', '0']) {
      process.env[ENV] = v
      expect(maxOutputTokens()).toBe(8000)
    }
  })
  test('正整数字符串 → 对应数字，且每次调用重新读取', () => {
    process.env[ENV] = '1234'
    expect(maxOutputTokens()).toBe(1234)
    process.env[ENV] = '77'
    expect(maxOutputTokens()).toBe(77)
    delete process.env[ENV]
    expect(maxOutputTokens()).toBe(8000)
  })
})

describe('truncateOutput 不截断', () => {
  test('未超限原样返回', () => {
    const t = 'hello\n\n世界\n'
    expect(truncateOutput(t, 100)).toBe(t)
    expect(truncateOutput('', 1)).toBe('')
  })
  test('恰好等于上限不截断，多 1 就截断', () => {
    expect(truncateOutput(a(40), 10)).toBe(a(40))
    expect(truncateOutput(a(41), 10)).not.toBe(a(41))
  })
  test('默认上限 8000：8000 不截断，8001 截断', () => {
    delete process.env[ENV]
    expect(truncateOutput(a(32000))).toBe(a(32000))
    expect(truncateOutput(a(32001))).not.toBe(a(32001))
  })
})

describe('truncateOutput 按行保留', () => {
  const line = a(12) // 估算 3，计价 3.25
  const text = Array(6).fill(line).join('\n')
  const count = (s: string) => s.split(line).length - 1

  test('上限 13：保留 4 行（累计恰为 13）', () => {
    const r = truncateOutput(text, 13)
    expect(r.startsWith([line, line, line, line].join('\n') + '\n\n')).toBe(true)
    expect(count(r)).toBe(4)
  })
  test('上限 12：保留 3 行（换行也计价）', () => {
    const r = truncateOutput(text, 12)
    expect(r.startsWith([line, line, line].join('\n') + '\n\n')).toBe(true)
    expect(count(r)).toBe(3)
  })
  test('不在行中间断开', () => {
    const lines = ['x'.repeat(40), 'y'.repeat(40), 'z'.repeat(40)]
    const r = truncateOutput(lines.join('\n'), 15)
    expect(r.startsWith(lines[0] + '\n\n')).toBe(true)
    expect(r.includes('y'.repeat(40))).toBe(false) // 被截掉的整行不出现
  })
  test('保留段是原文前缀，说明段在最后', () => {
    const r = truncateOutput(text, 7)
    const head = [line, line].join('\n')
    expect(text.startsWith(head)).toBe(true)
    expect(r.startsWith(head + '\n\n')).toBe(true)
    expect(r.length).toBeGreaterThan(head.length + 2)
  })
})

describe('truncateOutput 单行过长', () => {
  test('ASCII：上限 10 → 保留 40 个字符', () => {
    const r = truncateOutput(a(400), 10)
    expect(r.startsWith(a(40) + '\n\n')).toBe(true)
  })
  test('汉字：上限 5 → 保留 5 个字', () => {
    const t = '你'.repeat(50)
    const r = truncateOutput(t, 5)
    expect(r.startsWith('你'.repeat(5) + '\n\n')).toBe(true)
  })
  test('首行估算恰等于上限：仍按字符截取', () => {
    const r = truncateOutput(a(40) + '\n' + a(40), 10)
    expect(r.startsWith(a(40) + '\n\n')).toBe(true)
  })
  test('首行估算刚好超过上限：保留段延伸进第二行', () => {
    const r = truncateOutput(a(41) + '\nbbbb', 11)
    expect(r.startsWith(a(41) + '\nbb\n\n')).toBe(true)
  })
  test('首行估算小于上限：整行保留，不延伸', () => {
    const r = truncateOutput(a(36) + '\n' + 'b'.repeat(40), 10)
    expect(r.startsWith(a(36) + '\n\n')).toBe(true)
    expect(r.includes('b'.repeat(40))).toBe(false) // 被截掉的整行不出现
  })
  test('首行过长时后面的行也不保留', () => {
    const r = truncateOutput(a(400) + '\nTAIL', 10)
    expect(r.startsWith(a(40) + '\n\n')).toBe(true)
    expect(r.includes('TAIL')).toBe(false)
  })
})

describe('truncateOutput 说明段与上限来源', () => {
  test('含全文估算数、上限数、环境变量名、缩小范围的工具与参数名', () => {
    const r = truncateOutput(a(4 * 2345), 137)
    expect(r.includes('2345')).toBe(true)
    expect(r.includes('137')).toBe(true)
    expect(r.includes('JEV_MAX_OUTPUT_TOKENS')).toBe(true)
    expect(r.includes('read_page')).toBe(true)
    expect(r.includes('ref_id')).toBe(true)
    expect(r.includes('max_chars')).toBe(true)
  })
  test('缺省上限取调用时的环境变量', () => {
    const text = Array(20).fill(a(12)).join('\n')
    delete process.env[ENV]
    expect(truncateOutput(text)).toBe(text)
    process.env[ENV] = '20'
    const r = truncateOutput(text)
    expect(r).not.toBe(text)
    expect(r.includes('20')).toBe(true)
  })
  test('显式 max 优先于环境变量', () => {
    const text = Array(20).fill(a(12)).join('\n')
    process.env[ENV] = '5'
    expect(truncateOutput(text, 100000)).toBe(text)
  })
})

describe('isBatchable', () => {
  test('整个工具可批量，与 input 无关', () => {
    for (const n of ['navigate', 'tabs_context_mcp', 'upload_image', 'gif_creator', 'resize_window', 'file_upload', 'tabs_create_mcp']) {
      expect(isBatchable(n, undefined)).toBe(true)
      expect(isBatchable(n, null)).toBe(true)
      expect(isBatchable(n, { action: 'screenshot' })).toBe(true)
    }
  })
  test('computer 的可批量动作', () => {
    for (const action of ['key', 'type', 'wait', 'left_click_drag', 'left_click', 'scroll_to', 'hover', 'right_click', 'triple_click', 'double_click', 'scroll']) {
      expect(isBatchable('computer', { action })).toBe(true)
    }
  })
  test('computer 的其他动作 / 缺 input → false', () => {
    for (const action of ['screenshot', 'zoom', 'bogus', '']) expect(isBatchable('computer', { action })).toBe(false)
    expect(isBatchable('computer', undefined)).toBe(false)
    expect(isBatchable('computer', null)).toBe(false)
    expect(isBatchable('computer', {})).toBe(false)
  })
  test('其他工具一律 false，区分大小写', () => {
    for (const n of ['read_page', 'find', 'browser_batch', 'jev_task', 'get_page_text', 'NAVIGATE', 'Computer']) {
      expect(isBatchable(n, { action: 'left_click' })).toBe(false)
    }
  })
  test('永远返回布尔', () => {
    expect(typeof isBatchable('computer', undefined)).toBe('boolean')
    expect(typeof isBatchable('x', undefined)).toBe('boolean')
  })
})

describe('makeHinter', () => {
  const wrapped = (s: any) => typeof s === 'string' && s.startsWith('<system-reminder>') && s.endsWith('</system-reminder>')
  const isBatchHint = (s: any) => wrapped(s) && s.includes('browser_batch') && !s.includes('quick_task')
  const isClickHint = (s: any, n: number) => wrapped(s) && s.includes('quick_task') && s.includes(String(n))
  const click = (action = 'left_click') => ['computer', { action }] as const
  const shot = ['computer', { action: 'screenshot' }] as const
  const find = ['find', { query: 'x' }] as const
  const nav = ['navigate', { url: 'https://example.com' }] as const
  const wait = ['computer', { action: 'wait' }] as const

  function run(h: ReturnType<typeof makeHinter>, calls: ReadonlyArray<readonly [string, any]>) {
    return calls.map(([n, i]) => h.note(n, i, false))
  }

  test('连续两次可批量 → 第二次提醒；之后重新累计', () => {
    const h = makeHinter()
    const r = run(h, [nav, nav, nav, nav])
    expect(r[0]).toBeNull()
    expect(isBatchHint(r[1])).toBe(true)
    expect(r[2]).toBeNull()
    expect(isBatchHint(r[3])).toBe(true)
  })
  test('中间插入不可批量调用 → 不提醒', () => {
    expect(run(makeHinter(), [nav, find, nav])).toEqual([null, null, null])
  })
  test('browser_batch 与 jev_task 清零单调用计数', () => {
    expect(run(makeHinter(), [nav, ['browser_batch', { actions: [] }], nav])).toEqual([null, null, null])
    expect(run(makeHinter(), [nav, ['jev_task', {}], nav])).toEqual([null, null, null])
  })
  test('出错的调用既不提醒也不计数、不清零', () => {
    const h = makeHinter()
    expect(h.note('navigate', {}, false)).toBeNull()
    expect(h.note('navigate', {}, true)).toBeNull()
    expect(h.note('read_page', {}, true)).toBeNull()
    expect(isBatchHint(h.note('navigate', {}, false))).toBe(true)
  })
  test('computer 的 screenshot 清零，wait 计入', () => {
    expect(run(makeHinter(), [click(), shot, click()])).toEqual([null, null, null])
    const r = run(makeHinter(), [click(), wait])
    expect(r[0]).toBeNull()
    expect(isBatchHint(r[1])).toBe(true)
  })
  test('点击与截图交替，第 5 次点击给点击提醒并带数字 5，之后清零', () => {
    const h = makeHinter()
    const r = run(h, [click(), shot, click('double_click'), shot, click('triple_click'), shot, click('right_click'), shot, click()])
    expect(r.slice(0, 8).every((x) => x === null)).toBe(true)
    expect(isClickHint(r[8], 5)).toBe(true)
    expect(run(h, [click(), shot, click()])).toEqual([null, null, null])
  })
  test('zoom 不打断连点', () => {
    const zoom = ['computer', { action: 'zoom' }] as const
    const r = run(makeHinter(), [click(), zoom, click(), zoom, click(), zoom, click(), zoom, click()])
    expect(isClickHint(r[8], 5)).toBe(true)
  })
  test('点击数被其他调用清零', () => {
    const r = run(makeHinter(), [click(), shot, click(), shot, click(), shot, click(), shot, find, click()])
    expect(r.every((x) => x === null)).toBe(true)
  })
  test('jev_task 清零点击数', () => {
    const r = run(makeHinter(), [click(), shot, click(), shot, click(), shot, click(), shot, ['jev_task', {}], click()])
    expect(r.every((x) => x === null)).toBe(true)
  })
  test('批量内的点击按子动作累计，数字为累计值', () => {
    const acts = (n: number) => Array.from({ length: n }, () => ({ name: 'computer', input: { action: 'left_click' } }))
    expect(isClickHint(makeHinter().note('browser_batch', { actions: acts(5) }, false), 5)).toBe(true)
    expect(isClickHint(makeHinter().note('browser_batch', { actions: acts(7) }, false), 7)).toBe(true)
    const h = makeHinter()
    expect(h.note('browser_batch', { actions: acts(4) }, false)).toBeNull()
    expect(isClickHint(h.note(...click(), false), 5)).toBe(true)
  })
  test('批量内遇到别的子动作清零，截图类不清零', () => {
    const c = { name: 'computer', input: { action: 'left_click' } }
    const n = { name: 'navigate', input: {} }
    const s = { name: 'computer', input: { action: 'screenshot' } }
    expect(makeHinter().note('browser_batch', { actions: [c, c, c, n, c, c, c] }, false)).toBeNull()
    expect(isClickHint(makeHinter().note('browser_batch', { actions: [c, c, s, c, c, c] }, false), 5)).toBe(true)
  })
  test('两类条件同时满足只给点击提醒，并清零两个计数', () => {
    const h = makeHinter()
    const c = { name: 'computer', input: { action: 'left_click' } }
    expect(h.note('browser_batch', { actions: [c, c, c, c] }, false)).toBeNull()
    expect(h.note(...wait, false)).toBeNull()
    expect(isClickHint(h.note(...click(), false), 5)).toBe(true)
    expect(h.note(...wait, false)).toBeNull()
    expect(isBatchHint(h.note(...wait, false))).toBe(true)
  })
  test('批量提醒不清零点击数', () => {
    const h = makeHinter()
    const r = run(h, [click(), click(), click(), shot, click(), shot, click()])
    expect(isBatchHint(r[1])).toBe(true)
    expect(r[2]).toBeNull()
    expect(r.slice(3, 6).every((x) => x === null)).toBe(true)
    expect(isClickHint(r[6], 5)).toBe(true)
  })
  test('提醒器互相独立', () => {
    const h1 = makeHinter()
    const h2 = makeHinter()
    expect(h1.note('navigate', {}, false)).toBeNull()
    expect(h2.note('navigate', {}, false)).toBeNull()
    expect(isBatchHint(h1.note('navigate', {}, false))).toBe(true)
    expect(isBatchHint(h2.note('navigate', {}, false))).toBe(true)
  })
  test('畸形 input 不抛', () => {
    const h = makeHinter()
    expect(() => {
      h.note('browser_batch', undefined, false)
      h.note('browser_batch', null, false)
      h.note('browser_batch', { actions: 'x' }, false)
      h.note('browser_batch', { actions: [null, {}, 3, { name: 'computer' }] }, false)
      h.note('computer', null, false)
      h.note('whatever', undefined, false)
    }).not.toThrow()
  })
  test('未知工具首次调用返回 null', () => {
    expect(makeHinter().note('whatever', {}, false)).toBeNull()
  })
})
