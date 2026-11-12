import { describe, expect, it } from 'vitest'
import { compileMessage } from './message-template'

describe('message catalog interpolation', () => {
  it('preserves Chinese, repeated placeholders, numbers and missing values', () => {
    expect(compileMessage('{{platform}} 请求{{status}}：{{platform}} {{missing}}')({ platform: '视频平台', status: 403 })).toBe('视频平台 请求403：视频平台 ')
  })
  it('retains existing HTML escaping without evaluating templates or inherited fields', () => {
    expect(compileMessage('错误：{{error}}')({ error: '<script>"&\'' })).toBe('错误：&#60;script&#62;&#34;&#38;&#39;')
    expect(compileMessage('{{constructor}}')({})).toBe('')
    expect(compileMessage('{{error}}')({ error: '{{process.exit()}}' })).toBe('{{process.exit()}}')
  })
})
