import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EMPLOYEES } from '../packages/employees/registry.mjs'
import { recommendedCategories, skillFit } from '../packages/employees/skill-fit.mjs'

test('every employee uses existing curated categories, recommendations stay independent', async () => {
  const catalog = JSON.parse(await readFile(new URL('../skills/catalog/catalog.json', import.meta.url)))
  const categories = new Set(catalog.items.map(s => s.category))
  assert.equal(new Set(EMPLOYEES.map(e => e.departmentKey)).size, EMPLOYEES.length,
    'department binding storage must remain one-to-one with the fixed employee roster')
  for (const employee of EMPLOYEES) {
    assert.ok(recommendedCategories(employee.id).length)
    for (const category of recommendedCategories(employee.id)) assert.ok(categories.has(category))
  }
  assert.equal(skillFit('code-agent', '后端、数据库与云服务'), true)
  assert.equal(skillFit('file-agent', '后端、数据库与云服务'), false)
  assert.equal(skillFit('app-agent', '图像、视频与音频'), true)
  assert.equal(skillFit('data-agent', '安全与隐私'), true)
  assert.deepEqual(recommendedCategories('unknown'), [])
  recommendedCategories('code-agent').push('办公与文档')
  assert.equal(skillFit('code-agent', '办公与文档'), false)
})
