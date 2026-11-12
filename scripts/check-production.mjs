import { productionChecks } from '../apps/api/src/startup-checks.mjs'
// Read only. The caller chooses an env file; no cloud calls, mutations or secret output.
const checks = await productionChecks(process.env)
const ok = checks.every((c) => c.ok)
console.log(
  JSON.stringify(
    {
      configurationPassed: ok,
      publicationApproved: false,
      note: '仅核对启动配置；通过不代表云端登录、媒体权限、备份恢复、许可或容量已验收。',
      checks,
    },
    null,
    2,
  ),
)
process.exitCode = ok ? 0 : 1
