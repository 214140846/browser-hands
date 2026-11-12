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
}
