// Native macOS lifecycle for the original AiToEarn services and dedicated local infrastructure.
import { readFile, writeFile, mkdir, open, access, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { MongoClient } from 'mongodb'
import { createClient } from 'redis'
import { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3'
import { operationsLaunch } from './run-operations-service.mjs'
import { createOperationsDriver } from '../apps/api/src/operations/driver.mjs'
import { stopOperations } from './operations-local.mjs'
import { privateVideoPolicy } from './private-video-policy.mjs'
const run = promisify(execFile)
const exists = p => access(p).then(() => true, () => false)
const wait = ms => new Promise(r => setTimeout(r, ms))
export async function matchingProcess(pid, executable, requiredArgs) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false
  try {
    const { stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'command='])
    return stdout.trim().startsWith(executable + ' ') && requiredArgs.every(arg => stdout.includes(arg))
  } catch { return false }
}
async function main() {
  if (process.platform !== 'darwin') throw Error('Native lifecycle requires macOS')
  process.loadEnvFile('.env')
  const action = process.argv[2] || 'status'
  if (!['start','stop','status','recover'].includes(action)) throw Error('Use start, stop or status')
  const registry = JSON.parse(await readFile(process.env.OPERATIONS_RUNTIMES_FILE, 'utf8'))
  const tenant = process.argv[3] || Object.keys(registry).find(id => registry[id].nativeMac)
  const entry = registry[tenant]
  if (!entry?.nativeMac) throw Error('Prepare the private native Mac binding first')
  const root = resolve('.'), dir = resolve('.local/production-runtime'), driver = createOperationsDriver(process.env)
  const secrets = JSON.parse(await readFile(resolve(dir,'credentials.json'),'utf8'))
  await mkdir(resolve(dir,'logs'),{recursive:true,mode:0o700})
  const launches = {
    mongo: {exe:resolve(dir,'bin/mongod'),args:['--config',resolve(dir,'mongo.yaml')],cwd:root,env:process.env},
    redis: {exe:resolve('.local/services/bin/redis-server'),args:[resolve(dir,'redis.conf')],cwd:root,env:process.env},
    storage: {exe:resolve(dir,'bin/rustfs'),args:[resolve(dir,'assets')],cwd:root,env:{...process.env,RUSTFS_ADDRESS:'127.0.0.1:19000',RUSTFS_CONSOLE_ENABLE:'false',RUSTFS_ACCESS_KEY:secrets.storageAccessKey,RUSTFS_SECRET_KEY:secrets.storageSecretKey,RUSTFS_OBS_LOGGER_LEVEL:'error'}},
  }
  for (const service of ['server','ai']) { const launch=operationsLaunch(root,tenant,service,entry);launches[service]={exe:process.execPath,...launch} }
  const pidPath = name => resolve(dir,name+'.pid')
  const getPid = async name => Number(await readFile(pidPath(name),'utf8').catch(()=>0))
  const running = async name => {const l=launches[name];return matchingProcess(await getPid(name),l.exe,name==='redis'?['127.0.0.1:57379']:l.args)}
  async function start(name) {
    if (await running(name)) return
    const l=launches[name]
    await access(l.exe)
    const guarded = ['server','ai'].includes(name)
    const output=await open(guarded ? '/dev/null' : resolve(dir,'logs',name+'.out.log'),'a',0o600),error=await open(guarded ? '/dev/null' : resolve(dir,'logs',name+'.err.log'),'a',0o600)
    try {
      const child=spawn(l.exe,l.args,{cwd:l.cwd,env:l.env,detached:true,stdio:['ignore',output.fd,error.fd]})
      await new Promise((ok,no)=>{child.once('spawn',ok);child.once('error',no)})
      await writeFile(pidPath(name),String(child.pid),{mode:0o600});child.unref()
    } finally {await output.close();await error.close()}
    await wait(500)
    if (!(await running(name))) throw Error(name+' exited; inspect private runtime logs')
  }
  async function stop(name) {
    if (!(await running(name))) return
    const pid=await getPid(name);process.kill(pid,'SIGTERM')
    for(let i=0;i<50;i++){if(!(await running(name))){await unlink(pidPath(name)).catch(()=>{});return}await wait(200)}
    throw Error(name+' did not stop; data retained')
  }
  const mongo = () => new MongoClient(entry.infrastructure.mongodb.uri,{serverSelectionTimeoutMS:3000})
  async function initializeMongo() {
    const authenticated=mongo()
    try {await authenticated.connect();await authenticated.db('admin').command({ping:1});return}
    catch {} finally {await authenticated.close()}
    // MongoDB's localhost exception permits first-user provisioning only on a new protected server.
    const bootstrap=new MongoClient('mongodb://127.0.0.1:27018/?directConnection=true',{serverSelectionTimeoutMS:3000})
    try {
      await bootstrap.connect()
      try {await bootstrap.db('admin').command({replSetInitiate:{_id:'office-rs',members:[{_id:0,host:'127.0.0.1:27018'}]}})} catch(e){if(e.code!==23)throw e}
      for(let i=0;i<60;i++){if((await bootstrap.db('admin').command({hello:1})).isWritablePrimary)break;await wait(500)}
      await bootstrap.db('admin').command({createUser:secrets.mongoUser,pwd:secrets.mongoPassword,roles:[{role:'root',db:'admin'}]})
    } finally {await bootstrap.close()}
  }
  if(action==='stop'){
    const client=mongo();await client.connect()
    try{await stopOperations({drain:draining=>driver.request(entry,'ai','/office-bridge/drain',{method:'POST',body:{draining},signed:true}),active:async()=>await client.db(entry.infrastructure.mongodb.dbName).collection('contentGenerationTask').countDocuments({status:'running',deletedAt:null})+await client.db(entry.infrastructure.mongodb.dbName).collection('aiLogs').countDocuments({status:'generating'}),stop})}finally{await client.close()}
    for(const name of ['storage','redis','mongo'])await stop(name)
    console.log('Production services stopped; all tasks and media retained');return
  }
  if(action==='recover'){
    for(const name of ['mongo','redis','storage','server','ai']) await start(name)
  }
  if(action==='start'){
    for(const name of ['mongo','redis','storage'])await start(name)
    await initializeMongo()
    console.log('Dedicated MongoDB authenticated and ready')
    await run(process.execPath,['scripts/link-operations-build.mjs'],{cwd:root})
    console.log('Compiled runtime dependencies ready')
    const s3=new S3Client({endpoint:entry.infrastructure.assets.endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:secrets.storageAccessKey,secretAccessKey:secrets.storageSecretKey}})
    const Bucket=entry.infrastructure.assets.bucketName
    try{await s3.send(new HeadBucketCommand({Bucket}))}catch(e){if(![404,400].includes(e.$metadata?.httpStatusCode))throw e;await s3.send(new CreateBucketCommand({Bucket}))}
    // Restart must never re-enable anonymous reads of protected video objects.
    await s3.send(new PutBucketPolicyCommand({Bucket,Policy:JSON.stringify(privateVideoPolicy(Bucket))}));s3.destroy()
    if(!entry.userId){await run(process.execPath,['--env-file=.env','scripts/provision-operations-user.mjs',tenant],{cwd:root});entry.userId=JSON.parse(await readFile(process.env.OPERATIONS_RUNTIMES_FILE,'utf8'))[tenant].userId}
    await run(process.execPath,['--env-file=.env','scripts/export-operations-runtime.mjs',tenant],{cwd:root})
    for(const name of ['server','ai'])await start(name)
  }
  if(action==='status'){
    for(const name of ['mongo','redis','storage','server','ai']) if(!(await running(name))) throw Error(name+' is not running')
  }
  let error
  for(let i=0;i<(['start','recover'].includes(action)?60:1);i++){
    try{await driver.ready(tenant);console.log('AiToEarn server/AI bridge v5 ready; publication requires confirmation');return}catch(e){error=e}
    if(['start','recover'].includes(action))await wait(1000)
  }
  throw Error('Runtime not ready: '+error?.message)
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error('Native production runtime command failed:',error.name,error.code||error.$metadata?.httpStatusCode||'runtime-error','. Inspect .local/production-runtime/logs; credentials were not printed.');process.exitCode=1})
