import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
test(
  'knowledge UI imports documents, filters rows, rejects foreign templates, downloads and uses a validated workflow',
  { skip: process.env.REUSE_BROWSER_TESTS !== '1' },
  async () => {
    const { reuseFixture } = await import('./helpers/reuse-browser-fixture.mjs'),
      f = await reuseFixture()
    const browser = await (
      await import('playwright')
    ).chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
    const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
      errors = []
    const dir = fileURLToPath(
      new URL('../docs/knowledge-upgrade-evidence-2026-10-26/', import.meta.url),
    )
    await mkdir(dir, { recursive: true })
    p.on('pageerror', (e) => errors.push(e.message))
    try {
      await p.goto(f.url)
      await p.getByRole('heading', { name: '工作知识', exact: true }).waitFor()
      await p.getByRole('button', { name: '导入文字文件', exact: true }).click()
      await p.getByLabel('导入资料的适用项目').fill('客户乙')
      await p
        .getByLabel('选择知识文件')
        .setInputFiles({
          name: '退款说明.md',
          mimeType: 'text/markdown',
          buffer: Buffer.from('退款办理需要核对订单编号。先给三条结论，再写来源。'),
        })
      await p.getByRole('heading', { name: '校验通过 · 待导入 1 条' }).waitFor()
      assert.equal((await f.h.request('GET', '/reuse')).json().items.length, 1)
      await p.getByRole('button', { name: '确认导入知识' }).click()
      await p.getByText('导入完成：新增 1 条，跳过重复 0 条；未启动任务。').waitFor()
      await p.getByRole('button', { name: '收起导入' }).click()
      await p.getByLabel('搜索当前分类').fill('不存在的条目')
      await p.getByText('没有符合筛选条件的条目。清空搜索或切换状态再试。').waitFor()
      await p.getByLabel('搜索当前分类').fill('退款')
      assert.equal(await p.locator('.reuse-library .reuse-list > li').count(), 1)
      await p.getByLabel('搜索当前分类').fill('')
      for (const width of [1440, 768, 390]) {
        await p.setViewportSize({ width, height: 1000 })
        assert.equal(
          await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        )
        await p.screenshot({ path: `${dir}/library-${width}.png`, fullPage: true })
      }
      await writeFile(
        '/private/tmp/knowledge-visual.html',
        await p.evaluate(() => {
          const doc = document.documentElement.cloneNode(true)
          doc.querySelectorAll('script,link').forEach((n) => n.remove())
          return '<!doctype html>' + doc.outerHTML
        }),
      )
      await p.setViewportSize({ width: 1440, height: 1000 })
      await p.getByRole('button', { name: '流程模板', exact: true }).click()
      const downloaded = p.waitForEvent('download')
      await p.getByRole('button', { name: '下载格式示例' }).click()
      const file = await downloaded,
        bytes = await readFile(await file.path())
      assert.equal(JSON.parse(bytes).format, 'wishtaday.workflow')
      await p.getByRole('button', { name: '导入流程模板', exact: true }).click()
      await p
        .getByLabel('选择流程文件')
        .setInputFiles({
          name: 'foreign.json',
          mimeType: 'application/json',
          buffer: Buffer.from('{"nodes":[]}'),
        })
      await p.getByRole('alert').filter({ hasText: '不是有效的 Wishtaday' }).waitFor()
      assert.equal(await p.getByRole('button', { name: '确认导入模板' }).count(), 0)
      await p
        .getByLabel('选择流程文件')
        .setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: bytes })
      await p.getByRole('heading', { name: '校验通过 · 待导入 1 条' }).waitFor()
      await p.getByRole('button', { name: '确认导入模板' }).click()
      await p.getByText('导入完成：新增 1 条，跳过重复 0 条；未启动任务。').waitFor()
      await p.getByRole('button', { name: '填写本次参数', exact: true }).click()
      await p.getByLabel('项目', { exact: true }).fill('客户乙')
      await p.getByLabel('目标', { exact: true }).fill('整理退款政策并编写文案')
      await p.getByLabel('验收要求', { exact: true }).fill('明确订单编号与来源')
      await p.getByRole('button', { name: '预览本次流程' }).click()
      await p.getByRole('heading', { name: '待确认的本次要求' }).waitFor()
      await p.screenshot({ path: `${dir}/imported-template-preview.png`, fullPage: true })
      await p.getByRole('button', { name: '创建待确认分工' }).click()
      await p.getByText('待确认分工已创建', { exact: true }).waitFor()
      const tasks = (await f.h.request('GET', '/secretary')).json().board.tasks.slice(1)
      assert.equal(tasks.length, 2)
      assert.ok(tasks.every((t) => t.status === 'draft'))
      assert.ok(tasks.every((t) => t.knowledgeSnapshot.records.some((k) => k.title === '退款说明')))
      assert.deepEqual(tasks[1].dependsOn, [tasks[0].id])
      assert.equal(f.h.requests.length, 0)
      assert.deepEqual(errors, [])
      await writeFile(
        `${dir}/import-browser.json`,
        JSON.stringify(
          {
            textImport: true,
            filters: true,
            foreignRejected: true,
            downloadUploadRoundTrip: true,
            templateDraftWithKnowledge: true,
            paidCalls: 0,
          },
          null,
          2,
        ),
      )
    } finally {
      await browser.close()
      await f.close()
    }
  },
)
