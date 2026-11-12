// iframe 支持：每个 frame 各扫一次，编号带 frame 前缀（主 frame 不带，如 `f2:ref_5`）；
// 按编号点击时在对应 frame 里算位置，再加上各层 iframe 在父页面里的偏移，换成主页面坐标。
// 偏移换算是新写的：跨源 iframe 拿不到 frameElement，改用「子 frame postMessage 给父 frame，父按 event.source 对上 iframe 元素」。

import { INJECT_TIMEOUT_MS, pageLoadingError, withTimeout } from './errors.js'

const PREFIX = /^f(\d+):(ref_\d+)$/

// 06 form_input 等直接用：'f2:ref_5' -> { frameId: 2, ref: 'ref_5' }；'ref_5' -> { frameId: 0, ref: 'ref_5' }
export function parseRef(ref) {
  const m = PREFIX.exec(ref)
  return m ? { frameId: Number(m[1]), ref: m[2] } : { frameId: 0, ref }
}

const call = (o, a) => window.__jevScan?.[o](...a) ?? null

// 在指定 frame 里调页内函数；没注入（刷新过或第一次读）才注入 page-scan.js，之后复用
export async function inPage(tabId, op, args, frameId = 0) {
  const target = { tabId, frameIds: [frameId] }
  const run = () =>
    withTimeout(chrome.scripting.executeScript({ target, func: call, args: [op, args] }), INJECT_TIMEOUT_MS, pageLoadingError).catch((e) => {
      // iframe 已被移除：编号作废
      if (frameId !== 0 && /No frame with id/.test(e?.message)) throw Object.assign(new Error(`Frame ${frameId} no longer exists, so its refs are invalid. Run read_page again.`), { code: 'ref_stale' })
      throw e
    })
  let [r] = await run()
  if (r?.result == null) {
    await withTimeout(chrome.scripting.executeScript({ target, files: ['page-scan.js'] }), INJECT_TIMEOUT_MS, pageLoadingError)
    ;[r] = await run()
  }
  if (r?.result == null) throw Object.assign(new Error('The page script returned no result'), { code: 'injected_script_failed' })
  return r.result
}

// 带 frame 前缀的编号 → 在对应 frame 里调页内函数，第一个参数换成 frame 内的本地编号
// 例：callOnRef(tabId, 'f2:ref_5', 'formInput', [value])  →  在 frame 2 里执行 window.__jevScan.formInput('ref_5', value)
export function callOnRef(tabId, ref, op, args = []) {
  const p = parseRef(ref)
  return inPage(tabId, op, [p.ref, ...args], p.frameId)
}

// 所有 frame 各扫一次，返回 [{frameId, result}]，主 frame 在最前；没注入的 frame 补注入后重试
export async function scanAll(tabId, args, op = 'scan') {
  const run = (target) => chrome.scripting.executeScript({ target, func: call, args: [op, args] })
  const results = await run({ tabId, allFrames: true })
  const missing = results.filter((r) => r.result == null).map((r) => r.frameId)
  if (missing.length) {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: missing }, files: ['page-scan.js'] })
    const again = await run({ tabId, frameIds: missing })
    for (const a of again) results[results.findIndex((r) => r.frameId === a.frameId)] = a
  }
  return results.filter((r) => r.result != null).sort((a, b) => a.frameId - b.frameId)
}

// 把一个 frame 的扫描结果里的编号加上前缀
export function prefixRefs(text, frameId) {
  return frameId === 0 ? text : text.replace(/\[(ref_\d+)\]/g, `[f${frameId}:$1]`)
}

// ---- iframe 偏移 ----
// 以下三个函数在页面里跑（经 executeScript 序列化），不能引用外部变量。
// 父 frame：监听子 frame 的探测消息，按 event.source 找到 iframe 元素，记下内容区左上角（父视口坐标）
function installProbe() {
  if (window.__jevProbe) return
  const P = (window.__jevProbe = { done: new Map(), waiters: new Map() })
  window.addEventListener('message', (e) => {
    const token = e.data && e.data.__jevProbe
    if (!token) return
    let off = null
    for (const f of document.querySelectorAll('iframe,frame')) {
      if (f.contentWindow !== e.source) continue
      const r = f.getBoundingClientRect()
      const cs = getComputedStyle(f)
      off = [r.left + f.clientLeft + parseFloat(cs.paddingLeft || 0), r.top + f.clientTop + parseFloat(cs.paddingTop || 0)]
      break
    }
    P.done.set(token, off)
    P.waiters.get(token)?.(off)
  })
}
function awaitProbe(token, ms) {
  const P = window.__jevProbe
  if (P.done.has(token)) return P.done.get(token)
  return new Promise((res) => {
    P.waiters.set(token, res)
    setTimeout(() => res(null), ms)
  })
}
function postProbe(token) {
  parent.postMessage({ __jevProbe: token }, '*')
  return true
}

// frame 内视口坐标 → 主页面视口坐标：逐层加上 iframe 内容区在父 frame 里的偏移
export async function toMainCoords(tabId, frameId, [x, y]) {
  if (frameId === 0) return [x, y]
  const frames = await chrome.webNavigation.getAllFrames({ tabId })
  const parentOf = new Map(frames.map((f) => [f.frameId, f.parentFrameId]))
  while (frameId !== 0) {
    const parentId = parentOf.get(frameId)
    if (parentId === undefined || parentId < 0) throw Object.assign(new Error(`Frame ${frameId} no longer exists`), { code: 'ref_stale' })
    const token = crypto.randomUUID()
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [parentId] }, func: installProbe })
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: postProbe, args: [token] })
    const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [parentId] }, func: awaitProbe, args: [token, 3000] })
    const off = r?.result
    if (!off) throw Object.assign(new Error(`Cannot find the iframe element for frame ${frameId}`), { code: 'computer_element_not_found' })
    x += off[0]
    y += off[1]
    frameId = parentId
  }
  return [x, y]
}

// 按编号取元素在主页面里的中心点（在所属 frame 里滚到正中，再换算坐标）；form_input 等需要点击坐标时可直接用
export async function locateRef(tabId, ref) {
  const { frameId, ref: local } = parseRef(ref)
  const r = await inPage(tabId, 'locate', [local], frameId)
  if (!r.success) throw Object.assign(new Error(r.error), { code: r.errorCode === 'ref_stale' ? 'ref_stale' : 'computer_element_not_found' })
  return toMainCoords(tabId, frameId, r.coordinates)
}
