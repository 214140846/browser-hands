// 设置页：打开时读一次，点保存时写一次；不轮询。
const $ = (id) => document.getElementById(id)

const FIND_AI = { keys: ['findAiBaseUrl', 'findAiKey', 'findAiModel'], defaultModel: 'jev' }
const FIND_AI_KEYS = FIND_AI.keys

// 密钥不回显：已保存时输入框留空，用 placeholder 提示；留空保存 = 不改
function showFindAi(saved) {
  const [url, key, model] = FIND_AI_KEYS.map((k) => (saved[k] ?? '').trim())
  const on = Boolean(url && key)
  Object.entries({ findAiBaseUrl: url, findAiModel: model || FIND_AI.defaultModel, findAiKey: '' }).forEach(([id, v]) => ($(id).value = v))
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
  typed.findAiModel ||= FIND_AI.defaultModel
  await chrome.storage.local.set({ profileName: $('profileName').value.trim().slice(0, 60), clickMode: $('clickMode').value, ...typed })
  showFindAi(await chrome.storage.local.get(FIND_AI_KEYS))
  $('saved').textContent = 'Saved'
})
$('findAiClear').addEventListener('click', async () => {
  await chrome.storage.local.remove(FIND_AI_KEYS)
  showFindAi({})
  $('saved').textContent = 'Find model turned off'
})
load()
