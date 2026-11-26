import { describe, expect, test } from 'bun:test'
import { browserFromPath, launchingBrowser } from '../../server/launcher'

describe('browserFromPath', () => {
  test.each([
    ['/Applications/Arc.app/Contents/MacOS/Arc', 'arc'],
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome'],
    ['/Users/x/Library/Caches/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-for-testing'],
    ['/Applications/Chromium.app/Contents/MacOS/Chromium', 'chromium'],
    ['/bin/zsh', 'unknown'],
    ['', 'unknown'],
  ] as const)('%s → %s', (path, kind) => {
    expect(browserFromPath(path)).toBe(kind)
  })
})

describe('launchingBrowser', () => {
  test('父进程不是浏览器 → unknown', () => {
    expect(launchingBrowser()).toBe('unknown')
  })
  test('进程不存在 → unknown，不抛', () => {
    expect(launchingBrowser(999999)).toBe('unknown')
  })
})
