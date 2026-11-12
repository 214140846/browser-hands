// 保活：只靠 native messaging 连接 + 30 秒 alarm 看门狗。没有 offscreen、没有心跳、没有固定 sleep。
import { handle } from './dispatch.js'
import { toError } from './errors.js'

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

// 插件主动问 host 的请求（目前只有 jev_balance）：id 用字符串，host 的应答没有 method，按 id 找回
const asks = new Map()
let askSeq = 0
function askHost(method, params, ms = 12000) {
  return new Promise((resolve) => {
    if (!port) return resolve(null)
    const id = `ask${++askSeq}`
    const timer = setTimeout(() => (asks.delete(id), resolve(null)), ms)
    asks.set(id, (v) => (clearTimeout(timer), resolve(v)))
    port.postMessage({ id, method, params })
  })
}

// 状态小窗打开时问一次余额；没连上 host / 超时返回 null，小窗显示「余额不可用」。不轮询
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'getBalance') return
  askHost('jev_balance', {}).then((r) => reply(r))
  return true
})

// 设置页读写 Jev 模型来源：转给 host，key 只写不读（host 只回「是否已设置」）
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'jevSettings') return
  askHost(msg.op === 'set' ? 'jev_settings_set' : 'jev_settings_get', msg.patch ?? {}).then((r) => reply(r))
  return true
})

async function onMessage(msg) {
  if (msg && msg.method === undefined && asks.has(msg.id)) {
    const done = asks.get(msg.id)
    asks.delete(msg.id)
    return done(msg.result ?? null)
  }
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
