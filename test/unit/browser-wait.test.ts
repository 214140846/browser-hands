// host 还没报告过浏览器类型（storage.session 也是空的）时的行为；和 browser.test.ts 分开，因为模块状态不能重置
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
const { setBrowser, browserKind } = await import('../../extension/browser.js')

describe('browser：等 host_info', () => {
  test('没报告时先等，setBrowser 到了立刻返回报告的值', async () => {
    const started = Date.now()
    const a = browserKind()
    const b = browserKind()
    setTimeout(() => void setBrowser('arc'), 50)
    expect(await a).toBe('arc')
    expect(await b).toBe('arc')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
