import { describe, expect, test } from 'bun:test'
import * as mod from '../../extension/keys.js'
import { KEYS, MAC_COMMANDS } from '../../extension/keys.js'

const K = KEYS as Record<string, any>
const M = MAC_COMMANDS as Record<string, any>
// 调用方的读法：整串转小写后查表
const lookKey = (name: string) => K[name.toLowerCase()]
const lookCmd = (chord: string) => M[chord.toLowerCase()]
// 键事件三元组：[key, code, keyCode]
const tri = (e: any) => [e?.key, e?.code, e?.keyCode]
const asList = (v: unknown) => (Array.isArray(v) ? v : [v])

describe('导出形态', () => {
  test('只有两张表，都是普通对象', () => {
    expect(Object.keys(mod).sort()).toEqual(['KEYS', 'MAC_COMMANDS'])
    for (const t of [KEYS, MAC_COMMANDS]) {
      expect(typeof t).toBe('object')
      expect(t).not.toBeNull()
      expect(Array.isArray(t)).toBe(false)
    }
  })

  test('两张表的属性名全是小写', () => {
    for (const t of [K, M]) for (const name of Object.keys(t)) expect(name).toBe(name.toLowerCase())
  })

  test('大写名直接查表得不到，未知名得不到，原型成员名不是自有属性', () => {
    expect(K.Enter).toBeUndefined()
    expect(M['CMD+A']).toBeUndefined()
    expect(K['no-such-key']).toBeUndefined()
    expect(M['ctrl+alt+cmd+shift+nope']).toBeUndefined()
    for (const n of ['constructor', 'tostring', 'hasownproperty', '__proto__', 'valueof']) {
      expect(Object.hasOwn(K, n)).toBe(false)
      expect(Object.hasOwn(M, n)).toBe(false)
    }
  })
})

describe('KEYS 条目结构', () => {
  test('每个条目 key 非空、code 为字符串、keyCode 为 0–255 整数，text 若有恰为一个字符', () => {
    const names = Object.keys(K)
    expect(names.length).toBeGreaterThan(50)
    for (const n of names) {
      const e = K[n]
      expect(typeof e.key).toBe('string')
      expect(e.key.length).toBeGreaterThan(0)
      expect(typeof e.code).toBe('string')
      expect(Number.isInteger(e.keyCode)).toBe(true)
      expect(e.keyCode).toBeGreaterThanOrEqual(0)
      expect(e.keyCode).toBeLessThanOrEqual(255)
      if ('text' in e) expect([...e.text].length).toBe(1)
    }
  })

  test('单个字母和数字不收录（由调用方合成，区分大小写）', () => {
    for (let c = 97; c <= 122; c++) expect(Object.hasOwn(K, String.fromCharCode(c))).toBe(false)
    for (let d = 0; d <= 9; d++) expect(Object.hasOwn(K, String(d))).toBe(false)
  })
})

describe('KEYS 公开标准事实值', () => {
  test('回车：keyCode 13、code Enter，产生回车符；return 是别名', () => {
    const e = lookKey('Enter')
    expect(tri(e)).toEqual(['Enter', 'Enter', 13])
    expect(e.text).toBe('\r')
    expect(lookKey('RETURN')).toEqual(e)
  })

  test('小键盘回车标记为小键盘键', () => {
    expect([K.kp_enter.key, K.kp_enter.keyCode]).toEqual(['Enter', 13])
    expect(K.kp_enter.isKeypad).toBe(true)
    expect(K.kp_enter.text).toBe('\r')
  })

  test('Esc 与 Escape 相同，keyCode 27，不产生字符', () => {
    expect(tri(lookKey('Escape'))).toEqual(['Escape', 'Escape', 27])
    expect(lookKey('esc')).toEqual(lookKey('escape'))
    expect('text' in lookKey('escape')).toBe(false)
  })

  test('空格：space 与单个空格相同，key / text 都是空格', () => {
    expect(tri(K.space)).toEqual([' ', 'Space', 32])
    expect(K.space.text).toBe(' ')
    expect(K[' ']).toEqual(K.space)
  })

  test.each([
    ['Tab', 9],
    ['Backspace', 8],
    ['Delete', 46],
    ['Insert', 45],
    ['Home', 36],
    ['End', 35],
    ['PageUp', 33],
    ['PageDown', 34],
    ['CapsLock', 20],
    ['NumLock', 144],
  ])('命名键 %s：key 与 code 同名，keyCode %i，不产生字符', (name, vk) => {
    const e = lookKey(name)
    expect(tri(e)).toEqual([name, name, vk])
    expect('text' in e).toBe(false)
  })

  test('方向键：Windows 键码 37–40，长短写法、任意大小写都查得到', () => {
    const dirs: [string, number][] = [
      ['Left', 37],
      ['Up', 38],
      ['Right', 39],
      ['Down', 40],
    ]
    for (const [d, vk] of dirs) {
      const full = `Arrow${d}`
      const e = lookKey(full)
      expect(tri(e)).toEqual([full, full, vk])
      expect('text' in e).toBe(false)
      for (const form of [full.toUpperCase(), d, d.toUpperCase(), d.toLowerCase()]) expect(lookKey(form)).toEqual(e)
    }
  })

  test('功能键 F1–F12：keyCode 从 112 起连续，不产生字符', () => {
    for (let n = 1; n <= 12; n++) {
      const e = lookKey(`F${n}`)
      expect(tri(e)).toEqual([`F${n}`, `F${n}`, 111 + n])
      expect('text' in e).toBe(false)
    }
  })

  test('小键盘数字：keyCode 为 96 加数字，标记为小键盘键', () => {
    for (let n = 0; n <= 9; n++) {
      const e = K[`numpad${n}`]
      expect(tri(e)).toEqual([String(n), `Numpad${n}`, 96 + n])
      expect(e.isKeypad).toBe(true)
      if ('text' in e) expect(e.text).toBe(String(n))
    }
  })

  test('小键盘运算键', () => {
    expect(tri(K.numpadadd)).toEqual(['+', 'NumpadAdd', 107])
    expect(K.numpadadd.isKeypad).toBe(true)
    expect(tri(K.numpaddivide)).toEqual(['/', 'NumpadDivide', 111])
    expect(K.numpaddivide.isKeypad).toBe(true)
  })

  test('US 布局标点抽样：key 与 text 为字符本身', () => {
    expect(tri(K[';'])).toEqual([';', 'Semicolon', 186])
    expect(K[';'].text).toBe(';')
    expect(tri(K["'"])).toEqual(["'", 'Quote', 222])
    expect(K["'"].text).toBe("'")
    expect(tri(K['/'])).toEqual(['/', 'Slash', 191])
    expect(K['/'].text).toBe('/')
    expect(tri(K['['])).toEqual(['[', 'BracketLeft', 219])
    expect(K['['].text).toBe('[')
  })

  test('上档字符与同一物理键共用 code / keyCode，key 与 text 是上档字符本身', () => {
    // US 布局：上档字符 → 同键的下档字符
    const pairs: [string, string][] = [
      ['~', '`'],
      ['_', '-'],
      ['+', '='],
      ['{', '['],
      ['}', ']'],
      ['|', '\\'],
      [':', ';'],
      ['"', "'"],
      ['<', ','],
      ['>', '.'],
      ['?', '/'],
    ]
    for (const [up, down] of pairs) {
      expect(tri(K[up])).toEqual([up, K[down].code, K[down].keyCode])
      expect(K[up].text).toBe(up)
    }
    // 数字键上档：code 为 DigitN，keyCode 为数字的 ASCII 码
    const digitRow = ')!@#$%^&*('
    for (let n = 0; n <= 9; n++) {
      const ch = digitRow[n]
      expect(tri(K[ch])).toEqual([ch, `Digit${n}`, 48 + n])
      expect(K[ch].text).toBe(ch)
    }
  })
})

describe('MAC_COMMANDS', () => {
  test('值为字符串或非空字符串数组，选择器名不带冒号', () => {
    const entries = Object.entries(M)
    expect(entries.length).toBeGreaterThan(50)
    for (const [, v] of entries) {
      const list = asList(v)
      expect(list.length).toBeGreaterThan(0)
      for (const s of list) {
        expect(typeof s).toBe('string')
        expect(s).toMatch(/^[a-z][A-Za-z]*$/)
      }
    }
  })

  test('修饰键按 shift → ctrl → alt → cmd 排列', () => {
    const order = ['shift', 'ctrl', 'alt', 'cmd']
    for (const chord of Object.keys(M)) {
      const parts = chord.split('+')
      const mods = parts
        .slice(0, -1)
        .map((p) => order.indexOf(p))
        .filter((i) => i >= 0)
      expect(mods).toEqual([...mods].sort((a, b) => a - b))
    }
  })

  test.each([
    ['backspace', 'deleteBackward'],
    ['arrowLeft', 'moveLeft'],
    ['ArrowRight', 'moveRight'],
    ['Shift+ArrowRight', 'moveRightAndModifySelection'],
    ['alt+arrowleft', 'moveWordLeft'],
    ['alt+backspace', 'deleteWordBackward'],
    ['ctrl+a', 'moveToBeginningOfParagraph'],
    ['ctrl+e', 'moveToEndOfParagraph'],
    ['ctrl+k', 'deleteToEndOfParagraph'],
    ['cmd+backspace', 'deleteToBeginningOfLine'],
    ['cmd+arrowup', 'moveToBeginningOfDocument'],
    ['Shift+Cmd+ArrowRight', 'moveToRightEndOfLineAndModifySelection'],
    ['ctrl+tab', 'selectNextKeyView'],
    ['shift+ctrl+tab', 'selectPreviousKeyView'],
  ])('Apple 默认绑定：%s → %s', (chord, sel) => {
    expect(lookCmd(chord)).toBe(sel)
  })

  test('一键多命令的绑定是数组，顺序同 Apple 绑定表', () => {
    expect(M['ctrl+o']).toEqual(['insertNewlineIgnoringFieldEditor', 'moveBackward'])
    expect(M['alt+arrowup']).toEqual(['moveBackward', 'moveToBeginningOfParagraph'])
  })

  test('无独立绑定的 shift 组合退回去掉 shift 后的命令', () => {
    expect(M['shift+backspace']).toEqual(M.backspace)
    expect(M['shift+ctrl+arrowup']).toEqual(M['ctrl+arrowup'])
  })

  test('标准编辑快捷键', () => {
    expect(lookCmd('Cmd+A')).toBe('selectAll')
    expect(lookCmd('cmd+c')).toBe('copy')
    expect(lookCmd('cmd+x')).toBe('cut')
    expect(lookCmd('cmd+v')).toBe('paste')
    expect(lookCmd('cmd+z')).toBe('undo')
    expect(lookCmd('shift+cmd+z')).toBe('redo')
  })

  test('右方向键全名及其修饰组合都能用小写串查到', () => {
    for (const mods of ['', 'shift+', 'ctrl+', 'alt+', 'cmd+', 'shift+alt+', 'shift+cmd+']) {
      expect(Object.hasOwn(M, `${mods}arrowright`)).toBe(true)
    }
  })

  test('方向键短名与全名结果相同', () => {
    for (const d of ['up', 'down', 'left', 'right']) {
      for (const mods of ['', 'shift+', 'ctrl+', 'alt+', 'cmd+']) {
        expect(M[`${mods}${d}`]).toEqual(M[`${mods}arrow${d}`])
      }
    }
  })

  test('修饰键顺序不同的写法不要求命中（调用方不重排）', () => {
    expect(M['cmd+shift+z']).toBeUndefined()
  })
})
