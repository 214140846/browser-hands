// background-tab 单测专用：真浏览器页面，承载被注入的页内拦截守卫。
// bun 里没有 DOM，按方案「单测机制」用 Playwright 打开静态 HTML（挂在假 http 源上，测同源 / 跨源规则要真 origin）。
import { chromium, type Browser, type Page } from 'playwright'

export const ORIGIN = 'http://t.test'
export const OTHER = 'http://other.test'

let browser: Browser | undefined

export async function startBrowser() {
  browser ??= await chromium.launch()
}

export async function stopBrowser() {
  await browser?.close()
  browser = undefined
}

// 打开一页：body 进 <body>，head 进 <head>；两个源下的任何路径都回一个空白页
export async function openPage(body: string, head = ''): Promise<Page> {
  if (!browser) throw new Error('browser not started')
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const html = `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
  await page.route(/^http:\/\/(t|other)\.test\//, (route) => {
    const u = new URL(route.request().url())
    const isLanding = u.origin === ORIGIN && u.pathname === '/'
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: isLanding ? html : '<p>elsewhere</p>' })
  })
  await page.goto(ORIGIN + '/')
  return page
}

// 统计这一页之后开出的新窗口（没被拦下的 _blank 点击会开）
export function countPopups(page: Page) {
  const seen: Page[] = []
  page.on('popup', (p) => void seen.push(p))
  return {
    get count() {
      return seen.length
    },
    close: () => Promise.all(seen.map((p) => p.close().catch(() => {}))),
  }
}
