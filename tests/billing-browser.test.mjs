import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
test(
  'real browser and API: billing filters, export, review, budgets, prices, orders and member access',
  { skip: process.env.BILLING_BROWSER_TESTS !== '1' },
  async () => {
    const { billingFixture } = await import('./helpers/billing-browser-fixture.mjs'),
      fixture = await billingFixture()
    const browser = await (
      await import('playwright')
    ).chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
    const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
      errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    try {
      await p.goto(fixture.url)
      await p.getByRole('heading', { name: '用量与费用', exact: true }).waitFor()
      await p.getByRole('button', { name: '导出当前页 CSV' }).waitFor()
      const evidence = fileURLToPath(
        new URL('../docs/billing-evidence-2026-10-24', import.meta.url),
      )
      await mkdir(evidence, { recursive: true })
      for (const width of [1440, 768, 390]) {
        await p.setViewportSize({ width, height: 1000 })
        assert.equal(
          await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        )
        await p.screenshot({ path: `${evidence}/billing-${width}.png`, fullPage: true })
      }
      await p.setViewportSize({ width: 1440, height: 1000 })
      await p.getByLabel('仅看未核对').check()
      await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1)
      await p.getByRole('button', { name: `查看调用 ${fixture.unknownId}`, exact: true }).click()
      await p.getByLabel('上游实际收费（USD）').fill('0.002')
      await p.getByLabel('账单或工单编号').fill('隔离测试凭证-001')
      await p.getByRole('button', { name: '保存核对凭证' }).click()
      await p.getByText('已保存人工核对凭证，原始调用状态保留').waitFor()
      await p.getByLabel('仅看未核对').uncheck()
      await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2)
      const download = p.waitForEvent('download')
      await p.getByRole('button', { name: '导出当前页 CSV' }).click()
      const file = await download,
        csv = await readFile(await file.path(), 'utf8')
      assert.match(csv, /fixture-receipt-002/)
      assert.doesNotMatch(csv, /synthetic-key/)
      await p.getByLabel('任务编号', { exact: true }).fill(fixture.taskId)
      await p.getByRole('button', { name: '筛选', exact: true }).click()
      await p.locator('summary').filter({ hasText: '金额预算 ·' }).click()
      await p.getByLabel('新的每日预算（USD）').fill('1.25')
      await p.getByLabel('保存时开启金额拦截').check()
      await p.getByRole('button', { name: '保存预算', exact: true }).click()
      await p.getByText('预算已保存', { exact: true }).waitFor()
      await p.locator('summary').filter({ hasText: '单个任务的金额上限' }).click()
      await p.getByLabel('需要限制的任务编号').fill(fixture.taskId)
      await p.getByLabel('任务累计采购预算（USD）').fill('0.5')
      await p.getByRole('button', { name: '保存任务上限' }).click()
      await p.getByText('任务金额上限已保存').waitFor()
      await p.locator('summary').filter({ hasText: '文字模型价格' }).click()
      for (const [label, value] of [
        ['模型编号', 'fixture-model'],
        ['输入采购单价', '2'],
        ['输出采购单价', '3'],
        ['输入售价', '4'],
        ['输出售价', '5'],
        ['价格凭证编号', '模拟合同-002'],
      ])
        await p.getByLabel(label, { exact: true }).fill(value)
      await p.getByRole('button', { name: '保存新的价格版本' }).click()
      await p.getByText('新价格版本已保存').waitFor()
      await p.locator('summary').filter({ hasText: '支付、退款与核对范围' }).click()
      await p.getByRole('button', { name: '创建 1 美元模拟订单' }).click()
      await p.getByRole('button', { name: '模拟支付成功' }).click()
      await p.getByRole('button', { name: '模拟全额退款' }).click()
      await p.getByText(/已模拟退款/).waitFor()
      await p.reload()
      await p.getByText('金额预算 · 已开启').waitFor()
      fixture.setMember(true)
      await p.reload()
      await p.getByText('当前条件下没有调用记录。发生新的模型调用后会自动记录。').waitFor()
      assert.equal(await p.getByText('单个任务的金额上限').count(), 0)
      assert.equal(await p.getByText('保存核对凭证').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
      await fixture.close()
    }
  },
)
