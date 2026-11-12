import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
const source = await readFile(
  new URL('../apps/web/src/saas/billing-format.ts', import.meta.url),
  'utf8',
)
const { dollars, toMicros, csvCell } = await import(
  'data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(source))
)
test('money display and input preserve millionth-dollar precision without floating point rounding', () => {
  assert.equal(toMicros('1.000001'), '1000001')
  assert.equal(dollars('1000001'), '$1.000001')
  assert.equal(toMicros('0.01'), '10000')
  assert.equal(dollars('0'), '$0.000000')
  assert.equal(dollars(null), '待核价')
  for (const invalid of ['-1', '1e3', '1.0000001', '1000001', 'Infinity', ''])
    assert.throws(() => toMicros(invalid))
})
test('billing CSV quotes cells and neutralizes spreadsheet formulas', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"')
  assert.equal(csvCell(' @test'), '"\' @test"')
  assert.equal(csvCell('a,"b"'), '"a,""b"""')
  assert.equal(csvCell(null), '""')
})
