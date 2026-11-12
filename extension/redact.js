// 脱敏与文本清理：纯函数，无副作用。行为见 specs/redact.md。

// 统一占位符
const P = 'REDACTED'
const INPUT_MAX = 16384
const OUTPUT_MAX = 2048
const TRUNC_MARK = '~~(cut)~~'

const mustString = (v, name) => {
  if (typeof v !== 'string') throw new TypeError(`${name} must be a string`)
}

// 百分号解码；plus 为真时 + 当空格；失败按原文
const decode = (s, plus = true) => {
  const t = plus ? s.replace(/\+/g, ' ') : s
  try {
    return decodeURIComponent(t)
  } catch {
    return t
  }
}

// ---------- 敏感词表（按语义类别组织） ----------
const SHORT_WORDS = new Set([
  // 一次性凭证
  'assertion', 'code', 'magic', 'nonce', 'otp', 'pin', 'totp',
  // 认证 / 会话
  'auth', 'bearer', 'jwt', 'key', 'sid',
  // 签名与摘要
  'hash', 'hmac', 'mac', 'salt', 'sig',
  // 口令缩写
  'pass', 'pw', 'pwd',
  // 个人金融 / 身份
  'cc', 'cvc', 'cvv', 'ssn',
])

const CODE_PREFIXES = new Set([
  // 商品 / 目录
  'article', 'catalog', 'category', 'course', 'event', 'item', 'job', 'model', 'part', 'plan', 'product', 'sku', 'type',
  // 地理 / 区号
  'airport', 'area', 'city', 'country', 'dial', 'iata', 'post', 'postal', 'province', 'region', 'state', 'zip',
  // 语言 / 货币
  'currency', 'lang', 'language', 'locale',
  // 状态 / 结果
  'decline', 'error', 'exit', 'failure', 'http', 'reason', 'response', 'result', 'return', 'status',
  // 键盘与外观
  'char', 'color', 'colour', 'key', 'size',
])

const LONG_FRAGMENTS = [
  // 通用机密
  'credential', 'secret', 'token',
  // 口令
  'passcode', 'passphrase', 'passw',
  // 授权流程
  'apikey', 'authcode', 'authkey', 'authoriz', 'oauth', 'oobcode', 'otpcode', 'saml',
  // 签名
  'signature',
  // 会话与防跨站
  'cookie', 'csrf', 'sessid', 'session', 'xsrf',
  // 验证
  'verif',
  // 云厂商签名网址
  'keypairid', 'xamz', 'xgoog',
  // 密钥
  'accesskey', 'privatekey',
  // 个人金融 / 身份
  'cardnum', 'ccnumber', 'creditcard', 'socialsecurity',
]

// 分词：小写或数字后接大写处断开，非字母数字都是分隔符
const splitWords = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())

// 末词按短敏感词判（含复数），code 前接业务前缀时豁免
const shortHit = (words) => {
  const last = words[words.length - 1]
  if (!last) return false
  const base = SHORT_WORDS.has(last) ? last : last.endsWith('s') && SHORT_WORDS.has(last.slice(0, -1)) ? last.slice(0, -1) : null
  if (!base) return false
  if (base === 'code' && words.length > 1 && CODE_PREFIXES.has(words[words.length - 2])) return false
  return true
}

const isSensitiveName = (rawName) => {
  const name = decode(rawName)
  const words = splitWords(name)
  if (shortHit(words)) return true
  const joined = words.join('')
  if (LONG_FRAGMENTS.some((f) => joined.includes(f))) return true
  // 外层[内层]：内层单独判
  const open = name.indexOf('[')
  if (open > 0 && name.endsWith(']')) return isSensitiveName(name.slice(open + 1, -1))
  return false
}

// ---------- 值判定 ----------
// 字符类切换次数：小写→大写、字母→数字、数字→字母
const countSwitches = (w) => {
  let n = 0
  for (let i = 1; i < w.length; i++) {
    const a = w[i - 1]
    const b = w[i]
    const aLow = /[a-z]/.test(a), aLetter = /[A-Za-z]/.test(a), aDigit = /[0-9]/.test(a)
    const bUp = /[A-Z]/.test(b), bLetter = /[A-Za-z]/.test(b), bDigit = /[0-9]/.test(b)
    if ((aLow && bUp) || (aLetter && bDigit) || (aDigit && bLetter)) n++
  }
  return n
}

const isTokenWord = (w) => {
  if (w.length < 16) return false
  if (!/[A-Z]/.test(w) || !/[a-z]/.test(w)) return false
  const s = countSwitches(w)
  return s >= 3 && s * 5 >= w.length
}

const looksSecret = (raw) => {
  const v = decode(raw)
  if (v.split(/[^A-Za-z0-9_-]+/).some(isTokenWord)) return true
  if (v.length >= 24) {
    for (const run of v.match(/[A-Za-z0-9]{16,}/g) || []) {
      const kinds = [/[A-Z]/, /[a-z]/, /[0-9]/].filter((r) => r.test(run)).length
      if (kinds >= 2) return true
    }
  }
  return false
}

// 值里嵌着带机密的网址
const embedsSecretUrl = (raw) => {
  const v = decode(raw)
  if (/\/\/[^/?#\s]*@/.test(v)) return true
  for (const seg of v.split(/[?&#;]/)) {
    const eq = seg.indexOf('=')
    if (eq <= 0) continue
    const val = seg.slice(eq + 1)
    if (val.length >= 3 && (isSensitiveName(seg.slice(0, eq)) || looksSecret(val))) return true
  }
  const hash = v.indexOf('#')
  if (hash >= 0) {
    for (const seg of v.slice(hash + 1).split(/[?&#;]/)) {
      if (!seg.includes('=') && seg.split('/').some(looksSecret)) return true
    }
  }
  return false
}

// ---------- 网址各部分处理 ----------
// 单个查询段
const redactPair = (seg) => {
  if (!seg) return seg
  const eq = seg.indexOf('=')
  if (eq < 0 || /^=*$/.test(seg.slice(eq + 1))) {
    return looksSecret(seg.replace(/=+$/, '')) ? P : seg
  }
  const name = seg.slice(0, eq)
  const val = seg.slice(eq + 1)
  if (decode(val).length <= 2) return seg
  if (isSensitiveName(name) || looksSecret(val) || embedsSecretUrl(val)) return `${name}=${P}`
  return seg
}

// 查询串（不含 ?），& 与 ; 分隔符原样保留
const redactQuery = (q) => q.split(/([&;])/).map((p) => (p === '&' || p === ';' ? p : redactPair(p))).join('')

// 路径分号参数：只处理 ;名=值
const redactPath = (path) =>
  path
    .split('/')
    .map((seg) => {
      const parts = seg.split(';')
      return [parts[0], ...parts.slice(1).map((p) => (p.includes('=') ? redactPair(p) : p))].join(';')
    })
    .join('/')

const maskRoute = (route) => route.split('/').map((s) => (s && looksSecret(s) ? P : s)).join('/')

// 片段（不含 #）
const redactFragment = (f) => {
  const eq = f.indexOf('=')
  const qm = f.indexOf('?')
  if (eq >= 0 && (qm < 0 || eq < qm)) return redactQuery(f)
  if (qm >= 0) return `${maskRoute(f.slice(0, qm))}?${redactQuery(f.slice(qm + 1))}`
  return maskRoute(f)
}

// ---------- 编码与长度 ----------
const pctEncode = (ch) =>
  Array.from(new TextEncoder().encode(ch), (b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('')

const finish = (s) => {
  let out = s.replace(/[\s\u0085"'<>\\`]/g, pctEncode)
  if (out.length > OUTPUT_MAX) {
    // 避免把 %xx 截成半个
    out = out.slice(0, OUTPUT_MAX - TRUNC_MARK.length).replace(/%[0-9A-Fa-f]?$/, '') + TRUNC_MARK
  }
  return out
}

// 输入超长：截断并丢掉末尾残缺参数
const clipInput = (s) => {
  if (s.length <= INPUT_MAX) return s
  const head = s.slice(0, INPUT_MAX)
  const cut = Math.max(...['?', '&', '#', ';'].map((c) => head.lastIndexOf(c)))
  return cut >= 0 ? head.slice(0, cut) : head
}

const tryParse = (s) => {
  try {
    return new URL(s)
  } catch {
    return null
  }
}

export function redactUrl(url) {
  mustString(url, 'redactUrl')
  if (url === '') return ''
  const lower = url.toLowerCase()
  if (lower === 'about:blank' || lower === 'about:srcdoc') return lower
  const input = clipInput(url)
  const u = tryParse(input)
  if (!u) {
    const m = input.search(/[?#]/)
    return finish(m >= 0 ? input.slice(0, m) : input)
  }
  const proto = u.protocol
  if (proto === 'http:' || proto === 'https:') {
    let out = `${proto}//${u.host}${redactPath(u.pathname)}`
    const q = u.search.slice(1)
    if (q) out += '?' + redactQuery(q)
    const f = u.hash.slice(1)
    if (f) out += '#' + redactFragment(f)
    return finish(out)
  }
  if (proto === 'blob:') {
    const origin = u.origin
    return origin && origin !== 'null' ? `blob:${origin}` : 'blob:'
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim())) {
    return finish(`${proto}//${u.host}${redactPath(u.pathname)}`)
  }
  return proto
}

// ---------- 标题 ----------
const stripWww = (h) => h.replace(/^www\./i, '').toLowerCase()

export function redactTitle(title, url) {
  mustString(title, 'redactTitle')
  const t = title.length > INPUT_MAX ? title.slice(0, INPUT_MAX + 1) : title
  const trimmed = t.trim()
  if (/^https?:\/\/\S+$/i.test(trimmed) && tryParse(trimmed)) return redactUrl(trimmed)

  const u = typeof url === 'string' ? tryParse(url) : null
  if (!u) return title

  // 标题当主机名看
  const asHost = tryParse('http://' + trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''))
  if (asHost && !asHost.username && !asHost.password && u.hostname && stripWww(asHost.hostname) === stripWww(u.hostname)) {
    return redactUrl(url)
  }

  if (!u.search && !u.hash) return title
  if (t.length >= 4096) return redactUrl(url)

  const hay = [t, decode(t, false)]
  for (const part of [u.search, u.hash]) {
    if (part.length < 4 || part.length > t.length * 9) continue
    const needles = [part, decode(part, false)]
    if (needles.some((n) => hay.some((h) => h.includes(n)))) return redactUrl(url)
  }
  return title
}

// ---------- JSON 嵌入 ----------
export function escapeJson(text) {
  mustString(text, 'escapeJson')
  return text.replace(/[<>\u2028\u2029\u0085]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

// ---------- 文本清理 ----------
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f­؜​-‏\u2028\u2029‪-‮⁠⁦-⁩﻿]/g
const PAIRED_TAG = /<system-reminder\s*>[\s\S]*?<\/system-reminder\s*>/gi
const LONE_TAG = /<\/?system-reminder\s*>/gi

export function sanitizeText(text) {
  mustString(text, 'sanitizeText')
  // 先去隐形字符，避免拆开的标签在清理后才拼合
  return text.replace(INVISIBLE, '').replace(PAIRED_TAG, '').replace(LONE_TAG, '')
}
