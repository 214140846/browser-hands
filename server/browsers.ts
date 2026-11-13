// 扫 socket 目录，握手，清死 socket
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { HOST_NAME, nativeHostDirs, socketDir } from './paths'

export type HelloInfo = { profileId: string; profileName: string; email?: string; platform?: string; extensionVersion: string; protocolVersion: number }

export class Conn {
  private buf = ''
  private nextId = 1
  closed = false
  onClose?: () => void
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  constructor(private sock: Socket, readonly path: string) {
    sock.setEncoding('utf8')
    sock.on('data', (c: string) => {
      this.buf += c
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        if (!line.trim()) continue
        const m = JSON.parse(line)
        const w = this.waiting.get(m.id)
        if (!w || m.event !== undefined) continue
        this.waiting.delete(m.id)
        m.error ? w.reject(new Error(`${m.error.code ?? 'error'}: ${m.error.message}${m.error.hint ? `\nHint: ${m.error.hint}` : ''}`)) : w.resolve(m.result)
      }
    })
    const fail = () => {
      this.closed = true
      this.onClose?.()
      for (const w of this.waiting.values()) w.reject(new Error('browser_gone: connection to the browser was lost'))
      this.waiting.clear()
    }
    sock.on('close', fail)
    sock.on('error', fail)
  }
  call(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.sock.write(JSON.stringify({ id, sessionId, method, params }) + '\n')
    })
  }
  close() {
    this.sock.destroy()
  }
}

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(path)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

export type Browser = { conn: Conn; info: HelloInfo }

// 连上一个 socket 并握手；死 socket 删掉，插件没应答的不删
export async function openSocket(path: string): Promise<Browser | null> {
  let sock: Socket
  try {
    sock = await dial(path)
  } catch {
    rmSync(path, { force: true })
    return null
  }
  const conn = new Conn(sock, path)
  try {
    const info = await Promise.race([
      conn.call('hello'),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Handshake timed out')), 5000)),
    ])
    return { conn, info }
  } catch {
    conn.close()
    return null
  }
}

const pgrep = (pattern: string) =>
  new Promise<boolean>((ok) => execFile('pgrep', ['-f', pattern], (_e, stdout) => ok((stdout ?? '').trim().length > 0)))
const chromeRunning = () => pgrep('Google Chrome|Chromium|chrome-mac')
// Chrome 拉起的 host：打包版 `thundermcp.mjs host` / 带插件 origin，源码版 `server/host.ts`
const hostRunning = () => pgrep('thundermcp\\.mjs (host|chrome-extension://)|server/host\\.ts')

export async function explainNoBrowser(): Promise<string> {
  const manifests = Object.values(nativeHostDirs).filter((d) => existsSync(join(d, `${HOST_NAME}.json`)))
  if (!manifests.length && !process.env.JEV_SOCKET_DIR)
    return 'Cannot reach the browser: the host manifest is not installed. Run `bun run setup` in the v2 directory, then restart Chrome.'
  if (!(await chromeRunning())) return 'Cannot reach the browser: Chrome is not running. Open Chrome (with the Browser Hands extension installed).'
  if (await hostRunning()) {
    // 升级前的 host 把连接文件放在 /tmp，不会自愈，只能重启
    const legacy = `/tmp/thundermcp-${userInfo().username}`
    if (legacy !== socketDir() && existsSync(legacy) && readdirSync(legacy).some((f) => f.endsWith('.sock')))
      return `Cannot reach the browser: the running host is an old pre-upgrade version (its socket file is ${legacy}). Restart it with \`pkill -f 'thundermcp.mjs host'\`; Chrome will relaunch it.`
    return `Cannot reach the browser: the host is running but has no socket file (.sock) in ${socketDir()}. It was probably cleaned up and the host will recreate it within 5 seconds, so retry shortly. If it persists, the host and MCP may use different JEV_SOCKET_DIR values, or reload the Browser Hands extension at chrome://extensions (this restarts the host).`
  }
  return 'Cannot reach the browser: Chrome is open but no host has connected. The Browser Hands extension is probably not installed or is disabled (chrome://extensions), or the extension ID in the host manifest is wrong.'
}
