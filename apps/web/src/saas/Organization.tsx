import { useEffect, useState, useId } from 'react'
import { api } from './api'
import { emptyModels, modelLabels, type Models } from './organization-models'
import './organization.css'

export type Organization = {revision:number;departments:{id:string;name:string;description:string;models:Models}[];jobs:{id:string;departmentId:string;name:string;capabilities:string}[]}

export function ModelFields({value,onChange,disabled,prefix,hint,base}:{value:Models;onChange:(value:Models)=>void;disabled:boolean;prefix:string;hint:string;base:string}) {
  const id=useId(),[catalog,setCatalog]=useState<{id:string;kinds:string[]}[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState('')
  async function discover(){setLoading(true);setError('');try{const data=await api<{catalog:{id:string;kinds:string[]}[]}>(`${base}/operations/models`);setCatalog(data.catalog);if(!data.catalog.length)setError('服务暂未返回可用模型')}catch(e){setError((e as Error).message)}finally{setLoading(false)}}
  return <div className="organization-model-picker"><button type="button" disabled={disabled||loading} onClick={()=>void discover()}>{loading?'正在读取模型…':'读取可用模型'}</button><p className="muted">{catalog.length?`已读取 ${catalog.length} 个模型，点击输入框选择。`:'可从已保存的 API Key 查询模型列表，也可以直接填写模型标识。此操作不会发起生成。'}</p>{error&&<p role="alert">{error}</p>}<div className="organization-models">{(Object.keys(modelLabels) as (keyof Models)[]).map(kind=><label key={kind}>{prefix}{modelLabels[kind]}<input list={`${id}-${kind}`} value={value[kind]} maxLength={150} disabled={disabled} onChange={e=>onChange({...value,[kind]:e.target.value})} placeholder={hint} autoComplete="off" /><datalist id={`${id}-${kind}`}>{catalog.filter(m=>m.kinds.includes(kind==='search'?'text':kind)).map(m=><option key={m.id} value={m.id}/>)}</datalist></label>)}</div></div>
}

export function OrganizationManager({base,canEdit}:{base:string;canEdit:boolean}) {
  const [saved,setSaved]=useState<Organization|null>(null),[draft,setDraft]=useState<Organization|null>(null),[selected,setSelected]=useState('')
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const dirty=!!draft && JSON.stringify(saved)!==JSON.stringify(draft)
  const load=async()=>{try{const d=await api<Organization>(`${base}/organization`);setSaved(d);setDraft(d);setSelected(s=>d.departments.some(x=>x.id===s)?s:d.departments[0]?.id||'');setError('')}catch(e){setError((e as Error).message)}}
  useEffect(()=>{let live=true;void api<Organization>(`${base}/organization`).then(d=>{if(live){setSaved(d);setDraft(d);setSelected(d.departments[0]?.id||'')}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[base])
  useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>e.preventDefault();window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[dirty])
  useEffect(()=>{
    if(!dirty)return
    const guard=(event:MouseEvent)=>{
      const target=event.target as HTMLElement
      if(!target.closest('.workspace-nav nav button,.settings-sections button'))return
      if(busy || !window.confirm('部门与岗位还有未保存的修改，确定放弃并离开吗？')){event.preventDefault();event.stopImmediatePropagation()}
    }
    document.addEventListener('click',guard,true)
    return()=>document.removeEventListener('click',guard,true)
  },[dirty,busy])
  const department=draft?.departments.find(d=>d.id===selected)
  const patch=(value:Partial<NonNullable<typeof department>>)=>setDraft(d=>d?{...d,departments:d.departments.map(v=>v.id===selected?{...v,...value}:v)}:d)
  async function save(){if(!draft)return;setBusy(true);setError('');setNotice('');try{const d=await api<Organization>(`${base}/organization`,draft,'PUT');setSaved(d);setDraft(d);setNotice('部门和岗位已保存。员工的独立技能保持不变，有执行中的任务时，系统会提示等任务结束后再保存。')}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <section className="organization" aria-label="部门与岗位管理">
    <header className="organization-heading"><div><h2>部门与岗位</h2><p>先建立部门和岗位，再到招聘员工中安排人员。模型按“员工单独设置 → 部门默认 → 公司默认”使用。</p></div><button disabled={!canEdit||busy||!draft} onClick={()=>{const id=`dept_${crypto.randomUUID()}`;setDraft(d=>d?{...d,departments:[...d.departments,{id,name:'新部门',description:'',models:emptyModels()}]}:d);setSelected(id);setNotice('')}}>新建部门</button></header>
    {error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!draft?<p>正在读取部门… <button onClick={()=>void load()}>重新载入</button></p>:<>
      <div className="organization-layout"><nav aria-label="部门列表">{draft.departments.map(d=><button key={d.id} aria-current={selected===d.id?'page':undefined} onClick={()=>setSelected(d.id)}>{d.name}<small>{draft.jobs.filter(j=>j.departmentId===d.id).length} 个岗位</small></button>)}</nav>
      {department&&<div className="organization-detail"><fieldset disabled={!canEdit||busy}><legend>部门设置</legend><label>部门名称<input value={department.name} maxLength={60} onChange={e=>patch({name:e.target.value})}/></label><label>部门职责<textarea rows={2} value={department.description} maxLength={4000} onChange={e=>patch({description:e.target.value})}/></label>
        <h3>部门默认模型</h3><p className="muted">填写 4yi 模型标识，留空沿用原部门或公司默认模型。选择模型不会自动获得该模型的账号权限。</p>
        <ModelFields base={base} value={department.models} onChange={models=>patch({models})} disabled={!canEdit||busy} prefix="部门" hint="留空继承默认模型"/>
        <h3>部门岗位</h3><p className="muted">选择岗位后会填入职责，员工仍可单独调整。修改模板不会覆盖员工已有设置。</p>
        {draft.jobs.filter(j=>j.departmentId===selected).map(job=><div className="organization-job" key={job.id}><label>岗位名称<input value={job.name} maxLength={60} onChange={e=>setDraft({...draft,jobs:draft.jobs.map(j=>j.id===job.id?{...j,name:e.target.value}:j)})}/></label><label>岗位能力模板<textarea value={job.capabilities} maxLength={4000} rows={3} onChange={e=>setDraft({...draft,jobs:draft.jobs.map(j=>j.id===job.id?{...j,capabilities:e.target.value}:j)})}/></label><button type="button" onClick={()=>setDraft({...draft,jobs:draft.jobs.filter(j=>j.id!==job.id)})}>移除此岗位</button></div>)}
        {!draft.jobs.some(j=>j.departmentId===selected)&&<p>还没有岗位。新增后即可在员工设置中选择。</p>}
        <button type="button" onClick={()=>setDraft({...draft,jobs:[...draft.jobs,{id:`job_${crypto.randomUUID()}`,departmentId:selected,name:'新岗位',capabilities:''}]})}>新增岗位</button>
        <button type="button" className="organization-delete" onClick={()=>{setDraft({...draft,departments:draft.departments.filter(d=>d.id!==selected),jobs:draft.jobs.filter(j=>j.departmentId!==selected)});setSelected(draft.departments.find(d=>d.id!==selected)?.id||'')}}>移除此部门</button>
      </fieldset></div>}</div>
      <footer className="organization-actions"><button className="primary" disabled={!canEdit||busy||!dirty} onClick={()=>void save()}>{busy?'正在保存…':'保存部门与岗位'}</button>{dirty&&<><span role="status">有未保存的修改</span><button disabled={busy} onClick={()=>{setDraft(saved);setSelected(saved?.departments[0]?.id||'');setError('')}}>撤销本次修改</button></>}<p>有员工关联的部门或岗位不能删除。移除操作在保存后生效。</p></footer>
    </>}
  </section>
}
