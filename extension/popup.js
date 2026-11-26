// 状态小窗：打开时问后台要一次会话列表，点"全部停止"才再发消息；不轮询。
const list = document.getElementById('list')
const stopAll = document.getElementById('stopAll')

function render({ sessions }) {
  list.replaceChildren()
  if (!sessions.length) {
    const p = document.createElement('p')
    p.className = 'empty'
    p.textContent = 'No active sessions'
    list.append(p)
  }
  for (const s of sessions) {
    const box = document.createElement('div')
    box.className = 'session'
    box.dataset.session = s.id
    const name = document.createElement('b')
    name.textContent = `${s.running > 0 ? '⌛' : '✅'} ${s.name}`
    const ul = document.createElement('ul')
    ul.className = 'tabs'
    for (const t of s.tabs) {
      const li = document.createElement('li')
      li.textContent = `#${t.tabId} ${t.title || '(untitled)'}`
      ul.append(li)
    }
    box.append(name, ul)
    list.append(box)
  }
  stopAll.disabled = !sessions.some((s) => s.running > 0)
}

const refresh = async () => render(await chrome.runtime.sendMessage({ type: 'getStatus' }))
stopAll.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stopAll' })
  await refresh()
})
refresh()
