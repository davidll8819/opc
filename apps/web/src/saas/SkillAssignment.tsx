import { EMPLOYEES } from '../../../../packages/employees/registry.mjs'
import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'

type Binding = { skillIds: string[]; revision: string }
export function SkillAssignment({
  base,
  id,
  canEdit,
  onClose,
  employeeId: targetId,
  onBound,
}: {
  employeeId?: string
  onBound?: () => void
  base: string
  id: string
  canEdit: boolean
  onClose: () => void
}) {
  const [detail, setDetail] = useState<{ content: string; name: string } | null>(null)
  const [employeeId, setEmployeeId] = useState(targetId || '')
  const [binding, setBinding] = useState<Binding | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    api<NonNullable<typeof detail>>(`${base}/skills/${id}/detail`)
      .then((data) => {
        if (active) setDetail(data)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [base, id])
  useEffect(() => {
    let active = true
    setBinding(null)
    setNotice('')
    setError('')
    if (employeeId)
      api<Binding>(`${base}/employees/${employeeId}/skills`)
        .then((data) => {
          if (active) setBinding(data)
        })
        .catch((e) => {
          if (active) setError(e.message)
        })
    return () => {
      active = false
    }
  }, [base, employeeId, id])
  const employee = EMPLOYEES.find((e) => e.id === employeeId)
  const bound = binding?.skillIds.includes(id)
  async function toggle() {
    if (!binding) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const data = await api<Binding>(
        `${base}/employees/${employeeId}/skills`,
        {
          revision: binding.revision,
          skillIds: bound
            ? binding.skillIds.filter((skillId) => skillId !== id)
            : [...binding.skillIds, id],
        },
        'PUT',
      )
      setBinding(data)
      onBound?.()
      setNotice(
        `${employee?.name}：${t(bound ? '已解除此技能绑定' : '已绑定此技能')}。${t('其他员工不受影响。')}`,
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="builder-card">
      <div className="heading-row">
        <h3>{detail?.name || t('正在加载…')}</h3>
        <button onClick={onClose}>{t('收起')}</button>
      </div>
      {detail && (
        <details>
          <summary>{t('查看技能说明')}</summary>
          <pre className="skill-instructions">{detail.content}</pre>
        </details>
      )}
      <label>
        {t('选择绑定员工')}
        <select
          value={employeeId}
          disabled={busy || !!targetId}
          onChange={(e) => setEmployeeId(e.target.value)}
        >
          <option value="">{t('请选择一位员工')}</option>
          {EMPLOYEES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} · {t(e.department)}
            </option>
          ))}
        </select>
      </label>
      {employee && binding && (
        <p>
          {employee.name} · {t(bound ? '已绑定此技能' : '未绑定此技能')} · {binding.skillIds.length}{' '}
          / 8
        </p>
      )}
      <button
        disabled={!canEdit || busy || !binding || (!bound && binding.skillIds.length >= 8)}
        onClick={() => void toggle()}
      >
        {t(bound ? '解除该员工绑定' : '绑定给该员工')}
      </button>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
    </section>
  )
}
