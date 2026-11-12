import { readFile } from 'node:fs/promises'
async function main() {
  const config = JSON.parse(await readFile('integrations/aitoearn/source/project/aitoearn-backend/.claude-session/.claude-code-router/config.json', 'utf8'))
  let failed = false
  for (const [name, key] of [['absent', ''], ['incorrect', 'invalid-synthetic-auth'], ['legacy-default', ['c','c','r'].join('')], ['current', config.APIKEY]]) {
    const response = await fetch('http://127.0.0.1:3456/api/config', { headers: key ? { Authorization: `Bearer ${key}` } : {} })
    const body = await response.text()
    const protectedResponse = !body.includes(config.Providers[0].api_key) && !body.includes(config.APIKEY)
    const ok = response.status === (name === 'current' ? 403 : 401) && protectedResponse
    console.log(`${name}: HTTP ${response.status}, credential-free=${protectedResponse}, ${ok ? 'PASS' : 'FAIL'}`)
    failed ||= !ok
  }
  const response = await fetch('http://127.0.0.1:3456/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': config.APIKEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: config.Router.default, max_tokens: 32, messages: [{ role: 'user', content: 'Reply only OK.' }] }), signal: AbortSignal.timeout(90000),
  })
  const body = await response.json()
  const ok = response.ok && body.content?.some(item => item.type === 'text' && item.text.trim())
  console.log(`model invocation: HTTP ${response.status}, text-received=${Boolean(ok)}, ${ok ? 'PASS' : 'FAIL'}`)
  if (failed || !ok) process.exitCode = 1
}
main().catch(() => { console.error('Security verification failed; credentials and response body withheld.'); process.exitCode = 1 })
