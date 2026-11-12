// jev_observe：给 server 端 jev_task 循环的结构化观察。主 frame + 各 iframe 各观察一次，iframe 的编号带前缀（跟 read_page 一致）。
// 动作刚触发跳转时标签可能还在 loading：先等 status=complete（事件，上限 LOAD_WAIT_MS），页面脚本被跳转打断就等完再试，最多 3 次。
import { scanAll } from './frames.js'
import { redactTitle, redactUrl } from './redact.js'
import { checkAbort } from './abort.js'

const LOAD_WAIT_MS = 8000

function settled(tabId, signal) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const onUpdated = (id, info) => id === tabId && info.status === 'complete' && finish()
    const timer = setTimeout(finish, LOAD_WAIT_MS)
    chrome.tabs.onUpdated.addListener(onUpdated)
    signal?.addEventListener('abort', finish, { once: true })
    chrome.tabs.get(tabId).then((t) => t.status !== 'loading' && finish(), finish) // 先注册监听再查，不漏事件
  })
}

export async function observe(tabId, { max = 240 }, signal) {
  let all
  for (let i = 0; ; i++) {
    checkAbort(signal)
    await settled(tabId, signal)
    checkAbort(signal)
    try {
      all = await scanAll(tabId, [{ max }], 'observe')
      break
    } catch (e) {
      if (i >= 2) throw e
    }
  }
  const main = all.find((f) => f.frameId === 0)?.result
  if (!main) throw Object.assign(new Error('The page returned nothing (it may be a protected page)'), { code: 'chrome_protected_page' })
  const elements = [...main.elements]
  for (const f of all) {
    if (f.frameId === 0) continue
    for (const e of f.result.elements) if (elements.length < max) elements.push({ ...e, ref: `f${f.frameId}:${e.ref}` })
  }
  return { ...main, url: redactUrl(main.url), title: redactTitle(main.title, main.url), elements, tabId }
}
