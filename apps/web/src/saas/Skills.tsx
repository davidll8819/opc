import {useEmployeeDirectory} from './employee-directory'
import { SkillStudio } from './SkillStudio'
import { useState } from 'react'
import { OperationsSkillCard } from './operations/OperationsSkillCard'
import { EmployeeSkills } from './EmployeeSkills'
import { t } from '@/i18n'
import { SkillCatalog } from './SkillCatalog'
import { SkillUpload } from './SkillUpload'
import { InstalledSkills } from './InstalledSkills'
export type SkillView = 'catalog' | 'installed' | 'studio'
export function Skills({
  base,
  employeeId,
  onEmployee,
  returnProfile,
  canEdit,
  view,
  onView,
  revision,
  onInstalled,
  openOperations,
}: {
  base: string
  employeeId: string
  onEmployee: (id: string) => void
  returnProfile: () => void
  canEdit: boolean
  view: SkillView
  onView: (view: SkillView) => void
  revision: number
  onInstalled: () => void
  openOperations: () => void
}) {
  const [dirty, setDirty] = useState(false)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [bindingRevision, setBindingRevision] = useState(0)
  const employees=useEmployeeDirectory(base)
  const employee = employees.find((e) => e.id === employeeId)
  return (
    <>
      <div className="page-heading">
        <h1>{t('技能库')}</h1>
        <p className="muted">
          {t('技能包由企业共享，每位员工单独绑定；安装后需要明确选择使用它的员工。')}
        </p>
      </div>

      {view !== 'studio' && <section className="builder-card" aria-label={t('当前员工技能范围')}>
        <div className="heading-row">
          <label>
            {t('为员工管理技能')}
            <select
              aria-label={t('为员工管理技能')}
              value={employeeId}
              disabled={dirty}
              onChange={(e) => onEmployee(e.target.value)}
            >
              <option value="">{t('企业技能库 · 选择员工后绑定')}</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} · {t(e.department)}
                </option>
              ))}
            </select>
          </label>
          {employee && (
            <button disabled={dirty} onClick={returnProfile}>
              {t('返回员工档案')}
            </button>
          )}
        </div>
        {employee && (
          <>
            <p>
              {employee.name} · {t(employee.department)} · {t(employee.responsibility)}
            </p>
            <details className="employee-library-bindings" key={employeeId}>
              <summary>{t('查看与管理员工已绑定的技能')}</summary>
              <EmployeeSkills
                key={`${base}/${employeeId}/${revision}/${bindingRevision}`}
                base={base}
                employeeId={employeeId}
                canEdit={canEdit}
                onDirtyChange={setDirty}
                onSaved={() => setCatalogRevision((n) => n + 1)}
              />
            </details>
          </>
        )}
      </section>}
      <details className="skills-upload-inline"><summary>导入已有技能包（Markdown / ZIP）</summary>
        <SkillUpload base={base} canEdit={canEdit} onInstalled={onInstalled} />
      </details>
      <div className="skill-view-switch" role="group" aria-label={t('技能视图')}>
        {canEdit && <button aria-pressed={view === 'studio'} onClick={() => onView('studio')}>创建员工技能</button>}
        <button aria-pressed={view === 'catalog'} onClick={() => onView('catalog')}>
          {t('技能目录')}
        </button>
        <button aria-pressed={view === 'installed'} onClick={() => onView('installed')}>
          {t('我的技能')}
        </button>
      </div>
      {view === 'studio' ? <SkillStudio base={base} employeeId={employeeId} onBound={() => { setBindingRevision(n=>n+1); setCatalogRevision(n=>n+1) }} /> : <>
      <h2 className="skill-package-heading">{t('单体技能包')}</h2>
      {view === 'catalog' ? (
        <SkillCatalog
          key={`${base}/${employeeId}/${revision}/${catalogRevision}`}
          base={base}
          canEdit={canEdit && !dirty}
          openInstalled={onInstalled}
          employeeId={employeeId}
          onBound={() => setBindingRevision((n) => n + 1)}
        />
      ) : (
        <InstalledSkills
          base={base}
          revision={revision}
          canEdit={canEdit && !dirty}
          employeeId={employeeId}
          onBound={() => setBindingRevision((n) => n + 1)}
        />
      )}
      <section className="skill-workflow-section">
        <h2 className="skill-package-heading">{t('流程技能包')}</h2>
        <OperationsSkillCard onOpen={openOperations} />
      </section>
      </>}
    </>
  )
}
