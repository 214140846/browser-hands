import { expect, test } from 'bun:test'
import { browserName } from '../server/registry'

const id = '1234567890abcdef'
const cases: Array<[string, Parameters<typeof browserName>[0], string]> = [
  ['有名称用名称', { profileId: id, profileName: '工作', email: 'a@b.com' }, '工作'],
  ['无名称用邮箱', { profileId: id, profileName: '', email: 'a@b.com' }, 'a@b.com'],
  ['都空用 deviceId 前 8 位', { profileId: id, profileName: '', email: '' }, id.slice(0, 8)],
  ['字段缺省同上', { profileId: id }, id.slice(0, 8)],
]

test.each(cases)('取名顺序：%s', (_label, info, want) => {
  expect(browserName(info)).toBe(want)
})
