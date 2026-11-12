import { spawnSync } from 'node:child_process'
import { access, readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { validatePrivateAccess } from '../apps/api/src/private-access.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const configPath = fileURLToPath(new URL('../.local/private-access.json', import.meta.url))
const cliCandidates = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
]
const target = 'http://127.0.0.1:3000'
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  )
const cli = (
  await Promise.all(cliCandidates.map(async (path) => ((await exists(path)) ? path : null)))
).find(Boolean)
function run(args) {
  const result = spawnSync(cli, args, { cwd: root, encoding: 'utf8', timeout: 20000 })
  if (result.status !== 0)
    throw new Error(
      result.stderr?.trim() ||
        result.error?.message ||
        'Tailscale command failed; open the Mac app and finish sign-in',
    )
  return result.stdout.trim()
}
async function savedConfig() {
  try {
    return validatePrivateAccess(JSON.parse(await readFile(configPath, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
function currentIdentity() {
  const status = JSON.parse(run(['status', '--json']))
  if (status.BackendState !== 'Running' || !status.Self?.Online || !status.Self?.UserID)
    throw new Error('请先在 Mac 的 Tailscale 中完成个人账号登录并连接')
  const name = status.Self.DNSName?.replace(/\.$/, '')
  const login = status.User?.[status.Self.UserID]?.LoginName
  return validatePrivateAccess({ origin: `https://${name}`, login })
}
export function exclusivelyOwnServe(value, origin) {
  if (!value || Object.keys(value).length === 0) return true
  const host = `${new URL(origin).hostname}:443`
  return (
    Object.keys(value).every((k) => ['TCP', 'Web', 'AllowFunnel', 'Foreground'].includes(k)) &&
    Object.keys(value.TCP || {}).length === 1 &&
    value.TCP?.['443']?.HTTPS === true &&
    Object.keys(value.TCP['443']).every((k) => k === 'HTTPS') &&
    Object.keys(value.Web || {}).every((k) => k === host) &&
    Object.keys(value.Web?.[host]?.Handlers || {}).length === 1 &&
    value.Web?.[host]?.Handlers?.['/']?.Proxy === target &&
    !Object.values(value.AllowFunnel || {}).some(Boolean) &&
    Object.keys(value.Foreground || {}).length === 0
  )
}
async function main() {
  const command = process.argv[2] || 'status'
  if (!['status', 'prepare', 'enable', 'disable'].includes(command))
    throw Error('Use status, prepare, enable or disable')
  const saved = await savedConfig()
  if (command === 'status') {
    console.log(
      JSON.stringify(
        {
          installed: !!cli,
          configured: !!saved,
          origin: saved?.origin || null,
          instruction: !cli
            ? '请安装官方 Tailscale，并在 Mac 与手机使用同一账号登录'
            : 'Tailscale 登录后运行 prepare，再重启本地应用并运行 enable',
        },
        null,
        2,
      ),
    )
    return
  }
  if (!cli) throw Error('尚未安装 Tailscale，请先安装官方 Mac 客户端并登录')
  const current = currentIdentity()
  if (saved && (saved.origin !== current.origin || saved.login !== current.login))
    throw Error('当前 Tailscale 身份与已保存的私有入口不同，请先核对；未覆盖配置')
  if (command === 'prepare') {
    await mkdir(new URL('../.local/', import.meta.url), { recursive: true, mode: 0o700 })
    await writeFile(
      `${configPath}.next`,
      JSON.stringify({ origin: current.origin, login: current.login }, null, 2) + '\n',
      { mode: 0o600 },
    )
    await rename(`${configPath}.next`, configPath)
    console.log(
      `私有入口配置已保存：${current.origin}\n尚未开启访问。请重启本地应用，再运行 enable。`,
    )
    return
  }
  if (!saved) throw Error('请先运行 prepare；未开启网络访问')
  const serving = JSON.parse(run(['serve', 'status', '--json']) || '{}')
  if (!exclusivelyOwnServe(serving, saved.origin))
    throw Error('存在其他 Tailscale Serve/Funnel 配置；未修改，请先核对')
  if (command === 'disable') {
    run(['serve', '--https=443', 'off'])
    await unlink(configPath)
    console.log('已关闭此入口。重启本地应用后，清除手机入口配置；本地数据保留。')
    return
  }
  const response = await fetch(`${target}/public/config`, { signal: AbortSignal.timeout(5000) })
  const config = await response.json()
  if (!response.ok || config.privateOrigin !== saved.origin)
    throw Error('本地应用尚未加载私有入口配置，请重启后重试')
  console.log(run(['serve', '--bg', '--https=443', target]))
  const active = JSON.parse(run(['serve', 'status', '--json']) || '{}')
  if (!exclusivelyOwnServe(active, saved.origin) || !active.Web)
    throw Error('未能确认私有 HTTPS 入口，需检查 Tailscale 状态')
  console.log(
    `手机入口：${saved.origin}\n手机开启 Tailscale 后，用原 Wishtaday 账号登录；还需蜂窝网络实机验收。`,
  )
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
