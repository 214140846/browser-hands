import { beforeEach, describe, expect, test } from 'bun:test'

// sessions 单测专用的假 chrome：标签 / 窗口 / 标签组 / storage.session，只模拟 sessions.js 用到的部分
type Fn = (...a: any[]) => any
const hub = () => {
  const ls = new Set<Fn>()
  return { addListener: (f: Fn) => void ls.add(f), fire: (...a: any[]) => Promise.all([...ls].map((f) => f(...a))) }
}
const tabs = new Map<number, { id: number; windowId: number; groupId: number; title?: string }>()
let nextTab = 100
let nextGroup = 1
const grouped: any[] = []
const updates: any[] = []
const store: Record<string, any> = {}
const onCreated = hub()
const onRemoved = hub()
const chrome: any = {
  storage: {
    session: {
      get: async (keys: string | string[]) => Object.fromEntries([keys].flat().filter((k) => k in store).map((k) => [k, store[k]])),
      set: async (o: object) => void Object.assign(store, o),
    },
  },
  windows: { getLastFocused: async () => ({ id: 1 }), getAll: async () => [{ id: 1 }] },
  tabs: {
    get: async (id: number) => {
      const t = tabs.get(id)
      if (!t) throw new Error(`No tab with id: ${id}`)
      return { ...t }
    },
    create: async ({ windowId }: { windowId: number }) => {
      const t = { id: nextTab++, windowId, groupId: -1 }
      tabs.set(t.id, t)
      return { ...t }
    },
    query: async ({ groupId }: { groupId: number }) => [...tabs.values()].filter((t) => t.groupId === groupId),
    group: async (arg: any) => {
      grouped.push(arg)
      const g = arg.groupId ?? nextGroup++
      for (const id of arg.tabIds) tabs.get(id)!.groupId = g
      return g
    },
    onCreated,
    onRemoved,
  },
  tabGroups: {
    get: async (id: number) => ({ id, title: '', color: 'grey' }),
    update: async (id: number, p: any) => void updates.push({ id, ...p }),
    onUpdated: hub(),
  },
}
;(globalThis as any).chrome = chrome
const { setBrowser } = await import('../../extension/browser.js')
const mod: any = await import('../../extension/sessions.js')
const { beginCall, endCall, joinGroup, admit, listTabs, tracksTabIds, setTask, closeSession } = mod

let sid = 0
const fresh = () => `s${++sid}`
const open = (windowId = 1, groupId = -1) => {
  const t = { id: nextTab++, windowId, groupId }
  tabs.set(t.id, t)
  return t
}

beforeEach(() => {
  grouped.length = 0
})

describe('Arc：清单模式', () => {
  beforeEach(async () => setBrowser('arc'))

  test('开会话：新开空白页当主标签，从不调 chrome.tabs.group', async () => {
    const s = await beginCall(fresh())
    endCall(s)
    expect(tracksTabIds(s)).toBe(true)
    expect(s.groupId).toBe(-1)
    expect(s.tabIds).toEqual([s.mainTabId])
    expect(tabs.has(s.mainTabId)).toBe(true)
    expect(grouped).toHaveLength(0)
    expect(store.browser).toBe('arc')
  })

  test('joinGroup 记进清单；admit 只放行清单里的标签', async () => {
    const s = await beginCall(fresh())
    const t = open()
    await joinGroup(s, t.id)
    expect(s.tabIds).toEqual([s.mainTabId, t.id])
    await admit(s, t.id)
    const other = open()
    expect(admit(s, other.id)).rejects.toMatchObject({ code: 'tab_outside_group' })
    expect((await listTabs(s)).map((x: any) => x.id)).toEqual([s.mainTabId, t.id])
    expect(grouped).toHaveLength(0)
    endCall(s)
  })

  test('不在清单里的无组标签不会被当成本会话的（不能按 groupId -1 查）', async () => {
    const s = await beginCall(fresh())
    open() // 用户自己的无组标签
    expect((await listTabs(s)).map((x: any) => x.id)).toEqual([s.mainTabId])
    endCall(s)
  })

  test('会话标签里开出的新标签自动并入；关掉的标签从清单划掉', async () => {
    const s = await beginCall(fresh())
    const child = open()
    await onCreated.fire({ id: child.id, openerTabId: s.mainTabId })
    expect(s.tabIds).toContain(child.id)
    tabs.delete(child.id)
    await onRemoved.fire(child.id)
    expect(s.tabIds).not.toContain(child.id)
    endCall(s)
  })

  test('主标签被关：清单里还有就接着用，都没了再新开', async () => {
    const s = await beginCall(fresh())
    endCall(s)
    const extra = open()
    await joinGroup(s, extra.id)
    tabs.delete(s.mainTabId)
    const s2 = await beginCall(s.id)
    expect(s2.mainTabId).toBe(extra.id)
    endCall(s2)
    tabs.delete(extra.id)
    const s3 = await beginCall(s.id)
    expect(tabs.has(s3.mainTabId)).toBe(true)
    expect(s3.tabIds).toEqual([s3.mainTabId])
    endCall(s3)
  })
})

describe('Chrome：组模式', () => {
  beforeEach(async () => setBrowser('chrome'))

  test('开会话建标签组，joinGroup 入组', async () => {
    const s = await beginCall(fresh())
    expect(tracksTabIds(s)).toBe(false)
    expect(s.groupId).toBeGreaterThan(0)
    expect(grouped).toHaveLength(1)
    const t = open()
    await joinGroup(s, t.id)
    expect(grouped[1]).toEqual({ tabIds: [t.id], groupId: s.groupId })
    await admit(s, t.id)
    endCall(s)
  })

  test('浏览器没有 chrome.tabGroups → 不论报的是谁都走清单模式', async () => {
    const saved = chrome.tabGroups
    delete chrome.tabGroups
    try {
      await setBrowser('chrome')
      const s = await beginCall(fresh())
      expect(tracksTabIds(s)).toBe(true)
      expect(grouped).toHaveLength(0)
      endCall(s)
    } finally {
      chrome.tabGroups = saved
    }
  })
})

describe('标签组显示名', () => {
  beforeEach(async () => setBrowser('chrome'))
  const key = (dir: string, h = Math.random().toString(16).slice(2, 10).padEnd(8, '0')) => `claude-code-${h}@${dir}`
  const lastTitle = () => updates.filter((u) => u.title !== undefined).at(-1)?.title

  test('显示名是目录名，随机后缀不进标题；内部 key 不变', async () => {
    const id = key('proj', 'a1b2c3d4')
    const s = await beginCall(id)
    expect(s.id).toBe(id)
    expect(s.name).toBe('proj')
    expect(store.sessions[id].name).toBe('proj')
    await endCallAndSync(s)
    expect(lastTitle()).toBe('✅ proj')
    expect(lastTitle()).not.toContain('a1b2c3d4')
    await closeSession(id)
  })

  test('旧格式 key（没有 @目录）退回用整个 key', async () => {
    const s = await beginCall('legacy-1')
    expect(s.name).toBe('legacy-1')
    await closeSession('legacy-1')
  })

  test('只有重名时才加后缀；关掉后名字释放', async () => {
    const a = await beginCall(key('dup'))
    const b = await beginCall(key('dup'))
    const c = await beginCall(key('dup'))
    const other = await beginCall(key('solo'))
    expect([a.name, b.name, c.name, other.name]).toEqual(['dup', 'dup·2', 'dup·3', 'solo'])
    await closeSession(b.id)
    const d = await beginCall(key('dup'))
    expect(d.name).toBe('dup·2')
    for (const s of [a, c, d, other]) await closeSession(s.id)
  })

  test('setTask：标题带任务名；清空后去掉；超长截断', async () => {
    const s = await beginCall(key('proj'))
    await setTask(s, '  修登录  ')
    expect(lastTitle()).toBe('⌛ proj · 修登录')
    await setTask(s, 'x'.repeat(100))
    expect(lastTitle()).toBe(`⌛ proj · ${'x'.repeat(40)}`)
    await setTask(s, '')
    expect(lastTitle()).toBe('⌛ proj')
    await closeSession(s.id)
  })

  test('任务名随会话存盘', async () => {
    const s = await beginCall(key('proj'))
    await setTask(s, '写文档')
    expect(store.sessions[s.id].task).toBe('写文档')
    await closeSession(s.id)
  })
})

// 空闲计时器要等 20s；测试里直接触发一次同步：用 setTask 的同名空串路径不行，改为设任务再清掉
async function endCallAndSync(s: any) {
  endCall(s)
  await setTask(s, 'tmp')
  await setTask(s, '')
}
