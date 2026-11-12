import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import Fastify from 'fastify'
import { createReadiness, registerHealth } from '../apps/api/src/health.mjs'
import {
  productionChecks,
  assertProductionEnvironment,
  assertRestrictedDatabaseRole,
} from '../apps/api/src/startup-checks.mjs'

test('production rejects incomplete configuration before connecting or listening, without values in errors', async () => {
  const result = spawnSync(process.execPath, ['apps/api/src/server.mjs'], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      APP_ORIGIN: 'http://user:synthetic-private@localhost:3000',
      AUTH_MODE: 'local',
    },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Production configuration rejected/)
  assert.doesNotMatch(result.stderr, /synthetic-private|ECONNREFUSED|Server listening/)
  await assertProductionEnvironment({ NODE_ENV: 'development', AUTH_MODE: 'local' })
})

test('production checks enforce login, encrypted connections and media with value-free diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'office-startup-'))
  try {
    const cert = join(dir, 'cert.pem'),
      runtimes = join(dir, 'runtimes.json')
    // Parse a real CA bundle; no live TLS handshake is claimed by this test.
    await writeFile(cert, await readFile('certs/rds-global-bundle.pem'))
    const env = {
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://office.example.test',
      AUTH_MODE: 'cognito',
      COGNITO_ISSUER: 'https://cognito-idp.ap-east-1.amazonaws.com/ap-east-1_fixture',
      COGNITO_DOMAIN: 'https://login.example.test',
      COGNITO_CLIENT_ID: 'fixture123',
      ORIGIN_VERIFY_SECRET: 'synthetic-private-value-'.repeat(2),
      REDIS_URL: 'rediss://:synthetic-private@cache.example.test:6379',
      PGSSLROOTCERT: cert,
      OPERATIONS_CONFIG_KEY: Buffer.alloc(32, 9).toString('base64'),
    }
    assert.equal(
      (await productionChecks(env)).every((c) => c.ok),
      true,
    )
    await assertProductionEnvironment(env)
    for (const [name, value, code] of [
      ['AUTH_MODE', 'local', 'formal_auth'],
      ['APP_ORIGIN', 'http://office.example.test', 'https_origin'],
      ['APP_ORIGIN', 'https://office.example.test/path', 'https_origin'],
      ['APP_ORIGIN', 'https://office.example.test/', 'https_origin'],
      ['APP_ORIGIN', 'https://u:synthetic-private@office.example.test', 'https_origin'],
      ['COGNITO_ISSUER', 'https://untrusted.test/pool', 'identity_issuer'],
      ['COGNITO_DOMAIN', '', 'identity_domain'],
      ['COGNITO_CLIENT_ID', '', 'identity_client'],
      ['ORIGIN_VERIFY_SECRET', '', 'origin_protection'],
      ['REDIS_URL', 'redis://cache.test', 'redis_tls'],
      ['PGSSLROOTCERT', '/nonexistent-fixture', 'postgres_tls'],
      [
        'DATABASE_URL',
        'postgresql://user:synthetic-private@db.test/office?sslmode=disable',
        'postgres_tls_override',
      ],
      [
        'DATABASE_URL',
        'postgresql://user:synthetic-private@db.test/office?ssl=no-verify',
        'postgres_tls_override',
      ],
      ['OPERATIONS_CONFIG_KEY', '', 'config_encryption'],
    ]) {
      const bad = { ...env, [name]: value }
      const checks = await productionChecks(bad)
      assert.equal(checks.find((c) => c.id === code).ok, false, code)
      assert.doesNotMatch(JSON.stringify(checks), /synthetic-private/)
      await assert.rejects(assertProductionEnvironment(bad), new RegExp(code))
    }
    await writeFile(
      runtimes,
      JSON.stringify({
        tenant: { infrastructure: { assets: { cdnEndpoint: 'http://127.0.0.1:9000/bucket' } } },
      }),
    )
    await assert.rejects(
      assertProductionEnvironment({ ...env, OPERATIONS_RUNTIMES_FILE: runtimes }),
      /media_https/,
    )
    await writeFile(runtimes, '{malformed')
    await assert.rejects(
      assertProductionEnvironment({ ...env, OPERATIONS_RUNTIMES_FILE: runtimes }),
      /media_https/,
    )
    const keyFile = join(dir, 'config.key')
    await writeFile(keyFile, env.OPERATIONS_CONFIG_KEY, { mode: 0o600 })
    await assertProductionEnvironment({
      ...env,
      OPERATIONS_CONFIG_KEY: '',
      OPERATIONS_CONFIG_KEY_FILE: keyFile,
    })
    await writeFile(cert, '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----')
    await assert.rejects(assertProductionEnvironment(env), /postgres_tls/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('production process refuses a superuser or database permission bypass role', async () => {
  for (const role of [
    { rolsuper: true, rolbypassrls: false },
    { rolsuper: false, rolbypassrls: true },
    undefined,
  ])
    await assert.rejects(
      assertRestrictedDatabaseRole({ query: async () => ({ rows: role ? [role] : [] }) }),
      /must not bypass/,
    )
  await assertRestrictedDatabaseRole({
    query: async () => ({ rows: [{ rolsuper: false, rolbypassrls: false }] }),
  })
})

test('concurrent health checks share one probe; timeout cannot accumulate background probes; recovery works', async () => {
  let release,
    calls = 0
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const read = createReadiness({
    pool: {
      query: () => {
        calls++
        return calls === 1 ? pending : Promise.resolve()
      },
    },
    cache: { ping: async () => 'PONG' },
    timeoutMs: 40,
    cacheMs: 0,
  })
  const start = performance.now()
  const results = await Promise.all(Array.from({ length: 20 }, () => read()))
  assert.equal(
    results.every((r) => !r.ok && !r.postgres && r.redis),
    true,
  )
  assert.ok(performance.now() - start < 1000)
  for (let i = 0; i < 20; i++) assert.equal((await read()).ok, false)
  assert.equal(calls, 1)
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await read(), { ok: true, postgres: true, redis: true })
  assert.equal(calls, 2)
})

test('readiness reports HTTP 503 for a failed cache, live remains 200, secrets never leave probe errors', async () => {
  const app = Fastify()
  let offline = true,
    probes = 0
  registerHealth(app, {
    pool: { query: async () => {} },
    cache: {
      ping: async () => {
        probes++
        if (offline) throw Error('Authorization: Bearer synthetic-private')
      },
    },
    cacheMs: 0,
    timeoutMs: 40,
  })
  try {
    assert.equal((await app.inject('/health/live')).statusCode, 200)
    const bad = await app.inject('/health/ready')
    assert.equal(bad.statusCode, 503)
    assert.deepEqual(bad.json(), { ok: false, error: '基础服务暂时不可用' })
    assert.doesNotMatch(bad.body, /Authorization|Bearer|synthetic-private/)
    offline = false
    assert.deepEqual((await app.inject('/health/ready')).json(), { ok: true })
    assert.equal(probes, 2)
  } finally {
    await app.close()
  }
})
