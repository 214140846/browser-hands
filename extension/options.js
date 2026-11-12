// 设置页：打开时读一次，点保存时写一次；不轮询。key 只写不读（host 只回「是否已设置」）。
const $ = (id) => document.getElementById(id)
const ask = (op, patch) => chrome.runtime.sendMessage({ type: 'jevSettings', op, patch })
let info = null

function showKeyState() {
  const has = info?.hasKey?.[$('provider').value]
  $('keyState').textContent = !info ? 'Host not connected; cannot read model settings' : has ? 'Key: set' : 'Key: not set'
}

async function load() {
  const { profileName = '', clickMode = 'debugger' } = await chrome.storage.local.get(['profileName', 'clickMode'])
  $('profileName').value = profileName
  $('clickMode').value = clickMode
  info = await ask('get')
  if (info) {
    $('provider').value = info.provider
    $('model').value = info.model
    $('settingsError').textContent = info.error
  }
  showKeyState()
  document.body.dataset.ready = '1'
}

$('provider').addEventListener('change', showKeyState)
$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ profileName: $('profileName').value.trim().slice(0, 60), clickMode: $('clickMode').value })
  if (info) {
    const next = await ask('set', { provider: $('provider').value, model: $('model').value, key: $('key').value })
    if (next && !next.error) info = next
    $('settingsError').textContent = next?.error ?? ''
  }
  $('key').value = ''
  showKeyState()
  $('saved').textContent = 'Saved'
})
load()
