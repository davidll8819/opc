import {CreateEmployee} from './CreateEmployee'
import {notifyEmployeeDirectory} from './employee-directory'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { ModelFields, type Organization } from './Organization'
import { emptyModels, type Models } from './organization-models'
import { t, useLanguage } from '@/i18n'
import { TEAM_ROSTER } from '@/data/team'
import { RECRUITMENT_CATALOG, type RecruitmentCharacter } from './recruitment-catalog'
import './recruitment.css'

type Duty = {name:string;avatarId:string;custom:boolean;departmentKey:string;employeeId: string; seat: number | null; jobTitle: string; capabilities: string; profileRevision: number; departmentId:string; departmentName:string; jobId:string; modelOverrides:Models }
type Role = Duty & { skillIds: string[]; skillRevision: string }
type Skill = { id: string; name: string; description: string; version: string }
const intern = TEAM_ROSTER.find(e => e.role === 'intern')!
const characters: RecruitmentCharacter[] = [...RECRUITMENT_CATALOG, { id: intern.id, employeeId: intern.id, name: intern.name, department: intern.department, departmentEn: 'Intern', responsibility: intern.responsibility, portrait: '', style: '协助团队日常工作', styleEn: 'Team support' }]

export function Recruitment({ base, canEdit, onOpenEmployee, onOpenSkills, initialEmployeeId, onSelection }: {
  base: string; canEdit: boolean; onOpenEmployee: (id: string) => void; onOpenSkills?: (id: string) => void
  initialEmployeeId?: string; onSelection?: (id?: string) => void
}) {
  const [creating,setCreating]=useState(false)
  const en = useLanguage() === 'en'
  const [duty, setDuty] = useState<Duty[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const allCharacters=[...characters,...duty.filter(d=>d.custom).map(d=>({id:d.employeeId,employeeId:d.employeeId,name:d.name,department:d.jobTitle,departmentEn:'Custom role',responsibility:d.capabilities,portrait:characters.find(c=>c.employeeId===d.avatarId)?.portrait||'',style:'自建员工',styleEn:'Custom employee'}))]
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<'all' | 'current' | 'reserve'>('all')
  const [selected, setSelected] = useState(() => characters.find(c => c.employeeId === initialEmployeeId) || null)
  useEffect(()=>{if(initialEmployeeId&&!loading)setSelected(allCharacters.find(c=>c.employeeId===initialEmployeeId)||null)},[initialEmployeeId,loading])
  const refresh = useCallback(async () => {
    const result = await api<{ items: Duty[] }>(`${base}/employees/duty`)
    setDuty(result.items)
  }, [base])
  useEffect(() => {
    let live = true
    const read = async () => {
      try { const result = await api<{ items: Duty[] }>(`${base}/employees/duty`); if (live) { setDuty(result.items); setError('') } }
      catch (e) { if (live) setError((e as Error).message) }
      finally { if (live) setLoading(false) }
    }
    void read(); const timer = setInterval(() => void read(), 5000)
    return () => { live = false; clearInterval(timer) }
  }, [base])
  const state = (id: string | null) => duty.find(e => e.employeeId === id)
  const onDuty = (id: string | null) => { const item = state(id); return !!item && item.seat !== null }
  const used = duty.filter(e => e.seat !== null).length
  const visible = allCharacters.filter(c => (filter === 'all' || (filter === 'current' ? onDuty(c.employeeId) : !onDuty(c.employeeId))) && [c.name, state(c.employeeId)?.jobTitle || c.department, state(c.employeeId)?.capabilities || c.responsibility].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const choose = (character: RecruitmentCharacter | null) => { setSelected(character); onSelection?.(character?.employeeId || undefined) }
  return <section className="recruitment-page" aria-labelledby="recruitment-title">
    <header className="recruitment-heading"><div><h1 id="recruitment-title">{en ? 'Recruit employees' : '招聘员工'}</h1><p>{en ? 'Choose a character, define their role and skills, then assign a desk.' : '点击角色，设置岗位、能力和技能，再安排上岗。'}</p></div><p className="recruitment-total"><strong>{loading ? '…' : used} / 9</strong><span>{en ? 'occupied desks' : '已用工位'}</span></p></header>
    {canEdit&&<button className="primary" onClick={()=>setCreating(true)}>创建员工</button>}
    {creating&&<CreateEmployee base={base} close={()=>setCreating(false)} created={async()=>{setCreating(false);await refresh();notifyEmployeeDirectory()}}/>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="recruitment-toolbar"><div className="recruitment-filters" role="group" aria-label="员工状态">{([
      ['all', '全部员工', allCharacters.length], ['current', '已上岗', used], ['reserve', '待上岗', allCharacters.length - used],
    ] as const).map(([value, label, count]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(label)}<span>{loading && value !== 'all' ? '…' : count}</span></button>)}</div><label className="recruitment-search"><span className="recruitment-sr-only">搜索姓名、岗位或能力</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索姓名、岗位或能力" /></label></div>
    <p className="recruitment-results" role="status">{loading ? '正在读取员工状态…' : `共 ${visible.length} 位员工 · ${9 - used} 个空闲工位`}</p>
    {!visible.length && !loading && <div className="recruitment-empty"><h2>没有符合条件的员工</h2><button onClick={() => { setFilter('all'); setQuery('') }}>清除筛选</button></div>}
    <div className="recruitment-grid">{visible.map(character => <article className="recruitment-card" key={character.id}>
      <button className="recruitment-card-button" aria-label={`${character.name} · 员工设置`} onClick={() => choose(character)}>
        <div className="recruitment-portrait">{character.portrait ? <img src={character.portrait} alt={character.name} loading="lazy" decoding="async" /> : <span className="recruitment-intern-avatar" aria-hidden="true">实</span>}<span className="recruitment-status">{loading ? '读取中' : onDuty(character.employeeId) ? '已上岗' : '待上岗'}</span></div>
        <div className="recruitment-card-content"><p className="recruitment-role">{state(character.employeeId)?.departmentName} · {state(character.employeeId)?.jobTitle || t(character.department)}</p><h2>{character.name}</h2><p className="recruitment-responsibility">{state(character.employeeId)?.capabilities || t(character.responsibility)}</p><span className="recruitment-card-action">{onDuty(character.employeeId) ? '查看设置与下岗选项' : '配置岗位与安排上岗'} <span aria-hidden="true">↗</span></span></div>
      </button>
    </article>)}</div>
    <p className="recruitment-footnote">下岗只释放工位，保留技能、对话和任务记录。可以随时调整部门、岗位与能力，新设置用于后续任务。</p>
    {selected && <EmployeeSetup key={`${base}/${selected.id}`} base={base} character={selected} current={state(selected.employeeId)} used={used} canEdit={canEdit} refresh={refresh} close={() => choose(null)} onOpenEmployee={onOpenEmployee} onOpenSkills={onOpenSkills} />}
  </section>
}

function EmployeeSetup({ base, character, current, used, canEdit, refresh, close, onOpenEmployee, onOpenSkills }: {
  base: string; character: RecruitmentCharacter; current?: Duty; used: number; canEdit: boolean
  refresh: () => Promise<void>; close: () => void; onOpenEmployee: (id: string) => void; onOpenSkills?: (id: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [profile, setProfile] = useState<Role | null>(null), [skills, setSkills] = useState<Skill[]>([])
  const [jobTitle, setJobTitle] = useState(''), [capabilities, setCapabilities] = useState(''), [ids, setIds] = useState<string[]>([])
  const [organization,setOrganization]=useState<Organization|null>(null)
  const [departmentId,setDepartmentId]=useState(''),[jobId,setJobId]=useState(''),[models,setModels]=useState<Models>(emptyModels)
  const [tab, setTab] = useState<'role' | 'skills' | 'models'>('role'), [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [discard, setDiscard] = useState(false)
  const path = `${base}/employees/${character.employeeId}/role`
  const fill = (value: Role) => { setProfile(value); setJobTitle(value.jobTitle); setCapabilities(value.capabilities); setIds(value.skillIds); setDepartmentId(value.departmentId); setJobId(value.jobId); setModels(value.modelOverrides); setDiscard(false) }
  const dirty = !!profile && (departmentId !== profile.departmentId || jobId !== profile.jobId || JSON.stringify(models)!==JSON.stringify(profile.modelOverrides) || jobTitle !== profile.jobTitle || capabilities !== profile.capabilities || ids.length !== profile.skillIds.length || ids.some(id => !profile.skillIds.includes(id)))
  const seated = (current || profile)?.seat != null
  const editable = canEdit && !loading && !busy && !!profile
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => { element?.close(); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    let live = true
    void Promise.all([api<Role>(path), api<{items:Skill[]}>(`${base}/skills/installed`),api<Organization>(`${base}/organization`)]).then(([value, available, org]) => { if (live) { fill(value); setSkills(available.items); setOrganization(org) } }).catch(e => { if (live) setError(e.message) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [path, base])
  const dismiss = () => { if (busy) return; if (dirty) setDiscard(true); else close() }
  async function save() {
    if (!profile) return
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await api<Role>(path, {jobTitle, capabilities, profileRevision:profile.profileRevision, skillIds:ids, skillRevision:profile.skillRevision,departmentId,jobId:jobId||null,modelOverrides:models,organizationRevision:organization?.revision}, 'PUT')
      fill(value); await refresh(); notifyEmployeeDirectory(); setNotice('员工设置已保存，后续任务按此设置工作。')
    } catch(e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function changeDuty() {
    setBusy(true); setError(''); setNotice('')
    try { await api(`${base}/employees/duty/${character.employeeId}`, {onDuty:!seated}, 'PUT'); fill(await api<Role>(path)); await refresh(); setNotice(seated ? '已下岗，可以调整岗位、能力和技能。' : '已上岗，可以开始安排工作。') }
    catch(e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const matching = skills.filter(s => `${s.name} ${s.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a,b) => Number(ids.includes(b.id)) - Number(ids.includes(a.id)))
  return <dialog ref={dialog} className="recruitment-dialog employee-setup" aria-labelledby="employee-setup-title" onCancel={e => { e.preventDefault(); dismiss() }} onClick={e => { if (e.target === e.currentTarget) dismiss() }}>
    <div className="employee-setup-layout"><aside className="employee-setup-identity">
      {character.portrait ? <img src={character.portrait} alt={character.name} /> : <div className="recruitment-intern-avatar">实</div>}
      <h2 id="employee-setup-title">{character.name}</h2><p>{current?.jobTitle || character.department}</p><p className="employee-setup-state">{loading ? '读取中…' : seated ? `已上岗 · ${((current || profile)?.seat ?? 0) + 1} 号工位` : '待上岗 · 可配置'}</p>
      <p className="employee-setup-note">{seated ? '可直接修改员工设置。有任务执行时，请完成或停止任务后再保存设置或下岗。' : '先设定工作职责和技能，再安排工位。下岗不会清空已有记录。'}</p>
    </aside><div className="employee-setup-main">
      <header className="employee-setup-header"><h3>员工设置</h3><button autoFocus onClick={dismiss} disabled={busy} aria-label="关闭员工设置">×</button></header>
      {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status" className="employee-setup-notice">{notice}</p>}
      {discard && <div className="employee-setup-discard" role="alert"><p>还有未保存的修改，是否放弃并关闭？</p><button onClick={() => setDiscard(false)}>继续编辑</button><button onClick={close}>放弃修改并关闭</button></div>}
      {loading ? <p role="status">正在读取岗位与技能…</p> : !profile ? <button onClick={close}>关闭后重试</button> : <>
        <div className="employee-setup-tabs" role="group" aria-label="员工设置内容"><button aria-pressed={tab === 'role'} onClick={() => setTab('role')}>岗位与能力</button><button aria-pressed={tab === 'skills'} onClick={() => setTab('skills')}>员工技能 · {ids.length}/8</button><button aria-pressed={tab === 'models'} onClick={() => setTab('models')}>员工模型</button></div>
        {!canEdit && <p className="muted">当前账号可以查看设置，修改需要管理员权限。</p>}
        {tab === 'role' ? <div className="employee-setup-form"><label htmlFor="employee-department">所属部门</label><select id="employee-department" value={departmentId} disabled={!editable} onChange={e=>{setDepartmentId(e.target.value);setJobId('')}}>{organization?.departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <label htmlFor="employee-position">选择岗位模板</label><select id="employee-position" value={jobId} disabled={!editable} onChange={e=>{setJobId(e.target.value);const j=organization?.jobs.find(j=>j.id===e.target.value);if(j){setJobTitle(j.name);setCapabilities(j.capabilities)}}}><option value="">自定义岗位与能力</option>{organization?.jobs.filter(j=>j.departmentId===departmentId).map(j=><option key={j.id} value={j.id}>{j.name}</option>)}</select><p className="employee-setup-note">需要新部门或新岗位时，请到设置中的“部门与岗位”添加。切换部门会保留当前能力和独立技能，选择岗位模板会填入对应名称与能力。</p>
          <label htmlFor="employee-job-title">岗位名称</label><input id="employee-job-title" value={jobTitle} maxLength={60} disabled={!editable} onChange={e => setJobTitle(e.target.value)} placeholder="例如：客户成功顾问" /><label htmlFor="employee-capabilities">能力与工作职责</label><textarea id="employee-capabilities" rows={7} maxLength={4000} value={capabilities} disabled={!editable} onChange={e => setCapabilities(e.target.value)} placeholder="说明员工擅长什么、如何处理任务、输出什么成果，以及需要遵守的要求。" /><p className="employee-setup-note">这些设定会用于实际对话和任务执行。填写能力不会自动开通联网、代码执行或视频制作工具。</p></div> : tab==='models' ? <div className="employee-setup-form"><h3>员工独立模型</h3><p>当前部门：{organization?.departments.find(d=>d.id===departmentId)?.name}。留空继承部门默认；填写后仅覆盖这位员工的模型。</p><ModelFields base={base} value={models} onChange={setModels} disabled={!editable} prefix="员工" hint="留空继承部门默认模型"/><p className="employee-setup-note">所选模型必须在已配置 API Key 的权限内。模型配置不会改变员工技能。</p></div> : <div className="employee-setup-skills">
          <p>只勾选这位员工需要的技能，最多 8 个。保存后才会生效。</p>
          <label className="recruitment-sr-only" htmlFor="employee-skill-search">搜索已安装技能</label><input id="employee-skill-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索已安装技能" />
          {!skills.length ? <p className="employee-setup-empty">企业还没有安装技能。可以先到技能库安装或创建，再回来为这位员工选择。</p> : !matching.length ? <p>没有找到匹配的技能，试试其他关键词。</p> : <div className="employee-setup-skill-list">{matching.map(skill => <label key={skill.id}><input type="checkbox" checked={ids.includes(skill.id)} disabled={!editable || (!ids.includes(skill.id) && ids.length >= 8)} onChange={e => setIds(e.target.checked ? [...ids, skill.id] : ids.filter(id => id !== skill.id))} /><span><strong>{skill.name}</strong><small>v{skill.version}</small><span>{skill.description}</span></span></label>)}</div>}
          {onOpenSkills && <button disabled={busy || dirty} onClick={() => onOpenSkills(character.employeeId!)}>打开技能库，查找或创建技能</button>}
        </div>}
        {dirty && <p className="employee-setup-unsaved" role="status">有未保存的修改，请先保存再上岗或离开。</p>}
        <footer className="employee-setup-actions">
          {canEdit && <button className="primary" disabled={!editable || !dirty || !jobTitle.trim() || !capabilities.trim()} onClick={() => void save()}>保存员工设置</button>}
          {canEdit && <button className={!dirty ? 'primary' : ''} disabled={busy || dirty || (!seated && used >= 9)} onClick={() => void changeDuty()}>{busy ? '正在处理…' : seated ? '下岗 · 释放工位' : used >= 9 ? '工位已满' : '上岗 · 加入办公室'}</button>}
          {seated && <button disabled={busy || dirty} onClick={() => { close(); onOpenEmployee(character.employeeId!) }}>打开员工对话</button>}
        </footer>
        {!seated && used >= 9 && <p className="employee-setup-note">9 个工位已满。可先保存设置，再让一位空闲员工下岗。</p>}
        {error && !busy && <button onClick={() => void Promise.all([api<Role>(path),api<Organization>(`${base}/organization`)]).then(([value,org]) => { fill(value); setOrganization(org); setError('') }).catch(e => setError(e.message))}>重新载入员工设置（放弃本次修改）</button>}
      </>}
    </div></div>
  </dialog>
}
