import { AppException, ResponseCode } from '@yikart/common'
import axios from 'axios'
import { describe, expect, it, vi } from 'vitest'
import { RelayClientService } from './relay-client.service'

vi.mock('../../../config', () => ({ config: {
  assets: { endpoint: 'http://storage:9000', cdnEndpoint: 'http://localhost:8080/oss', bucketName: 'aitoearn' },
} }))
vi.mock('@yikart/mongodb', () => ({ AssetType: { PublishMedia: 'publishMedia' } }))

describe('relay media preparation', () => {
  it('uploads repeated local media once through internal storage and preserves public URLs', async () => {
    const client = new RelayClientService()
    const upload = vi.spyOn(client, 'uploadFileFromLocalUrl').mockResolvedValue('https://cdn.example.test/uploaded.mp4')
    const media = [{ url: 'http://localhost:8080/oss/user/video.mp4' }]
    const body = { content: { media }, items: [{ overrides: { media } }], cover: 'https://other.example.test/cover.png' }
    const result = await client.replaceLocalUrls(body)
    expect(upload).toHaveBeenCalledExactlyOnceWith('http://storage:9000/aitoearn/user/video.mp4')
    expect(result).toEqual({
      content: { media: [{ url: 'https://cdn.example.test/uploaded.mp4' }] },
      items: [{ overrides: { media: [{ url: 'https://cdn.example.test/uploaded.mp4' }] } }],
      cover: 'https://other.example.test/cover.png',
    })
    expect(body.content.media[0].url).toBe('http://localhost:8080/oss/user/video.mp4')
  })

  it('leaves external-only content unchanged without downloading it', async () => {
    const client = new RelayClientService()
    const upload = vi.spyOn(client, 'uploadFileFromLocalUrl')
    const body = { media: [{ url: 'https://other.example.test/video.mp4' }] }
    expect(await client.replaceLocalUrls(body)).toEqual(body)
    expect(upload).not.toHaveBeenCalled()
  })
})


describe('relay upload error contract', () => {
  it('rejects an invalid upload signature with a business error and never uploads or confirms', async () => {
    const client = new RelayClientService()
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: new ArrayBuffer(4), headers: { 'content-type': 'video/mp4' } })
    const put = vi.spyOn(axios, 'put')
    const post = vi.spyOn(client, 'post').mockResolvedValue({ id: 'test-asset' })
    try {
      const result = client.uploadFileFromLocalUrl('http://storage:9000/aitoearn/test.mp4')
      await expect(result).rejects.toBeInstanceOf(AppException)
      await expect(result).rejects.toMatchObject({ code: ResponseCode.RelayServerUnavailable })
      expect(post).toHaveBeenCalledTimes(1)
      expect(put).not.toHaveBeenCalled()
    }
    finally {
      get.mockRestore()
      put.mockRestore()
      post.mockRestore()
    }
  })
})
