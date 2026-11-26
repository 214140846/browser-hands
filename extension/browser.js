// 拉起 native host 的浏览器（host 握手时用 host_info 报告，见 server/host.ts）。
// 只在浏览器行为和 Chrome 不同的地方用来选路径。还没报告时先等 host_info（最多 REPORT_WAIT_MS），
// 免得 Arc 上抢在报告前到的调用走了 Chrome 的路径（标签组会卡死）；等不到记为 'unknown'，按 Chrome 处理。
const REPORT_WAIT_MS = 3000

let kind // undefined = host 还没报告过
let loaded
let reported // 等报告的 promise；setBrowser 或超时时 resolve。整个 service worker 生命周期只等一次
let onReport = () => {}

const load = () =>
  (loaded ??= chrome.storage.session.get('browser').then((r) => {
    if (typeof r.browser === 'string') kind ??= r.browser
  }))

const waitForReport = () =>
  (reported ??= new Promise((resolve) => {
    const timer = setTimeout(resolve, REPORT_WAIT_MS)
    onReport = () => (clearTimeout(timer), resolve())
  }))

export async function setBrowser(k) {
  kind = typeof k === 'string' ? k : 'unknown'
  onReport()
  await chrome.storage.session.set({ browser: kind })
}

export async function browserKind() {
  await load()
  if (kind === undefined) await waitForReport()
  return kind ?? 'unknown'
}
