import {useEmployeeDirectory} from './employee-directory'
import { useEffect, useState } from 'react'
import { api } from './api'
import './skill-studio.css'

type Version = { version: number; title: string; requirement: string; instructions: string; installed_id?: string }
type Run = { id: string; version: number; employee_id: string; kind: string; state: string; input: string; output: string; error: string }
type Draft = Version & { id: string; versions: Version[]; runs: Run[] }
export function SkillStudio({ base, employeeId, onBound }: { base: string; employeeId: string; onBound: () => void }) {
  const [items,setItems]=useState<(Version & {id:string})[]>([])
  const [draft,setDraft]=useState<Draft|null>(null)
  const [title,setTitle]=useState(''),[requirement,setRequirement]=useState(''),[instructions,setInstructions]=useState('')
  const [employee,setEmployee]=useState(employeeId||'marvis'),[sample,setSample]=useState('')
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmed,setConfirmed]=useState(false)
  const [loading,setLoading]=useState(true)
  const employees=useEmployeeDirectory(base)
  const root=`${base}/skills/studio`
  const dirty=!!draft&&(title!==draft.title||requirement!==draft.requirement||instructions!==draft.instructions)
  const loadList=async()=>setItems((await api<{items:(Version & {id:string})[]}>(root)).items)
  const fill=(value:Draft)=>{setDraft(value);setTitle(value.title);setRequirement(value.requirement);setInstructions(value.instructions);setConfirmed(false)}
  const load=async(id:string)=>fill(await api<Draft>(`${root}/${id}`))
  useEffect(()=>{let live=true;void api<{items:(Version & {id:string})[]}>(root).then(r=>{if(live)setItems(r.items)}).catch(e=>{if(live)setError(e.message)}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[root])
  const action=async(label:string,fn:()=>Promise<void>)=>{setBusy(label);setError('');setNotice('');try{await fn();await loadList()}catch(e){setError((e as Error).message)}finally{setBusy('')}}
  const save=async()=>{
    const value=await api<{id:string}>(draft?`${root}/${draft.id}`:root,{title,requirement,instructions,...(draft?{version:draft.version}:{})},draft?'PUT':'POST')
    await load(value.id);return value.id
  }
  const run=async(kind:'generate'|'trial')=>{
    const id=draft?.id||await save()
    const current=await api<Draft>(`${root}/${id}`)
    try{await api(`${root}/${id}/run`,{requestId:crypto.randomUUID(),version:current.version,employeeId:employee,kind,input:kind==='generate'?requirement:sample})}
    finally{await load(id)}
    setNotice(kind==='generate'?'草稿已生成，请编辑检查后试运行。':'试运行已完成，请检查输出是否符合要求，再确认启用。')
  }
  const trial=draft?.runs.find(r=>r.kind==='trial'&&r.state==='completed'&&r.version===draft.version&&r.employee_id===employee)
  return <section className="skill-studio" aria-label="创建员工技能">
    <header><h2>创建员工技能</h2><p>描述需求 → 生成草稿 → 编辑与试运行 → 确认启用 → 绑定员工</p></header>
    {error&&<p className="error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <div className="skill-studio-layout"><aside aria-label="已保存技能草稿">
      <button disabled={!!busy||dirty} onClick={()=>{setDraft(null);setTitle('');setRequirement('');setInstructions('');setNotice('');setConfirmed(false)}}>＋ 新建技能</button>
      {loading?<p role="status">正在读取草稿…</p>:!items.length?<p className="muted">还没有自创技能。先写下希望员工学会的工作方法。</p>:items.map(item=><button key={item.id} disabled={!!busy||dirty} aria-current={draft?.id===item.id?'true':undefined} onClick={()=>void action('读取草稿',()=>load(item.id))}>{item.title}<small>v{item.version} · {item.installed_id?'已启用版本':'草稿'}</small></button>)}
    </aside><div className="skill-studio-editor">
      <fieldset disabled={!!busy}>
        <label>技能名称<input aria-label="技能名称" value={title} maxLength={100} onChange={e=>setTitle(e.target.value)} placeholder="例如：客户需求访谈整理" /></label>
        <label>希望员工做到什么<textarea aria-label="希望员工做到什么" rows={3} value={requirement} maxLength={6000} onChange={e=>setRequirement(e.target.value)} placeholder="说明使用场景、提供哪些资料、希望得到什么结果以及验收标准" /></label>
        <label>使用／试运行员工<select value={employee} onChange={e=>{setEmployee(e.target.value);setConfirmed(false)}}>{employees.map(e=><option key={e.id} value={e.id}>{e.name} · {e.department}</option>)}</select></label>
        <p className="muted">试运行员工需要先上岗。储备员工沿用对应岗位的模型，不会更改模型设置。</p>
        <div className="studio-actions"><button disabled={!title.trim()||!requirement.trim()} onClick={()=>void action('保存草稿',async()=>{await save();setNotice('草稿已保存，尚未绑定员工。')})}>{draft?'保存新版本':'保存草稿'}</button><button disabled={!title.trim()||!requirement.trim()||dirty} onClick={()=>void action('生成草稿',()=>run('generate'))}>生成技能草稿</button></div>
        <label>技能内容<textarea aria-label="技能内容" rows={12} value={instructions} maxLength={16000} onChange={e=>{setInstructions(e.target.value);setConfirmed(false)}} placeholder="可直接编辑 Markdown：适用条件、输入、步骤、输出格式和验收标准" /></label>
        {dirty&&<p role="status">有未保存的修改。请先保存新版本，再试运行；也可重新载入放弃本次编辑。</p>}
        {dirty&&draft&&<button onClick={()=>void action('重新载入',()=>load(draft.id))}>放弃本次编辑，重新载入</button>}
        <label>试运行样例<textarea aria-label="试运行样例" rows={3} value={sample} maxLength={6000} onChange={e=>setSample(e.target.value)} placeholder="提供一份真实或模拟的工作输入，用来检查技能输出" /></label>
        <p className="muted">试运行会调用当前员工模型并计入用量；仅验证文字方法及技能文档读取。需要联网、执行代码或制作视频的流程，仍需在对应工作台验证。</p>
        <button disabled={!draft||dirty||!instructions.trim()||!sample.trim()} onClick={()=>void action('试运行中，请勿重复提交',()=>run('trial'))}>试运行当前版本</button>
        {trial&&<section className="studio-trial"><h3>当前版本试运行结果 · v{trial.version}</h3><pre>{trial.output}</pre><label className="studio-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} />我已检查输出，确认此技能适合所选员工</label><button className="primary" disabled={!confirmed||dirty} onClick={()=>void action('启用技能',async()=>{await api(`${root}/${draft!.id}/enable`,{version:draft!.version,trialId:trial.id,employeeId:employee,confirmed:true});await load(draft!.id);onBound();setNotice('已启用并绑定所选员工。其他员工的技能保持不变。')})}>确认启用并绑定所选员工</button></section>}
      </fieldset>
      {busy&&<p role="status">{busy}… 请稍候</p>}
      {draft&&<details><summary>版本与运行记录</summary><p className="muted">恢复历史版本会创建新草稿，试运行并确认后才替换所选员工的版本。</p>{draft.versions.map(v=><div className="studio-version" key={v.version}><span>v{v.version} · {v.title} · {v.installed_id?'已发布':'草稿'}</span><button disabled={!!busy||dirty||v.version===draft.version} onClick={()=>void action('恢复为新草稿',async()=>{await api(`${root}/${draft.id}`,{title:v.title,requirement:v.requirement,instructions:v.instructions,version:draft.version},'PUT');await load(draft.id)})}>恢复为新草稿</button></div>)}{draft.runs.map(r=><details key={r.id}><summary>v{r.version} · {r.kind==='trial'?'试运行':'生成'} · {employees.find(e=>e.id===r.employee_id)?.name} · {r.state==='completed'?'已完成':r.state==='failed'?'未完成':'处理中／结果待核对'}</summary><p>输入：{r.input}</p><pre>{r.output||r.error||'结果尚未返回。请刷新记录核对；中断后不会自动重复收费调用。'}</pre></details>)}<button disabled={!!busy||dirty} onClick={()=>void action('刷新记录',()=>load(draft.id))}>刷新记录</button></details>}
    </div></div>
  </section>
}
