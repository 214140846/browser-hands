// page-scan 单测专用：真浏览器页面。page-scan 是注入网页的经典脚本，bun 里没有 DOM，
// 所以按方案「单测机制」用 Playwright 开静态 HTML，读脚本源码原样注入（不加 type=module）。
// 每条用例一张新页面，页面挂在假的 http 源上（同源 iframe、同源链接都要真 origin）。
import { chromium, type Browser, type Page } from 'playwright'

const SCRIPT = await Bun.file(new URL('../../../extension/page-scan.js', import.meta.url)).text()
export const ORIGIN = 'http://t.test'

let browser: Browser | undefined

export async function startBrowser() {
  browser ??= await chromium.launch()
}

export async function stopBrowser() {
  await browser?.close()
  browser = undefined
}

// pages：路径 → HTML；第一个键是落地页
export async function openPage(pages: Record<string, string>, size = { width: 800, height: 600 }): Promise<Page> {
  if (!browser) throw new Error('browser not started')
  const page = await browser.newPage({ viewport: size })
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname
    const body = pages[path]
    return body === undefined
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body })
  })
  await page.goto(ORIGIN + Object.keys(pages)[0])
  await inject(page)
  return page
}

export const inject = (page: Page) => page.addScriptTag({ content: SCRIPT })

// 在页面里调 window.__jevScan[op](...args)
export const call = (page: Page, op: string, ...args: unknown[]): Promise<any> =>
  page.evaluate(([o, a]) => (window as any).__jevScan[o as string](...(a as unknown[])), [op, args] as const)
