// Resolve the compiled Nx workspaces without rewriting source package links.
import { readdir, readFile, mkdir, realpath, symlink, lstat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
const root=resolve('integrations/aitoearn/source/project/aitoearn-backend')
const packages=[]
for(const kind of ['libs','apps'])for(const name of await readdir(resolve(root,kind))){
 try{const json=JSON.parse(await readFile(resolve(root,kind,name,'package.json'),'utf8'));await lstat(resolve(root,'dist',kind,name,'package.json'));packages.push({name:json.name,source:resolve(root,kind,name),target:resolve(root,'dist',kind,name)})}catch{}
}
const workspaces=new Map(packages.map(p=>[p.name,p.target]))
for(const p of packages){
 const modules=resolve(p.source,'node_modules')
 let dirs;try{dirs=await readdir(modules)}catch{continue}
 const names=[]
 for(const name of dirs){if(name.startsWith('@')){for(const child of await readdir(resolve(modules,name)))names.push(name+'/'+child)}else if(!name.startsWith('.'))names.push(name)}
 for(const name of names){
  let target=workspaces.get(name)
  if(!target){try{target=await realpath(resolve(modules,name))}catch{continue}}
  const link=resolve(p.target,'node_modules',name)
  await mkdir(dirname(link),{recursive:true})
  try{const existing=await realpath(link);if(existing!==target)throw Error('Conflicting compiled dependency: '+name)}catch(e){if(e.code==='ENOENT')await symlink(target,link,'dir');else throw e}
 }
}
console.log('Compiled workspace dependencies linked for '+packages.length+' packages')
