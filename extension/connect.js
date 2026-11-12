const rid = new URLSearchParams(location.search).get('rid')
const { profileName = '' } = await chrome.storage.local.get('profileName')
document.getElementById('name').value = profileName
const email = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }).then((i) => i.email ?? '', () => '')
document.getElementById('who').textContent = email ? `${profileName || '(unnamed)'} · ${email}` : profileName || '(unnamed)'
document.getElementById('connect').onclick = async () => {
  const name = document.getElementById('name').value.trim()
  await chrome.runtime.sendMessage({ type: 'connectDecision', requestId: rid, name })
}
