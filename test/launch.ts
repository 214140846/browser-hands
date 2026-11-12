import { join, resolve } from 'node:path'
import { chromium, type BrowserContext } from 'playwright'

const ext = join(resolve(import.meta.dir, '..'), 'extension')

// 测试共用启动：默认新无头模式（完整 Chromium，能加载插件），JEV_HEADED=1 才弹窗
// 等插件 service worker 起来再返回，免得测试拿到 undefined
export async function launchBrowser(userDataDir: string, env: Record<string, string>): Promise<BrowserContext> {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.JEV_HEADED !== '1',
    channel: 'chromium',
    viewport: null,
    env,
    // 调试器提示条会在 attach/detach 时出现消失，改变 innerHeight；固定窗口尺寸让有头无头一致
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--silent-debugger-extension-api', '--window-size=1280,800'],
  })
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker')
  return ctx
}

// 取文本里第一行能 JSON.parse 且是对象的行（说明文字可在 JSON 前后）
export function firstJson(text: string): any {
  for (const line of text.split('\n')) {
    try {
      const v = JSON.parse(line)
      if (v && typeof v === 'object') return v
    } catch {}
  }
  throw new Error('no JSON line in: ' + text.slice(0, 200))
}
