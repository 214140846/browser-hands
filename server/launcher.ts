// 认出拉起 native host 的浏览器：Chrome 系浏览器直接 fork 出 host，父进程就是浏览器主程序。
// 插件据此决定会话怎么圈标签（Arc 不能用标签组，见 extension/sessions.js）。
import { execFileSync } from 'node:child_process'

export type BrowserKind = 'arc' | 'chrome' | 'chrome-for-testing' | 'chromium' | 'unknown'

// 只看可执行文件路径里的 .app 包名，不看窗口标题之类会变的东西
export function browserFromPath(path: string): BrowserKind {
  if (path.includes('/Arc.app/')) return 'arc'
  if (path.includes('/Google Chrome for Testing.app/')) return 'chrome-for-testing'
  if (path.includes('/Google Chrome.app/')) return 'chrome'
  if (path.includes('/Chromium.app/')) return 'chromium'
  return 'unknown'
}

export function launchingBrowser(ppid = process.ppid): BrowserKind {
  try {
    return browserFromPath(execFileSync('ps', ['-o', 'comm=', '-p', String(ppid)], { encoding: 'utf8' }).trim())
  } catch {
    return 'unknown'
  }
}
