// 按键数据模块：按公开标准（W3C UI Events code/key、Windows VK、Apple 默认键绑定）按规则生成两张查找表。
// 纯数据，无 import、无副作用。两张表都用空原型对象并冻结。

// 生成空原型、冻结的表
const table = (pairs) => Object.freeze(Object.assign(Object.create(null), Object.fromEntries(pairs)))

// ---------- KEYS ----------

// 单条记录构造：text 只在给出时出现
const rec = (key, code, keyCode, text, extra) =>
  Object.freeze({ key, code, keyCode, ...(text === undefined ? {} : { text }), ...extra })

// 小键盘公共字段（W3C location：3 为小键盘）
const PAD = { isKeypad: true, location: 3 }

// 不产生字符的命名键：W3C 命名 = key = code，值为 Windows VK
const NAMED = {
  Tab: 9, Backspace: 8, Delete: 46, Insert: 45, Escape: 27,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  CapsLock: 20, NumLock: 144, ScrollLock: 145, Pause: 19, PrintScreen: 44,
}

// US 布局标点物理键：code → [VK_OEM_*, 下档字符, 上档字符]
const OEM = {
  Backquote: [192, '`', '~'], Minus: [189, '-', '_'], Equal: [187, '=', '+'],
  BracketLeft: [219, '[', '{'], BracketRight: [221, ']', '}'], Backslash: [220, '\\', '|'],
  Semicolon: [186, ';', ':'], Quote: [222, "'", '"'],
  Comma: [188, ',', '<'], Period: [190, '.', '>'], Slash: [191, '/', '?'],
}

// 数字行上档字符，下标即数字
const DIGIT_SHIFTED = ')!@#$%^&*('

// 小键盘运算：W3C 后缀 → [字符, VK]
const PAD_OPS = { Multiply: ['*', 106], Add: ['+', 107], Subtract: ['-', 109], Decimal: ['.', 110], Divide: ['/', 111] }

// 别名：别名 → 主名
const KEY_ALIASES = {
  return: 'enter', esc: 'escape', ' ': 'space', kp_enter: 'numpadenter', quote: "'",
  up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
}

function* keyEntries() {
  for (const [name, vk] of Object.entries(NAMED)) yield [name.toLowerCase(), rec(name, name, vk)]
  for (let n = 1; n <= 24; n++) yield [`f${n}`, rec(`F${n}`, `F${n}`, 111 + n)]
  yield ['enter', rec('Enter', 'Enter', 13, '\r')]
  yield ['numpadenter', rec('Enter', 'NumpadEnter', 13, '\r', PAD)]
  yield ['space', rec(' ', 'Space', 32, ' ')]
  for (let n = 0; n <= 9; n++) {
    yield [`numpad${n}`, rec(String(n), `Numpad${n}`, 96 + n, String(n), PAD)]
    yield [DIGIT_SHIFTED[n], rec(DIGIT_SHIFTED[n], `Digit${n}`, 48 + n, DIGIT_SHIFTED[n])]
  }
  for (const [op, [ch, vk]] of Object.entries(PAD_OPS)) yield [`numpad${op.toLowerCase()}`, rec(ch, `Numpad${op}`, vk, ch, PAD)]
  for (const [code, [vk, ...chars]] of Object.entries(OEM)) for (const ch of chars) yield [ch, rec(ch, code, vk, ch)]
}

const baseKeys = new Map(keyEntries())
for (const [alias, target] of Object.entries(KEY_ALIASES)) baseKeys.set(alias, baseKeys.get(target))
export const KEYS = table(baseKeys)

// ---------- MAC_COMMANDS ----------

// Apple StandardKeyBinding.dict 的紧凑转写：「修饰符号+主键名」→ 选择器（去冒号），多个用空格分隔。
// 修饰符号：$ shift、^ ctrl、~ alt、@ cmd；主键名用本模块键名（短名方向键）。
const APPLE = `
up moveUp|down moveDown|left moveLeft|right moveRight
$up moveUpAndModifySelection|$down moveDownAndModifySelection|$left moveLeftAndModifySelection|$right moveRightAndModifySelection
~up moveBackward moveToBeginningOfParagraph|~down moveForward moveToEndOfParagraph|~left moveWordLeft|~right moveWordRight
$~up moveParagraphBackwardAndModifySelection|$~down moveParagraphForwardAndModifySelection|$~left moveWordLeftAndModifySelection|$~right moveWordRightAndModifySelection
@up moveToBeginningOfDocument|@down moveToEndOfDocument|@left moveToLeftEndOfLine|@right moveToRightEndOfLine
$@up moveToBeginningOfDocumentAndModifySelection|$@down moveToEndOfDocumentAndModifySelection|$@left moveToLeftEndOfLineAndModifySelection|$@right moveToRightEndOfLineAndModifySelection
^up scrollPageUp|^down scrollPageDown|^left moveToLeftEndOfLine|^right moveToRightEndOfLine
$^left moveToLeftEndOfLineAndModifySelection|$^right moveToRightEndOfLineAndModifySelection
home scrollToBeginningOfDocument|end scrollToEndOfDocument|pageup scrollPageUp|pagedown scrollPageDown
$home moveToBeginningOfDocumentAndModifySelection|$end moveToEndOfDocumentAndModifySelection
$pageup pageUpAndModifySelection|$pagedown pageDownAndModifySelection|~pageup pageUp|~pagedown pageDown
delete deleteForward|~delete deleteWordForward
backspace deleteBackward|~backspace deleteWordBackward|^backspace deleteBackwardByDecomposingPreviousCharacter|@backspace deleteToBeginningOfLine
enter insertNewline|~enter insertNewlineIgnoringFieldEditor|^enter insertNewlineIgnoringFieldEditor|numpadenter insertNewline
tab insertTab|$tab insertBacktab|~tab insertTabIgnoringFieldEditor|^tab selectNextKeyView|$^tab selectPreviousKeyView
escape cancelOperation|@. cancelOperation
^a moveToBeginningOfParagraph|^b moveBackward|^d deleteForward|^e moveToEndOfParagraph|^f moveForward|^h deleteBackward
^k deleteToEndOfParagraph|^l centerSelectionInVisibleArea|^n moveDown|^o insertNewlineIgnoringFieldEditor moveBackward
^p moveUp|^t transpose|^v pageDown|^y yank
$^a moveToBeginningOfParagraphAndModifySelection|$^b moveBackwardAndModifySelection|$^e moveToEndOfParagraphAndModifySelection
$^f moveForwardAndModifySelection|$^n moveDownAndModifySelection|$^p moveUpAndModifySelection|$^v pageDownAndModifySelection
@a selectAll|@c copy|@x cut|@v paste|@z undo|$@z redo
`

// 修饰符号 → 名字，顺序即组合键串里的固定顺序
const MODS = [['$', 'shift'], ['^', 'ctrl'], ['~', 'alt'], ['@', 'cmd']]

// 解析一条「符号+主键」为 [修饰名数组, 主键]
const parseChord = (spec) => {
  const i = spec.search(/[^$^~@]/)
  const syms = spec.slice(0, i)
  return [MODS.filter(([s]) => syms.includes(s)).map(([, n]) => n), spec.slice(i)]
}
const joinChord = (mods, key) => [...mods, key].join('+')

// 主键的所有写法（方向键全/短名、小键盘回车、引号）
const SPELLINGS = { up: ['up', 'arrowup'], down: ['down', 'arrowdown'], left: ['left', 'arrowleft'], right: ['right', 'arrowright'], numpadenter: ['numpadenter', 'kp_enter'], "'": ["'", 'quote'] }

// 第一步：解析 Apple 表，键为规范组合串（[mods, key]）
const parsed = new Map()
for (const line of APPLE.trim().split(/\n|\|/)) {
  const [spec, ...sels] = line.trim().split(' ')
  parsed.set(spec, { chord: parseChord(spec), value: sels.length === 1 ? sels[0] : Object.freeze(sels) })
}

// 第二步：shift 退回——无独立绑定的 shift 组合沿用去掉 shift 后的值
const withShift = new Map()
for (const { chord: [mods, key], value } of parsed.values()) withShift.set(joinChord(mods, key), [mods, key, value])
for (const [mods, key, value] of [...withShift.values()]) {
  if (mods.includes('shift')) continue
  const sm = ['shift', ...mods]
  if (!withShift.has(joinChord(sm, key))) withShift.set(joinChord(sm, key), [sm, key, value])
}

// 第三步：展开主键别名
const cmdPairs = []
for (const [mods, key, value] of withShift.values())
  for (const k of SPELLINGS[key] ?? [key]) cmdPairs.push([joinChord(mods, k), value])

export const MAC_COMMANDS = table(cmdPairs)
