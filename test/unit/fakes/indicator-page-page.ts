// indicator-page 单测专用夹具：经典脚本，bun 里没有 DOM，所以开真浏览器页面原样注入源码。
// 页面里没有扩展环境，注入前用 init script 放一个假的 chrome.runtime.sendMessage，把收到的消息记到页面数组里；
// 同时数一下 window / document 上新挂的事件监听，用来检查「注入时不挂监听」。
import { chromium, type Browser, type Page } from 'playwright'

const SCRIPT = await Bun.file(new URL('../../../extension/indicator-page.js', import.meta.url)).text()
const ORIGIN = 'http://ind.test'

let browser: Browser | undefined

export async function startBrowser() {
  browser ??= await chromium.launch()
}

export async function stopBrowser() {
  await browser?.close()
  browser = undefined
}

// resolve：sendMessage 返回成功的 Promise；reject：返回失败的 Promise（没有接收方时就是这样）
export type SendMode = 'resolve' | 'reject'

export interface Opened {
  page: Page
  errors: string[] // 页面里未捕获的异常 / 未处理的 Promise 拒绝
}

function setup(mode: SendMode) {
  const w = window as any
  w.__sent = []
  w.__listen = 0
  const orig = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (this: EventTarget, ...a: any[]) {
    if (this === window || this === document) w.__listen++
    return (orig as any).apply(this, a)
  }
  w.chrome = {
    runtime: {
      sendMessage(msg: unknown) {
        w.__sent.push(JSON.parse(JSON.stringify(msg)))
        return mode === 'reject' ? Promise.reject(new Error('no receiver')) : Promise.resolve(undefined)
      },
    },
  }
}

export async function openPage(body: string, opts: { mode?: SendMode; inject?: boolean } = {}): Promise<Opened> {
  if (!browser) throw new Error('browser not started')
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>Fixture</title><style>html,body{margin:0;background:#fff}</style></head><body>${body}</body></html>`,
    }),
  )
  await page.addInitScript(setup, opts.mode ?? 'resolve')
  await page.goto(ORIGIN + '/')
  if (opts.inject !== false) await inject(page)
  return { page, errors }
}

export const inject = (page: Page) => page.addScriptTag({ content: SCRIPT })

// 以全局作用域执行一次源码（等同经典脚本），返回执行期间 window / document 上新挂的监听数
export const injectCounting = (page: Page): Promise<number> =>
  page.evaluate((src) => {
    const w = window as any
    const before = w.__listen
    ;(0, eval)(src)
    return w.__listen - before
  }, SCRIPT)

// 在页面里调 window.__jevIndicator[op](...args)
export const call = (page: Page, op: string, ...args: unknown[]): Promise<any> =>
  page.evaluate(([o, a]) => (window as any).__jevIndicator[o as string](...(a as unknown[])), [op, args] as const)

export const sent = (page: Page): Promise<any[]> => page.evaluate(() => (window as any).__sent)

// 可访问树里所有 button 的名字（closed shadow 里的内容在这里也看得到）
export async function axButtons(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page)
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as any
  await cdp.detach()
  return nodes
    .filter((n: any) => !n.ignored && n.role?.value === 'button')
    .map((n: any) => String(n.name?.value ?? ''))
}

// 用调试协议穿透 closed shadow，对 Stop 按钮派发「脚本伪造」的点击（isTrusted 为 false）：
// 一次 click() 方法，一次手造 MouseEvent。返回找到的按钮数。
export async function forgeClicks(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page)
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as any
  const found: number[] = []
  const walk = (n: any) => {
    if (n.nodeName === 'BUTTON') found.push(n.backendNodeId)
    for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(c)
  }
  walk(root)
  for (const backendNodeId of found) {
    const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId })) as any
    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () { this.click(); this.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })) }`,
    })
  }
  await cdp.detach()
  return found.length
}
