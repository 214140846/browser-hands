// input 单测专用替身：假调试器（记录收到的命令）、自编的小键表、中止检查、页面内兜底、假 chrome。
// 只给 input 单测用，不是共享 fake。键表内容是测试自编的，不代表真实表。
type Listener = (...a: any[]) => void

export interface Sent { tabId: number; method: string; params: any }

export function makeDeps() {
  const state = {
    platform: 'mac', // 加载新实例前可改
    initialMode: undefined as string | undefined, // 模块加载时存储里的点击方式
    sent: [] as Sent[],
    // 返回 Error 则本次 send 以它 reject；返回其他值忽略
    failWith: undefined as undefined | ((c: Sent, n: number) => any),
    onSend: undefined as undefined | ((c: Sent, n: number) => void),
    platformCalls: 0,
    dom: [] as { fn: string; args: any[] }[],
  }
  const listeners: Listener[] = []

  const debuggerModule = {
    send: async (tabId: number, method: string, params?: any) => {
      const c = { tabId, method, params: structuredClone(params) }
      state.sent.push(c)
      const n = state.sent.length
      state.onSend?.(c, n)
      const err = state.failWith?.(c, n)
      if (err instanceof Error) throw err
      return {}
    },
  }

  // 键表：小写名 → { key, code, keyCode, text?, location?, isKeypad? }。条目用元组造，内容自编
  const row = ([name, k, c, vk, txt]: (string | number | undefined)[]) => [name, Object.assign({ key: k, code: c, keyCode: vk }, txt === undefined ? {} : { text: txt })]
  const KEYS: Record<string, any> = Object.fromEntries(
    [
      ['enter', 'Enter', 'Enter', 13, '\r'],
      ['tab', 'Tab', 'Tab', 9],
      ['space', ' ', 'Space', 32, ' '],
      [' ', ' ', 'Space', 32, ' '],
      ['left', 'ArrowLeft', 'ArrowLeft', 37],
      ['!', '!', 'Digit1', 49, '!'],
      ['?', '?', 'Slash', 191, '?'],
      ['/', '/', 'Slash', 191, '/'],
    ].map(row),
  )
  KEYS.padfive = { ...KEYS['/'], key: '5', code: 'Numpad5', keyCode: 101, text: '5', isKeypad: true, location: 3 }
  // Mac 编辑命令表：小写整串组合键 → 命令名或命令名数组（名字自编）
  const MAC_COMMANDS: Record<string, string | string[]> = { enter: 'cmdEnter', 'ctrl+a': 'cmdA', 'ctrl+o': ['c1', 'c2'], 'alt+ctrl+q': 'cmdQ' }

  const abortModule = {
    checkAbort: (signal?: AbortSignal) => {
      if (signal?.aborted) throw Object.assign(new Error('halted'), { code: 'stopped' })
    },
  }

  const rec = (fn: string) => async (...args: any[]) => {
    state.dom.push({ fn, args })
    if (fn === 'domClick') await args[5]?.()
    return 'dom-ok'
  }
  const domModule = Object.fromEntries(['Click', 'Hover', 'Wheel', 'Text', 'Key'].map((n) => ['dom' + n, rec('dom' + n)]))

  const chrome = {
    runtime: {
      getPlatformInfo: async () => {
        state.platformCalls++
        return { os: state.platform }
      },
    },
    storage: {
      local: { get: async (_k?: any) => (state.initialMode ? { clickMode: state.initialMode } : {}) },
      onChanged: { addListener: (f: Listener) => void listeners.push(f) },
    },
  }
  const fireStorage = (changes: any, area: string) => listeners.forEach((f) => f(changes, area))

  return { state, chrome, listeners, fireStorage, debuggerModule, keysModule: { KEYS, MAC_COMMANDS }, abortModule, domModule }
}
