import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { fail } from './db.mjs'
import { emptyBrief } from '../../../packages/secretary/task-brief.mjs'

export const workflowExample = {
  format: 'wishtaday.workflow',
  version: 1,
  title: '资料整理与文案流程',
  workflow: {
    brief: { ...emptyBrief, project: '{{项目}}', goal: '{{目标}}', acceptance: '{{验收要求}}' },
    steps: [
      {
        title: '整理资料',
        dept: 'file-agent',
        brief: '整理{{项目}}的资料，目标：{{目标}}。不足的信息明确列出。',
        dependsOn: [],
      },
      {
        title: '编写文案',
        dept: 'new-agent-7',
        brief: '根据前序资料完成{{目标}}；验收：{{验收要求}}。只交付草稿，不发布。',
        dependsOn: [0],
      },
    ],
  },
}
const portable = z
  .object({
    format: z.literal('wishtaday.workflow'),
    version: z.literal(1),
    title: z.string(),
    workflow: z.unknown(),
  })
  .strict()
const inputSchema = z
  .object({
    filename: z.string().trim().min(1).max(120),
    text: z.string().min(1).max(64000),
    kind: z.enum(['knowledge', 'memory', 'template']),
    project: z.string().trim().max(80).default(''),
  })
  .strict()
export function importEntries(input, checkedEntry) {
  const { filename, text, kind, project } = inputSchema.parse(input)
  if (kind === 'template') {
    if (!/\.json$/i.test(filename))
      throw fail(400, '可执行模板需要 Wishtaday JSON 格式；普通文档请作为知识导入')
    let parsed
    try {
      parsed = portable.parse(JSON.parse(text.replace(/^\uFEFF/, '')))
    } catch {
      throw fail(400, '不是有效的 Wishtaday v1 流程模板，请下载格式示例；其他平台的流程需要先转换')
    }
    try {
      return [
        checkedEntry({
          kind,
          title: parsed.title,
          project: '',
          enabled: true,
          body: parsed.workflow,
        }),
      ]
    } catch (error) {
      if (error.statusCode) throw error
      const at = error.issues?.[0]?.path?.join('.')
      throw fail(
        400,
        `模板字段不完整或超出限制${at ? `（${at}）` : ''}，请核对负责人、步骤要求和需求单`,
      )
    }
  }
  if (!/\.(txt|md)$/i.test(filename))
    throw fail(400, '此入口支持 UTF-8 的 TXT、Markdown；PDF、Word 请先在资料室解析并核对文字')
  if (text.includes('\u0000') || text.includes('\uFFFD'))
    throw fail(400, '文件不是有效的 UTF-8 文字，请转换编码后重试')
  const content = text.replace(/^\uFEFF/, '').trim()
  if (!content) throw fail(400, '文件没有可导入的文字')
  if (content.length > 32000) throw fail(400, '单份知识文件最多 32000 字，请按主题拆分后导入')
  const chunks = []
  for (let i = 0; i < content.length;) {
    let end = Math.min(i + 4000, content.length)
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--
    const part = content.slice(i, end).trim()
    if (part) chunks.push(part)
    i = end
  }
  const title = filename.replace(/\.(txt|md)$/i, '').slice(0, 80)
  return chunks.map((part, i) =>
    checkedEntry({
      kind,
      title: title + (chunks.length > 1 ? `（${i + 1}/${chunks.length}）` : ''),
      project,
      enabled: true,
      body: { content: part, source: `导入文件：${filename}` },
    }),
  )
}
// Import is transactional and exact duplicates are reused, including after a timed-out retry.
export function registerReuseTransfer(app, { scoped, checkedEntry, getEntry, selection, keys }) {
  const root = '/api/tenants/:tenantId/reuse'
  app.get(`${root}/template-format`, (req) => scoped(req, async () => workflowExample))
  app.post(`${root}/import-preview`, { bodyLimit: 512 * 1024 }, (req) =>
    scoped(req, async () => ({ entries: importEntries(req.body, checkedEntry) })),
  )
  app.post(`${root}/import`, { bodyLimit: 512 * 1024 }, (req) =>
    scoped(req, async (db, tenant, c) => {
      const { entries } = z
        .object({ entries: z.array(z.unknown()).min(1).max(10) })
        .strict()
        .parse(req.body)
      const checked = entries.map(checkedEntry)
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [c.userId])
      const existing = (await db.query(selection, keys(c))).rows
      const canonical = (value) =>
        Array.isArray(value)
          ? value.map(canonical)
          : value && typeof value === 'object'
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((k) => [k, canonical(value[k])]),
              )
            : value
      const fingerprint = (entry) =>
        JSON.stringify(
          canonical(
            Object.fromEntries(
              ['kind', 'title', 'project', 'enabled', 'body'].map((k) => [k, entry[k]]),
            ),
          ),
        )
      const seen = new Map(existing.map((e) => [fingerprint(e), e]))
      const results = [],
        fresh = []
      for (const v of checked) {
        const key = fingerprint(v)
        if (seen.has(key)) {
          results.push(seen.get(key))
          continue
        }
        const row = { ...v, id: randomUUID(), version: 1 }
        seen.set(key, row)
        results.push(row)
        fresh.push(row)
      }
      if (existing.length + fresh.length > 200)
        throw fail(409, '导入后会超过 200 条容量，请先整理旧条目；本次没有写入任何条目')
      for (const v of fresh) {
        await db.query(
          'INSERT INTO reuse_entries(id,tenant_id,user_id,kind,enabled) VALUES($1,$2,$3,$4,$5)',
          [v.id, ...keys(c), v.kind, v.enabled],
        )
        await db.query(
          'INSERT INTO reuse_versions(entry_id,tenant_id,user_id,version,title,project,body) VALUES($1,$2,$3,1,$4,$5,$6)',
          [v.id, ...keys(c), v.title, v.project, JSON.stringify(v.body)],
        )
      }
      return { items: results, created: fresh.length, reused: checked.length - fresh.length }
    }),
  )
  app.get(`${root}/:id/export`, (req) =>
    scoped(req, async (db, tenant, c) => {
      const entry = await getEntry(db, c, z.uuid().parse(req.params.id))
      if (entry.kind !== 'template') throw fail(400, '仅流程模板支持可执行格式导出')
      return { format: 'wishtaday.workflow', version: 1, title: entry.title, workflow: entry.body }
    }),
  )
}
