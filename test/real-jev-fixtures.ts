// 真 Jev 采样用的本地多步任务页面和「每一步选得对不对」的判官。不上外网。
// 被 real-jev-task.test.ts（起站点、跑任务）和 real-jev-wrap.ts（包住真 Jev、记录每步概率）共用，不能 import bun:test。

export type Ctx = { op: string; tgt: string; els: any[]; text: string; recent: any[] }
const row = (c: Ctx, name: string) => c.els.find((e) => String(e.label).includes(name))
// 输入框的值观察不到（元素的 value 不回报），用最近动作里「填过且有值」代替
const filled = (c: Ctx, name: string) => c.recent.some((a) => a.kind === 'fill' && String(a.action).includes(name) && a.text)
const picked = (c: Ctx, v: string) => c.els.some((e) => e.value === v)
const on = (c: Ctx, name: string) => String(row(c, name)?.checked) === 'true'
const has = (c: Ctx, s: string) => c.text.includes(s)

// 默认让采样也走真 text()（当前 provider）；JEV_TEXT_TABLE=1 才改成按标签查这张表（不花钱，没有的字段给 null = 目标里没这个值）
export const fieldValues: Record<string, string> = { 'Full name': 'Ann Lee', Email: 'ann@example.com', 'Search products': 'widget', 'Phone number': '5550100', 'Company name': 'Acme', 'Shipping postcode': '90210' }

export type Fixture = { key: string; start: string; goal: string; details?: string; html: (u: URL) => string; ok: (c: Ctx) => boolean }

const page = (title: string, body: string, script = '') => `<title>${title}</title><body style="font:16px sans-serif"><main>${body}</main><script>${script}</script></body>`

export const fixtures: Fixture[] = [
  {
    key: 'exchange',
    start: '/f-exchange',
    goal: 'Start an exchange: enter the order number and the email from the details into the form. Do NOT click Submit.',
    details: 'Order number: A-10086, email: ann@example.com',
    html: () =>
      page(
        'Exchange',
        `<h1>Start an exchange</h1>
<label>Order number <input id="o" aria-label="Order number"></label><br>
<label>Email <input id="m" type="email" aria-label="Email"></label><br>
<button>Submit</button>`,
      ),
    ok: (c) => {
      if (c.op === 'TYPE_TEXT') return (c.tgt.includes('Order number') && !filled(c, 'Order number')) || (c.tgt.includes('Email') && !filled(c, 'Email'))
      if (c.op === 'DONE') return filled(c, 'Order number') && filled(c, 'Email')
      return false
    },
  },
  {
    key: 'form',
    start: '/f-form',
    goal: 'Fill the application form: name Ann Lee, email ann@example.com, country Canada, and tick the terms checkbox. Do NOT click Apply.',
    html: () =>
      page(
        'Application',
        `<h1>Application</h1>
<label>Full name <input id="n" aria-label="Full name"></label><br>
<label>Email <input id="e" type="email" aria-label="Email"></label><br>
<label>Country <select aria-label="Country"><option>Select…</option><option>Canada</option><option>France</option><option>Japan</option></select></label><br>
<label><input type="checkbox" aria-label="Accept terms"> Accept terms</label><br>
<button>Apply</button>`,
      ),
    ok: (c) => {
      if (c.op === 'TYPE_TEXT') return (c.tgt.includes('Full name') && !filled(c, 'Full name')) || (c.tgt.includes('Email') && !filled(c, 'Email'))
      if (c.op === 'SELECT') return c.tgt.includes('→ Canada') && !picked(c, 'Canada')
      if (c.op === 'CLICK') return c.tgt.includes('Accept terms') && !on(c, 'Accept terms')
      if (c.op === 'DONE') return filled(c, 'Full name') && filled(c, 'Email') && picked(c, 'Canada') && on(c, 'Accept terms')
      return false
    },
  },
  {
    key: 'selects',
    start: '/f-selects',
    goal: 'Set the size to Large, the colour to Green and the quantity to 3.',
    html: () =>
      page(
        'Options',
        `<h1>Options</h1>
<label>Size <select aria-label="Size"><option>Small</option><option>Medium</option><option>Large</option></select></label><br>
<label>Colour <select aria-label="Colour"><option>Red</option><option>Green</option><option>Blue</option></select></label><br>
<label>Quantity <select aria-label="Quantity"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label>`,
      ),
    ok: (c) => {
      const want: [string, string][] = [['Size', 'Large'], ['Colour', 'Green'], ['Quantity', '3']]
      const done = (_n: string, v: string) => picked(c, v)
      if (c.op === 'SELECT') return want.some(([n, v]) => c.tgt.includes(`→ ${v}`) && !done(n, v))
      if (c.op === 'DONE') return want.every(([n, v]) => done(n, v))
      return false
    },
  },
  {
    key: 'pages',
    start: '/f-pages?n=1',
    goal: 'Find the report called Zeta in the list and open it.',
    html: (u) => {
      const n = Number(u.searchParams.get('n') ?? 1)
      const items = [['Alpha', 'Beta', 'Gamma'], ['Delta', 'Epsilon', 'Eta'], ['Theta', 'Zeta', 'Kappa']][n - 1]
      return page(
        'Reports',
        `<h1>Reports, page ${n} of 3</h1><ul>${items.map((i) => `<li>${i} report <a href="/f-pages-detail?r=${i}">Open ${i}</a></li>`).join('')}</ul>
${n > 1 ? `<a href="/f-pages?n=${n - 1}">Previous page</a> ` : ''}${n < 3 ? `<a href="/f-pages?n=${n + 1}">Next page</a>` : ''}`,
      )
    },
    ok: (c) => {
      if (has(c, 'Zeta details')) return c.op === 'DONE'
      if (has(c, 'Zeta report')) return c.op === 'CLICK' && c.tgt.includes('Open Zeta')
      return c.op === 'CLICK' && c.tgt.includes('Next page')
    },
  },
  {
    key: 'toggles',
    start: '/f-toggles',
    goal: 'In the notification settings, turn on Email alerts and Dark mode, turn off SMS alerts, and leave Beta features as they are.',
    html: () =>
      page(
        'Notifications',
        `<h1>Notification settings</h1>
<label><input type="checkbox" aria-label="Email alerts"> Email alerts</label><br>
<label><input type="checkbox" aria-label="SMS alerts" checked> SMS alerts</label><br>
<label><input type="checkbox" aria-label="Dark mode"> Dark mode</label><br>
<label><input type="checkbox" aria-label="Beta features" checked> Beta features</label>`,
      ),
    ok: (c) => {
      const want: [string, boolean][] = [['Email alerts', true], ['SMS alerts', false], ['Dark mode', true]]
      if (c.op === 'CLICK') return want.some(([n, v]) => c.tgt.includes(n) && on(c, n) !== v)
      if (c.op === 'DONE') return want.every(([n, v]) => on(c, n) === v) && on(c, 'Beta features')
      return false
    },
  },
  {
    key: 'search',
    start: '/f-search',
    goal: 'Search for "widget" and open the Blue Widget result.',
    details: 'Search query: widget',
    html: () =>
      page(
        'Shop',
        `<h1>Shop</h1><input aria-label="Search products"> <button id="go">Search</button><div id="r"></div>`,
        `document.getElementById('go').onclick=()=>{document.getElementById('r').innerHTML='<h2>Results</h2><a href="#" id="b">Blue Widget</a> <a href="#">Red Widget</a>';document.getElementById('b').onclick=e=>{e.preventDefault();document.querySelector('main').innerHTML='<h1>Blue Widget details</h1>'}}`,
      ),
    ok: (c) => {
      if (has(c, 'Blue Widget details')) return c.op === 'DONE'
      if (has(c, 'Results')) return c.op === 'CLICK' && c.tgt.includes('Blue Widget')
      if (!filled(c, 'Search products')) return c.op === 'TYPE_TEXT' && c.tgt.includes('Search products')
      return (c.op === 'CLICK' && c.tgt.endsWith('Search')) || c.op === 'PRESS_ENTER'
    },
  },
  {
    key: 'tabs',
    start: '/f-tabs',
    goal: 'In Settings open the Security tab, turn on two-factor authentication and enter the phone number 5550100.',
    details: 'Phone number: 5550100',
    html: () =>
      page(
        'Settings',
        `<h1>Settings</h1><button role="tab" id="t1">Profile</button> <button role="tab" id="t2">Security</button>
<div id="p1"><p>Profile settings</p></div>
<div id="p2" hidden><p>Security settings</p><label><input type="checkbox" aria-label="Two-factor authentication"> Two-factor authentication</label><br><label>Phone <input aria-label="Phone number"></label></div>`,
        `t2.onclick=()=>{p1.hidden=true;p2.hidden=false};t1.onclick=()=>{p1.hidden=false;p2.hidden=true}`,
      ),
    ok: (c) => {
      if (!has(c, 'Security settings')) return c.op === 'CLICK' && c.tgt.includes('Security')
      if (c.op === 'TYPE_TEXT') return c.tgt.includes('Phone number') && !filled(c, 'Phone number')
      if (c.op === 'CLICK') return c.tgt.includes('Two-factor') && !on(c, 'Two-factor')
      if (c.op === 'DONE') return on(c, 'Two-factor') && filled(c, 'Phone number')
      return false
    },
  },
  {
    key: 'wizard',
    start: '/f-wizard',
    goal: 'Choose the Pro plan, set the company name to Acme, and go through the wizard until the review step is shown.',
    html: () =>
      page(
        'Wizard',
        `<div id="s1"><h1>Step 1: plan</h1><label><input type="radio" name="p" aria-label="Free plan"> Free plan</label><br><label><input type="radio" name="p" aria-label="Pro plan"> Pro plan</label><br><label><input type="radio" name="p" aria-label="Team plan"> Team plan</label><br><button id="n1">Next</button></div>
<div id="s2" hidden><h1>Step 2: company</h1><label>Company <input aria-label="Company name"></label><br><button id="n2">Next</button></div>
<div id="s3" hidden><h1>Review</h1><p>Plan and company are set.</p></div>`,
        `n1.onclick=()=>{s1.hidden=true;s2.hidden=false};n2.onclick=()=>{s2.hidden=true;s3.hidden=false}`,
      ),
    ok: (c) => {
      if (has(c, 'Review')) return c.op === 'DONE'
      if (has(c, 'Step 1')) return c.op === 'CLICK' && ((c.tgt.includes('Pro plan') && !on(c, 'Pro plan')) || (c.tgt.endsWith('Next') && on(c, 'Pro plan')))
      if (has(c, 'Step 2')) return (c.op === 'TYPE_TEXT' && c.tgt.includes('Company name') && !filled(c, 'Company name')) || (c.op === 'CLICK' && c.tgt.endsWith('Next') && filled(c, 'Company name'))
      return false
    },
  },
  {
    key: 'ship',
    start: '/f-ship',
    goal: 'Enter the shipping postcode 90210 (leave the billing postcode alone) and tick Same-day delivery.',
    html: () =>
      page(
        'Checkout address',
        `<h1>Address</h1><label>Billing postcode <input aria-label="Billing postcode"></label><br><label>Shipping postcode <input aria-label="Shipping postcode"></label><br>
<label><input type="checkbox" aria-label="Same-day delivery"> Same-day delivery</label><br><label><input type="checkbox" aria-label="Gift wrap"> Gift wrap</label>`,
      ),
    ok: (c) => {
      if (c.op === 'TYPE_TEXT') return c.tgt.includes('Shipping postcode') && !filled(c, 'Shipping postcode')
      if (c.op === 'CLICK') return c.tgt.includes('Same-day') && !on(c, 'Same-day delivery')
      if (c.op === 'DONE') return filled(c, 'Shipping postcode') && on(c, 'Same-day delivery') && !filled(c, 'Billing postcode')
      return false
    },
  },
  {
    key: 'rows',
    start: '/f-rows',
    goal: 'Open the edit page for the user Carol Diaz.',
    html: () =>
      page(
        'Users',
        `<h1>Users</h1><table>${['Ann Lee', 'Bob Chen', 'Carol Diaz', 'Dave Kim'].map((n) => `<tr><td>${n}</td><td>${n.toLowerCase().replace(' ', '.')}@example.com</td><td><a href="/f-rows-detail?r=Edit ${n}">Edit</a></td></tr>`).join('')}</table>`,
      ),
    ok: (c) => {
      if (has(c, 'Edit Carol Diaz details')) return c.op === 'DONE'
      return c.op === 'CLICK' && c.tgt.startsWith('[3] ') // 第 3 个元素是 Carol 那行的 Edit
    },
  },
  // 下面 5 组是「容易选错」的压力题：已经满足 / 页面上没有这个按钮 / 反向措辞 / 近似项 / 要比价
  {
    key: 'noop',
    start: '/f-noop',
    goal: 'Make sure dark mode is on.',
    html: () => page('Display', `<h1>Display</h1><label><input type="checkbox" aria-label="Dark mode" checked> Dark mode</label><br><label><input type="checkbox" aria-label="Large text"> Large text</label>`),
    ok: (c) => c.op === 'DONE',
  },
  {
    key: 'missing',
    start: '/f-missing',
    goal: 'Click the Export PDF button.',
    html: () => page('Report', `<h1>Report</h1><p>Quarterly numbers.</p><button>Save</button> <button>Cancel</button> <a href="#">Help</a>`),
    ok: (c) => c.op === 'BLOCKED',
  },
  {
    key: 'mute',
    start: '/f-mute',
    goal: 'Turn notifications back on so that nothing is muted.',
    html: () => page('Sound', `<h1>Sound</h1><label><input type="checkbox" aria-label="Mute all notifications" checked> Mute all notifications</label><br><label><input type="checkbox" aria-label="Mute sounds"> Mute sounds</label>`),
    ok: (c) => {
      if (c.op === 'CLICK') return c.tgt.includes('Mute all') && on(c, 'Mute all notifications')
      if (c.op === 'DONE') return !on(c, 'Mute all notifications') && !on(c, 'Mute sounds')
      return false
    },
  },
  {
    key: 'dates',
    start: '/f-dates',
    goal: 'Open the report for March 2024.',
    html: () => page('Archive', `<h1>Archive</h1><ul>${['March 2023', 'Marsh 2024', 'March 2024', 'April 2024'].map((m) => `<li><a href="/f-dates-detail?r=${m}">Report ${m}</a></li>`).join('')}</ul>`),
    ok: (c) => (has(c, 'March 2024 details') ? c.op === 'DONE' : c.op === 'CLICK' && c.tgt.includes('Report March 2024')),
  },
  {
    key: 'prices',
    start: '/f-prices',
    goal: 'Choose the cheapest paid plan.',
    html: () => page('Plans', `<h1>Plans</h1>${[['Max', 19], ['Basic', 5], ['Pro', 9], ['Free', 0]].map(([n, p]) => `<p>${n}: $${p} per month <a href="/f-prices-detail?r=${n}">Choose ${n}</a></p>`).join('')}`),
    ok: (c) => (has(c, 'Basic details') ? c.op === 'DONE' : c.op === 'CLICK' && c.tgt.includes('Choose Basic')),
  },
]

export const fixtureOf = (pathname: string) => fixtures.find((f) => pathname.startsWith(f.start.split('?')[0]))
