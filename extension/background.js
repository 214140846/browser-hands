// 保活：只靠 native messaging 连接 + 30 秒 alarm 看门狗。没有 offscreen、没有心跳、没有固定 sleep。
import { handle } from './dispatch.js'
import { toError } from './errors.js'
import { setBrowser } from './browser.js'

const HOST_NAME = 'com.thundermcp.host'
let port = null

function connect() {
  if (port) return
  let p
  try {
    p = chrome.runtime.connectNative(HOST_NAME)
  } catch {
    return
  }
  port = p
  p.onMessage.addListener(onMessage)
  p.onDisconnect.addListener(() => {
    void chrome.runtime.lastError // 读掉，避免未检查报错
    if (port === p) port = null
  })
}

async function onMessage(msg) {
  if (msg?.method === 'host_info') return setBrowser(msg.params?.browser)
  if (!msg || msg.id === undefined) return
  const reply = { id: msg.id }
  try {
    reply.result = await handle(msg.method, msg.params ?? {}, msg.sessionId)
  } catch (e) {
    reply.error = toError(e)
  }
  port?.postMessage(reply)
}

chrome.alarms.create('watchdog', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'watchdog') connect() // 断了才重连，没断什么都不做
})
chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect()
