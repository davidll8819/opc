import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { transaction, fail } from './db.mjs'
import { budgetDay } from './operations/budget.mjs'

// All amounts are integer millionths of USD; rate units are per million tokens.
export function amount(input, output, inputRate, outputRate) {
  const numerator = BigInt(input) * BigInt(inputRate) + BigInt(output) * BigInt(outputRate)
  return ((numerator + 999999n) / 1000000n).toString()
}
const validUsage = (u) => u && [u.input, u.output].every((n) => Number.isSafeInteger(n) && n >= 0)
export function safeReceipt(value) {
  return typeof value === 'string' &&
    /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) &&
    !/^(sk-|eyJ)|bearer|api.?key|authorization/i.test(value)
    ? value
    : null
}
const history = `(SELECT id,tenant_id,user_id,task_id,step,department,model,kind,day,price_id,reserved_microusd,cost_microusd,sale_microusd,input_tokens,output_tokens,state,provider_request_id,created_at,finished_at,false AS legacy FROM billing_calls
  UNION ALL SELECT m.id,m.tenant_id,m.user_id,NULL::text,m.department,m.department,m.model,'text',m.day,NULL::uuid,0::bigint,NULL::bigint,NULL::bigint,m.input_tokens,m.output_tokens,m.state,NULL::text,m.created_at,m.finished_at,true FROM model_requests m
  WHERE NOT EXISTS(SELECT 1 FROM billing_calls b WHERE b.id=m.id AND b.tenant_id=m.tenant_id))`
async function lock(db, tenantId) {
  // Serializes reservation and budget changes, including the first request of a day.
  await db.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId])
}
export async function moneyUsage(db, tenantId, day = budgetDay(), taskId) {
  return (
    await db.query(
      `SELECT coalesce(sum(coalesce(r.upstream_microusd,h.cost_microusd)),0)::text used,
    coalesce(sum(CASE WHEN h.state IN ('pending','unknown') AND r.id IS NULL THEN h.reserved_microusd ELSE 0 END),0)::text reserved,
    count(*) FILTER(WHERE h.cost_microusd IS NULL AND r.id IS NULL AND (h.price_id IS NULL OR h.state='unknown'))::int unpriced
    FROM ${history} h LEFT JOIN billing_reviews r ON r.tenant_id=h.tenant_id AND r.call_id=h.id WHERE h.tenant_id=$1 AND ${taskId ? 'task_id' : 'day'}=$2`,
      [tenantId, taskId || day],
    )
  ).rows[0]
}
export async function blockUnmetered(db, tenantId) {
  if (
    (await db.query('SELECT enabled FROM billing_limits WHERE tenant_id=$1', [tenantId])).rows[0]
      ?.enabled
  )
    throw fail(409, '已开启金额预算，此通道尚不能可靠核价，已停止调用；请先核对计费支持范围')
}
export async function beginBilling(
  pool,
  ctx,
  { model, department, kind = 'text', input = 0, output = 0, uncertain = false, step },
) {
  return transaction(
    pool,
    async (db) => {
      await lock(db, ctx.tenantId)
      const day = budgetDay(),
        id = randomUUID()
      const limit = (
        await db.query('SELECT * FROM billing_limits WHERE tenant_id=$1', [ctx.tenantId])
      ).rows[0]
      const taskLimit = ctx.taskId
        ? (
            await db.query('SELECT * FROM billing_task_limits WHERE tenant_id=$1 AND task_id=$2', [
              ctx.tenantId,
              ctx.taskId,
            ])
          ).rows[0]
        : null
      const price =
        kind === 'text' && !uncertain
          ? (
              await db.query(
                'SELECT * FROM billing_prices WHERE tenant_id=$1 AND model=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
                [ctx.tenantId, model],
              )
            ).rows[0]
          : null
      const reserved = price
        ? amount(input, output, price.input_microusd, price.output_microusd)
        : '0'
      if (limit?.enabled || taskLimit?.enabled) {
        if (!price)
          throw fail(
            409,
            '已开启金额预算，但本次调用缺少可靠价格（媒体、搜索或附加工具费尚待核验），已停止调用',
          )
      }
      if (limit?.enabled) {
        const totals = await moneyUsage(db, ctx.tenantId, day)
        // Historical unknown calls must be reconciled before claiming an available balance.
        const legacy = (
          await db.query(
            "SELECT count(*)::int n FROM model_requests WHERE tenant_id=$1 AND state IN ('pending','unknown') AND NOT EXISTS(SELECT 1 FROM billing_calls b WHERE b.tenant_id=$1 AND b.id=model_requests.id) AND NOT EXISTS(SELECT 1 FROM billing_reviews r WHERE r.tenant_id=$1 AND r.call_id=model_requests.id)",
            [ctx.tenantId],
          )
        ).rows[0]
        if (totals.unpriced || legacy.n)
          throw fail(409, '存在待核价或待核对调用，金额余额尚不可靠，请先核对账单')
        if (
          BigInt(totals.used) + BigInt(totals.reserved) + BigInt(reserved) >
          BigInt(limit.daily_microusd)
        )
          throw fail(429, '今日金额预算不足，本次调用未发出')
      }
      if (taskLimit?.enabled) {
        const totals = await moneyUsage(db, ctx.tenantId, day, ctx.taskId)
        if (totals.unpriced) throw fail(409, '本任务存在待核价调用，已停止继续调用')
        if (
          BigInt(totals.used) + BigInt(totals.reserved) + BigInt(reserved) >
          BigInt(taskLimit.amount_microusd)
        )
          throw fail(429, '本任务金额预算不足，本次调用未发出')
      }
      await db.query(
        `INSERT INTO billing_calls(id,tenant_id,user_id,task_id,step,department,model,kind,day,price_id,reserved_microusd)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          ctx.tenantId,
          ctx.userId || null,
          ctx.taskId || null,
          step || ctx.billingStep || department,
          department,
          model,
          kind,
          day,
          price?.id || null,
          reserved,
        ],
      )
      return id
    },
    ctx,
  )
}
export async function finishBilling(pool, ctx, id, state, usage, receipt) {
  if (!id) return
  return transaction(
    pool,
    async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM billing_calls WHERE id=$1 AND tenant_id=$2 AND state='pending' FOR UPDATE",
          [id, ctx.tenantId],
        )
      ).rows[0]
      if (!row) return
      const measured = validUsage(usage)
      if (state === 'completed' && row.kind === 'text' && !measured) state = 'unknown'
      const price = row.price_id
        ? (
            await db.query('SELECT * FROM billing_prices WHERE id=$1 AND tenant_id=$2', [
              row.price_id,
              ctx.tenantId,
            ])
          ).rows[0]
        : null
      const cost =
        state === 'rejected'
          ? '0'
          : state === 'completed' && measured && price
            ? amount(usage.input, usage.output, price.input_microusd, price.output_microusd)
            : null
      const sale =
        state === 'rejected'
          ? '0'
          : state === 'completed' && measured && price
            ? amount(
                usage.input,
                usage.output,
                price.sale_input_microusd,
                price.sale_output_microusd,
              )
            : null
      await db.query(
        `UPDATE billing_calls SET state=$3,input_tokens=$4,output_tokens=$5,cost_microusd=$6,sale_microusd=$7,provider_request_id=$8,finished_at=now() WHERE tenant_id=$1 AND id=$2`,
        [
          ctx.tenantId,
          id,
          state,
          measured ? usage.input : null,
          measured ? usage.output : null,
          cost,
          sale,
          safeReceipt(receipt),
        ],
      )
    },
    ctx,
  )
}

const micros = z
  .string()
  .regex(/^\d{1,13}$/)
  .refine((v) => BigInt(v) <= 1000000000000n, '金额超出范围')
const reference = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9\u4e00-\u9fff _./:-]+$/)
  .refine(
    (v) => !/(?:sk-|Bearer|eyJ|api.?key|authorization)/i.test(v),
    '请填写凭证编号，不要填写密钥',
  )
const admin = ['owner', 'admin']
const taskIdentifier = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/)
async function audit(db, ctx, action, id) {
  await db.query(
    'INSERT INTO audit_events(id,tenant_id,user_id,action,target_id) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), ctx.tenantId, ctx.userId, action, id],
  )
}
const selected = `id,user_id,task_id,step,department,model,kind,day,price_id,reserved_microusd::text,cost_microusd::text,sale_microusd::text,input_tokens::text,output_tokens::text,state,provider_request_id,created_at,finished_at,legacy`
export function registerBilling(app, { scoped, env }) {
  const base = '/api/tenants/:tenantId/billing'
  app.get(base, (req) =>
    scoped(req, async (db, t, ctx) => {
      const member = t.role === 'member',
        values = [ctx.tenantId],
        filter = member ? ' AND user_id=$2' : ''
      if (member) values.push(ctx.userId)
      const summary = (
        await db.query(
          `SELECT count(*)::int calls,count(*) FILTER(WHERE ${member ? 'sale_microusd' : 'coalesce(reviewed,cost_microusd)'} IS NULL)::int unpriced,
      coalesce(sum(coalesce(reviewed,cost_microusd)),0)::text known_cost,coalesce(sum(sale_microusd),0)::text known_sale
      FROM (SELECT h.*,(SELECT upstream_microusd FROM billing_reviews r WHERE r.tenant_id=h.tenant_id AND r.call_id=h.id) reviewed FROM ${history} h) s WHERE tenant_id=$1${filter}`,
          values,
        )
      ).rows[0]
      const legacy = (
        await db.query(
          `SELECT count(*)::int calls,count(*) FILTER(WHERE state IN ('pending','unknown'))::int unknown
      FROM model_requests WHERE tenant_id=$1${filter} AND NOT EXISTS(SELECT 1 FROM billing_calls b WHERE b.tenant_id=$1 AND b.id=model_requests.id)`,
          values,
        )
      ).rows[0]
      const limits = member
        ? null
        : (
            await db.query(
              'SELECT enabled,daily_microusd::text FROM billing_limits WHERE tenant_id=$1',
              [ctx.tenantId],
            )
          ).rows[0] || { enabled: false, daily_microusd: '0' }
      if (member) summary.known_cost = null
      return {
        role: t.role,
        day: budgetDay(),
        timezone: 'Asia/Shanghai',
        currency: 'USD',
        summary,
        legacy,
        limits,
        today: member ? null : await moneyUsage(db, ctx.tenantId),
        prices: member
          ? []
          : (
              await db.query(
                'SELECT DISTINCT ON(model) id,model,input_microusd::text,output_microusd::text,sale_input_microusd::text,sale_output_microusd::text,reference,created_at FROM billing_prices WHERE tenant_id=$1 ORDER BY model,created_at DESC,id DESC',
                [ctx.tenantId],
              )
            ).rows,
        paymentsEnabled: false,
        testOrdersEnabled: env.NODE_ENV === 'test',
        coverage:
          '4yi 网关新调用；旧调用未补算。媒体与搜索待核价，运行服务调用可能尚未关联个人任务。报价估算不等于上游扣款。',
      }
    }),
  )
  app.get(`${base}/calls`, (req) =>
    scoped(req, async (db, t, ctx) => {
      const q = z
        .object({
          offset: z.coerce.number().int().min(0).max(100000).default(0),
          task: taskIdentifier.optional(),
          attention: z.enum(['true']).optional(),
        })
        .strict()
        .parse(req.query)
      const values = [ctx.tenantId],
        filters = []
      if (t.role === 'member') {
        values.push(ctx.userId)
        filters.push(`user_id=$${values.length}`)
      }
      if (q.task) {
        values.push(q.task)
        filters.push(`task_id=$${values.length}`)
      }
      if (q.attention)
        filters.push(
          "(state IN ('unknown','pending') OR cost_microusd IS NULL) AND NOT EXISTS(SELECT 1 FROM billing_reviews r WHERE r.tenant_id=h.tenant_id AND r.call_id=h.id)",
        )
      const where = `tenant_id=$1${filters.length ? ' AND ' + filters.join(' AND ') : ''}`
      values.push(q.offset)
      const rows = (
        await db.query(
          `SELECT ${selected},(SELECT json_build_object('input',p.input_microusd::text,'output',p.output_microusd::text,'saleInput',p.sale_input_microusd::text,'saleOutput',p.sale_output_microusd::text) FROM billing_prices p WHERE p.id=h.price_id AND p.tenant_id=h.tenant_id) AS rate_snapshot,(SELECT upstream_microusd::text FROM billing_reviews r WHERE r.tenant_id=h.tenant_id AND r.call_id=h.id) AS reviewed_cost,(SELECT reference FROM billing_reviews r WHERE r.tenant_id=h.tenant_id AND r.call_id=h.id) AS review_reference FROM ${history} h WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET $${values.length}`,
          values,
        )
      ).rows
      if (t.role === 'member')
        for (const row of rows) {
          row.cost_microusd = null
          if (row.rate_snapshot) {
            delete row.rate_snapshot.input
            delete row.rate_snapshot.output
          }
          row.reviewed_cost = null
          row.review_reference = null
          row.price_id = null
          row.reserved_microusd = null
        }
      return { calls: rows.slice(0, 50), hasMore: rows.length > 50, offset: q.offset }
    }),
  )
  app.post(`${base}/prices`, (req) =>
    scoped(
      req,
      async (db, _t, ctx) => {
        const p = z
          .object({
            model: z
              .string()
              .min(1)
              .max(160)
              .regex(/^[a-zA-Z0-9._:/-]+$/),
            input: micros,
            output: micros,
            saleInput: micros,
            saleOutput: micros,
            reference,
          })
          .strict()
          .parse(req.body)
        await lock(db, ctx.tenantId)
        const id = randomUUID()
        await db.query(
          'INSERT INTO billing_prices(id,tenant_id,model,input_microusd,output_microusd,sale_input_microusd,sale_output_microusd,reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            id,
            ctx.tenantId,
            p.model,
            p.input,
            p.output,
            p.saleInput,
            p.saleOutput,
            p.reference,
            ctx.userId,
          ],
        )
        await audit(db, ctx, 'billing.price.created', id)
        return { id }
      },
      admin,
    ),
  )
  app.post(`${base}/limit`, (req) =>
    scoped(
      req,
      async (db, _t, ctx) => {
        const p = z.object({ enabled: z.boolean(), daily: micros }).strict().parse(req.body)
        await lock(db, ctx.tenantId)
        await db.query(
          'INSERT INTO billing_limits(tenant_id,enabled,daily_microusd) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET enabled=$2,daily_microusd=$3,updated_at=now()',
          [ctx.tenantId, p.enabled, p.daily],
        )
        await audit(db, ctx, 'billing.limit.updated', ctx.tenantId)
        return { ok: true }
      },
      admin,
    ),
  )
  app.get(`${base}/task-limits`, (req) =>
    scoped(
      req,
      async (db, _t, ctx) => ({
        limits: (
          await db.query(
            'SELECT task_id,enabled,amount_microusd::text FROM billing_task_limits WHERE tenant_id=$1 AND user_id=$2',
            [ctx.tenantId, ctx.userId],
          )
        ).rows,
      }),
      admin,
    ),
  )
  app.post(`${base}/task-limits`, (req) =>
    scoped(
      req,
      async (db, _t, ctx) => {
        const p = z
          .object({ taskId: taskIdentifier, enabled: z.boolean(), amount: micros })
          .strict()
          .parse(req.body)
        await lock(db, ctx.tenantId)
        const board = (
          await db.query(
            'SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2',
            [ctx.tenantId, ctx.userId],
          )
        ).rows[0]?.board
        const task = board?.tasks?.find((t) => t.id === p.taskId)
        if (!task) throw fail(404, '找不到你的任务，请先创建任务分工')
        if (task.dept === 'app-agent')
          throw fail(
            409,
            '视频运行服务暂不能逐次传回主任务编号，请使用企业日预算；不能为此任务承诺独立金额拦截',
          )
        await db.query(
          'INSERT INTO billing_task_limits(tenant_id,task_id,user_id,amount_microusd,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,task_id) DO UPDATE SET amount_microusd=$4,enabled=$5',
          [ctx.tenantId, p.taskId, ctx.userId, p.amount, p.enabled],
        )
        await audit(db, ctx, 'billing.task_limit.updated', p.taskId)
        return { ok: true }
      },
      admin,
    ),
  )
  app.get(`${base}/reviews`, (req) =>
    scoped(
      req,
      async (db, _t, ctx) => ({
        reviews: (
          await db.query(
            'SELECT call_id,upstream_microusd::text,reference,created_at FROM billing_reviews WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',
            [ctx.tenantId],
          )
        ).rows,
      }),
      admin,
    ),
  )
  app.post(`${base}/reviews`, (req) =>
    scoped(
      req,
      async (db, _t, ctx) => {
        const p = z
          .object({ callId: z.uuid(), upstream: micros, reference })
          .strict()
          .parse(req.body)
        await lock(db, ctx.tenantId)
        const row = (
          await db.query(`SELECT id,state FROM ${history} h WHERE tenant_id=$1 AND id=$2`, [
            ctx.tenantId,
            p.callId,
          ])
        ).rows[0]
        if (!row) throw fail(404, '调用记录不存在')
        if (row.state === 'pending') throw fail(409, '调用仍在处理中，暂不能核对最终账单')
        const old = (
          await db.query(
            'SELECT upstream_microusd::text,reference FROM billing_reviews WHERE tenant_id=$1 AND call_id=$2',
            [ctx.tenantId, p.callId],
          )
        ).rows[0]
        if (old) {
          if (BigInt(old.upstream_microusd) !== BigInt(p.upstream) || old.reference !== p.reference)
            throw fail(409, '已存在核对记录，请保留原始证据')
          return { ok: true }
        }
        await db.query(
          'INSERT INTO billing_reviews(id,tenant_id,call_id,user_id,upstream_microusd,reference) VALUES($1,$2,$3,$4,$5,$6)',
          [randomUUID(), ctx.tenantId, p.callId, ctx.userId, p.upstream, p.reference],
        )
        await audit(db, ctx, 'billing.review.recorded', p.callId)
        return { ok: true }
      },
      admin,
    ),
  )
  // Local test simulator only. No provider webhook, real wallet or subscription is modified.
  const testOnly = () => {
    if (env.NODE_ENV !== 'test') throw fail(404, '测试订单仅在隔离测试环境提供')
  }
  app.get(`${base}/test-orders`, (req) =>
    scoped(
      req,
      async (db, _t, ctx) => {
        testOnly()
        return {
          orders: (
            await db.query(
              'SELECT id,amount_microusd::text,state,created_at FROM billing_test_orders WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',
              [ctx.tenantId],
            )
          ).rows,
        }
      },
      admin,
    ),
  )
  app.post(`${base}/test-orders`, (req) =>
    scoped(
      req,
      async (db, _t, ctx) => {
        testOnly()
        const p = z
          .object({ requestId: z.uuid(), amount: micros.refine((v) => BigInt(v) > 0n) })
          .strict()
          .parse(req.body)
        await lock(db, ctx.tenantId)
        const old = (
          await db.query(
            'SELECT id,amount_microusd::text FROM billing_test_orders WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3',
            [ctx.tenantId, ctx.userId, p.requestId],
          )
        ).rows[0]
        if (old) {
          if (BigInt(old.amount_microusd) !== BigInt(p.amount))
            throw fail(409, '同一订单请求的金额不一致')
          return { id: old.id }
        }
        const id = randomUUID()
        await db.query(
          'INSERT INTO billing_test_orders(id,tenant_id,user_id,request_id,amount_microusd) VALUES($1,$2,$3,$4,$5)',
          [id, ctx.tenantId, ctx.userId, p.requestId, p.amount],
        )
        await audit(db, ctx, 'billing.test_order.created', id)
        return { id }
      },
      admin,
    ),
  )
  app.post(`${base}/test-orders/:id/events`, (req) =>
    scoped(
      req,
      async (db, _t, ctx) => {
        testOnly()
        const id = z.uuid().parse(req.params.id),
          p = z
            .object({ event: z.enum(['paid', 'refunded']), amount: micros })
            .strict()
            .parse(req.body)
        const order = (
          await db.query(
            'SELECT * FROM billing_test_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [ctx.tenantId, id],
          )
        ).rows[0]
        if (!order) throw fail(404, '订单不存在')
        if (BigInt(order.amount_microusd) !== BigInt(p.amount)) throw fail(409, '订单金额不一致')
        const existing = (
          await db.query(
            'SELECT id FROM billing_test_events WHERE order_id=$1 AND tenant_id=$2 AND event=$3',
            [id, ctx.tenantId, p.event],
          )
        ).rows[0]
        if (existing) return { state: order.state, replayed: true }
        if (
          (p.event === 'paid' && order.state !== 'pending') ||
          (p.event === 'refunded' && order.state !== 'paid')
        )
          throw fail(409, '订单状态不允许此操作')
        await db.query(
          'INSERT INTO billing_test_events(id,tenant_id,order_id,event) VALUES($1,$2,$3,$4)',
          [randomUUID(), ctx.tenantId, id, p.event],
        )
        await db.query('UPDATE billing_test_orders SET state=$3 WHERE tenant_id=$1 AND id=$2', [
          ctx.tenantId,
          id,
          p.event,
        ])
        await audit(db, ctx, `billing.test_order.${p.event}`, id)
        return { state: p.event, replayed: false }
      },
      admin,
    ),
  )
}
