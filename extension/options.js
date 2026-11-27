// 设置页：打开时读一次，点保存时写一次；不轮询。
const $ = (id) => document.getElementById(id)

import { DEFAULT_MODEL, STORAGE_KEYS as FIND_AI_KEYS, testConnection } from './find-ai.js'

// 密钥不回显：已保存时输入框留空，用 placeholder 提示；留空保存 = 不改
function showFindAi(saved) {
  const [url, key, model] = FIND_AI_KEYS.map((k) => (saved[k] ?? '').trim())
  const on = Boolean(url && key)
  Object.entries({ findAiBaseUrl: url, findAiModel: model || DEFAULT_MODEL, findAiKey: '' }).forEach(([id, v]) => ($(id).value = v))
  $('findAiKey').placeholder = key ? 'Saved (leave empty to keep)' : ''
  $('findAiStatus').textContent = on ? 'On' : 'Off'
}

async function load() {
  const { profileName = '', clickMode = 'debugger' } = await chrome.storage.local.get(['profileName', 'clickMode'])
  $('profileName').value = profileName
  $('clickMode').value = clickMode
  showFindAi(await chrome.storage.local.get(FIND_AI_KEYS))
  document.body.dataset.ready = '1'
}

$('save').addEventListener('click', async () => {
  const typed = Object.fromEntries(FIND_AI_KEYS.map((k) => [k, $(k).value.trim()]))
  if (!typed.findAiKey) delete typed.findAiKey
  typed.findAiModel ||= DEFAULT_MODEL
  await chrome.storage.local.set({ profileName: $('profileName').value.trim().slice(0, 60), clickMode: $('clickMode').value, ...typed })
  showFindAi(await chrome.storage.local.get(FIND_AI_KEYS))
  $('saved').textContent = 'Saved'
})
$('findAiClear').addEventListener('click', async () => {
  await chrome.storage.local.remove(FIND_AI_KEYS)
  showFindAi({})
  $('saved').textContent = 'Find model turned off'
})
// Test：用输入框里现在的值发一个最小请求（不保存）。密钥留空时只在地址没改（与已保存的相同）才用已保存的密钥，
// 防止把已保存的密钥发到刚改的新地址
const sameUrl = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
$('findAiTest').addEventListener('click', async () => {
  const out = $('findAiTestResult')
  const btn = $('findAiTest')
  btn.disabled = true
  try {
    const saved = await chrome.storage.local.get(['findAiBaseUrl', 'findAiKey'])
    const baseUrl = $('findAiBaseUrl').value.trim()
    const typedKey = $('findAiKey').value.trim()
    const key = typedKey || (sameUrl(baseUrl, (saved.findAiBaseUrl ?? '').trim()) ? (saved.findAiKey ?? '').trim() : '')
    if (!baseUrl || !key) return void (out.textContent = 'Fill in the base URL and the API key first (the saved key is only reused when the base URL is unchanged)')
    out.textContent = 'Testing…'
    const r = await testConnection({ baseUrl, key, model: $('findAiModel').value.trim() || DEFAULT_MODEL })
    out.textContent = r.ok ? `OK (${r.format} format, ${r.ms} ms)` : `Failed (${r.format} format): ${r.error}`
  } finally {
    btn.disabled = false
  }
})
load()
