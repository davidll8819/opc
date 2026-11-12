import { mkdir, readdir, writeFile, chmod } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { fail } from '../db.mjs'
import { createNativeProvisioner } from '../../../../scripts/lib/native-video-provisioner.mjs'

import { privateJson, readJson, hostLock } from '../../../../scripts/lib/private-runtime-files.mjs'
const uuid = z.string().uuid()
const stages = {
  queued: '等待开通视频服务', allocating: '正在分配独立视频环境',
  infrastructure: '正在准备独立数据与素材存储', configuring: '正在配置视频服务',
  starting: '正在启动视频服务', checking: '正在检查视频服务连接',
  ready: '视频服务已开通', failed: '视频服务开通失败', disabled: '此主机尚未启用视频自动开通',
}
export function publicProvisioning(job, enabled) {
  const state = job?.state || (enabled ? 'not_requested' : 'disabled')
  const stage = job?.stage || state
  return { state, stage, message: job?.error || stages[stage] || '尚未开通视频服务',
    canRetry: enabled && ['not_requested', 'failed'].includes(state),
    updatedAt: job?.updatedAt || null }
}

export async function createVideoProvisioning(env, { pool, adapter, root = fileURLToPath(new URL('../../../../', import.meta.url)), config } = {}) {
  config ??= env.OPERATIONS_PROVISIONER_FILE ? await readJson(env.OPERATIONS_PROVISIONER_FILE) : null
  const enabled = !!config?.enabled
  const jobsDir = resolve(root, '.local/video-provisioning')
  const jobPath = id => resolve(jobsDir, uuid.parse(id) + '.json')
  let running, timer, stopped = false
  const controller = new AbortController()
  const write = async (id, job) => privateJson(jobPath(id), { ...job, updatedAt: new Date().toISOString() })
  const status = async id => {
    const job = await readJson(jobPath(id))
    if (enabled && job?.state === 'ready' && adapter?.health) {
      try { await adapter.health(id) }
      catch { return publicProvisioning({ ...job, state: 'failed', stage: 'failed', error: '视频服务连接中断，请重试恢复；已保存的资料会保留。' }, enabled) }
    }
    return publicProvisioning(job, enabled)
  }
  if (enabled) {
    if (!env.OPERATIONS_RUNTIMES_FILE) throw Error('Video provisioning requires a private runtime registry')
    await mkdir(jobsDir, { recursive: true, mode: 0o700 }); await chmod(jobsDir, 0o700)
    adapter ??= createNativeProvisioner({ root, env, config })
  }
  async function enqueue(id, { retry = false } = {}) {
    uuid.parse(id)
    if (!enabled) return publicProvisioning(null, false)
    const registry = await readJson(env.OPERATIONS_RUNTIMES_FILE, {})
    if (registry[id] && !registry[id].managedProvisioning) return { state: 'ready', stage: 'ready', message: stages.ready, canRetry: false }
    // Exclusive create avoids duplicate work when two requests arrive together.
    try {
      await writeFile(jobPath(id), JSON.stringify({ tenantId: id, state: 'queued', stage: 'queued', updatedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const old = await readJson(jobPath(id))
      const disconnected = retry && old.state === 'ready' && adapter?.health && await adapter.health(id).then(() => false, () => true)
      if (retry && (old.state === 'failed' || disconnected)) {
        // Claim the retry atomically with the same lock used by the worker.
        const claimed = await hostLock(resolve(jobsDir, 'allocator.lock'), async () => {
          const fresh = await readJson(jobPath(id))
          if (fresh.state === 'failed' || (disconnected && fresh.state === 'ready')) await write(id, { ...fresh, state: 'queued', stage: 'queued', error: null })
        })
        if (!claimed) throw fail(409, '另一个视频环境正在开通，请稍后重试')
      }
    }
    return status(id)
  }
  async function processJobs({ recover = false } = {}) {
    if (!enabled || stopped) return
    await hostLock(resolve(jobsDir, 'allocator.lock'), async () => {
      for (const file of (await readdir(jobsDir)).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).sort()) {
        if (stopped) break
        const id = uuid.parse(file.slice(0, -5)), job = await readJson(jobPath(id))
        if (!['queued', 'provisioning'].includes(job.state) && !(recover && job.state === 'ready')) continue
        if (!(await pool.query('SELECT id FROM tenants WHERE id=$1', [id])).rows.length) {
          await write(id, { ...job, state: 'failed', stage: 'failed', error: '工作空间不存在，已停止开通' }); continue
        }
        const progress = async stage => write(id, { ...job, state: 'provisioning', stage, error: null })
        try {
          await progress('allocating')
          await adapter.ensure(id, { progress, signal: controller.signal })
          await write(id, { ...job, state: 'ready', stage: 'ready', error: null })
        } catch (e) {
          if (stopped) break // Keep the checkpoint; resume after the next startup.
          await write(id, { ...job, state: 'failed', stage: 'failed', error: e.provisionMessage || '开通未完成，请点击重试。管理员可检查本机视频服务日志。' })
        }
      }
    })
  }
  function tick(options) {
    if (!running) running = processJobs(options).catch(() => {}).finally(() => { running = null })
    return running
  }
  return { enabled, status, enqueue, runOnce: processJobs,
    start() { if (enabled) { void tick({ recover: true }); timer = setInterval(() => void tick(), 3000); timer.unref() } },
    async close() { stopped = true; clearInterval(timer); controller.abort(); await running },
  }
}
