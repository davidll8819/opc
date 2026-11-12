// Bounded local query expansion; never sends document text to an external index.
const stop = new Set([
  '请问',
  '请帮',
  '帮我',
  '我查',
  '查询',
  '检索',
  '已归',
  '归档',
  '档资',
  '资料',
  '文档',
  '回答',
  '什么',
  '多少',
  '一下',
  '告诉',
  '根据',
  '当前',
  '中的',
  '里面',
  '是否',
  '哪些',
  '以及',
  '还有',
  '这个',
  '那份',
  '这份',
  '需要',
  '问题',
  '要求',
  '给我',
  '我们',
  '你们',
  '请从',
  '档案',
  '已在',
])
const synonyms = [
  ['退款', '退费'],
  ['客户', '顾客'],
  ['价格', '报价', '定价'],
  ['配乐', '背景音乐'],
  ['品牌', '商标'],
  ['发票', '开票'],
  ['交付', '交货'],
]
export function archiveQueryTerms(text = '') {
  const value = text.normalize('NFKC').toLowerCase(),
    terms = [...(value.match(/zl-\d{4}-\d{6,}/g) || []), ...(value.match(/[a-z0-9]+/g) || [])]
  for (const word of value.match(/[\p{Script=Han}]+/gu) || [])
    for (let i = 0; i < word.length - 1; i++) terms.push(word.slice(i, i + 2))
  const expanded = synonyms.filter((group) => group.some((word) => value.includes(word))).flat()
  return [...new Set([...terms.filter((t) => !stop.has(t)).slice(0, 24), ...expanded])].slice(0, 40)
}
