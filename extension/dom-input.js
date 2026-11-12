// 调试器实在挂不上时的兜底：在页面里派发模拟事件（isTrusted 为 false，部分网站不认）。
// 参考老版 extension/lib/driver.js 的 domHover / domFill / domKey / scroll 思路。
import { KEYS } from './keys.js'
import { INJECT_TIMEOUT_MS, pageLoadingError, withTimeout } from './errors.js'

function pageOp(op, a) {
  // 落在同源 iframe 上就钻进去（坐标换成 iframe 内部的）；跨源进不去，停在 iframe 元素上
  const at = (x, y) => {
    let doc = document
    let el = doc.elementFromPoint(x, y) ?? doc.body
    while (el.tagName === 'IFRAME' && el.contentDocument) {
      const r = el.getBoundingClientRect()
      x -= r.left + el.clientLeft
      y -= r.top + el.clientTop
      doc = el.contentDocument
      el = doc.elementFromPoint(x, y) ?? doc.body
    }
    return el
  }
  const mouse = (el, type, x, y, extra = {}) =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, ...extra }))
  if (op === 'click') {
    const el = at(a.x, a.y)
    const button = a.button === 'right' ? 2 : 0
    mouse(el, 'mousemove', a.x, a.y)
    for (let i = 1; i <= a.count; i++) {
      mouse(el, 'mousedown', a.x, a.y, { button, detail: i })
      mouse(el, 'mouseup', a.x, a.y, { button, detail: i })
      if (button === 2) mouse(el, 'contextmenu', a.x, a.y, { button })
      else {
        el.focus?.()
        mouse(el, 'click', a.x, a.y, { detail: i })
        if (i === 2) mouse(el, 'dblclick', a.x, a.y, { detail: 2 })
      }
    }
  } else if (op === 'hover') {
    const el = at(a.x, a.y)
    mouse(el, 'mouseover', a.x, a.y)
    mouse(el, 'mouseenter', a.x, a.y, { bubbles: false })
    mouse(el, 'mousemove', a.x, a.y)
  } else if (op === 'text') {
    const el = document.activeElement
    if (el && 'value' in el) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
      const v = el.value.slice(0, el.selectionStart ?? el.value.length) + a.text + el.value.slice(el.selectionEnd ?? el.value.length)
      setter ? setter.call(el, v) : (el.value = v)
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: a.text, inputType: 'insertText' }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (el?.isContentEditable) document.execCommand('insertText', false, a.text)
  } else if (op === 'key') {
    const el = document.activeElement ?? document.body
    const init = { key: a.key, code: a.code, keyCode: a.keyCode, bubbles: true, cancelable: true, ...a.mods }
    el.dispatchEvent(new KeyboardEvent('keydown', init))
    if (a.key === 'Enter' && el.form) el.form.requestSubmit?.()
    el.dispatchEvent(new KeyboardEvent('keyup', init))
  } else if (op === 'wheel') {
    const el = at(a.x, a.y)
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: a.x, clientY: a.y, deltaX: a.dx, deltaY: a.dy }))
    let n = el
    while (n && n !== document.documentElement) {
      const o = getComputedStyle(n).overflowY
      if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) break
      n = n.parentElement
    }
    ;(n && n !== document.documentElement ? n : document.scrollingElement).scrollBy(a.dx, a.dy)
  }
}

const run = (tabId, op, a) =>
  withTimeout(chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageOp, args: [op, a] }), INJECT_TIMEOUT_MS, pageLoadingError)

export async function domClick(tabId, x, y, button, count, before) {
  await before?.()
  return run(tabId, 'click', { x, y, button, count })
}
export const domHover = (tabId, x, y) => run(tabId, 'hover', { x, y })
export const domWheel = (tabId, x, y, dx, dy) => run(tabId, 'wheel', { x, y, dx, dy })
export const domText = (tabId, text) => run(tabId, 'text', { text })
export async function domKey(tabId, chord) {
  const parts = chord.split('+')
  const name = parts.pop()
  const mods = {}
  for (const p of parts.map((x) => x.toLowerCase())) {
    if (p === 'shift') mods.shiftKey = true
    else if (p === 'alt') mods.altKey = true
    else if (p === 'ctrl' || p === 'control') mods.ctrlKey = true
    else mods.metaKey = true
  }
  const k = KEYS[name.toLowerCase()] ?? { key: name, code: '', keyCode: 0 }
  return run(tabId, 'key', { key: k.key ?? name, code: k.code, keyCode: k.keyCode ?? 0, mods })
}
