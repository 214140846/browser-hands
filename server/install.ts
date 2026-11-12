// bun run setup（或打包后的 node thundermcp.mjs setup）[--browser chrome|chromium|chrome-for-testing] [--dir <NativeMessagingHosts 目录>] [--uninstall]
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import manifest from '../extension/manifest.json'
import { HOST_NAME, nativeHostDirs } from './paths'

const self = fileURLToPath(import.meta.url)
const root = resolve(dirname(self), '..')
// 打包后是一个 thundermcp.mjs（node 跑），不在 server/ 目录里
const bundled = !self.endsWith(join('server', 'install.ts'))

export function extensionId(): string {
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('')
}

export function writeHostManifest(targetDir: string): string {
  mkdirSync(targetDir, { recursive: true })
  const gen = bundled ? dirname(self) : join(root, '.generated')
  mkdirSync(gen, { recursive: true })
  const launcher = join(gen, 'host.sh')
  const target = bundled ? `"${self}" host` : `"${join(root, 'server/host.ts')}"`
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" ${target}\n`)
  chmodSync(launcher, 0o755)
  const file = join(targetDir, `${HOST_NAME}.json`)
  writeFileSync(
    file,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'ThunderMCP native host',
        path: launcher,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId()}/`],
      },
      null,
      2,
    ),
  )
  return file
}

export function main(args: string[]) {
  const opt = (n: string) => args[args.indexOf(n) + 1]
  const dir = args.includes('--dir') ? opt('--dir') : nativeHostDirs[args.includes('--browser') ? opt('--browser') : 'chrome']
  if (args.includes('--uninstall')) {
    rmSync(join(dir, `${HOST_NAME}.json`), { force: true })
    console.log('Removed', dir)
  } else {
    console.log('Host manifest:', writeHostManifest(dir))
    console.log('Extension ID:', extensionId(), '(enable Developer mode at chrome://extensions and load the extension/ directory)')
    const args = bundled ? [self, 'mcp'] : [join(root, 'server/mcp.ts')]
    console.log('\nConnect Claude Code: claude mcp add thundermcp -s user --', [process.execPath, ...args].map((a) => JSON.stringify(a)).join(' '))
    console.log('\nExample MCP config (~/.claude.json or .mcp.json):')
    console.log(JSON.stringify({ mcpServers: { 'thundermcp': { command: process.execPath, args } } }, null, 2))
  }
}

if (import.meta.main) main(process.argv.slice(2))
