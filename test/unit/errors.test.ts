import { describe, expect, test } from 'bun:test'
import * as mod from '../../extension/errors.js'
import { errorCode, INJECT_TIMEOUT_MS, pageLoadingError, toError, withTimeout } from '../../extension/errors.js'

const withCode = (msg: string, code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(msg), { code, ...extra })
const GENERIC = ['internal', 'computer_action_failed', 'tool_execution_exception']
const HINTED = [
  'navigated_away', 'ref_stale', 'tab_outside_group', 'tab_not_found', 'debugger_detached', 'debugger_attach_failed',
  'page_navigated_or_closed', 'page_loading', 'chrome_protected_page', 'blocked_by_other_extension', 'cdp_timeout',
  'input_invalid', 'element_unsupported', 'element_not_editable', 'navigate_beforeunload_blocked', 'navigate_no_history',
  'navigate_load_failed', 'coordinate_out_of_bounds', 'injected_script_failed', 'invalid_params', 'unknown_method',
]

// Chrome / CDP 原生报错样本（这些是浏览器的原话，作为输入，不是本模块文案）
const NATIVE: [string, string][] = [
  ['No tab with id: 42', 'tab_not_found'],
  ['No tab with given id 7.', 'tab_not_found'],
  ['No tab with id 3', 'tab_not_found'],
  ['Debugger is not attached to the tab with id: 1.', 'debugger_detached'],
  ['Detached while handling command.', 'debugger_detached'],
  ['Inspected target navigated or closed', 'page_navigated_or_closed'],
  ['Execution context was destroyed.', 'page_navigated_or_closed'],
  ['Cannot find default execution context', 'page_navigated_or_closed'],
  ['Cannot find context with specified id', 'page_navigated_or_closed'],
  ['Promise was collected', 'page_navigated_or_closed'],
  ['Object reference chain is too long', 'js_result_not_serializable'],
  ["Object couldn't be returned by value", 'js_result_not_serializable'],
  ['Cannot access a chrome-extension:// URL of different extension', 'blocked_by_other_extension'],
  ['Another debugger is already attached to the tab with id: 5.', 'debugger_attach_failed'],
  ['Cannot attach to this target.', 'debugger_attach_failed'],
  ['Cannot access a chrome:// URL', 'chrome_protected_page'],
  ['The extensions gallery cannot be scripted.', 'chrome_protected_page'],
  ['Frame with ID 12 was removed.', 'page_navigated_or_closed'],
  ['The frame was removed.', 'page_navigated_or_closed'],
  ['The tab was closed.', 'page_navigated_or_closed'],
  ['Cannot find a next page in history.', 'navigate_no_history'],
  ['Cannot find a previous page in history.', 'navigate_no_history'],
]

describe('导出面', () => {
  test('恰好五个导出', () => {
    expect(Object.keys(mod).sort()).toEqual(['INJECT_TIMEOUT_MS', 'errorCode', 'pageLoadingError', 'toError', 'withTimeout'])
  })
  test('INJECT_TIMEOUT_MS 为 45 秒', () => {
    expect(INJECT_TIMEOUT_MS).toBe(45000)
  })
})

describe('errorCode', () => {
  test.each(NATIVE)('无码 Error「%s」→ %s', (msg, code) => {
    expect(errorCode(new Error(msg))).toBe(code)
  })

  test('字符串输入同样归类', () => {
    expect(errorCode('No tab with id: 9')).toBe('tab_not_found')
  })

  test('去掉 CDP 的 JSON 包装再归类，负数码也可', () => {
    expect(errorCode(new Error('{"code":-32000,"message":"Execution context was destroyed."}'))).toBe('page_navigated_or_closed')
    expect(errorCode(new Error('{"code":123,"message":"No tab with id: 1"}'))).toBe('tab_not_found')
  })

  test('无法归类 → internal；null / undefined / 空 → internal', () => {
    expect(errorCode(new Error('随便什么'))).toBe('internal')
    expect(errorCode(null)).toBe('internal')
    expect(errorCode(undefined)).toBe('internal')
    expect(errorCode('')).toBe('internal')
  })

  test('无码时只认开头：报错正文中间出现不归类', () => {
    expect(errorCode(new Error('Error clicking: Execution context was destroyed'))).toBe('internal')
  })

  test('具体码优先，不看正文；未登记的自定义码原样返回', () => {
    expect(errorCode(withCode('No tab with id: 1', 'ref_stale'))).toBe('ref_stale')
    expect(errorCode(withCode('whatever', 'my_custom_code'))).toBe('my_custom_code')
    expect(errorCode({ code: 'input_invalid' })).toBe('input_invalid')
  })

  test('空串码视为没带码', () => {
    expect(errorCode(withCode('No tab with id: 1', ''))).toBe('tab_not_found')
  })

  test.each(GENERIC)('兜底码 %s：前缀包裹的原生报错也能归类', (g) => {
    expect(errorCode(withCode('Error clicking: Execution context was destroyed', g))).toBe('page_navigated_or_closed')
    expect(errorCode(withCode('No tab with id: 4', g))).toBe('tab_not_found')
    expect(errorCode(withCode('failed: Cannot access a chrome:// URL', g))).toBe('chrome_protected_page')
  })

  test.each(GENERIC)('兜底码 %s：归不了类时保留兜底码', (g) => {
    expect(errorCode(withCode('something odd', g))).toBe(g)
  })

  test('其他扩展页先于 chrome 内部页判定', () => {
    expect(errorCode(withCode('x: Cannot access a chrome-extension:// URL of different extension', 'internal'))).toBe('blocked_by_other_extension')
  })
})

describe('toError', () => {
  test('结构：code / message / hint，普通对象', () => {
    const r = toError(withCode('boom', 'ref_stale'))
    expect(r.code).toBe('ref_stale')
    expect(r.message).toBe('boom')
    expect(typeof r.hint).toBe('string')
    expect(r).not.toBeInstanceOf(Error)
    expect(Object.keys(r).sort()).toEqual(['code', 'hint', 'message'])
  })

  test.each(HINTED)('%s 有非空英文建议', (code) => {
    const { hint } = toError(withCode('x', code))
    expect(hint).toMatch(/[A-Za-z]{3}/)
    expect(hint).not.toMatch(/[一-鿿]/)
  })

  test('建议语义（宽松正则，新旧文案都应满足）', () => {
    const h = (c: string) => toError(withCode('x', c)).hint!
    expect(h('ref_stale')).toMatch(/read_page|find/)
    expect(h('tab_not_found')).toMatch(/tabs_context_mcp/)
    expect(h('tab_outside_group')).toMatch(/tabs_context_mcp|tabs_create_mcp/)
    expect(h('navigated_away')).toMatch(/read_page|tabs_context_mcp/)
    expect(h('page_navigated_or_closed')).toMatch(/read_page/)
    expect(h('chrome_protected_page')).toMatch(/navigate|https?/)
    expect(h('navigate_beforeunload_blocked')).toMatch(/force/)
    expect(h('element_unsupported')).toMatch(/input|select|textarea/)
    expect(h('debugger_detached')).toMatch(/retry/i)
    expect(h('unknown_method')).toMatch(/version/i)
  })

  test.each([...GENERIC, 'js_result_not_serializable', 'my_custom_code'])('%s 无建议：不出现 hint 键', (code) => {
    const r = toError(withCode('nothing matches here', code))
    expect('hint' in r).toBe(false)
  })

  test('自带 hint 优先于表', () => {
    expect(toError(withCode('x', 'ref_stale', { hint: 'mine' })).hint).toBe('mine')
    expect(toError(withCode('x', 'my_custom_code', { hint: 'mine' })).hint).toBe('mine')
  })

  test('code 走 errorCode 归类，message 保留原文', () => {
    const r = toError(new Error('No tab with id: 3'))
    expect(r.code).toBe('tab_not_found')
    expect(r.message).toBe('No tab with id: 3')
    expect(r.hint).toBeTruthy()
  })

  test('非 Error 输入：message 为其字符串形式', () => {
    expect(toError('plain').message).toBe('plain')
    expect(toError('plain').code).toBe('internal')
    expect(toError(null).message).toBe('null')
    expect(toError(undefined).message).toBe('undefined')
    expect(toError({ message: 5 }).message).toBe('5')
  })
})

describe('pageLoadingError', () => {
  test('Error + page_loading 码，消息带毫秒数和语义', () => {
    const e = pageLoadingError(30) as Error & { code: string }
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('page_loading')
    expect(e.message).toMatch(/\b30ms\b/)
    expect(e.message).toMatch(/busy|navigat/i)
    expect(toError(e).code).toBe('page_loading')
    expect(toError(e).hint).toBeTruthy()
  })
})

describe('withTimeout', () => {
  test('时限内成功：原值', async () => {
    expect(await withTimeout(Promise.resolve(7), 50, pageLoadingError)).toBe(7)
  })

  test('时限内失败：原因不变', async () => {
    const boom = new Error('boom')
    expect(await withTimeout(Promise.reject(boom), 50, pageLoadingError).catch((e) => e)).toBe(boom)
  })

  test('超时：以 makeError(ms) 失败，传入 ms', async () => {
    const calls: number[] = []
    const marker = { tag: 'timeout' }
    const err = await withTimeout(new Promise(() => {}), 20, (ms) => (calls.push(ms), marker)).catch((e) => e)
    expect(err).toBe(marker)
    expect(calls).toEqual([20])
  })

  test('超时配 pageLoadingError → page_loading', async () => {
    const err = await withTimeout(new Promise(() => {}), 30, pageLoadingError).catch((e) => e)
    expect(toError(err).code).toBe('page_loading')
    expect(err.message).toMatch(/\b30ms\b/)
  })

  test('提前结束后不再调用 makeError（计时器已清）', async () => {
    let called = 0
    await withTimeout(Promise.resolve(1), 20, () => (called++, new Error('t')))
    await withTimeout(Promise.reject(new Error('r')), 20, () => (called++, new Error('t'))).catch(() => {})
    await new Promise((r) => setTimeout(r, 60))
    expect(called).toBe(0)
  })
})

describe('补充边界', () => {
  test('JSON 前缀只按开头剥离；不符的按原文', () => {
    expect(errorCode('{"code":-1,"message":"The tab was closed."}')).toBe('page_navigated_or_closed')
    expect(errorCode('{"message":"No tab with id: 1","code":1}')).toBe('internal')
    expect(errorCode('{"code":"x","message":"No tab with id: 1"}')).toBe('internal')
  })

  test('匹配区分大小写', () => {
    expect(errorCode(new Error('no tab with id: 1'))).toBe('internal')
    expect(errorCode(withCode('x: EXECUTION CONTEXT WAS DESTROYED', 'internal'))).toBe('internal')
  })

  test('普通对象：正文为对象字符串形式，不归类；message 取字段', () => {
    expect(errorCode({ message: 'No tab with id: 1' })).toBe('internal')
    const r = toError({ message: 'No tab with id: 1' })
    expect(r.code).toBe('internal')
    expect(r.message).toBe('No tab with id: 1')
  })

  test('非字符串 code：真值原样返回，假值视为没带', () => {
    expect(errorCode(withCode('No tab with id: 1', 5 as any))).toBe(5 as any)
    expect(errorCode(withCode('No tab with id: 1', 0 as any))).toBe('tab_not_found')
  })

  test('空串 hint：不回落到表，也不出现 hint 键', () => {
    const r = toError(withCode('x', 'ref_stale', { hint: '' }))
    expect('hint' in r).toBe(false)
  })

  test('同时含两类报错按行序取靠前者', () => {
    expect(errorCode(withCode('x: The tab was closed; No tab with id: 1', 'internal'))).toBe('tab_not_found')
  })
})
