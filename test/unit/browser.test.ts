import { describe, expect, test } from 'bun:test'

const store: Record<string, unknown> = {}
;(globalThis as any).chrome = {
  storage: {
    session: {
      get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
      set: async (o: object) => void Object.assign(store, o),
    },
  },
}
store.browser = 'chrome' // 模拟 service worker 重启前存下的值
const { setBrowser, browserKind } = await import('../../extension/browser.js')

describe('browser', () => {
  test('重启后读回存储里的值', async () => {
    expect(await browserKind()).toBe('chrome')
  })
  test('setBrowser 后立即生效并写进存储', async () => {
    await setBrowser('arc')
    expect(await browserKind()).toBe('arc')
    expect(store.browser).toBe('arc')
  })
  test.each([[undefined], [3], [{}]])('非字符串 %p → unknown', async (v) => {
    await setBrowser(v)
    expect(await browserKind()).toBe('unknown')
  })
})
