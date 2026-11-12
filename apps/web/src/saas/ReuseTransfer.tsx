import { useRef, useState } from 'react'
import { api } from './api'
import type { Entry } from './ReuseWorkspace'
import { departments } from '../../../../packages/secretary/model.mjs'

import { downloadWorkflow } from './reuse-download'
export function ReuseTransfer({
  base,
  kind,
  onImported,
}: {
  base: string
  kind: 'knowledge' | 'memory' | 'template'
  onImported: () => Promise<void>
}) {
  const [open, setOpen] = useState(false),
    [project, setProject] = useState('')
  const [entries, setEntries] = useState<Entry[]>([]),
    [busy, setBusy] = useState(false)
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const pending = useRef(false)
  const template = kind === 'template'
  async function run(fn: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <section className="reuse-transfer" aria-label={template ? '流程导入' : '知识导入'}>
      <div className="reuse-actions">
        <button disabled={busy} onClick={() => setOpen(!open)}>
          {open ? '收起导入' : template ? '导入流程模板' : '导入文字文件'}
        </button>
        {template && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () =>
                downloadWorkflow(
                  await api(`${base}/reuse/template-format`),
                  'Wishtaday-流程模板示例',
                ),
              )
            }
          >
            下载格式示例
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {open && (
        <div className="reuse-import-body">
          <h3>{template ? '上传可执行流程结构' : '把文字资料加入工作知识'}</h3>
          <p>
            {template
              ? '支持 Wishtaday v1 JSON，包含需求单、负责人、步骤要求和前后依赖。普通 Word、PDF 或其他平台工作流不能直接执行。'
              : '支持 UTF-8 的 TXT、Markdown，最多 32000 字；长文自动分段，确认后才入库。PDF、Word 请先在资料室解析并核对文字。'}
          </p>
          {!template && (
            <label>
              导入资料的适用项目
              <input
                maxLength={80}
                value={project}
                disabled={busy}
                onChange={(e) => {
                  setProject(e.target.value)
                  setEntries([])
                }}
              />
            </label>
          )}
          <label>
            选择{template ? '流程文件' : '知识文件'}
            <input
              type="file"
              accept={template ? '.json' : '.txt,.md'}
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                setEntries([])
                if (!file) return
                void run(async () => {
                  if (file.size > 256 * 1024) throw Error('文件超过 256 KB，请按主题拆分后导入')
                  const text = new TextDecoder('utf-8', { fatal: true }).decode(
                    await file.arrayBuffer(),
                  )
                  const result = await api<{ entries: Entry[] }>(`${base}/reuse/import-preview`, {
                    filename: file.name,
                    text,
                    kind,
                    project,
                  })
                  setEntries(result.entries)
                })
              }}
            />
          </label>
          {busy && <p role="status">正在处理…</p>}
          {!!entries.length && (
            <div aria-label="导入预览">
              <h3>校验通过 · 待导入 {entries.length} 条</h3>
              {entries.map((entry, i) => (
                <details key={i}>
                  <summary>
                    {entry.title} · {entry.project || (template ? '使用时填写项目' : '全项目')}
                  </summary>
                  {'content' in entry.body ? (
                    <p className="reuse-text">{entry.body.content}</p>
                  ) : (
                    <ol>
                      {entry.body.steps.map((s, n) => (
                        <li key={n}>
                          {s.title} · {departments.find((d) => d.id === s.dept)?.person || s.dept}
                          <p>{s.brief}</p>
                          <p>
                            {s.dependsOn.length
                              ? `等待步骤 ${s.dependsOn.map((x) => x + 1).join('、')}`
                              : '无前置步骤'}
                          </p>
                        </li>
                      ))}
                    </ol>
                  )}
                </details>
              ))}
              <p>
                {template
                  ? '导入后填写本次参数、预览并确认分工，才会开始执行；不会自动对外发布。'
                  : '确认后启用这些条目，秘书、新任务及普通员工对话会按适用范围检索。不会更改旧任务。'}
                完全相同的重复条目会跳过。
              </p>
              <button
                className="reuse-primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ created: number; reused: number }>(
                      `${base}/reuse/import`,
                      { entries },
                    )
                    setEntries([])
                    setNotice(
                      `导入完成：新增 ${result.created} 条，跳过重复 ${result.reused} 条；未启动任务。`,
                    )
                    await onImported()
                  })
                }
              >
                确认导入{template ? '模板' : '知识'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
