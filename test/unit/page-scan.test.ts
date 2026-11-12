// page-scan 单测：注入网页的经典脚本，不能 import。按方案「单测机制」读源码注入 Playwright 真页面，
// 每条用例一张新页面。断言错误码、结构、数值约束，不断言文案。
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Page } from 'playwright'
import { call, inject, openPage, ORIGIN, startBrowser, stopBrowser } from './fakes/page-scan-page'

// 每条用例都开真页面，机器忙时单条可能超过默认 5 秒
setDefaultTimeout(30_000)
beforeAll(startBrowser)
afterAll(stopBrowser)

const open = (body: string, extra: Record<string, string> = {}, size?: { width: number; height: number }) =>
  openPage({ '/': `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`, ...extra }, size)

let pages: Page[] = []
const fresh = async (body: string, extra?: Record<string, string>, size?: { width: number; height: number }) => {
  const p = await open(body, extra, size)
  pages.push(p)
  return p
}
afterAll(async () => {
  for (const p of pages) await p.close().catch(() => {})
  pages = []
})

const REF = /\[ref_\d+\]/
const refs = (out: string) => [...out.matchAll(/\[(ref_\d+)\]/g)].map((m) => m[1])
const lineWith = (out: string, needle: string) => out.split('\n').find((l) => l.includes(needle))
const refOn = (out: string, needle: string) => {
  const l = lineWith(out, needle)
  return l ? /\[(ref_\d+)\]/.exec(l)?.[1] : undefined
}
const indent = (l: string) => l.length - l.trimStart().length
const scan = (p: Page, opts: object = {}) => call(p, 'scan', { filter: 'interactive', ...opts })
const elapsed = async <T>(fn: () => Promise<T>) => {
  const t0 = performance.now()
  const v = await fn()
  return { v, ms: performance.now() - t0 }
}
const b64 = (s: string) => Buffer.from(s).toString('base64')

describe('脚本形态', () => {
  test('挂出 8 个函数', async () => {
    const p = await fresh('<p>hi</p>')
    const keys = await p.evaluate(() => Object.entries((window as any).__jevScan).map(([k, v]) => [k, typeof v]))
    expect(keys.map(([k]) => k).sort()).toEqual(
      ['dropFiles', 'formInput', 'locate', 'observe', 'pageText', 'scan', 'scrollFallback', 'uploadFiles'],
    )
    expect(keys.every(([, t]) => t === 'function')).toBe(true)
  })
  test('重复注入不替换已有对象、不重置编号', async () => {
    const p = await fresh('<button>One</button>')
    const before = refOn((await scan(p)).pageContent, 'One')
    await p.evaluate(() => ((window as any).__jevScan.marker = 1))
    await inject(p)
    expect(await p.evaluate(() => (window as any).__jevScan.marker)).toBe(1)
    await p.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<button>Two</button>'))
    const out = (await scan(p)).pageContent
    expect(refOn(out, 'One')).toBe(before)
    expect(refOn(out, 'Two')).not.toBe(before)
  })
})

describe('scan：交互模式收录', () => {
  test('原生控件和标记出来的可交互元素都收，普通文字不收', async () => {
    const p = await fresh(`
      <button>Btn</button><a href="/go">Lnk</a><input aria-label="Inp"><select><option>Sel</option></select>
      <textarea aria-label="Txt"></textarea><div onclick="1">Clickable</div><div tabindex="0">Tabbable</div>
      <span role="button">Rb</span><div contenteditable="true" aria-label="Ced"></div>
      <details><summary>Sum</summary>x</details><p>Plain paragraph text</p>`)
    const out = (await scan(p)).pageContent
    for (const n of ['Btn', 'Lnk', 'Inp', 'Sel', 'Txt', 'Clickable', 'Tabbable', 'Rb', 'Ced', 'Sum']) expect(refOn(out, n)).toBeDefined()
    expect(out).not.toContain('Plain paragraph')
  })
  test('手形光标：只收自己是手形且父级不是的那一层', async () => {
    const p = await fresh(`
      <div id="card" style="cursor:pointer;width:200px;height:40px">Card<span>inner</span>
        <div style="cursor:pointer">nested</div></div>`)
    const out = (await scan(p)).pageContent
    expect(refs(out)).toHaveLength(1)
  })
  test('视口外不收；all 模式收', async () => {
    const p = await fresh('<button>Top</button><div style="height:3000px"></div><button>Far</button>')
    expect((await scan(p)).pageContent).not.toContain('Far')
    expect(refOn((await scan(p, { filter: 'all' })).pageContent, 'Far')).toBeDefined()
  })
  test('隐藏的不收（display/visibility/opacity/aria-hidden）；all 模式收', async () => {
    const p = await fresh(`
      <button>Shown</button><button style="display:none">H1</button><button style="visibility:hidden">H2</button>
      <button style="opacity:0">H3</button><button aria-hidden="true">H4</button>`)
    const out = (await scan(p)).pageContent
    expect(refOn(out, 'Shown')).toBeDefined()
    for (const n of ['H1', 'H2', 'H3', 'H4']) expect(out).not.toContain(n)
    const all = (await scan(p, { filter: 'all' })).pageContent
    for (const n of ['H1', 'H2', 'H3', 'H4']) expect(refOn(all, n)).toBeDefined()
  })
  test('display:contents 的容器不挡住里面的元素', async () => {
    const p = await fresh('<div style="display:contents"><button>Inside</button></div>')
    expect(refOn((await scan(p)).pageContent, 'Inside')).toBeDefined()
  })
  test('开放 shadow root 里的元素收；slot 进来的元素只出现一次', async () => {
    const p = await fresh(`<div id="host"><button>Slotted</button></div><script>
      const r = host.attachShadow({ mode: 'open' }); r.innerHTML = '<button>Shadowed</button><slot></slot>'</script>`)
    const out = (await scan(p)).pageContent
    expect(refOn(out, 'Shadowed')).toBeDefined()
    expect(out.split('Slotted').length - 1).toBe(1)
  })
  test('script / style 的内容不出现', async () => {
    const p = await fresh('<style>.zzstyle{}</style><script>var zzscript = 1</script><button>B</button>')
    const out = (await scan(p, { filter: 'all' })).pageContent
    expect(out).not.toContain('zzstyle')
    expect(out).not.toContain('zzscript')
  })
  test('非交互模式（如 all）收地标、标题和有名字的元素', async () => {
    const p = await fresh('<nav><h2>Heading here</h2></nav><div>Some words</div>')
    const out = (await scan(p, { filter: 'all' })).pageContent
    expect(lineWith(out, 'Heading here')?.trim().startsWith('heading')).toBe(true)
    expect(out.split('\n').some((l) => l.trim().startsWith('navigation') && REF.test(l))).toBe(true)
  })
})

describe('scan：编号', () => {
  test('编号形如 ref_正整数，同一元素多次扫描不变，新元素拿新号', async () => {
    const p = await fresh('<button>A</button><button>B</button>')
    const one = (await scan(p)).pageContent
    for (const r of refs(one)) expect(r).toMatch(/^ref_[1-9]\d*$/)
    await p.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<button>C</button>'))
    const two = (await scan(p)).pageContent
    expect(refOn(two, 'A')).toBe(refOn(one, 'A'))
    expect(refOn(two, 'B')).toBe(refOn(one, 'B'))
    expect([refOn(one, 'A'), refOn(one, 'B')]).not.toContain(refOn(two, 'C'))
  })
  test('元素换掉后不复用旧号', async () => {
    const p = await fresh('<div id="w"><button>Old</button></div>')
    const old = refOn((await scan(p)).pageContent, 'Old')
    await p.evaluate(() => (document.getElementById('w')!.innerHTML = '<button>Old</button>'))
    expect(refOn((await scan(p)).pageContent, 'Old')).not.toBe(old)
  })
})

describe('scan：每行内容', () => {
  test('角色', async () => {
    const p = await fresh(`
      <input type="checkbox" aria-label="cb"><input type="radio" aria-label="rd"><input type="submit" value="Go">
      <input aria-label="tx"><select><option>sl</option></select><a href="/">ln</a><span role="tab" tabindex="0">tb</span>`)
    const out = (await scan(p)).pageContent
    const role = (n: string) => lineWith(out, `"${n}"`)?.trim().split(' ')[0]
    expect([role('cb'), role('rd'), role('Go'), role('tx'), role('sl'), role('ln'), role('tb')]).toEqual(
      ['checkbox', 'radio', 'button', 'textbox', 'combobox', 'link', 'tab'],
    )
  })
  test('名字来源：aria-label、placeholder、关联 label、alt、按钮里的嵌套文字、submit 的 value', async () => {
    const p = await fresh(`
      <input placeholder="Search here"><label for="em">Email address</label><input id="em">
      <a href="/x"><img alt="Logo pic" src="data:,"></a><button><span>Save</span> <b>draft</b></button>
      <input type="submit" value="Send it"><button aria-label="Close dialog">X</button>`)
    const out = (await scan(p, { filter: 'all' })).pageContent as string
    // 锚在「角色 + 名字 + 编号」上，避免被同行属性或 label 自己那一行误满足
    const named = (role: string, name: string) => new RegExp(`^ *${role} "${name}" \\[ref_\\d+\\]`, 'm').test(out)
    expect(named('textbox', 'Search here')).toBe(true)
    expect(named('textbox', 'Email address')).toBe(true)
    expect(named('button', 'Save draft')).toBe(true)
    expect(named('button', 'Send it')).toBe(true)
    expect(named('button', 'Close dialog')).toBe(true)
    expect(lineWith(out, '"X"')).toBeUndefined()
    expect(named('image', 'Logo pic')).toBe(true)
  })
  test('名字压空白、过长截断', async () => {
    const long = 'word '.repeat(80)
    const p = await fresh(`<button>Multi
        line   name</button><button>${long}</button>`)
    const out = (await scan(p)).pageContent
    expect(lineWith(out, '"Multi line name"')).toBeDefined()
    const l = lineWith(out, 'word word')!
    const name = l.slice(l.indexOf('"') + 1, l.lastIndexOf('"'))
    expect(name.length).toBeLessThanOrEqual(110)
    expect(name.length).toBeGreaterThanOrEqual(90)
  })
  test('href / type / placeholder 以 key="value" 原样附在行内', async () => {
    const p = await fresh('<a href="/path?q=1">L</a><input type="email" placeholder="you@x">')
    const out = (await scan(p)).pageContent
    expect(lineWith(out, '"L"')).toContain(' href="/path?q=1"')
    const inp = lineWith(out, 'email')!
    expect(inp).toContain('type="email"')
    expect(inp).toContain('placeholder="you@x"')
  })
  test('下拉列出各选项，选中项有区别标记，value 与文字不同时带上 value', async () => {
    const p = await fresh('<select><option value="v1">First</option><option value="vv2" selected>Second</option></select>')
    const out = (await scan(p)).pageContent
    const lines = out.split('\n')
    const sel = lines.findIndex((l) => l.includes('[ref_'))
    const first = lines.find((l) => l.includes('First'))!
    const second = lines.findLast((l) => l.includes('Second'))!
    expect(lines.indexOf(first)).toBeGreaterThan(sel)
    expect(indent(first)).toBeGreaterThan(indent(lines[sel]))
    expect(second).toContain('vv2')
    expect(second.replace('Second', '').replace('vv2', '').trim()).not.toBe(first.replace('First', '').replace('v1', '').trim())
  })
})

describe('scan：敏感字段', () => {
  test('密码、cc-number、one-time-code 的值任何输出里都不出现', async () => {
    const p = await fresh(`
      <input type="password" id="pw"><input autocomplete="cc-number" id="cc"><textarea autocomplete="one-time-code" id="ot"></textarea>`)
    await p.evaluate(() => {
      ;(document.getElementById('pw') as HTMLInputElement).value = 'pwSECRET1'
      ;(document.getElementById('cc') as HTMLInputElement).value = '4111SECRET'
      ;(document.getElementById('ot') as HTMLTextAreaElement).value = 'otpSECRET'
    })
    for (const filter of ['interactive', 'all']) {
      const r = await scan(p, { filter, compact: true })
      expect(r.pageContent + r.compact).not.toContain('SECRET')
      expect(refs(r.pageContent)).toHaveLength(3)
    }
  })
  test('敏感下拉不列选项、名字不取选中项', async () => {
    const p = await fresh('<select autocomplete="cc-exp-month"><option>Opt07</option><option selected>Opt08</option></select>')
    const r = await scan(p, { compact: true })
    expect(refs(r.pageContent)).toHaveLength(1)
    expect(r.pageContent + r.compact).not.toContain('Opt0')
  })
})

describe('scan：深度与上限', () => {
  const nest = (n: number) => Array.from({ length: n }, (_, i) => `<div role="button">L${i}`).join('') + '</div>'.repeat(n)
  test('默认深度 15：20 层嵌套只出 16 层，末尾有一行不带编号的提示', async () => {
    const p = await fresh(nest(20))
    const out = (await scan(p)).pageContent
    expect(refs(out)).toHaveLength(16)
    const last = out.split('\n').at(-1)!
    expect(last).not.toMatch(REF)
    expect(last.trim().length).toBeGreaterThan(0)
  })
  test('depth 参数；子行缩进大于父行', async () => {
    const p = await fresh(nest(10))
    const out = (await scan(p, { depth: 3 })).pageContent
    expect(refs(out)).toHaveLength(4)
    const ls = out.split('\n').filter((l) => REF.test(l))
    for (let i = 1; i < ls.length; i++) expect(indent(ls[i])).toBeGreaterThan(indent(ls[i - 1]))
  })
  test('没被收录的包装层不占深度', async () => {
    const p = await fresh('<div>'.repeat(30) + '<button>Deep</button>' + '</div>'.repeat(30))
    expect(refOn((await scan(p, { depth: 1 })).pageContent, 'Deep')).toBeDefined()
  })
  test('没碰到深度上限时没有提示行', async () => {
    const p = await fresh('<button>A</button>')
    const out = (await scan(p)).pageContent
    expect(out.split('\n').every((l) => REF.test(l))).toBe(true)
  })
  test('超过 10000 个元素只收 10000 个，末尾有提示', async () => {
    const p = await fresh('')
    await p.evaluate(() => (document.body.innerHTML = '<button>b</button>'.repeat(10050)))
    const out = (await scan(p, { filter: 'all' })).pageContent
    expect(refs(out)).toHaveLength(10000)
    expect(out.split('\n').at(-1)).not.toMatch(REF)
  })
  test('maxChars：在行边界截断，保留尽量多的整行，后接提示', async () => {
    const p = await fresh(Array.from({ length: 60 }, (_, i) => `<button>Button number ${i}</button>`).join(''))
    const full = (await scan(p)).pageContent as string
    const cut = (await scan(p, { maxChars: 500 })).pageContent as string
    const fl = full.split('\n')
    const cl = cut.split('\n')
    let k = 0
    while (k < cl.length && cl[k] === fl[k]) k++
    const kept = fl.slice(0, k).join('\n')
    expect(k).toBeGreaterThan(0)
    expect(kept.length).toBeLessThanOrEqual(500)
    expect(kept.length + 1 + fl[k].length).toBeGreaterThan(500)
    expect(cl.slice(k).join('\n')).not.toMatch(REF)
    expect(cl.slice(k).join('').trim().length).toBeGreaterThan(0)
  })
  test('没超 maxChars 不动', async () => {
    const p = await fresh('<button>A</button>')
    const r = await scan(p, { maxChars: 50000 })
    expect(r.pageContent).toBe((await scan(p)).pageContent)
  })
})

describe('scan：按编号聚焦', () => {
  test('只出该子树，根总在第一行，子树里视口外的也收', async () => {
    const p = await fresh(`<button>Outside</button><div role="group"><span>txt</span><div style="height:3000px"></div><button>FarIn</button></div>`)
    const all = (await scan(p, { filter: 'all' })).pageContent
    const ref = refOn(all, 'group')!
    const out = (await scan(p, { refId: ref })).pageContent
    expect(refs(out)[0]).toBe(ref)
    expect(refOn(out, 'FarIn')).toBeDefined()
    expect(out).not.toContain('Outside')
  })
  test('平时不收的根元素也作为第一行出现', async () => {
    const p = await fresh('<div id="plain"><button>Kid</button></div>')
    // 普通 div 平时不收：临时让它可交互拿到编号，再撤掉
    await p.evaluate(() => document.getElementById('plain')!.setAttribute('tabindex', '0'))
    const ref = refs((await scan(p)).pageContent)[0]
    await p.evaluate(() => document.getElementById('plain')!.removeAttribute('tabindex'))
    const out = (await scan(p, { refId: ref })).pageContent
    expect(refs(out)[0]).toBe(ref)
    expect(refOn(out, 'Kid')).toBeDefined()
  })
  test('编号失效 / 不存在 → ref_stale，空内容，仍给视口', async () => {
    const p = await fresh('<button id="x">Gone</button>')
    const ref = refOn((await scan(p)).pageContent, 'Gone')
    await p.evaluate(() => document.getElementById('x')!.remove())
    for (const id of [ref, 'ref_987654']) {
      const r = await scan(p, { refId: id })
      expect(r.errorCode).toBe('ref_stale')
      expect(typeof r.error).toBe('string')
      expect(r.error.length).toBeGreaterThan(0)
      expect(r.pageContent).toBe('')
      expect(r.viewport).toEqual({ width: 800, height: 600 })
    }
  })
})

describe('scan：返回结构与精简表', () => {
  test('默认只有 pageContent 和 viewport', async () => {
    const p = await fresh('<button>A</button>')
    const r = await scan(p)
    expect(Object.keys(r).sort()).toEqual(['pageContent', 'viewport'])
    expect(r.viewport).toEqual({ width: 800, height: 600 })
  })
  test('compact：每个可交互元素一行，以编号开头，带角色和名字；非交互的不进表', async () => {
    const p = await fresh('<h1>Title words</h1><button>Press</button><a href="/q">Go there</a>')
    const r = await scan(p, { filter: 'all', compact: true })
    const rows = (r.compact as string).split('\n')
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toMatch(/^ref_\d+ /)
    const press = rows.find((x) => x.includes('Press'))!
    expect(press.split(' ')[0]).toBe(refOn(r.pageContent, 'Press'))
    expect(press).toContain('button')
    expect(r.compact).not.toContain('Title words')
  })
})

describe('pageText', () => {
  const text = (p: Page, n = 50000) => call(p, 'pageText', n)
  test('有 article 取 article（多个取字最多的），不含外面的字', async () => {
    const p = await fresh(`<nav>Menu stuff</nav><main><article>Short article body</article>
      <article>The longer article body with many more words in it</article></main>`)
    const r = await text(p)
    expect(r.source).toBe('article')
    expect(r.text).toContain('longer article')
    expect(r.text).not.toContain('Menu stuff')
    expect(r.title).toBe('Fixture')
    expect(r.url).toBe(ORIGIN + '/')
    expect(r.error).toBeUndefined()
  })
  test('没有 article 取 main；都没有取 body；role=main 也算正文容器', async () => {
    expect((await text(await fresh('<nav>Menu</nav><main>Main region content here</main>'))).source).toBe('main')
    expect((await text(await fresh('<div>Just a body with text</div>'))).source).toBe('body')
    const r = await text(await fresh('<nav>Menu</nav><section role="main">Role main content</section>'))
    expect(r.source).toBe('section')
    expect(r.text).not.toContain('Menu')
  })
  test('空白规整：行内空白压成一个空格，空行最多一行，首尾去空', async () => {
    const p = await fresh('<pre>  alpha    beta\t\tgamma  \n\n\n\n\n  delta  </pre>')
    expect((await text(p)).text).toBe('alpha beta gamma\n\ndelta')
  })
  test('字太少 → 空文本、source=none、带错误', async () => {
    const r = await text(await fresh('<img src="data:,"><p>tiny</p>'))
    expect(r.text).toBe('')
    expect(r.source).toBe('none')
    expect(typeof r.error).toBe('string')
    expect(r.error.length).toBeGreaterThan(0)
  })
  test('超长在行边界截断，后接提示', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `<p>Paragraph line ${i}</p>`).join('')
    const p = await fresh(body)
    const full = (await text(p)).text as string
    const r = await text(p, 200)
    const head = full.slice(0, full.lastIndexOf('\n', 200))
    expect(r.text.startsWith(head + '\n')).toBe(true)
    expect(r.text.length).toBeGreaterThan(head.length + 1)
    expect(r.text.slice(head.length)).not.toContain(full.slice(head.length, head.length + 30).trim())
  })
})

describe('locate', () => {
  test('滚到可见并给出中心点（视口坐标）', async () => {
    const p = await fresh('<div style="height:2500px"></div><button id="b" style="width:100px;height:40px">Low</button>')
    const ref = refOn((await scan(p, { filter: 'all' })).pageContent, 'Low')
    const r = await call(p, 'locate', ref)
    expect(r.success).toBe(true)
    const box = await p.evaluate(() => document.getElementById('b')!.getBoundingClientRect().toJSON())
    expect(r.coordinates[0]).toBeCloseTo(box.left + box.width / 2, 0)
    expect(r.coordinates[1]).toBeCloseTo(box.top + box.height / 2, 0)
    expect(r.coordinates[1]).toBeGreaterThan(0)
    expect(r.coordinates[1]).toBeLessThan(600)
  })
  test('编号失效 → success:false + ref_stale', async () => {
    const p = await fresh('<button id="b">B</button>')
    const ref = refOn((await scan(p)).pageContent, '"B"')
    await p.evaluate(() => document.getElementById('b')!.remove())
    const r = await call(p, 'locate', ref)
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('ref_stale')
    expect(r.error.length).toBeGreaterThan(0)
  })
})

describe('scrollFallback', () => {
  const page = () =>
    fresh(`<div id="box" style="height:200px;width:300px;overflow:auto"><div style="height:2000px"><p id="in">x</p></div></div>
      <div style="height:3000px"></div>`)
  test('点在可滚动容器里（含其子元素）→ 滚容器，不滚窗口，返回 true', async () => {
    const p = await page()
    expect(await call(p, 'scrollFallback', 50, 10, 0, 150)).toBe(true)
    const s = await p.evaluate(() => [document.getElementById('box')!.scrollTop, scrollY])
    expect(s).toEqual([150, 0])
  })
  test('点下没有可滚动容器 → 滚窗口', async () => {
    const p = await page()
    expect(await call(p, 'scrollFallback', 600, 400, 0, 300)).toBe(true)
    expect(await p.evaluate(() => scrollY)).toBe(300)
  })
})

describe('formInput', () => {
  const setup = async (html: string) => {
    const p = await fresh(html + '<script>window.ev=[];for(const t of ["input","change","click"])document.addEventListener(t,e=>ev.push(t+":"+e.target.id),true)</script>')
    const out = (await scan(p, { filter: 'all' })).pageContent as string
    // 每个控件带 aria-label="#id#"，按它找所在行
    const ref = async (id: string) => refOn(out, `#${id}#`)!
    return { p, ref }
  }
  const fill = (p: Page, ref: string, v: unknown) => call(p, 'formInput', ref, v)
  const events = (p: Page) => p.evaluate(() => (window as any).ev as string[])
  const valueOf = (p: Page, id: string) => p.evaluate((i) => (document.getElementById(i) as HTMLInputElement).value, id)

  test('文本框：赋值、光标在末尾、先 input 后 change 都冒泡、成功只给 output', async () => {
    const { p, ref } = await setup('<input id="t" aria-label="#t#" value="old">')
    const r = await fill(p, await ref('t'), 'new text')
    expect(r.error).toBeUndefined()
    expect(typeof r.output).toBe('string')
    expect(r.output.length).toBeGreaterThan(0)
    expect(await valueOf(p, 't')).toBe('new text')
    expect(await p.evaluate(() => (document.getElementById('t') as HTMLInputElement).selectionStart)).toBe(8)
    expect((await events(p)).filter((e) => !e.startsWith('click'))).toEqual(['input:t', 'change:t'])
  })
  test('绕开实例上的 value 拦截（受控输入框），用原生 setter 写进去', async () => {
    const { p, ref } = await setup('<input id="t" aria-label="#t#">')
    await p.evaluate(() => {
      const el = document.getElementById('t')!
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
      Object.defineProperty(el, 'value', { configurable: true, get() { return d.get!.call(this) }, set() {} })
    })
    await fill(p, await ref('t'), 'via native')
    expect(await valueOf(p, 't')).toBe('via native')
  })
  test('textarea 同样赋值', async () => {
    const { p, ref } = await setup('<textarea id="a" aria-label="#a#"></textarea>')
    expect((await fill(p, await ref('a'), 'multi\nline')).error).toBeUndefined()
    expect(await valueOf(p, 'a')).toBe('multi\nline')
  })
  test('下拉：按 value 或按显示文字选中；找不到 → input_invalid', async () => {
    const { p, ref } = await setup('<select id="s"><option value="">#s#</option><option value="a">Apple</option><option value="b">Banana</option></select>')
    const r = await ref('s')
    expect((await fill(p, r, 'b')).error).toBeUndefined()
    expect(await valueOf(p, 's')).toBe('b')
    expect((await fill(p, r, 'Apple')).error).toBeUndefined()
    expect(await valueOf(p, 's')).toBe('a')
    expect((await events(p)).filter((e) => !e.startsWith('click')).slice(0, 2)).toEqual(['input:s', 'change:s'])
    const bad = await fill(p, r, 'Cherry')
    expect(bad.errorCode).toBe('input_invalid')
    expect(bad.output).toBeUndefined()
  })
  test('敏感下拉找不到选项时，报错里不泄露选项', async () => {
    const { p, ref } = await setup('<select id="s" aria-label="#s#" autocomplete="cc-exp-month"><option value="m07">Month07</option></select>')
    const r = await fill(p, await ref('s'), 'zz')
    expect(r.errorCode).toBe('input_invalid')
    expect(r.error).not.toContain('m07')
    expect(r.error).not.toContain('Month07')
  })
  test('复选框：要布尔值；状态不同才点击；已是目标状态不点击', async () => {
    const { p, ref } = await setup('<input type="checkbox" id="c" aria-label="#c#">')
    const r = await ref('c')
    expect((await fill(p, r, 'true')).errorCode).toBe('input_invalid')
    expect((await fill(p, r, true)).error).toBeUndefined()
    expect(await p.evaluate(() => (document.getElementById('c') as HTMLInputElement).checked)).toBe(true)
    expect((await events(p)).filter((e) => e.startsWith('click'))).toHaveLength(1)
    expect((await fill(p, r, true)).error).toBeUndefined()
    expect((await events(p)).filter((e) => e.startsWith('click'))).toHaveLength(1)
  })
  test('复选框被页面拦住没变 → input_invalid', async () => {
    const { p, ref } = await setup('<input type="checkbox" id="c" aria-label="#c#" onclick="return false">')
    expect((await fill(p, await ref('c'), true)).errorCode).toBe('input_invalid')
  })
  test('单选：false → input_invalid；true → 选中', async () => {
    const { p, ref } = await setup('<input type="radio" name="g" id="r" aria-label="#r#">')
    const r = await ref('r')
    expect((await fill(p, r, false)).errorCode).toBe('input_invalid')
    expect((await fill(p, r, true)).error).toBeUndefined()
    expect(await p.evaluate(() => (document.getElementById('r') as HTMLInputElement).checked)).toBe(true)
  })
  test('数字 / 范围：非数字 → input_invalid；数字照写；数字框可清空', async () => {
    const { p, ref } = await setup('<input type="number" id="n" aria-label="#n#" value="3"><input type="range" id="g" aria-label="#g#" min="0" max="100">')
    const n = await ref('n')
    const g = await ref('g')
    expect((await fill(p, n, 'abc')).errorCode).toBe('input_invalid')
    expect((await fill(p, g, 'abc')).errorCode).toBe('input_invalid')
    expect((await fill(p, n, 42)).error).toBeUndefined()
    expect(await valueOf(p, 'n')).toBe('42')
    expect((await fill(p, g, '30')).error).toBeUndefined()
    expect(await valueOf(p, 'g')).toBe('30')
    expect((await fill(p, n, '')).error).toBeUndefined()
    expect(await valueOf(p, 'n')).toBe('')
  })
  test('日期类：浏览器不收的值 → input_invalid 且不发事件；合法值写入', async () => {
    const { p, ref } = await setup('<input type="date" id="d" aria-label="#d#">')
    const d = await ref('d')
    expect((await fill(p, d, '2026-13-45')).errorCode).toBe('input_invalid')
    expect((await events(p)).filter((e) => !e.startsWith('click'))).toEqual([])
    expect((await fill(p, d, '2026-11-12')).error).toBeUndefined()
    expect(await valueOf(p, 'd')).toBe('2026-11-12')
  })
  test('禁用 / 只读 → element_not_editable；不是表单控件 → element_unsupported', async () => {
    const { p, ref } = await setup(`
      <input id="x" aria-label="#x#" disabled><input id="y" aria-label="#y#" readonly>
      <select id="z" disabled><option>#z#</option></select>
      <div id="v" aria-label="#v#" tabindex="0">div</div><div id="w" aria-label="#w#" contenteditable="true"></div>`)
    for (const id of ['x', 'y', 'z']) expect((await fill(p, await ref(id), 'q')).errorCode).toBe('element_not_editable')
    for (const id of ['v', 'w']) expect((await fill(p, await ref(id), 'q')).errorCode).toBe('element_unsupported')
  })
  test('编号失效 → ref_stale', async () => {
    const { p, ref } = await setup('<input id="t" aria-label="#t#">')
    const r = await ref('t')
    await p.evaluate(() => document.getElementById('t')!.remove())
    expect((await fill(p, r, 'q')).errorCode).toBe('ref_stale')
  })
  test('页面里抛异常 → injected_script_failed', async () => {
    const { p, ref } = await setup('<input id="t" aria-label="#t#">')
    await p.evaluate(() => {
      document.getElementById('t')!.focus = () => { throw new Error('boom') }
    })
    expect((await fill(p, await ref('t'), 'q')).errorCode).toBe('injected_script_failed')
  })
  test('密码框：新旧值都不出现在结果里', async () => {
    const { p, ref } = await setup('<input type="password" id="t" aria-label="#t#" value="oldPw">')
    const r = await fill(p, await ref('t'), 'newPw')
    expect(r.error).toBeUndefined()
    expect(r.output).not.toContain('newPw')
    expect(r.output).not.toContain('oldPw')
    expect(await valueOf(p, 't')).toBe('newPw')
  })
})

describe('observe', () => {
  const obs = (p: Page, o: object = {}) => call(p, 'observe', { quietMs: 30, capMs: 300, ...o })
  test('异步；返回页面信息、滚动、文字和元素', async () => {
    const p = await fresh('<p>Hello   visible\n text</p><button>Go</button><div style="height:3000px"></div>')
    expect(await p.evaluate(() => (window as any).__jevScan.observe({ quietMs: 1, capMs: 5 }) instanceof Promise)).toBe(true)
    const r = await obs(p)
    expect(r.url).toBe(ORIGIN + '/')
    expect(r.title).toBe('Fixture')
    expect(r.viewport).toEqual({ w: 800, h: 600 })
    expect(r.scroll.y).toBe(0)
    expect(r.scroll.height).toBeGreaterThan(3000)
    expect(r.scroll.canDown).toBe(true)
    expect(r.scroll.canUp).toBe(false)
    expect(typeof r.canGoBack).toBe('boolean')
    expect(r.text.startsWith('Hello visible text')).toBe(true)
    expect(r.omitted).toBe(0)
    expect(r.elements).toHaveLength(1)
    expect(r.elements[0]).toMatchObject({ role: 'button', label: 'Go', inView: true })
  })
  test('滚到底：canUp 真、canDown 假、y 为整数', async () => {
    const p = await fresh('<div style="height:3000px"></div>')
    await p.evaluate(() => scrollTo(0, 99999))
    const r = await obs(p)
    expect(r.scroll.canUp).toBe(true)
    expect(r.scroll.canDown).toBe(false)
    expect(Number.isInteger(r.scroll.y)).toBe(true)
  })
  test('文字按 textChars 截', async () => {
    const r = await obs(await fresh(`<p>${'abc '.repeat(500)}</p>`), { textChars: 50 })
    expect(r.text.length).toBeLessThanOrEqual(50)
  })
  test('只收视口内、可见、未禁用、有大小的可交互元素', async () => {
    const p = await fresh(`
      <button>Ok</button><button disabled>Dis</button><div aria-disabled="true"><button>UnderDis</button></div>
      <button style="display:none">Hid</button><button style="width:0;height:0;padding:0;border:0;overflow:hidden">Zero</button>
      <button aria-hidden="true">AH</button><div style="height:3000px"></div><button>Far</button>`)
    const labels = (await obs(p)).elements.map((e: any) => e.label)
    expect(labels).toEqual(['Ok'])
  })
  test('与 scan 共用编号', async () => {
    const p = await fresh('<button>Shared</button>')
    const r = await obs(p)
    expect(r.elements[0].ref).toBe(refOn((await scan(p)).pageContent, 'Shared'))
  })
  test('没有名字时 label 用角色；名字过长截断', async () => {
    const p = await fresh(`<div tabindex="0" style="width:50px;height:20px"></div><button>${'x'.repeat(300)}</button>`)
    const els = (await obs(p)).elements
    expect(els[0].label).toBe('generic')
    expect(els[1].label.length).toBeLessThanOrEqual(120)
  })
  test('字段：value、checked 字符串、aria 状态、editable / inputType', async () => {
    const p = await fresh(`
      <input id="a" aria-label="Name" value="Bob"><input type="email" aria-label="Mail"><input type="search" aria-label="Find">
      <input type="checkbox" aria-label="Agree" checked><button aria-expanded="false">Menu</button>
      <div contenteditable="true" aria-label="Notes"></div><input type="password" aria-label="Pw" value="pwSECRET">`)
    const by = Object.fromEntries((await obs(p)).elements.map((e: any) => [e.label, e]))
    expect(by.Name).toMatchObject({ value: 'Bob', editable: true })
    expect(by.Name.inputType).toBeUndefined()
    expect(by.Mail).toMatchObject({ editable: true, inputType: 'email' })
    expect(by.Find.inputType).toBeUndefined()
    expect(by.Agree.checked).toBe('true')
    expect(by.Agree.editable).toBeUndefined()
    expect(by.Menu.expanded).toBe('false')
    expect(by.Notes.editable).toBe(true)
    expect(JSON.stringify(by.Pw)).not.toContain('SECRET')
  })
  test('值和名字相同时不重复给 value', async () => {
    const p = await fresh('<input value="Same">')
    const el = (await obs(p)).elements[0]
    expect(el.label).toBe('Same')
    expect(el.value).toBeUndefined()
  })
  test('链接：同源只给路径+查询，跨源给全址，最长 100', async () => {
    const p = await fresh(`<a href="/a/b?c=1#frag">Same</a><a href="https://other.example/x">Other</a>
      <a href="https://other.example/${'p'.repeat(200)}">Long</a>`)
    const by = Object.fromEntries((await obs(p)).elements.map((e: any) => [e.label, e]))
    expect(by.Same.href).toBe('/a/b?c=1')
    expect(by.Other.href).toBe('https://other.example/x')
    expect(by.Long.href.length).toBe(100)
  })
  test('下拉：选项最多 60 个，字段齐；敏感下拉选项为空', async () => {
    const opts = Array.from({ length: 70 }, (_, i) => `<option value="v${i}"${i === 2 ? ' selected' : ''}${i === 3 ? ' disabled' : ''}>Opt ${i}</option>`).join('')
    const p = await fresh(`<select>${opts}</select><select aria-label="Card" autocomplete="cc-exp-month"><option>m1</option></select>`)
    const by = Object.fromEntries((await obs(p)).elements.map((e: any) => [e.label, e]))
    expect(by['Opt 2'].options).toHaveLength(60)
    expect(by['Opt 2'].options[2]).toEqual({ i: 2, label: 'Opt 2', value: 'v2', selected: true, disabled: false })
    expect(by['Opt 2'].options[3].disabled).toBe(true)
    expect(by['Opt 2'].editable).toBeUndefined()
    expect(by.Card.options).toEqual([])
  })
  test('max 封顶，超出计入 omitted', async () => {
    const p = await fresh(Array.from({ length: 12 }, (_, i) => `<button>B${i}</button>`).join(''))
    const r = await obs(p, { max: 5 })
    expect(r.elements).toHaveLength(5)
    expect(r.omitted).toBe(7)
  })
  test('外层与里层同名时只留里层；可编辑的不参与去重', async () => {
    const p = await fresh(`<div role="option" tabindex="0" aria-label="Pick me"><a href="/p">Pick me</a></div>
      <div contenteditable="true" aria-label="Field"><span tabindex="0">Field</span></div>`)
    const els = (await obs(p)).elements
    expect(els.filter((e: any) => e.label === 'Pick me').map((e: any) => e.role)).toEqual(['link'])
    const field = els.filter((e: any) => e.label === 'Field')
    expect(field).toHaveLength(2)
    expect(field[0].editable).toBe(true)
  })
  test('等 DOM 安静：等待期间加的元素能拿到', async () => {
    const p = await fresh('')
    const r = await p.evaluate(() => {
      setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<button>Late</button>'), 15)
      return (window as any).__jevScan.observe({ quietMs: 80, capMs: 1000 })
    })
    expect(r.elements.map((e: any) => e.label)).toContain('Late')
  })
  test('DOM 一直在变也不超过 capMs 太多', async () => {
    const p = await fresh('<div id="t">0</div><script>setInterval(()=>t.textContent=Math.random(),10)</script>')
    const { ms } = await elapsed(() => obs(p, { quietMs: 100, capMs: 400 }))
    expect(ms).toBeGreaterThan(350)
    expect(ms).toBeLessThan(1500)
  })
  test('DOM 安静时不等到 capMs', async () => {
    const p = await fresh('<button>Calm</button>')
    const { ms } = await elapsed(() => obs(p, { quietMs: 40, capMs: 3000 }))
    expect(ms).toBeLessThan(1500)
  })
})

describe('uploadFiles', () => {
  const setup = async (html: string) => {
    const p = await fresh(html + '<script>window.ev=[];for(const t of ["input","change"])document.addEventListener(t,e=>ev.push(t),true)</script>')
    const out = (await scan(p, { filter: 'all' })).pageContent as string
    return { p, ref: (n: string) => refOn(out, n)! }
  }
  test('file input：塞进文件（内容、名字、类型，缺类型给通用二进制类型），发 input 和 change', async () => {
    const { p, ref } = await setup('<input type="file" id="f" aria-label="Up" multiple>')
    const r = await call(p, 'uploadFiles', ref('Up'), [
      { data: b64('hello'), name: 'a.txt', mimeType: 'text/plain' },
      { data: b64('\x00\x01\x02'), name: 'b.bin' },
    ])
    expect(r.error).toBeUndefined()
    expect(r.output).toContain('a.txt')
    expect(r.output).toContain('b.bin')
    const files = await p.evaluate(async () =>
      Promise.all([...(document.getElementById('f') as HTMLInputElement).files!].map(async (f) => [f.name, f.type, f.size, await f.text()])),
    )
    expect(files[0]).toEqual(['a.txt', 'text/plain', 5, 'hello'])
    expect(files[1].slice(0, 3)).toEqual(['b.bin', 'application/octet-stream', 3])
    expect((await p.evaluate(() => (window as any).ev)).sort()).toEqual(['change', 'input'])
  })
  test('不是 file input → element_unsupported；编号失效 → ref_stale；坏 base64 → injected_script_failed', async () => {
    const { p, ref } = await setup('<input aria-label="Txt"><button>Btn</button><input type="file" aria-label="Up" id="f">')
    const one = [{ data: b64('x'), name: 'x.txt' }]
    expect((await call(p, 'uploadFiles', ref('Txt'), one)).errorCode).toBe('element_unsupported')
    expect((await call(p, 'uploadFiles', ref('Btn'), one)).errorCode).toBe('element_unsupported')
    expect((await call(p, 'uploadFiles', ref('Up'), [{ data: '!!!', name: 'x' }])).errorCode).toBe('injected_script_failed')
    await p.evaluate(() => document.getElementById('f')!.remove())
    expect((await call(p, 'uploadFiles', ref('Up'), one)).errorCode).toBe('ref_stale')
  })
})

describe('dropFiles', () => {
  const zone = `<div id="z" style="position:absolute;left:0;top:0;width:300px;height:200px"></div>
    <script>window.ev=[];for(const t of ["dragenter","dragover","drop"])z.addEventListener(t,e=>{e.preventDefault();
    ev.push([t,e.clientX,e.clientY,[...e.dataTransfer.files].map(f=>f.name)])})</script>`
  const file = [{ data: b64('img'), name: 'pic.png', mimeType: 'image/png' }]
  test('落点是普通元素 → 依次派三种拖放事件，带文件和坐标；结果提到文件名和显示坐标', async () => {
    const p = await fresh(zone)
    const r = await call(p, 'dropFiles', 100, 50, file, [1234.4, 567.6])
    expect(r.error).toBeUndefined()
    expect(r.output).toContain('pic.png')
    expect(r.output).toContain('1234')
    expect(r.output).toContain('568')
    const ev = await p.evaluate(() => (window as any).ev)
    expect(ev.map((e: any) => e[0])).toEqual(['dragenter', 'dragover', 'drop'])
    for (const e of ev) expect(e.slice(1)).toEqual([100, 50, ['pic.png']])
  })
  test('落点是 file input → 直接塞文件并发 change', async () => {
    const p = await fresh('<input type="file" id="f" style="position:absolute;left:0;top:0;width:200px;height:40px"><script>window.ch=0;f.onchange=()=>ch++</script>')
    const r = await call(p, 'dropFiles', 20, 20, file, [20, 20])
    expect(r.error).toBeUndefined()
    expect(await p.evaluate(() => [(document.getElementById('f') as HTMLInputElement).files![0].name, (window as any).ch])).toEqual(['pic.png', 1])
  })
  test('同源 iframe：钻进去投到里面的元素', async () => {
    const p = await fresh('<iframe src="/inner" style="position:absolute;left:100px;top:100px;width:400px;height:300px;border:0"></iframe>', { '/inner': `<body style="margin:0">${zone}</body>` })
    await p.waitForFunction(() => (document.querySelector('iframe') as HTMLIFrameElement).contentDocument?.getElementById('z'))
    const r = await call(p, 'dropFiles', 150, 130, file, [150, 130])
    expect(r.error).toBeUndefined()
    const ev = await p.evaluate(() => ((document.querySelector('iframe') as HTMLIFrameElement).contentWindow as any).ev)
    expect(ev.map((e: any) => e[0])).toContain('drop')
  })
  test('落点没有元素 → 只有 error，没有 errorCode', async () => {
    const p = await fresh(zone)
    const r = await call(p, 'dropFiles', -50, -50, file, [-50, -50])
    expect(typeof r.error).toBe('string')
    expect(r.error.length).toBeGreaterThan(0)
    expect(r.errorCode).toBeUndefined()
    expect(r.output).toBeUndefined()
  })
  test('坏 base64 → 只有 error，没有 errorCode', async () => {
    const p = await fresh(zone)
    const r = await call(p, 'dropFiles', 100, 50, [{ data: '!!!', name: 'x' }], [100, 50])
    expect(r.error.length).toBeGreaterThan(0)
    expect(r.errorCode).toBeUndefined()
  })
})
