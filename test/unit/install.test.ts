// 安装器的卸载：Arc 借用 Chrome 的清单目录，卸载 Arc 不能删掉 Chrome 也在用的那份清单
// 目录全部换成临时目录（Bun 的 homedir() 不看运行时改的 HOME，不能靠改 HOME 隔离）
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'thundermcp-install-'))
const chromeDir = join(tmp, 'Google/Chrome/NativeMessagingHosts')
const real = await import('../../server/paths.ts')
mock.module('../../server/paths.ts', () => ({
  ...real,
  nativeHostDirs: { chrome: chromeDir, arc: chromeDir },
}))
const { main } = await import('../../server/install.ts')
const manifest = join(chromeDir, `${real.HOST_NAME}.json`)
const log = console.log
console.log = () => {}
afterAll(() => {
  console.log = log
  rmSync(tmp, { recursive: true, force: true })
})

describe('install --uninstall', () => {
  test('--browser arc 保留和 Chrome 共用的清单', () => {
    mkdirSync(chromeDir, { recursive: true })
    writeFileSync(manifest, '{}')
    main(['--browser', 'arc', '--uninstall'])
    expect(existsSync(manifest)).toBe(true)
  })
  test('--browser chrome 删掉清单', () => {
    main(['--browser', 'chrome', '--uninstall'])
    expect(existsSync(manifest)).toBe(false)
  })
  test('--browser arc --dir 显式给目录时照删', () => {
    const dir = join(tmp, 'custom')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${real.HOST_NAME}.json`), '{}')
    main(['--browser', 'arc', '--dir', dir, '--uninstall'])
    expect(existsSync(join(dir, `${real.HOST_NAME}.json`))).toBe(false)
  })
})
