// 浏览器注册表：一个 socket 一个浏览器。fs.watch 目录变化，每次调用前再补扫一次（合并成一次扫描）。
import { existsSync, mkdirSync, readdirSync, watch } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { openSocket, type Browser } from './browsers'
import { socketDir } from './paths'

const browsers = new Map<string, Browser>() // socket 路径 -> 浏览器
let inflight: Promise<void> | null = null
let watching = false
let selected = '' // profileId

async function scan() {
  const dir = socketDir()
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sock')) : []
  await Promise.all(
    files.map(async (f) => {
      const path = join(dir, f)
      if (browsers.has(path)) return
      const b = await openSocket(path)
      if (!b) return
      browsers.set(path, b)
      b.conn.onClose = () => browsers.get(path) === b && browsers.delete(path)
    }),
  )
}

export function refresh() {
  if (!watching) {
    watching = true
    const dir = socketDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    watch(dir, () => void refresh().catch(() => {})).on('error', () => {})
  }
  return (inflight ??= scan().finally(() => (inflight = null)))
}

export const online = () => [...browsers.values()].filter((b) => !b.conn.closed)

// 名称取值：用户起的名称 → 邮箱 → deviceId 前缀
export const browserName = (i: { profileId: string; profileName?: string; email?: string }) => i.profileName || i.email || i.profileId.slice(0, 8)

// 重新握手一次，拿最新的名称 / 邮箱（改名不用重启）
export async function refreshInfo() {
  await Promise.all(
    online().map((b) =>
      b.conn.call('hello').then(
        (info) => void (b.info = info),
        () => {},
      ),
    ),
  )
}

export function describe(list = online()) {
  const rows = list.map((b) => ({
    deviceId: b.info.profileId,
    name: browserName(b.info),
    email: b.info.email ?? '',
    osPlatform: b.info.platform ?? '',
    isLocal: true,
    onThisComputer: true,
    inUse: b.info.profileId === selected,
    extensionVersion: b.info.extensionVersion,
  }))
  const lines = rows.map((r) => `  • ${r.name}${r.email && r.email !== r.name ? ` <${r.email}>` : ''} (deviceId ${r.deviceId}, ${r.osPlatform})${r.inUse ? ' [current]' : ''}`)
  return `${JSON.stringify({ browsers: rows })}\n\nOnline browsers:\n${lines.join('\n') || '  (none)'}`
}

export function select(deviceId: string) {
  if (!online().some((b) => b.info.profileId === deviceId)) throw new Error(`No online browser with deviceId ${deviceId}`)
  selected = deviceId
}

// 给每个在线插件发连接请求，第一个点 Connect 的被选中；超时（一次性计时）返回 null
export async function switchBrowser(timeoutMs: number): Promise<Browser | null> {
  const list = online()
  const requestId = randomBytes(6).toString('hex')
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<null>((res) => (timer = setTimeout(() => res(null), timeoutMs)))
  const clicks = list.map((b) =>
    b.conn.call('connect_request', { requestId }).then(
      (r) => (r?.connected ? { b, name: r.profileName as string } : new Promise<never>(() => {})), // 取消/关窗：不算赢
      () => new Promise<never>(() => {}),
    ),
  )
  const won = await Promise.race([timeout, ...clicks])
  clearTimeout(timer!)
  for (const b of list) if (!won || b !== won.b) b.conn.call('connect_cancel', { requestId }).catch(() => {})
  if (!won) return null
  if (won.name) won.b.info.profileName = won.name
  selected = won.b.info.profileId
  return won.b
}

export type Pick = { browser: Browser } | { error: string; code?: string; none?: boolean }

export function pick(): Pick {
  const list = online()
  if (selected) {
    const b = list.find((x) => x.info.profileId === selected)
    if (b) return { browser: b }
    selected = '' // 报一次就清掉，下次剩一个时自动选
    return { code: 'browser_gone', error: `browser_gone: the selected browser disconnected.\n${describe(list)}` }
  }
  if (list.length === 1) return { browser: list[0] }
  if (!list.length) return { error: '', none: true }
  return { code: 'select_browser', error: `${list.length} browsers are online. Check them with list_connected_browsers, then pick one with select_browser.\n${describe(list)}` }
}
