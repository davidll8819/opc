// A stuck dependency must not create a new probe on every load-balancer request.
// Retain its one in-flight probe until the underlying operation actually settles.
export function createReadiness({ pool, cache, timeoutMs = 2500, cacheMs = 1000 }) {
  const pending = new Map()
  let snapshot,
    expires = 0,
    refresh
  const probe = (name, work) => {
    if (pending.has(name)) return pending.get(name)
    let timer
    const operation = Promise.resolve()
      .then(work)
      .then(
        () => true,
        () => false,
      )
    const bounded = Promise.race([
      operation,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ]).finally(() => clearTimeout(timer))
    pending.set(name, bounded)
    operation.then(() => {
      if (pending.get(name) === bounded) pending.delete(name)
    })
    return bounded
  }
  return async () => {
    if (snapshot && Date.now() < expires) return snapshot
    if (!refresh)
      refresh = Promise.all([
        probe('postgres', () => pool.query('SELECT 1')),
        probe('redis', () => cache.ping()),
      ])
        .then(([postgres, redis]) => {
          snapshot = { ok: postgres && redis, postgres, redis }
          expires = Date.now() + cacheMs
          return snapshot
        })
        .finally(() => {
          refresh = null
        })
    return refresh
  }
}

export function registerHealth(app, dependencies) {
  const ready = createReadiness(dependencies)
  app.get('/health/live', () => ({ ok: true }))
  app.get('/health/ready', async (_req, reply) => {
    const result = await ready()
    if (!result.ok) return reply.code(503).send({ ok: false, error: '基础服务暂时不可用' })
    return { ok: true }
  })
}
