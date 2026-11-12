import { expect, test } from 'bun:test'
import { errorCode, pageLoadingError, toError, withTimeout } from '../extension/errors.js'

// Chrome / CDP 原生报错 → 固定错误码
const native: Array<[string, string]> = [
  ['No tab with id: 42', 'tab_not_found'],
  ['Debugger is not attached to the tab', 'debugger_detached'],
  ['{"code":-32000,"message":"Execution context was destroyed."}', 'page_navigated_or_closed'],
  ['Cannot access a chrome:// URL', 'chrome_protected_page'],
  ['Cannot find a next page in history', 'navigate_no_history'],
  ['随便什么', 'internal'],
]

test.each(native)('原生报错 %p 归类为 %p', (msg, want) => {
  expect(errorCode(new Error(msg))).toBe(want)
})

const withCode = (msg: string, code: string) => Object.assign(new Error(msg), { code })

test('自带具体码的错误保留原码并补 hint', () => {
  const out = toError(withCode('x', 'ref_stale'))
  expect(out).toMatchObject({ code: 'ref_stale' })
  expect(out.hint).toBeTruthy()
  expect(errorCode(withCode('No tab with id: 1', 'ref_stale'))).toBe('ref_stale')
})

test('兜底码遇到可识别的原生报错时改判为具体码', () => {
  const out = toError(withCode('Error clicking: Execution context was destroyed', 'computer_action_failed'))
  expect(out.code).toBe('page_navigated_or_closed')
})

test('withTimeout：按时完成原样返回，超时得到 page_loading 并注明时长', async () => {
  const ok = await withTimeout(Promise.resolve(7), 50, pageLoadingError)
  expect(ok).toBe(7)
  const late = await withTimeout(new Promise(() => {}), 30, pageLoadingError).then(() => null, (e) => e)
  expect(toError(late).code).toBe('page_loading')
  expect(String(late.message)).toContain('30ms')
})
