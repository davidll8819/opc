import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
let server, roomSnapshot
before(async () => {
 server = await createServer({configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom'})
 ;({roomSnapshot}=await server.ssrLoadModule('/src/saas/secretary/waner-office-state.ts'))
})
after(async()=>{await server?.close()})
test('blocked task takes precedence over running work and old completions',()=>{
 const actual=roomSnapshot({tasks:[{id:'done',status:'completed'},{id:'run',status:'working'},{id:'blocked',status:'blocked'}]})
 assert.equal(actual.mode,'attention');assert.equal(actual.featured[0].id,'blocked');assert.equal(actual.attention.length,1);assert.equal(actual.working.length,1)
})
test('queued and partial review tasks never announce success',()=>{
 assert.equal(roomSnapshot({tasks:[{status:'queued'}]}).working.length,0)
 const actual=roomSnapshot({tasks:[{status:'review',quality:{status:'partial'}}]})
 assert.equal(actual.mode,'attention');assert.match(actual.line,/处理/)
})
test('empty office does not invent work or messages',()=>{
 const actual=roomSnapshot({tasks:[]});assert.equal(actual.mode,'idle');assert.equal(actual.featured.length,0);assert.equal(actual.attention.length,0)
})
