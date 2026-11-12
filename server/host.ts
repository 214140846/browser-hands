// native host：Chrome 拉起（stdio 4 字节小端长度 + JSON），本地 unix socket 给 MCP 连（换行分隔 JSON）。只转发，不懂业务。
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { balanceInfo, saveSettings, settingsInfo } from './jev'
import { socketDir } from './paths'

const dir = socketDir()
const sockPath = join(dir, `${process.pid}.sock`)

// 转发时重写 id，回复/事件按它找回是哪条连接的哪个请求
let nextId = 1
const pending = new Map<number, { conn: Socket; id: unknown }>()

function toChrome(obj: unknown) {
  const body = Buffer.from(JSON.stringify(obj))
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length)
  process.stdout.write(Buffer.concat([head, body]))
}

function onConn(conn: Socket) {
  let buf = ''
  const sids = new Set<string>() // 这条连接用过的会话，断开时逐个通知插件
  conn.setEncoding('utf8')
  conn.on('data', (chunk: string) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (typeof msg.sessionId === 'string') sids.add(msg.sessionId)
        const hid = nextId++
        pending.set(hid, { conn, id: msg.id })
        toChrome({ ...msg, id: hid })
      } catch {}
    }
  })
  conn.on('error', () => {})
  conn.on('close', () => {
    for (const [k, v] of pending) if (v.conn === conn) pending.delete(k)
    for (const sessionId of sids) toChrome({ id: nextId++, method: 'session_closed', sessionId, params: {} }) // 回复无人认领，丢弃
  })
}

function shutdown() {
  rmSync(sockPath, { force: true })
  process.exit(0)
}

// 建目录并监听。自愈时新建一个 server，旧的只停接新连接：已连上的 MCP 不受影响
let server: Server | null = null
let healing = false
function listen() {
  // 先关旧的再建新的：Bun 关 unix socket 服务时会删同路径文件，顺序反了会把新文件删掉
  server?.close()
  server = null
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  rmSync(sockPath, { force: true })
  const next = createServer(onConn)
  healing = true
  next.once('error', () => {
    healing = false // 下一轮自愈再试
  })
  next.listen(sockPath, () => {
    server = next
    healing = false
    // 旧 server 关闭时可能异步删掉同路径的新文件；没了就交给下一轮自愈重建
    try { chmodSync(sockPath, 0o600) } catch {}
  })
}
listen()

// 自愈：socket 文件被外部删掉（系统清理、安全软件、手动删目录）就重新监听，生成新文件
const HEAL_INTERVAL_MS = Number(process.env.JEV_HEAL_INTERVAL_MS) || 5000
setInterval(() => {
  if (!healing && !existsSync(sockPath)) listen()
}, HEAL_INTERVAL_MS).unref()

// 来自 Chrome
let inbuf = Buffer.alloc(0)
process.stdin.on('data', (chunk: Buffer) => {
  inbuf = Buffer.concat([inbuf, chunk])
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32LE(0)
    if (inbuf.length < 4 + len) break
    const msg = JSON.parse(inbuf.subarray(4, 4 + len).toString('utf8'))
    inbuf = inbuf.subarray(4 + len)
    if (msg.method === 'jev_balance') {
      // 插件（状态小窗）问余额：host 自己读配置查，不经 MCP
      balanceInfo().then((result) => toChrome({ id: msg.id, result }))
      continue
    }
    if (msg.method === 'jev_settings_get' || msg.method === 'jev_settings_set') {
      // 设置页读 / 写 Jev 模型来源：key 只进不出
      try {
        toChrome({ id: msg.id, result: msg.method === 'jev_settings_get' ? settingsInfo() : saveSettings(msg.params ?? {}) })
      } catch (e: any) {
        toChrome({ id: msg.id, result: { error: String(e.message) } })
      }
      continue
    }
    const p = pending.get(msg.id)
    if (!p) continue
    if (msg.event === undefined) pending.delete(msg.id)
    if (!p.conn.destroyed) p.conn.write(JSON.stringify({ ...msg, id: p.id }) + '\n')
  }
})
process.stdin.on('end', shutdown) // Chrome 断开
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('exit', () => rmSync(sockPath, { force: true }))
