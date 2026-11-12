// 真实输入：经 CDP Input 域发鼠标 / 键盘事件；调试器挂不上或设置为页面内模拟时退到 dom-input
import { send } from './debugger.js'
import { KEYS, MAC_COMMANDS } from './keys.js'
import { checkAbort } from './abort.js'
import { domClick, domHover, domWheel, domText, domKey } from './dom-input.js'

// ---------- 设置项：点击方式 ----------
let useDom = false
const modeReady = (async () => {
  try {
    const got = await chrome.storage.local.get('clickMode')
    useDom = got?.clickMode === 'dom'
  } catch {
    useDom = false
  }
})()
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes || !('clickMode' in changes)) return
  useDom = changes.clickMode?.newValue === 'dom'
})

// 统一调度：页面内模式直接兜底；调试器挂不上再兜底；其他错误原样抛
async function route(viaCdp, viaDom) {
  await modeReady
  if (useDom) return viaDom()
  try {
    return await viaCdp()
  } catch (err) {
    if (err?.code === 'debugger_attach_failed') return viaDom()
    throw err
  }
}

// ---------- 平台 ----------
let macPromise = null
export function isMac() {
  macPromise ??= chrome.runtime.getPlatformInfo().then((p) => p?.os === 'mac')
  return macPromise
}

// ---------- 修饰键 ----------
const MOD_BITS = new Map([
  ['alt', 1],
  ['ctrl', 2], ['control', 2],
  ['meta', 4], ['cmd', 4], ['command', 4], ['win', 4], ['windows', 4],
  ['shift', 8],
])

export function modifierMask(names) {
  let mask = 0
  for (const seg of String(names).split('+')) mask |= MOD_BITS.get(seg.trim().toLowerCase()) ?? 0
  return mask
}

// ---------- 缩放快捷键 ----------
const ZOOM_IN = new Set(['+', '=', 'plus', 'add', 'numpadadd'])
const ZOOM_OUT_RESET = new Set(['-', 'minus', 'subtract', 'numpadsubtract', '0', 'numpad0'])

export function isZoomChord(chord) {
  if (typeof chord !== 'string') return false
  let s = chord.trim().toLowerCase()
  let main
  if (s.endsWith('++')) {
    main = '+'
    s = s.slice(0, -2)
  } else {
    const cut = s.lastIndexOf('+')
    main = s.slice(cut + 1).trim()
    s = cut < 0 ? '' : s.slice(0, cut)
  }
  const mods = s ? s.split('+').map((x) => x.trim()) : []
  let ctl = false, shift = false
  for (const m of mods) {
    const bit = MOD_BITS.get(m)
    if (bit === 2 || bit === 4) ctl = true
    else if (bit === 8) shift = true
    else return false // alt 或认不出的段
  }
  if (!ctl) return false
  if (ZOOM_IN.has(main)) return true
  return !shift && ZOOM_OUT_RESET.has(main)
}

// ---------- 鼠标 ----------
const BUTTON_MASK = { left: 1, right: 2, middle: 4 }

const mouseEvent = (tabId, type, x, y, extra = {}) =>
  send(tabId, 'Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), modifiers: 0, ...extra })

export function click(tabId, x, y, button = 'left', count = 1, modifiers = 0, before) {
  const mods = Math.trunc(modifiers) || 0
  return route(
    async () => {
      await mouseEvent(tabId, 'mouseMoved', x, y, { modifiers: mods, buttons: 0 })
      for (let i = 1; i <= count; i++) {
        if (before) await before()
        await mouseEvent(tabId, 'mousePressed', x, y, { modifiers: mods, button, buttons: BUTTON_MASK[button] ?? 0, clickCount: i })
        await mouseEvent(tabId, 'mouseReleased', x, y, { modifiers: mods, button, buttons: 0, clickCount: i })
      }
    },
    () => domClick(tabId, x, y, button, count, before),
  )
}

export function hover(tabId, x, y) {
  return route(() => mouseEvent(tabId, 'mouseMoved', x, y, { buttons: 0 }), () => domHover(tabId, x, y))
}

export function wheel(tabId, x, y, deltaX, deltaY) {
  return route(
    () => mouseEvent(tabId, 'mouseWheel', x, y, { deltaX, deltaY }),
    () => domWheel(tabId, x, y, deltaX, deltaY),
  )
}

// 拖拽只走调试器；步数按距离定，每 20 像素一步，至少 2 步、最多 24 步
export async function drag(tabId, from, to, signal) {
  checkAbort(signal)
  const [x0, y0] = from
  const [x1, y1] = to
  const steps = Math.min(24, Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 20)))
  await mouseEvent(tabId, 'mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1 })
  let at = [x0, y0]
  try {
    for (let i = 1; i <= steps; i++) {
      checkAbort(signal)
      at = [x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps]
      await mouseEvent(tabId, 'mouseMoved', at[0], at[1], { button: 'left', buttons: 1 })
    }
  } catch (err) {
    if (err?.code === 'stopped') {
      // 松开左键再报中止；松开失败不盖过中止
      await mouseEvent(tabId, 'mouseReleased', at[0], at[1], { button: 'left', buttons: 0, clickCount: 1 }).catch(() => {})
    }
    throw err
  }
  await mouseEvent(tabId, 'mouseReleased', x1, y1, { button: 'left', buttons: 0, clickCount: 1 })
}

// ---------- 键盘 ----------
// 美式键盘上要按 Shift 才出的符号
const SHIFTED = new Set('!@#$%^&*()_+{}|:"<>?~')

// 名字 → 键定义；单字母 / 单数字现场合成（KEYS 有同名条目则用条目）
function keyDefOf(name) {
  const lower = name.toLowerCase()
  if (KEYS[lower]) return KEYS[lower]
  if (/^[a-zA-Z]$/.test(name)) {
    const up = name.toUpperCase()
    return { key: name, code: 'Key' + up, keyCode: up.charCodeAt(0), text: name }
  }
  if (/^[0-9]$/.test(name)) return { key: name, code: 'Digit' + name, keyCode: name.charCodeAt(0), text: name }
  return null
}

// 一次按键：按下 + 抬起
async function pressKey(tabId, def, modifiers, commands = []) {
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers, location: def.location ?? 0 }
  if (def.isKeypad) base.isKeypad = true
  const down = def.text
    ? { ...base, type: 'keyDown', text: def.text, unmodifiedText: def.text }
    : { ...base, type: 'rawKeyDown', text: '', unmodifiedText: '' }
  if (commands.length) down.commands = commands
  await send(tabId, 'Input.dispatchKeyEvent', down)
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

const insertRaw = (tabId, text) => send(tabId, 'Input.insertText', { text })

export function type(tabId, text, signal) {
  return route(
    async () => {
      for (const ch of text) {
        checkAbort(signal)
        if (ch === '\n' || ch === '\r') {
          await pressKey(tabId, keyDefOf('enter'), 0)
          continue
        }
        const def = keyDefOf(ch)
        if (!def) {
          await insertRaw(tabId, ch)
          continue
        }
        const shift = (ch >= 'A' && ch <= 'Z') || SHIFTED.has(ch)
        await pressKey(tabId, def, shift ? 8 : 0)
      }
    },
    () => domText(tabId, text),
  )
}

const badChord = (chord, why) => Object.assign(new Error(`Invalid key chord "${chord}": ${why}`), { code: 'invalid_params' })

// 解析组合键：返回 { mask, def }，非法时抛 invalid_params
function parseChord(chord) {
  let mask = 0
  let main = ''
  for (const raw of chord.split('+')) {
    const seg = raw.trim()
    if (!seg) continue
    const bit = MOD_BITS.get(seg.toLowerCase())
    if (bit) mask |= bit
    else main = seg // 多个非修饰段时取最后一个
  }
  if (!main) throw badChord(chord, 'missing main key')
  const def = keyDefOf(main)
  if (!def) throw badChord(chord, `unknown key "${main}"`)
  return { mask, def }
}

export function key(tabId, chord) {
  return route(
    async () => {
      if (!chord.includes('+')) {
        const def = keyDefOf(chord)
        return def ? pressKey(tabId, def, 0) : insertRaw(tabId, chord)
      }
      const { mask, def } = parseChord(chord)
      let commands = []
      if (await isMac()) {
        const hit = MAC_COMMANDS[chord.toLowerCase()]
        commands = hit === undefined ? [] : Array.isArray(hit) ? [...hit] : [hit]
      }
      return pressKey(tabId, def, mask, commands)
    },
    () => domKey(tabId, chord),
  )
}

export function insertText(tabId, text) {
  return route(() => insertRaw(tabId, text), () => domText(tabId, text))
}
