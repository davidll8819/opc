import {useEffect,useState} from 'react'
import {EMPLOYEES,type Employee} from '../../../../packages/employees/registry.mjs'
import {api} from './api'
export type DirectoryEmployee=Employee & {avatarId?:string;custom?:boolean;task:string}
export const notifyEmployeeDirectory=()=>window.dispatchEvent(new Event('office-employees-updated'))
export function useEmployeeDirectory(base:string) {
 const [employees,setEmployees]=useState<DirectoryEmployee[]>(()=>EMPLOYEES.map(e=>({...e,task:`${e.department}：${e.responsibility}`})))
 useEffect(()=>{let live=true;const load=()=>void api<{employees:DirectoryEmployee[]}>(`${base}/employees`).then(d=>{if(live)setEmployees(d.employees.map(e=>({...e,task:`${e.department}：${e.responsibility}`})))}).catch(()=>{});load();window.addEventListener('office-employees-updated',load);return()=>{live=false;window.removeEventListener('office-employees-updated',load)}},[base])
 return employees
}
export const taskDepartments=(employees:DirectoryEmployee[])=>employees.filter(e=>e.role!=='secretary').map(e=>({id:e.id,name:e.department,en:e.departmentEn,person:e.name}))
