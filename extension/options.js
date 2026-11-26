// 设置页：打开时读一次，点保存时写一次；不轮询。
const $ = (id) => document.getElementById(id)

async function load() {
  const { profileName = '', clickMode = 'debugger' } = await chrome.storage.local.get(['profileName', 'clickMode'])
  $('profileName').value = profileName
  $('clickMode').value = clickMode
  document.body.dataset.ready = '1'
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ profileName: $('profileName').value.trim().slice(0, 60), clickMode: $('clickMode').value })
  $('saved').textContent = 'Saved'
})
load()
