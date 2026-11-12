import { describe, expect, test } from 'bun:test'
import * as mod from '../../extension/redact.js'
import { escapeJson, redactTitle, redactUrl, sanitizeText } from '../../extension/redact.js'

// 占位符由实现自定：从一个必然抹值的样本里取出来，后面统一比对
const P = redactUrl('https://a.com/?token=abcdef').split('token=')[1]
const TOK = 'aB3dE5fG7hJ9kL1mN2' // 18 位、字符类频繁切换 → 像令牌
const HEX = 'a3f9b2c4d5e6f7a8b9c0d1e2f3a4b5c6' // 32 位十六进制摘要
const q = (query: string) => redactUrl(`https://a.com/p?${query}`).split('?').slice(1).join('?')
const masked = (query: string) => q(query) === query.replace(/=.*$/, '=' + P)
const kept = (query: string) => q(query) === query

describe('导出面与占位符', () => {
  test('恰好四个导出', () => {
    expect(Object.keys(mod).sort()).toEqual(['escapeJson', 'redactTitle', 'redactUrl', 'sanitizeText'])
  })
  test('占位符非空、纯字母数字、不含原值', () => {
    expect(P).toMatch(/^[A-Za-z0-9]+$/)
    expect(P).not.toContain('abcdef')
  })
  test('非字符串第一个参数 → TypeError', () => {
    for (const bad of [null, undefined, 5]) {
      expect(() => redactUrl(bad as any)).toThrow(TypeError)
      expect(() => redactTitle(bad as any, 'https://a.com/')).toThrow(TypeError)
      expect(() => escapeJson(bad as any)).toThrow(TypeError)
      expect(() => sanitizeText(bad as any)).toThrow(TypeError)
    }
  })
})

describe('redactUrl：网址类型', () => {
  test('http(s)：丢用户名密码，主机小写，保留端口', () => {
    expect(redactUrl('https://user:pw@A.com:8080/x')).toBe('https://a.com:8080/x')
    expect(redactUrl('http://a.com:80/')).toBe('http://a.com/')
  })
  test('about:blank / srcdoc 转小写；其他 about 只留协议', () => {
    expect(redactUrl('ABOUT:BLANK')).toBe('about:blank')
    expect(redactUrl('about:srcdoc')).toBe('about:srcdoc')
    expect(redactUrl('about:config')).toBe('about:')
  })
  test('blob：只留来源', () => {
    expect(redactUrl('blob:https://a.com/1234-5678')).toBe('blob:https://a.com')
    expect(redactUrl('blob:null/1234')).toBe('blob:')
  })
  test('其他带 // 协议：留主机路径，丢查询片段，分号参数照抹', () => {
    expect(redactUrl('ftp://h.com/dir/f.txt?x=1#y')).toBe('ftp://h.com/dir/f.txt')
    expect(redactUrl('ftp://h.com/p;sig=abcdef')).toBe(`ftp://h.com/p;sig=${P}`)
  })
  test('无 // 的协议只留协议', () => {
    expect(redactUrl('mailto:someone@b.com?subject=hi')).toBe('mailto:')
    expect(redactUrl('data:text/plain,hello')).toBe('data:')
    expect(redactUrl('javascript:alert(1)')).toBe('javascript:')
  })
  test('不可解析：截到第一个 ? 或 #，并编码', () => {
    expect(redactUrl('not a url ?token=x')).toBe('not%20a%20url%20')
    expect(redactUrl('foo#bar')).toBe('foo')
    expect(redactUrl('')).toBe('')
  })
})

describe('redactUrl：查询参数名', () => {
  test.each([
    'assertion', 'auth', 'bearer', 'cc', 'code', 'cvc', 'cvv', 'hash', 'hmac', 'jwt', 'key', 'mac', 'magic', 'nonce', 'otp', 'pass', 'pin', 'pw', 'pwd', 'salt', 'sid', 'sig', 'ssn', 'totp',
  ])('短敏感词 %s 作末词 → 抹值', (w) => {
    expect(masked(`${w}=hello`)).toBe(true)
    expect(masked(`user_${w}=hello`)).toBe(true)
  })
  test('短敏感词只看末词', () => {
    expect(kept('key_id=hello')).toBe(true)
    expect(kept('keyword=hello')).toBe(true)
  })
  test('复数按单数看', () => {
    expect(masked('keys=hello')).toBe(true)
    expect(masked('sids=hello')).toBe(true)
  })
  test.each([
    'AccessKeyId', 'apikey', 'authcode', 'authkey', 'authorization', 'card_number', 'ccnumber', 'client_secret', 'cookie', 'credentials', 'creditcard', 'csrf', 'Key-Pair-Id', 'oauth_state', 'oobCode', 'otpcode', 'passcode', 'passphrase', 'password', 'PHPSESSID', 'private_key', 'SAMLResponse', 'session_id', 'signature', 'social_security', 'token', 'verifier', 'X-Amz-Credential', 'X-Goog-Date', 'xsrf_t',
  ])('长敏感片段 %s → 抹值', (name) => {
    expect(masked(`${name}=hello`)).toBe(true)
  })
  test('驼峰 / 连字符 / 大小写同判', () => {
    for (const n of ['apiKey', 'API-Key', 'api_key', 'myApiKeyValue']) expect(masked(`${n}=hello`)).toBe(true)
  })
  test.each(['productCode', 'zip_code', 'countryCode', 'errorCode', 'key_code', 'lang-code', 'status_code', 'colorCode'])(
    '业务编码前缀 + code 不抹：%s',
    (n) => {
      expect(kept(`${n}=XYZ123`)).toBe(true)
    },
  )
  test('方括号内单独判：product[code] 抹，product_code 不抹', () => {
    expect(masked('product[code]=XYZ123')).toBe(true)
    expect(kept('product_code=XYZ123')).toBe(true)
    expect(masked('data[sig]=hello')).toBe(true)
  })
  test('值解码后 ≤ 2 个字符不抹', () => {
    expect(kept('password=ab')).toBe(true)
    expect(kept('token=1')).toBe(true)
    expect(kept('token=%41%42')).toBe(true)
    expect(masked('token=abc')).toBe(true)
  })
  test('普通参数原样', () => {
    expect(kept('q=hello&page=2&sort=asc')).toBe(true)
  })
})

describe('redactUrl：查询参数值', () => {
  test('像令牌的值 → 抹', () => {
    expect(masked(`id=${TOK}`)).toBe(true)
    expect(masked(`id=prefix.${TOK}.suffix`)).toBe(true)
  })
  test('不像令牌：切换稀疏、单一大小写、太短', () => {
    expect(kept('id=HelloWorldExample')).toBe(true)
    expect(kept('id=abcdefghijklmnopqrstu')).toBe(true)
    expect(kept('id=aB3dE5fG7h')).toBe(true)
  })
  test('长值含混合字母数字段 → 抹；纯字母长文本不抹', () => {
    expect(masked(`h=${HEX}`)).toBe(true)
    expect(kept('h=abcdefghijklmnopqrstuvwxyz')).toBe(true)
    expect(kept('h=1234567890123456789012345')).toBe(true)
    expect(masked('h=12345678901234567890123x')).toBe(true)
  })
  test('长度门槛 24：短于 24 的混合串不按长值规则抹', () => {
    expect(kept('h=a3f9b2c4d5e6f7a8b9c0')).toBe(true)
  })
  test('值嵌网址：内层敏感名、内层机密、用户信息 → 抹', () => {
    expect(masked('r=' + encodeURIComponent('https://x.com/cb?token=abcd'))).toBe(true)
    expect(masked('r=' + encodeURIComponent(`https://x.com/cb?id=${TOK}`))).toBe(true)
    expect(masked('r=' + encodeURIComponent('https://u:p@x.com/'))).toBe(true)
    expect(masked('r=' + encodeURIComponent(`https://x.com/#/a/${HEX}`))).toBe(true)
    expect(kept('r=' + encodeURIComponent('https://x.com/cb?page=2'))).toBe(true)
  })
  test('+ 视作空格解码后再判', () => {
    expect(masked(`id=x+${TOK}`)).toBe(true)
  })
  test('无 = 的段：像机密整段抹，否则原样', () => {
    expect(q(`a=1&${TOK}&flag`)).toBe(`a=1&${P}&flag`)
    expect(q(`${TOK}==`)).toBe(P)
    expect(kept('flag&debug')).toBe(true)
  })
  test('& 与 ; 分隔都认，分隔符保留', () => {
    expect(q('a=1;token=abcdef&b=2')).toBe(`a=1;token=${P}&b=2`)
  })
  test('只有 ? 时不输出 ?', () => {
    expect(redactUrl('https://a.com/p?')).toBe('https://a.com/p')
    expect(redactUrl('https://a.com/p#')).toBe('https://a.com/p')
  })
})

describe('redactUrl：路径与片段', () => {
  test('http 路径普通段即使像令牌也不抹', () => {
    expect(redactUrl(`https://a.com/reset/${TOK}`)).toBe(`https://a.com/reset/${TOK}`)
  })
  test('路径分号参数按查询对规则', () => {
    expect(redactUrl('https://a.com/x;jsessionid=abcdef/y')).toBe(`https://a.com/x;jsessionid=${P}/y`)
    expect(redactUrl('https://a.com/x;page=2')).toBe('https://a.com/x;page=2')
  })
  test('片段像查询：#access_token=\u2026', () => {
    expect(redactUrl('https://a.com/#access_token=abcdef&s=1')).toBe(`https://a.com/#access_token=${P}&s=1`)
  })
  test('片段是路由 + 查询', () => {
    expect(redactUrl(`https://a.com/#/route/${TOK}?code=12345&tab=2`)).toBe(`https://a.com/#/route/${P}?code=${P}&tab=2`)
  })
  test('片段是纯路由：像机密的段整段抹', () => {
    expect(redactUrl(`https://a.com/#/a/${HEX}/b`)).toBe(`https://a.com/#/a/${P}/b`)
    expect(redactUrl('https://a.com/#/settings/profile')).toBe('https://a.com/#/settings/profile')
  })
})

describe('redactUrl：编码与长度', () => {
  test('危险字符百分号编码，单引号 %27', () => {
    const out = redactUrl("https://a.com/#a'b\"c<d>e`f")
    expect(out).not.toMatch(/['"<>`\s\\]/)
    expect(out).toContain('%27')
  })
  test('输出不超过 2048 且标记截断', () => {
    const long = 'https://a.com/' + 'a'.repeat(3000)
    const out = redactUrl(long)
    expect(out.length).toBeLessThanOrEqual(2048)
    expect(out.length).toBeGreaterThan(1900)
    expect(out.startsWith('https://a.com/aaaa')).toBe(true)
    expect(/a$/.test(out)).toBe(false)
  })
  test('不超长不截断', () => {
    const u = 'https://a.com/' + 'a'.repeat(1000)
    expect(redactUrl(u)).toBe(u)
  })
  test('超 16384 输入：末尾残缺参数被丢弃，前面的敏感值仍被抹', () => {
    const u = `https://a.com/?token=abcdef&pad=${'a'.repeat(16400)}`
    const out = redactUrl(u)
    expect(out).not.toContain('abcdef')
    expect(out).not.toContain('pad=')
  })
})

describe('redactTitle', () => {
  test('标题本身是 http(s) 网址 → 按网址脱敏，与第二参数无关', () => {
    expect(redactTitle('  https://x.com/?token=abcdef  ', 'https://y.com/')).toBe(`https://x.com/?token=${P}`)
  })
  test('标题含空白不算网址', () => {
    expect(redactTitle('see https://x.com/?token=abcdef', 'https://y.com/')).toBe('see https://x.com/?token=abcdef')
  })
  test('标题是主机名（www 与大小写不计） → 脱敏网址', () => {
    expect(redactTitle('www.Example.com', 'https://example.com/?token=abcdef')).toBe(`https://example.com/?token=${P}`)
    expect(redactTitle('example.com/path', 'https://www.example.com/?token=abcdef')).toBe(`https://www.example.com/?token=${P}`)
  })
  test('标题带用户信息不算主机名', () => {
    expect(redactTitle('u@example.com', 'https://example.com/?token=abcdef')).toBe('u@example.com')
  })
  test('标题含网址查询串 → 脱敏网址；解码后匹配也算', () => {
    expect(redactTitle('?token=abcdef - Page', 'https://a.com/?token=abcdef')).toBe(`https://a.com/?token=${P}`)
    expect(redactTitle('#q=a b', 'https://a.com/#q=a%20b')).toBe(`https://a.com/#q=a%20b`)
  })
  test('查询串太短（< 4）不算', () => {
    expect(redactTitle('?ab page', 'https://a.com/?ab')).toBe('?ab page')
  })
  test('普通标题原样', () => {
    expect(redactTitle('Welcome', 'https://a.com/?token=abcdef')).toBe('Welcome')
    expect(redactTitle('Welcome', 'https://a.com/')).toBe('Welcome')
    expect(redactTitle('', 'https://a.com/?token=abcdef')).toBe('')
  })
  test('网址不可解析 → 原标题', () => {
    expect(redactTitle('anything', 'nope')).toBe('anything')
    expect(redactTitle('anything', undefined as any)).toBe('anything')
  })
  test('超长标题（≥ 4096）视为携带网址', () => {
    expect(redactTitle('x'.repeat(5000), 'https://a.com/?token=abcdef')).toBe(`https://a.com/?token=${P}`)
    expect(redactTitle('x'.repeat(5000), 'https://a.com/')).toBe('x'.repeat(5000))
  })
})

describe('escapeJson', () => {
  test('转义尖括号和三种分行字符，十六进制小写', () => {
    expect(escapeJson('<a>')).toBe('\\u003ca\\u003e')
    expect(escapeJson('\u2028\u2029\u0085')).toBe('\\u2028\\u2029\\u0085')
  })
  test('其他字符原样，空串原样', () => {
    expect(escapeJson('abc 中文 "x" \n')).toBe('abc 中文 "x" \n')
    expect(escapeJson('')).toBe('')
  })
  test('JSON 往返等价', () => {
    const v = { html: '</script><b>', sep: 'a\u2028b\u2029c\u0085d', n: [1, '>'] }
    const s = JSON.stringify(v)
    const e = escapeJson(s)
    expect(e).not.toMatch(new RegExp('[<>\\u2028\\u2029\\u0085]'))
    expect(JSON.parse(e)).toEqual(v)
  })
})

describe('sanitizeText', () => {
  const tag = 'system-reminder'
  test('成对标签连内容整块删除，跨行、大小写不限', () => {
    expect(sanitizeText(`a<${tag}>x\ny</${tag}>b`)).toBe('ab')
    expect(sanitizeText(`a<${tag.toUpperCase()}>x</${tag}>b`)).toBe('ab')
  })
  test('非贪婪：两块之间的文字保留', () => {
    expect(sanitizeText(`<${tag}>1</${tag}>keep<${tag}>2</${tag}>`)).toBe('keep')
  })
  test('落单标签只删标签', () => {
    expect(sanitizeText(`a<${tag}>b`)).toBe('ab')
    expect(sanitizeText(`a</${tag} >b`)).toBe('ab')
  })
  test('保留制表、换行、回车', () => {
    expect(sanitizeText('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })
  test('删除控制字符与隐形格式字符', () => {
    const bad = '\u0000\u0008\u000b\u000c\u001f\u007f\u0085\u009f\u061c\u200b\u200d\u200f\u2028\u2029\u202a\u202e\u2060\u2066\u2069\u00ad\ufeff'
    expect(sanitizeText(`a${bad}b`)).toBe('ab')
  })
  test('普通文本、尖括号、emoji 原样', () => {
    expect(sanitizeText('<b>中文 😀</b>')).toBe('<b>中文 😀</b>')
    expect(sanitizeText('')).toBe('')
  })
})
