export function dollars(value: string | null | undefined) {
  if (value === null || value === undefined) return '待核价'
  const n = BigInt(value)
  return `$${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')}`
}
export function toMicros(value: string) {
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(value.trim())) throw new Error('请输入金额，最多保留 6 位小数')
  const [whole, fraction = ''] = value.trim().split('.')
  const n = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))
  if (n > 1000000000000n) throw new Error('金额不能超过 100 万美元')
  return n.toString()
}
export function csvCell(value: unknown) {
  let text = value == null ? '' : String(value)
  if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text
  return '"' + text.replaceAll('"', '""') + '"'
}
