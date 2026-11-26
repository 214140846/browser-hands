// 老版本 host 不发 host_info：只等一次（3 秒），之后直接 unknown
import { describe, expect, test } from 'bun:test'

;(globalThis as any).chrome = {
  storage: { session: { get: async () => ({}), set: async () => {} } },
}
const { setBrowser, browserKind } = await import('../../extension/browser.js')

describe('browser：等不到 host_info', () => {
  test('超时返回 unknown，之后不再等；再报告仍生效', async () => {
    let t = Date.now()
    expect(await browserKind()).toBe('unknown')
    expect(Date.now() - t).toBeGreaterThanOrEqual(2900)
    t = Date.now()
    expect(await browserKind()).toBe('unknown')
    expect(Date.now() - t).toBeLessThan(100)
    await setBrowser('chrome')
    expect(await browserKind()).toBe('chrome')
  }, 6000)
})
