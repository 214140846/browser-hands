// 真模型回归（花钱）：默认跳过，JEV_REAL=1 才跑。看 find 的概率分布，定「有匹配 / 无匹配」的阈值。
// key 只从 loadSettings() 取（配置文件 / JEV_* 环境变量），不打印、不落盘。累计费用到 $0.9 立刻停。
//   JEV_REAL=1 bun test test/real-jev.test.ts
import { expect, test } from 'bun:test'
import { loadSettings, makeProvider } from '../server/jev'
import { parseTree, rank } from '../server/jev-tools'

const real = process.env.JEV_REAL === '1'
const LIMIT = 0.9

// 本地 fixture：每页是 read_page 风格的树，每个问题标明页面上到底有没有匹配的元素
const login = `link "Home" [ref_1] href="/"
textbox "Email" [ref_2]
textbox "Password" [ref_3]
checkbox "Remember me" [ref_4]
button "Sign in" [ref_5]
link "Forgot password?" [ref_6]
button "Create account" [ref_7]`
const shop = `searchbox "Search products" [ref_1]
button "Search" [ref_2]
combobox "Sort by" [ref_3]
link "Red running shoes" [ref_4]
link "Blue running shoes" [ref_5]
button "Add to cart" [ref_6]
button "Buy now" [ref_7]
link "Cart (0)" [ref_8]`
const settings = `tab "Profile" [ref_1]
tab "Security" [ref_2]
tab "Billing" [ref_3]
switch "Email notifications" [ref_4]
switch "Dark mode" [ref_5]
textbox "Display name" [ref_6]
button "Save changes" [ref_7]
button "Delete account" [ref_8]`
const zh = `textbox "邮箱" [ref_1]
textbox "密码" [ref_2]
button "登录" [ref_3]
button "注册" [ref_4]
link "忘记密码" [ref_5]`

const cases: { page: string; tree: string; query: string; expect: string | null }[] = [
  { page: 'login', tree: login, query: 'the sign in button', expect: 'ref_5' },
  { page: 'login', tree: login, query: 'the password input', expect: 'ref_3' },
  { page: 'login', tree: login, query: 'the checkout button', expect: null },
  { page: 'login', tree: login, query: 'the language selector dropdown', expect: null },
  { page: 'shop', tree: shop, query: 'the button that puts the item in the cart', expect: 'ref_6' },
  { page: 'shop', tree: shop, query: 'the sort dropdown', expect: 'ref_3' },
  { page: 'shop', tree: shop, query: 'the login button', expect: null },
  { page: 'shop', tree: shop, query: 'the newsletter email field', expect: null },
  { page: 'settings', tree: settings, query: 'the dark mode toggle', expect: 'ref_5' },
  { page: 'settings', tree: settings, query: 'the button that saves the form', expect: 'ref_7' },
  { page: 'settings', tree: settings, query: 'the search box', expect: null },
  { page: 'settings', tree: settings, query: 'the download invoice link', expect: null },
  { page: 'zh', tree: zh, query: '登录按钮', expect: 'ref_3' },
  { page: 'zh', tree: zh, query: '购物车图标', expect: null },
]

test.skipIf(!real)('真 Jev：find 概率分布（有匹配 / 无匹配）', async () => {
  const jev = makeProvider(loadSettings())
  let spent = 0
  const rows: any[] = []
  for (const c of cases) {
    if (spent >= LIMIT) break
    const treeRows = parseTree(c.tree)
    const r = await rank(jev, { description: c.query, rows: treeRows, url: `https://fixture.test/${c.page}`, title: c.page })
    spent += r.cost
    const [top, second] = r.candidates
    rows.push({ page: c.page, query: c.query, truth: c.expect ?? 'none', top: top?.ref, top_p: top?.p, second_p: second?.p ?? 0, none_p: r.none })
  }
  console.table(rows)
  console.log(`花费 $${spent.toFixed(4)}`)
  expect(spent).toBeLessThan(1)
}, 600000)
