import { afterEach, describe, expect, test } from 'bun:test'
import * as mod from '../../extension/abort.js'
import { abortableSleep, checkAbort, stoppedError } from '../../extension/abort.js'

// 同步抛和返回被拒 Promise 两种失败形态都接住
async function settle(run: () => unknown): Promise<{ ok: boolean; value: any }> {
  try {
    return { ok: true, value: await run() }
  } catch (e) {
    return { ok: false, value: e }
  }
}
const isStopped = (e: any) => e instanceof Error && e.code === 'stopped'
const aborted = (...reason: unknown[]) => {
  const c = new AbortController()
  c.abort(...(reason as [unknown?]))
  return c.signal
}

// 在真实信号上统计 abort 监听的登记与摘除
function counted(signal: AbortSignal) {
  const live = new Set<unknown>()
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  ;(signal as any).addEventListener = (type: string, fn: any, opt?: any) => {
    if (type === 'abort') live.add(fn)
    return add(type, fn, opt)
  }
  ;(signal as any).removeEventListener = (type: string, fn: any, opt?: any) => {
    if (type === 'abort') live.delete(fn)
    return remove(type, fn, opt)
  }
  return live
}

const realSet = globalThis.setTimeout
const realClear = globalThis.clearTimeout
afterEach(() => {
  globalThis.setTimeout = realSet
  globalThis.clearTimeout = realClear
})

describe('导出面', () => {
  test('恰好三个导出', () => {
    expect(Object.keys(mod).sort()).toEqual(['abortableSleep', 'checkAbort', 'stoppedError'])
  })
})

describe('stoppedError', () => {
  test('Error 实例，code 为 stopped，message 非空', () => {
    const e: any = stoppedError()
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('stopped')
    expect(typeof e.message).toBe('string')
    expect(e.message.length).toBeGreaterThan(0)
  })
  test('每次返回新对象', () => {
    expect(stoppedError()).not.toBe(stoppedError())
  })
})

describe('checkAbort', () => {
  test('无信号 / null / 未中止 → 不抛，返回 undefined', () => {
    expect(checkAbort(undefined as any)).toBeUndefined()
    expect(checkAbort(null as any)).toBeUndefined()
    expect((checkAbort as any)()).toBeUndefined()
    expect(checkAbort(new AbortController().signal)).toBeUndefined()
  })
  test('已中止 → 同步抛 stopped', () => {
    let caught: any
    try {
      checkAbort(aborted())
    } catch (e) {
      caught = e
    }
    expect(isStopped(caught)).toBe(true)
  })
  test('不论 reason 是什么，抛的都是 stopped 而不是 reason', () => {
    const reason = new Error('reason-object')
    for (const s of [aborted('plain-text'), aborted(reason), aborted(42)]) {
      let caught: any
      try {
        checkAbort(s)
      } catch (e) {
        caught = e
      }
      expect(isStopped(caught)).toBe(true)
      expect(caught).not.toBe(reason)
    }
  })
  test('中止后才变红：同一信号前后两次检查', () => {
    const c = new AbortController()
    expect(() => checkAbort(c.signal)).not.toThrow()
    c.abort()
    expect(() => checkAbort(c.signal)).toThrow()
  })
})

describe('abortableSleep', () => {
  test('无信号：约 ms 后以 undefined 成功，不早到', async () => {
    const t0 = performance.now()
    const r = await settle(() => abortableSleep(60))
    expect(r.ok).toBe(true)
    expect(r.value).toBeUndefined()
    expect(performance.now() - t0).toBeGreaterThanOrEqual(55)
  })
  test('未中止的信号：照常等到点', async () => {
    const t0 = performance.now()
    const r = await settle(() => abortableSleep(40, new AbortController().signal))
    expect(r.ok).toBe(true)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(35)
  })
  test('ms 为 0 或负数：很快成功', async () => {
    for (const ms of [0, -5]) {
      const t0 = performance.now()
      const r = await settle(() => abortableSleep(ms, new AbortController().signal))
      expect(r.ok).toBe(true)
      expect(performance.now() - t0).toBeLessThan(200)
    }
  })
  test('返回值可 await（thenable）', () => {
    const p: any = abortableSleep(1)
    expect(typeof p?.then).toBe('function')
    return p
  })
  test('调用时已中止：立即以 stopped 失败，不等计时', async () => {
    const t0 = performance.now()
    const r = await settle(() => abortableSleep(5000, aborted('x')))
    expect(r.ok).toBe(false)
    expect(isStopped(r.value)).toBe(true)
    expect(performance.now() - t0).toBeLessThan(200)
  }, 2000)
  test('等待中被中止：立即以 stopped 失败，与 reason 无关', async () => {
    const c = new AbortController()
    const t0 = performance.now()
    realSet(() => c.abort(new Error('some reason')), 20)
    const r = await settle(() => abortableSleep(3000, c.signal))
    expect(r.ok).toBe(false)
    expect(isStopped(r.value)).toBe(true)
    expect(performance.now() - t0).toBeLessThan(500)
  }, 2000)
  test('同一信号上并行的多次等待都被中止', async () => {
    const c = new AbortController()
    const runs = [settle(() => abortableSleep(3000, c.signal)), settle(() => abortableSleep(3000, c.signal)), settle(() => abortableSleep(3000, c.signal))]
    realSet(() => c.abort(), 10)
    const rs = await Promise.all(runs)
    for (const r of rs) {
      expect(r.ok).toBe(false)
      expect(isStopped(r.value)).toBe(true)
    }
  }, 2000)
  test('成功之后再中止：无效果，不产生未处理拒绝', async () => {
    const c = new AbortController()
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const r = await settle(() => abortableSleep(5, c.signal))
      expect(r.ok).toBe(true)
      c.abort()
      await new Promise((res) => realSet(res, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
  test('正常结束后，本次登记的 abort 监听已摘掉', async () => {
    const c = new AbortController()
    const live = counted(c.signal)
    for (let i = 0; i < 3; i++) await abortableSleep(1, c.signal)
    expect(live.size).toBe(0)
  })
  test('被中止时清掉本次的计时器', async () => {
    const created: unknown[] = []
    const cleared: unknown[] = []
    globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => {
      const id = realSet(fn, ms, ...rest)
      created.push(id)
      return id
    }) as any
    globalThis.clearTimeout = ((id: any) => {
      cleared.push(id)
      return realClear(id)
    }) as any
    const c = new AbortController()
    const p = settle(() => abortableSleep(3000, c.signal))
    c.abort()
    const r = await p
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    expect(r.ok).toBe(false)
    expect(created.length).toBeGreaterThan(0)
    expect(created.every((id) => cleared.includes(id))).toBe(true)
  }, 2000)
})
