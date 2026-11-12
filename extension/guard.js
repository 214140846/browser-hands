// 执行器第 2 步：记下调用开始时标签所在的网站，执行前 / 点击按下前 / 截图前再查（含正在跳转的目标），变了报 navigated_away。
// 在动作之前拦，不依赖站点分类，只比较网站（hostname）；url 与 pendingUrl（Chrome tabs API 字段）都看。
const siteOf = (url) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

const urlsOf = (t) => [t?.url, t?.pendingUrl].filter(Boolean)

export async function startGuard(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null)
  // 调用开始时就在跳转的话，当前网址和跳转目标都算「开始时的网站」
  const sites = new Set(urlsOf(t).map(siteOf))
  const site = siteOf(urlsOf(t)[0] ?? '')
  if (!sites.size) sites.add('')
  return {
    tabId,
    site,
    // stage：要做的动作（click / type / screenshot …），只用来写进报错
    async check(stage) {
      const now = await chrome.tabs.get(tabId).catch(() => null)
      for (const u of urlsOf(now)) {
        const to = siteOf(u)
        if (!sites.has(to))
          throw Object.assign(
            new Error(`Tab ${tabId} navigated away from "${site || 'about:blank'}" to "${to || 'about:blank'}" during this call, so the ${stage} was not performed.`),
            { code: 'navigated_away' },
          )
      }
    },
  }
}

// 测试钩子：端到端测试在 service worker 里直接调（service worker 里不能动态 import）
globalThis.__jevGuard = { startGuard }
