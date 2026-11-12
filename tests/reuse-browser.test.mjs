import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
test('task detail keeps exactly one feedback form after repeated board refreshes', { skip: process.env.REUSE_BROWSER_TESTS !== '1' }, async () => {
  const { reuseFixture } = await import('./helpers/reuse-browser-fixture.mjs'), f = await reuseFixture({ taskView: true })
  const browser = await (await import('playwright')).chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  const p = await browser.newPage(), errors = []
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  try {
    await p.goto(f.url)
    await p.getByRole('heading', { name: '任务成果', exact: true }).waitFor()
    for (let i=0; i<12; i++) {
      await p.getByRole('button', { name: `刷新状态 ${i}`, exact: true }).click()
      await p.getByRole('button', { name: `刷新状态 ${i+1}`, exact: true }).waitFor()
      assert.equal(await p.locator('summary').filter({ hasText: '成果使用反馈' }).count(), 1)
    }
    assert.equal(await p.locator('[aria-label="调研成果与验收"]').count(),1)
    assert.deepEqual(errors, [])
  } finally { await browser.close(); await f.close() }
})
test(
  'real browser/API: knowledge versions, retrieval, reusable draft, notices and outcome feedback',
  { skip: process.env.REUSE_BROWSER_TESTS !== '1' },
  async () => {
    const { reuseFixture } = await import('./helpers/reuse-browser-fixture.mjs'),
      f = await reuseFixture()
    const browser = await (
      await import('playwright')
    ).chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
    const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
      errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    p.on('dialog', (d) => d.accept())
    const evidence = fileURLToPath(new URL('../docs/knowledge-upgrade-evidence-2026-10-26/', import.meta.url))
    await mkdir(evidence, { recursive: true })
    try {
      await p.goto(f.url)
      await p.getByRole('heading', { name: '工作知识', exact: true }).waitFor()
      await p.getByText('客户乙用语规范', { exact: true }).waitFor()
      await p.getByRole('button', { name: '长期记忆', exact: true }).click()
      await p.getByRole('button', { name: '新增长期记忆', exact: true }).click()
      await p.getByLabel('名称', { exact: true }).fill('报告表达习惯')
      await p.getByLabel('内容', { exact: true }).fill('先列结论，再说明资料来源。')
      await p.getByLabel('来源或确认依据').fill('隔离测试：明确确认')
      await p.getByRole('button', { name: '保存', exact: true }).click()
      await p.getByText('已保存，新任务将使用启用的最新版本').waitFor()
      const item = p.locator('.reuse-list li').filter({ hasText: '报告表达习惯' })
      await item.getByRole('button', { name: '编辑', exact: true }).click()
      await p.getByLabel('内容', { exact: true }).fill('先列证据，再给出结论。')
      await p.getByRole('button', { name: '保存新版本' }).click()
      await item.getByText(/v2/).waitFor()
      await item.getByRole('button', { name: '查看版本' }).click()
      await p.getByRole('heading', { name: '历史版本' }).waitFor()
      await p.locator('summary').filter({ hasText: '报告表达习惯 · v1' }).click()
      await p.getByText('先列结论，再说明资料来源。', { exact: true }).waitFor()
      await p.locator('summary').filter({ hasText: '检查本次会用到哪些知识' }).click()
      await p.getByLabel('本次项目', { exact: true }).fill('客户乙')
      await p.getByLabel('本次问题', { exact: true }).fill('如何介绍产品')
      await p.getByRole('button', { name: '检索工作知识', exact: true }).click()
      await p.getByRole('heading', { name: '客户乙用语规范 · v1', exact: true }).waitFor()
      for (const width of [1440, 768, 390]) {
        await p.setViewportSize({ width, height: 1000 })
        assert.equal(
          await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        )
        await p.screenshot({ path: `${evidence}/knowledge-${width}.png`, fullPage: true })
      }
      await p.setViewportSize({ width: 1440, height: 1000 })
      await p.getByRole('button', { name: '流程模板', exact: true }).click()
      await p.locator('summary').filter({ hasText: '从已完成流程提取模板' }).click()
      await p.getByLabel('已完成任务', { exact: true }).selectOption(f.taskId)
      await p.getByRole('button', { name: '提取流程结构' }).click()
      await p.getByRole('heading', { name: '新增流程模板' }).waitFor()
      assert.equal(await p.getByLabel('步骤要求').inputValue(), '{{目标}}；验收：{{验收要求}}')
      await p.getByLabel('名称', { exact: true }).fill('资料整理标准流程')
      await p.getByRole('button', { name: '保存', exact: true }).click()
      await p.getByRole('button', { name: '填写本次参数' }).click()
      await p.getByLabel('项目', { exact: true }).fill('客户乙')
      await p.getByLabel('目标', { exact: true }).fill('整理本周公开资料')
      await p.getByLabel('验收要求', { exact: true }).fill('每项注明来源')
      await p.getByRole('button', { name: '预览本次流程' }).click()
      await p.getByRole('heading', { name: '待确认的本次要求' }).waitFor()
      assert.ok(
        !(await p.locator('[aria-label="本次流程预览"]').innerText()).includes('旧客户私有内容'),
      )
      await p.screenshot({ path: `${evidence}/template-preview.png`, fullPage: true })
      await p.getByRole('button', { name: '创建待确认分工' }).click()
      await p.getByText('待确认分工已创建', { exact: true }).waitFor()
      const board = (await f.h.request('GET', '/secretary')).json().board
      assert.equal(board.tasks.length, 2)
      assert.equal(board.tasks.at(-1).status, 'draft')
      assert.equal(board.tasks.at(-1).knowledgeSnapshot.records.length, 2)
      assert.equal(f.h.requests.length, 0)
      await p.getByRole('button', { name: /任务通知/ }).click()
      await p.getByRole('button', { name: '标为已读', exact: true }).click()
      await p.getByText('执行完成，请检查成果 · 已读').waitFor()
      await p.reload()
      await p.getByRole('button', { name: /任务通知/ }).click()
      await p.getByText('执行完成，请检查成果 · 已读').waitFor()
      await p.locator('summary').filter({ hasText: '成果使用反馈' }).click()
      await p.getByLabel('使用结果').selectOption('revise')
      await p.getByLabel('具体反馈').fill('请补齐引用来源')
      await p.getByRole('button', { name: '保存反馈' }).click()
      await p.getByText(/需要修改 · 请补齐引用来源/).waitFor()
      assert.equal((await f.h.request('GET', `/reuse/feedback/${f.taskId}`)).json().items.length, 1)
      await p.getByRole('button', { name: '长期记忆', exact: true }).click()
      await p
        .locator('.reuse-list li')
        .filter({ hasText: '报告表达习惯' })
        .getByRole('button', { name: '删除', exact: true })
        .click()
      await p.getByText('条目及版本已删除，已有任务快照保留').waitFor()
      assert.equal(
        (await f.h.request('GET', '/reuse')).json().items.some((i) => i.title === '报告表达习惯'),
        false,
      )
      assert.deepEqual(errors, [])
    } catch (e) {
      await p.screenshot({ path: evidence + '/browser-failure.png', fullPage: true })
      console.log(
        JSON.stringify({ pageErrors: errors, visible: await p.locator('body').innerText() }),
      )
      throw e
    } finally {
      await browser.close()
      await f.close()
    }
  },
)
