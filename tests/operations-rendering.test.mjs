import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { runtimeOutput } from '../apps/api/src/operations/task-tracking.mjs'
const source = await readFile(
  new URL('../apps/web/src/saas/operations/models.ts', import.meta.url),
  'utf8',
)
const { resultMedia, mergeMedia, taskReply, taskHeadline } = await import(
  'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64')
)
const video = 'http://127.0.0.1:19000/office-content/user/ai/video/artifact'
const image = 'http://127.0.0.1:19000/office-content/user/ai/image/image.png'
const messages = [
  {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          content: [
            {
              type: 'text',
              text: JSON.stringify({ id: 'video1', status: 'SUCCESS', videoUrl: video }),
            },
          ],
        },
      ],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                { type: 'resource_link', uri: image, name: 'Generated image' },
              ]),
            },
          ],
        },
      ],
    },
  },
]
for (const [name, extract] of [
  ['browser', resultMedia],
  ['archive', (v) => runtimeOutput(v).media],
]) {
  test(name + ' previews saved tool-result video and image links without filename extensions', () =>
    assert.deepEqual(extract(messages), [
      { type: 'VIDEO', url: video },
      { type: 'IMAGE', url: image },
    ]),
  )
  test(name + ' excludes unfinished, unsafe and malformed tool results', () =>
    assert.deepEqual(
      extract([
        { type: 'text', text: '{broken' },
        { videoUrl: video, status: 'InProgress' },
        { videoUrl: 'javascript:alert(1)', status: 'SUCCESS' },
        { type: 'resource_link', uri: 'file:///secret', name: 'Generated image' },
      ]),
      [],
    ),
  )
  test(name + ' previews the SDK sanitized image resource-link text', () =>
    assert.deepEqual(
      extract([
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                content: [{ type: 'text', text: '[Resource link: Generated image] ' + image }],
              },
            ],
          },
        },
      ]),
      [{ type: 'IMAGE', url: image }],
    ),
  )
}

test('browser preserves per-video dimensions for a mismatched saved result', () => {
  const specification = {
    requested: { ratio: '9:16', resolution: '720p' },
    actual: { width: 1920, height: 1080 },
    matches: false,
  }
  assert.deepEqual(resultMedia([{ status: 'SUCCESS', videoUrl: video, specification }]), [
    { type: 'VIDEO', url: video, specification },
  ])
})
test('browser ignores malformed video specification metadata', () => {
  assert.deepEqual(
    resultMedia([
      {
        status: 'SUCCESS',
        videoUrl: video,
        specification: { actual: 'invalid', requested: 'invalid' },
      },
    ]),
    [{ type: 'VIDEO', url: video }],
  )
})

test('final mediaOnly output cannot erase earlier per-video specification', () => {
  const specification = {
    requested: { ratio: '9:16', resolution: '720p' },
    actual: { width: 1920, height: 1080 },
    matches: false,
  }
  const full = { type: 'VIDEO', url: video, specification }
  assert.deepEqual(mergeMedia([full, { type: 'VIDEO', url: video }]), [full])
  assert.deepEqual(mergeMedia([{ type: 'VIDEO', url: video }, full]), [full])
})

test('provider uppercase resolution preserves the saved format verification', () => {
  const specification = {
    requested: { ratio: '9:16', resolution: '1080P' },
    actual: { width: 1080, height: 1920 },
    matches: true,
  }
  const [result] = resultMedia({ status: 'SUCCESS', videoUrl: video, specification })
  assert.equal(result.specification.requested.resolution, '1080p')
  assert.equal(result.specification.matches, true)
  assert.equal(specification.requested.resolution, '1080P')
})

test('task summary excludes tool and skill payloads, hides API stacks and keeps user-facing replies bounded', () => {
  const output = taskReply([
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'internal skill manual' }] },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'create_draft', input: { private: 'tool argument' } },
          { type: 'text', text: '视频制作完成，请预览。' },
        ],
      },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'API Error: internal stack' }] },
    },
  ])
  assert.equal(output, '视频制作完成，请预览。')
  assert.ok(
    taskReply(Array.from({ length: 100 }, () => ({ role: 'assistant', text: '长'.repeat(5000) })))
      .length < 3700,
  )
  assert.equal(taskHeadline('后续模型对话中断', true), '视频已生成，可继续剪辑和下载')
  assert.equal(taskHeadline('制作已完成，请验收成果', true), '视频已生成，等待验收')
})
