const TEST_TMP = process.env.THUNDERMCP_TEST_TMP || '/tmp/thundermcp-test'
require('node:fs').mkdirSync(TEST_TMP, { recursive: true })
// host 的 socket 文件被外部删掉后要自己重建；已连上的连接不受影响。默认目录不在 /tmp。
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { socketDir } from '../server/paths'

const work = mkdtempSync(TEST_TMP + '/host-sock-')
const dir = join(work, 'sock')
const host = Bun.spawn(['bun', join(resolve(import.meta.dir, '..'), 'server/host.ts')], {
  env: { ...process.env, JEV_SOCKET_DIR: dir, JEV_HEAL_INTERVAL_MS: '100' },
  stdin: 'pipe',
  stdout: 'ignore',
  stderr: 'inherit',
})
const sockPath = join(dir, `${host.pid}.sock`)

afterAll(() => {
  host.kill()
  rmSync(work, { recursive: true, force: true })
})

async function until(ok: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('等待超时')
    await Bun.sleep(20)
  }
}

const dial = (p: string) =>
  new Promise<Socket>((ok, fail) => {
    const s = connect(p)
    s.once('connect', () => ok(s))
    s.once('error', fail)
  })

test('默认目录在 ~/.thundermcp/sock，JEV_SOCKET_DIR 可覆盖', () => {
  const saved = process.env.JEV_SOCKET_DIR
  delete process.env.JEV_SOCKET_DIR
  expect(socketDir()).toBe(join(homedir(), '.thundermcp', 'sock'))
  expect(`${socketDir()}/4194304.sock`.length).toBeLessThan(104)
  process.env.JEV_SOCKET_DIR = '/x/y'
  expect(socketDir()).toBe('/x/y')
  if (saved === undefined) delete process.env.JEV_SOCKET_DIR
  else process.env.JEV_SOCKET_DIR = saved
})

test('socket 文件被删后自动重建，旧连接不断、新连接能连', async () => {
  await until(() => existsSync(sockPath))
  const old = await dial(sockPath)
  let oldClosed = false
  old.on('close', () => (oldClosed = true))

  rmSync(sockPath)
  await until(() => existsSync(sockPath))
  const fresh = await dial(sockPath)
  expect(oldClosed).toBe(false)

  // 整个目录被删也能恢复
  rmSync(dir, { recursive: true, force: true })
  await until(() => existsSync(sockPath))
  const again = await dial(sockPath)
  expect(oldClosed).toBe(false)

  for (const s of [old, fresh, again]) s.destroy()
})
