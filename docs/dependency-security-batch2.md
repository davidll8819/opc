# 第二批：内部凭据轮换与依赖漏洞修复

验收日期：2026-10-21。结论：内部旧凭据已撤销；当前主应用及视频后端依赖扫描无告警；服务已经重启并通过下列实际检查。远程访问只提供方案，功能完善另排批次。

依赖库是程序使用的现成零件；漏洞扫描查的是已公布的问题，扫描为零不等于整个程序没有安全问题，也不代表所有功能测试都通过。

## 修改范围与位置

1. `scripts/rotate-operations-secrets.mjs`：无视频任务执行时，先把旧注册表留在项目外的私有目录，再随机生成新的 `bridgeSecret`、`jwtSecret`，原子替换并重启主应用及视频应用。只改这两个注册表字段；供应商Key、模型型号、员工技能、业务数据不变。旧网关/桥接签名返回403，旧JWT认证失败，新认证成功。JWT是服务用来验证访问身份的签名令牌。
2. `integrations/aitoearn/source/project/aitoearn-backend/package.json` 的 `pnpm.overrides` 及同目录 `pnpm-lock.yaml`：只针对扫描公告覆盖受影响版本，再用固定的pnpm 10.33.0安装；没有执行整树更新或强制自动修复。包括XML、protobuf、HTTP请求、文件上传、图像、网络框架、测试工具的受影响依赖。具体版本以该清单和锁文件为准。
3. `libs/common/package.json`、`libs/common/src/i18n/messages.ts`、新增 `message-template.ts`：旧消息模板库间接引入没有修复版本的 `html-minifier`；当前42条消息仅需替换占位文字，因此移除该库，改为小型替换函数，保留原有HTML字符转义。旧/新结果126组对照通过；新增2个测试通过。没有调整消息文案或业务规则。
4. `apps/aitoearn-ai/src/core/ai/libs/volcengine/services/upload.service.ts:193`：新版Axios将响应头类型定义得更宽，解析文件大小前先转为字符串；解决编译错误，不改变正常响应处理结果。
5. `scripts/verify-operations-dependencies.mjs`：用合成数据验证真实安装的图像处理、XML、protobuf、HTTP请求及测试配置解析依赖，不调用外部视频生成、不创建业务任务。

第2—4项中的短路径均相对于AiToEarn后端目录。未启用的上游独立前端 `integrations/aitoearn/source/project/aitoearn-web` 没有安装/升级，初次体检中的告警不能视为本次已处理；若以后要部署它，需要单独修复和验收。办公室动画、员工技能绑定、主应用依赖树均未修改。

## 扫描和构建结果

主项目目录：`/Users/david/Documents/ChatGPT/WishTaday/ops`。
视频后端目录：`integrations/aitoearn/source/project/aitoearn-backend`。

主项目命令前使用 `PATH="$PWD/.local/bin:$PATH"`；后端命令使用项目内Node以及 `.local/tools/pnpm/node_modules/pnpm/bin/pnpm.cjs`，版本为10.33.0。不要使用本机另一个pnpm 11来重装当前项目，以免版本覆盖规则失效。

| 检查 | 实际命令（简写） | 输出摘要 |
|---|---|---|
| 主应用依赖 | `npm audit --json` | total 0 |
| 视频生产依赖 | `pnpm audit --prod --json` | critical 0 / high 0 / moderate 0 / low 0 |
| 视频含开发工具依赖 | `pnpm audit --json` | critical 0 / high 0 / moderate 0 / low 0 |
| 服务构建 | `nx run-many -t build -p aitoearn-ai aitoearn-server --parallel=2`；兼容修改后 `nx build aitoearn-ai` | server成功；AI最终成功，含11个依赖构建任务 |
| 编译产物依赖 | `node scripts/link-operations-build.mjs` | Compiled workspace dependencies linked for 17 packages |
| 真实依赖功能 | `node scripts/verify-operations-dependencies.mjs` | 图像编码/缩放/解码、protobuf和UUID、XML转义往返、新旧HTTP客户端、YAML配置加载：全部PASS |

相同pnpm 10扫描口径下，视频生产依赖由严重4、高危81、中危112、低危8，共205条记录降为0。同一公告可能出现在多条依赖路径中，205不是205种独立漏洞。首次体检的完整视频依赖扫描为316条记录，当前完整扫描为0；完整扫描基线来自首次体检，生产前后对照来自本批现场扫描。

主要公告来源：[XML解析器](https://github.com/advisories/GHSA-m7jm-9gc2-mpf2)、[protobuf](https://github.com/advisories/GHSA-xq3m-2v4x-88gg)、[旧模板压缩依赖](https://github.com/advisories/GHSA-pfq8-rq6v-vf5m)。最终扫描摘要保存在 [audit-summary.json](security-evidence-2026-10-21/audit-summary.json)。没有执行漏洞利用测试。

受限环境中Nx使用以下参数运行，避免后台进程影响验证：

```sh
NX_DAEMON=false NX_TUI=false NX_NO_CLOUD=true NX_ISOLATE_PLUGINS=false \
NX_WORKSPACE_DATA_DIRECTORY=/private/tmp/wishtaday-fix-batch2/nx-build-finish \
CI=1 ./node_modules/.bin/nx build aitoearn-ai
```

## 重启后的真实验收

执行 `node scripts/verify-router-security.mjs`：

```text
absent: HTTP 401, credential-free=true, PASS
incorrect: HTTP 401, credential-free=true, PASS
legacy-default: HTTP 401, credential-free=true, PASS
current: HTTP 403, credential-free=true, PASS
model invocation: HTTP 200, text-received=true, PASS
```

只读验收程序 `/private/tmp/wishtaday-fix-batch2/verify-final.mjs` 实际验证：

- 主应用 `/health/ready` 返回200；视频AI/server桥接就绪。
- 新JWT读取 `/agent/tasks?pageNo=1&pageSize=1` 和 `/user/mine` 成功。
- 旧JWT在两个服务均认证失败；旧桥接签名及旧模型网关凭据均被拒绝。上游部分认证错误用HTTP200包装，程序同时检查业务错误码。
- 从现有媒体读取128字节，HTTP206，内容与RustFS存储一致。RustFS是当前保存视频素材的文件服务。
- 扫描28个日志文件，凭据格式/已知凭据匹配0、日志及相关配置权限不符0。
- 注册表除授权轮换的两项外一致。没有创建、删除或编辑业务任务和素材；真实模型检查只产生正常用量记录。

永久保留的无凭据输出：[runtime-final.log](security-evidence-2026-10-21/runtime-final.log)、[model-final.log](security-evidence-2026-10-21/model-final.log)、[rotation.log](security-evidence-2026-10-21/rotation.log)、[dependency-smoke.log](security-evidence-2026-10-21/dependency-smoke.log)。临时验收脚本可能随系统清理而消失，本文件已保留检查路径、方法和结果。

**验证边界：**没有新生成或重新剪辑一条完整视频，没有测试外部平台真实发布，没有新增浏览器端到端验收；已有视频能读取不能替代新视频全流程验收。本轮服务可用，不据此宣称所有制作功能已完备。

## 自动化测试与保留问题

| 命令 | 结果 |
|---|---|
| 主项目 `npm test` | 后端369通过、5跳过；前端51通过、44跳过；合计420通过、0失败、49跳过，退出码0 |
| `vitest run --root libs/common src/i18n/message-template.spec.ts` | 2通过、0失败 |
| `nx run-many -t test -p aitoearn-ai aitoearn-server --parallel=2 --args=run` | AI188通过、3断言失败，另有2空测试文件；server719通过、1断言失败，退出非零 |

未修的测试问题继续记入AUDIT_REPORT的Y03：

- `apps/aitoearn-ai/src/core/agent/mcp/util.mcp.spec.ts:154`，以及 `mcp/volcengine/aideo.mcp.spec.ts:330、336`：测试读取的工具/版本字段为空。与首次体检失败位置一致。
- `apps/aitoearn-ai/src/core/ai/chat/chat.service.spec.ts`、`core/draft-generation/draft-generation.service.spec.ts`：没有实际测试用例。
- `apps/aitoearn-server/src/core/channels/channels-error-contract.spec.ts:41`：发现 `core/channels/relay/relay-client.service.ts:62` 使用普通Error，未遵守统一业务错误约定。源码与本批开始前一致；这个静态规则失败不等于已经实测平台发布失败。

没有删除/跳过失败用例来制造通过结果。下一功能批次先核实这些问题，以免视频编辑功能建立在验证不足的流程之上。

## 备份、手动事项与下一步

已执行 `node scripts/backup-system.mjs` 生成轮换后的新备份，结果complete：36张PostgreSQL表、18个Mongo集合、7个媒体对象、50个私有文件，文件校验全部一致。

- 数据：`/Users/david/Wishtaday-Backups/2026-10-21T06-41-04-900Z-ae761489`
- 密钥及私有配置：`/Users/david/Wishtaday-Backup-Keys/2026-10-21T06-41-04-900Z-ae761489`

备份目录0700、文件0600；密钥与数据库分开存放。当前备份做了完整文件校验，没有重复恢复到临时数据库；实际隔离恢复演练已在第一批完成，详见 [备份与恢复](backup-and-restore.md)。不要直接恢复旧备份中的已撤销凭据。

目前无需你手动更换这两个内部密钥，也没有要求你换4YI供应商Key。远程方案见 [远程访问方案](remote-access-plan.md)，本轮未启用。

按你的意图，后续优先修功能，建议分三小批：

1. **视频可靠性与交付**：处理Y03测试缺口；检查新视频从任务开始到成品下载的完整过程；把“生成成功”和“符合你的交付要求”分开。
2. **视频剪辑最小可用版**：已有素材裁剪/拼接、中文字幕、背景音乐与音量、导出下载；每次任务给清晰进度、失败原因和重试入口。
3. **日常体验**：成果页先显示成品与结论，执行日志可折叠；补文件清理/引用保护，保存员工自检结果。

这些是待确认的工作顺序，本轮未修改功能界面、办公室动画或员工技能绑定。
