// 拉起 native host 的浏览器（host 握手时用 host_info 报告，见 server/host.ts）。
// 只在浏览器行为和 Chrome 不同的地方用来选路径；没报告过时为 'unknown'，按 Chrome 处理。
let kind
let loaded

const load = () =>
  (loaded ??= chrome.storage.session.get('browser').then((r) => {
    kind ??= typeof r.browser === 'string' ? r.browser : 'unknown'
  }))

export async function setBrowser(k) {
  kind = typeof k === 'string' ? k : 'unknown'
  await chrome.storage.session.set({ browser: kind })
}

export async function browserKind() {
  await load()
  return kind
}
