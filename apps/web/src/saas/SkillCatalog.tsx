import './employee-skills.css'
import { EMPLOYEES } from '../../../../packages/employees/registry.mjs'
import { recommendedCategories, skillFit } from '../../../../packages/employees/skill-fit.mjs'
import { useEffect, useRef, useState } from 'react'
import { t, useLanguage } from '@/i18n'
import { api } from './api'

type Skill = {
  id: string
  defaultHidden?: boolean
  mergedSources?: { id: string; number: number; source: string }[]
  installedId?: string | null
  number: number
  category: string
  name: string
  descriptionZh: string
  descriptionEn?: string
  source: string
  sameNameCount: number
  detailUrl: string
  descriptionBasis: string
  download: {
    status: 'downloaded' | 'failed'
    packagePath?: string
    skillFile?: string
    sha256?: string
    historical?: boolean
    error?: string
  }
}
const PAGE_SIZE = 20
export function SkillCatalog({
  base,
  canEdit,
  openInstalled,
  employeeId = '',
  onBound,
}: {
  base: string
  canEdit: boolean
  openInstalled: () => void
  employeeId?: string
  onBound?: () => void
}) {
  const employee = EMPLOYEES.find((e) => e.id === employeeId)
  const [recommendedOnly, setRecommendedOnly] = useState(!!employeeId)
  const [boundIds, setBoundIds] = useState<string[]>([])
  const [bindingRevision, setBindingRevision] = useState('')
  const language = useLanguage()
  const [installing, setInstalling] = useState<string | null>(null)
  const [installError, setInstallError] = useState<{ id: string; message: string } | null>(null)
  const [installedName, setInstalledName] = useState('')
  const [items, setItems] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Skill | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const resultsHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    let active = true
    api<{ items: Skill[] }>(`${base}/skills/catalog`)
      .then((data) => {
        if (active) {
          setItems(data.items)
          setError('')
          setLoading(false)
        }
      })
      .catch((err) => {
        if (active) {
          setError(err.message)
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [base])
  useEffect(() => {
    if (!employeeId) return
    let active = true
    api<{ skillIds: string[]; revision: string }>(`${base}/employees/${employeeId}/skills`)
      .then((data) => {
        if (active) {
          setBoundIds(data.skillIds)
          setBindingRevision(data.revision)
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [base, employeeId])
  useEffect(() => {
    if (selected) dialog.current?.showModal()
  }, [selected])
  async function install(skill: Skill) {
    if (
      installing ||
      (!employeeId && skill.installedId) ||
      !canEdit ||
      (!skill.installedId && skill.download.status !== 'downloaded')
    )
      return
    setInstalling(skill.id)
    setInstallError(null)
    setInstalledName('')
    try {
      const result = await api<{ skill: { id: string }; skillIds?: string[]; revision?: string }>(
        employeeId ? `${base}/employees/${employeeId}/skills/catalog` : `${base}/skills/install`,
        employeeId ? { id: skill.id, revision: bindingRevision } : { id: skill.id },
      )
      if (employeeId && result.skillIds && result.revision) {
        setBoundIds(result.skillIds)
        setBindingRevision(result.revision)
        onBound?.()
      }
      setItems((items) =>
        items.map((item) =>
          item.id === skill.id ? { ...item, installedId: result.skill.id } : item,
        ),
      )
      setSelected((current) =>
        current?.id === skill.id ? { ...current, installedId: result.skill.id } : current,
      )
      setInstalledName(skill.name)
    } catch (err) {
      setInstallError({
        id: skill.id,
        message: err instanceof Error ? err.message : '安装失败，请重试',
      })
    } finally {
      setInstalling(null)
    }
  }
  function installButton(skill: Skill) {
    const bound = !!skill.installedId && boundIds.includes(skill.installedId)
    const label = employee
      ? bound
        ? '已绑定'
        : skill.installedId
          ? '绑定给'
          : '安装并绑定给'
      : skill.installedId
        ? '已安装'
        : '安装'
    return (
      <button
        className="catalog-install"
        disabled={
          !canEdit ||
          !!installing ||
          (employeeId ? !bindingRevision || bound : !!skill.installedId) ||
          (!skill.installedId && skill.download.status !== 'downloaded')
        }
        title={!canEdit ? t('仅企业所有者或管理员可以上传安装技能。') : undefined}
        aria-label={`${skill.name} · ${skill.source} · ${t(label)} ${employee?.name || ''}`}
        onClick={() => void install(skill)}
      >
        {installing === skill.id
          ? t('正在处理…')
          : `${t(label)}${employee && !bound ? ` ${employee.name}` : ''}`}
      </button>
    )
  }
  const categories = [...new Set(items.map((skill) => skill.category))]
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = items.filter(
    (skill) =>
      (showHidden || !skill.defaultHidden) &&
      (!recommendedOnly || skillFit(employeeId, skill.category)) &&
      (!category || category === skill.category) &&
      (!status || status === skill.download.status) &&
      words.every((word) =>
        [skill.name, skill.descriptionZh, skill.descriptionEn, skill.source]
          .join(' ')
          .toLowerCase()
          .includes(word),
      ),
  )
  const priorities = recommendedCategories(employeeId)
  const rank = (category: string) => {
    const index = priorities.indexOf(category)
    return index < 0 ? priorities.length : index
  }
  filtered.sort((a, b) => rank(a.category) - rank(b.category))
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  const displayed = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  function changePage(next: number) {
    setPage(next)
    resultsHeading.current?.focus()
  }
  if (loading) return <p role="status">{t('正在加载技能目录…')}</p>
  if (error)
    return (
      <p className="error" role="alert">
        {t(error)}
      </p>
    )
  return (
    <section className="skill-catalog" aria-label={t('技能目录')}>
      <p className="catalog-note">
        {employee
          ? `${employee.name} · ${t('按岗位推荐分类')}：${recommendedCategories(employeeId).map(t).join('、')}`
          : t('点击安装，将所选技能加入当前企业；不会自动绑定员工。')}
      </p>
      {employee && (
        <label className="catalog-employee-recommendation">
          <input
            type="checkbox"
            checked={recommendedOnly}
            onChange={(e) => {
              setRecommendedOnly(e.target.checked)
              setPage(0)
            }}
          />
          {t('仅看适合当前员工的分类')}
        </label>
      )}
      {items.some((skill) => !skill.installedId && skill.download.status === 'failed') && (
        <p className="catalog-note" role="status">
          {t(
            '部分技能的本机安装包不可用，暂不能安装。请查看详情中的原因和恢复说明；已安装技能不受影响。',
          )}
        </p>
      )}
      {!canEdit && <p className="small muted">{t('仅企业所有者或管理员可以上传安装技能。')}</p>}
      {!!installedName && (
        <div className="catalog-install-success" role="status">
          <span>
            {t(employeeId ? '已绑定给' : '安装成功：')}
            {employee?.name} ·{installedName}
          </span>
          <button onClick={openInstalled}>{t('查看我的技能')}</button>
        </div>
      )}
      <div className="catalog-filters">
        <label className="catalog-visibility">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => {
              setShowHidden(e.target.checked)
              setPage(0)
            }}
          />
          {t('显示暂不常用的技能')}
        </label>
        <label>
          {t('搜索技能')}
          <input
            type="search"
            placeholder={t('搜索名称、中文释义或发布来源')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
          />
        </label>
        <label>
          {t('整理分类')}
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value)
              setPage(0)
            }}
          >
            <option value="">{t('全部分类')}</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {t(value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('本机安装包状态')}
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(0)
            }}
          >
            <option value="">{t('全部状态')}</option>
            <option value="downloaded">{t('本机可用')}</option>
            <option value="failed">{t('待补齐')}</option>
          </select>
        </label>
      </div>
      <h2 ref={resultsHeading} tabIndex={-1} className="catalog-results" aria-live="polite">
        {t('筛选结果')} · {filtered.length}
      </h2>
      <p className="small muted">
        {t('中文释义沿用原表，技能实际能力以原文为准。同名技能按发布来源区分。')}
      </p>
      <div className="catalog-table-scroll">
        <table className="catalog-table">
          <caption className="sr-only">{t('技能目录')}</caption>
          <thead>
            <tr>
              <th>{t('序号')}</th>
              <th>{t('技能名称与说明')}</th>
              <th>{t('发布来源')}</th>
              <th>{t('状态与操作')}</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((skill) => (
              <tr key={skill.id}>
                <td>{skill.number}</td>
                <td>
                  <strong>{skill.name}</strong>
                  {!!skill.mergedSources?.length && (
                    <p className="small muted">
                      {t('已合并重复来源：')}
                      {skill.mergedSources.map((entry) => entry.source).join('、')}
                    </p>
                  )}
                  <p>
                    {language === 'zh'
                      ? skill.descriptionZh
                      : skill.descriptionEn || skill.name.replaceAll('-', ' ')}
                  </p>
                  <span className="catalog-category">
                    {t(skill.category)}
                    {employeeId && skillFit(employeeId, skill.category)
                      ? ` · ${t('岗位推荐')}`
                      : ''}
                  </span>
                </td>
                <td>
                  <span className="catalog-source">{skill.source}</span>
                  {skill.sameNameCount > 1 && (
                    <small>
                      {t('同名来源数')} · {skill.sameNameCount}
                    </small>
                  )}
                </td>
                <td>
                  <span className={`catalog-status ${skill.download.status}`}>
                    {t(
                      skill.installedId
                        ? '已安装'
                        : skill.download.status === 'downloaded'
                          ? '本机可用 · 未安装'
                          : '待补齐',
                    )}
                  </span>
                  <button
                    onClick={() => setSelected(skill)}
                    aria-label={`${skill.name} · ${skill.source} · ${t('查看对应文件')}`}
                  >
                    {t('查看详情')}
                  </button>
                  {installButton(skill)}
                  {installError?.id === skill.id && (
                    <p className="error catalog-install-error" role="alert">
                      {t(installError.message)}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!filtered.length && (
        <div className="catalog-empty">
          <p>{t('没有匹配的技能')}</p>
          <button
            onClick={() => {
              setQuery('')
              setCategory('')
              setStatus('')
              setRecommendedOnly(false)
              setPage(0)
            }}
          >
            {t('清除筛选')}
          </button>
        </div>
      )}
      <div className="catalog-pagination">
        <button disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>
          {t('上一页')}
        </button>
        <span>
          {currentPage + 1} / {pages}
        </span>
        <button disabled={currentPage + 1 >= pages} onClick={() => changePage(currentPage + 1)}>
          {t('下一页')}
        </button>
      </div>
      {selected && (
        <dialog
          ref={dialog}
          className="catalog-dialog"
          aria-labelledby="skill-detail-title"
          onClose={() => setSelected(null)}
        >
          <div className="heading-row">
            <h2 id="skill-detail-title">{selected.name}</h2>
            <button onClick={() => dialog.current?.close()}>{t('关闭')}</button>
          </div>
          <p>
            {language === 'zh'
              ? selected.descriptionZh
              : selected.descriptionEn || selected.name.replaceAll('-', ' ')}
          </p>
          <dl>
            <dt>{t('发布来源')}</dt>
            <dd>{selected.source}</dd>
            <dt>{t('目录编号')}</dt>
            <dd>
              {selected.number} · {selected.id}
            </dd>
            <dt>{t('原表释义依据')}</dt>
            <dd>{t(selected.descriptionBasis)}</dd>
            <dt>{t('下载状态')}</dt>
            <dd>
              {t(
                selected.installedId
                  ? '已安装'
                  : selected.download.status === 'downloaded'
                    ? '本机可用 · 未安装'
                    : '待补齐',
              )}
            </dd>
            {selected.download.packagePath && (
              <>
                <dt>{t('对应安装包')}</dt>
                <dd>
                  <code>{selected.download.packagePath}</code>
                </dd>
                <dt>{t('包内技能文件')}</dt>
                <dd>
                  <code>{selected.download.skillFile}</code>
                </dd>
                <dt>SHA-256</dt>
                <dd>
                  <code>{selected.download.sha256}</code>
                </dd>
              </>
            )}
          </dl>
          {selected.download.historical && (
            <p className="catalog-note">
              {t('已从原发布仓库的历史版本找回，安装前需核对版本兼容性。')}
            </p>
          )}
          {selected.download.error && <p className="error">{t(selected.download.error)}</p>}
          <p className="small muted">
            {t('一个来源包可以包含多项技能；安装时将按包内路径定位所选技能。')}
          </p>
          <a href={selected.detailUrl} target="_blank" rel="noreferrer">
            {t('查看来源页面')} ↗
          </a>
          <div className="catalog-detail-install">
            {installButton(selected)}
            {selected.installedId && <button onClick={openInstalled}>{t('查看我的技能')}</button>}
          </div>
          {installError?.id === selected.id && (
            <p className="error" role="alert">
              {t(installError.message)}
            </p>
          )}
          <p className="small muted">
            {t('安装后选择具体员工绑定。绑定只影响该员工后续对话和新任务，上传不会执行脚本。')}
          </p>
        </dialog>
      )}
    </section>
  )
}
