import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOST_NAME = 'com.thundermcp.host'
export const PROTOCOL_VERSION = 1

// host 和 MCP 靠这个目录里的 <pid>.sock 对上。不放 /tmp：系统或安全软件会清掉长期没访问的文件，host 还活着但 MCP 找不到。
// unix socket 路径上限约 104 字节，~/.thundermcp/sock/<pid>.sock 足够短。
export function socketDir() {
  return process.env.JEV_SOCKET_DIR || join(homedir(), '.thundermcp', 'sock')
}

export const nativeHostDirs: Record<string, string> = {
  chrome: join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
  chromium: join(homedir(), 'Library/Application Support/Chromium/NativeMessagingHosts'),
  'chrome-for-testing': join(homedir(), 'Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts'),
  // Arc 不读自己的 Arc/User Data 目录：它编译时沿用了 Chrome 的路径，native host 清单只认 Chrome 这个目录
  // （ArcCore 里写死的是 Google/Chrome；1Password、Codex 的 Arc 支持也装在这里）。和 chrome 共用一份清单。
  arc: join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
}

// 借用别家目录的浏览器 → 目录的主人。卸载它时不删清单：那份文件主人也在用，删了主人会断连。
export const borrowedHostDir: Record<string, string> = { arc: 'chrome' }
