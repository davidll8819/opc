# 4yi DEV 部署准备记录 · 2026-11-12

## 当前状态

用户已授权开始部署，参考 `4yi-ai/teardown`；应用免费，每位用户保存自己的 4yi API Key。用户提供的目标组织名为 `master`。实际已登录的管理后台是 `https://xclaw-dev.bieases.com/admin/marketplace/ai-import`；后台账号已登录，尚未执行组织安装，因此 **master 的实际安装归属尚未验证**。

后续在同一后台「租户管理」用页面搜索框搜索 `master`，结果为「0 总计／暂无租户」。因此不能把当前管理员所属组织或分析器自动生成的域名当作用户指定组织。已向用户询问准确组织名／ID，以及是否应使用另一个后台；未新建租户。

后续用户提供表单截图，确认 `master` 出现在 **Branch（代码分支）** 栏位；此前将其解释为组织名有误。Wishtaday 仓库当前使用 `main`，用户要求先同步最新代码，再重新部署。目标组织仍应在实际安装环节核对，不能继续把 `master` 当作组织名。

已经创建 `https://github.com/davidll8819/ops` 的 Dedicated DEV 导入记录，并执行 Run Analyze。分析提交为 `d76a58598747289717344a3c82a8faf851fd2465`，状态为 `needs_review`。这是 GitHub 的旧版，只用于核对平台扫描结果，**不是本机最新功能的部署**。

平台自动识别错误：把 `integrations/aitoearn/source/project/aitoearn-web` 选为公开主站，健康检查 `/health`；根项目被识别为内部 api。没有点击 Apply、Release、Certify 或 Publish。没有云端实例启动成功的证据，也没有公开发布。

实际 AI Analysis 显示扫描 2000 文件、0 个 blocker、24 个 warning、`review_required`。其中包括托管 PostgreSQL／Redis／MongoDB、队列、长连接、后台任务生命周期、代码执行所需 Docker 和数据库初始化审核。**“0 blocker”不代表可直接部署**，分析器同时提示文件证据不完整，而且分析的是旧提交。

## 已完成的本地准备

1. 新增根目录 `4yi-app.json`，明确主站 Dockerfile/context 为根目录，端口 3000，健康检查 `/health/ready`。声明路径和唯一公开服务已检查。资源为待平台复核的 2 CPU／4096 MiB，持久卷挂载 `/app/.local`。**这只是主站识别声明，完整服务组合和环境变量仍未完成，不能直接用于正式发布。**
2. 实现独立 `AUTH_MODE=4yi`，然后才在声明中加入 `FOURYI_ROUTER_IDENTITY_REQUIRED=1`。`apps/api/src/fouryi-identity.mjs` 校验平台 HMAC 签名、原始请求正文、方法、完整路径与查询、用户、组织、主机名、30 秒时效及共享 Redis 防重放。按「组织＋用户」映射内部账号；生产启动仍要求数据库／缓存 TLS、配置加密和 HTTPS。健康检查免平台签名；内部集成路径继续使用既有 bridge／JWT 验证。没有复制 `TEXT_MODEL` 或共享模型 Key，个人 Key 规则不变。本地登录配置未改。
3. `.dockerignore` 增加对 outputs、运行会话、日志、数据库导出、私有目录和验收证据目录的排除，保留产品角色图片和正常技能文件。当前环境未找到 Docker 可执行程序，因此镜像实际内容尚未通过构建检查。
4. 主应用 Zod 4.6.5 → 4.6.6 定向补丁，修复超大集合校验导致内存耗尽的高危告警。锁文件仅 `apps/api` 声明和 `node_modules/zod` 两个条目变化，未批量升级。

## 验证

以下第一组为定向依赖补丁后的结果；身份适配后的最新结果见下一组。

```sh
npm install zod@4.6.6 --workspace=@office/api --save-exact --ignore-scripts --no-audit --no-fund
# changed 1 package
npm test
# API: 481 total, 472 pass, 0 fail, 9 skipped
# Web: 136 total, 73 pass, 0 fail, 63 skipped
npm run build
# 通过，仍有已有的大包体积提示
npm audit --omit=dev --json
# critical 0, high 0, moderate 4, low 2
```

补丁前主应用告警：high 1、moderate 4、low 2。补丁后六条较低级别告警仍待处理；本轮没有重新扫描嵌套视频后端。安全补丁已在代码与构建中验证，没有重启当前本机业务服务。

身份接入验证：

```sh
node --test tests/fouryi-identity.test.mjs
# 3 tests, 3 pass, 0 fail, 0 skipped
npm test
# API: 484 total, 475 pass, 0 fail, 9 skipped
# Web: 136 total, 73 pass, 0 fail, 63 skipped
npm run build
# 通过；已有单包超过 500 kB 提示仍存在
```

身份测试使用隔离 PGlite 数据库、模拟平台签名和测试缓存：真实 Fastify 请求已验证签名改动被拒绝、原始正文篡改被拒绝、重放被拒绝、同组织不同用户及不同组织不能读他人的工作空间、CSRF 检查、自动创建内部账号和自己的工作空间、返回平台入口、本地密码入口在 4yi 模式不可用。总计 548 项通过、72 项跳过。**这不等于真实平台路由注入、多账号浏览器验收或云端 Redis 测试通过。**

本轮没有付费模型调用，没有改本机 `.env` 或重启业务服务，没有改办公室动画、现有员工／技能／模型配置和真实业务数据。

## 云端配置边界

- 新安装带产品代码、岗位模板和允许分发的素材，不默认迁移本机聊天、工作空间、视频或个人 Key。
- 平台安全注入 `FOURYI_ROUTER_IDENTITY_KEY` 与 `XCLAW_APP_HOSTNAME`；应用据此生成 HTTPS `APP_ORIGIN`，冲突配置拒绝启动。签名密钥不能手填进部署声明或 Git。
- 每个人仍在「我的 4yi Key」保存自己的凭据。平台网关的安装令牌不能覆盖用户个人 Key，也不能把应用免费理解为模型调用免费。
- 应用账号必须是不能绕过行权限的 PostgreSQL 账号，Redis 必须支持现有原子限流与防重放；平台的托管服务地址、TLS 证书与初始化方式仍待核实。当前声明没有虚构这些地址。
- 视频回调与模型代理需要内部服务访问路径，不能假设后台服务可绕过 4yi 浏览器登录直接请求公开入口；现有集成 bridge／JWT 验证必须保留。
- `4yi` 签名协议提供用户与组织 ID，没有已验证邮箱。当前内部账号使用不可投递的占位邮箱；既有按邮箱邀请成员流程尚未完成平台适配，不能声称组织协作已验收。

## 尚需完成才能构建可用实例

- 真实 4yi 签名路由、登录及组织成员邀请适配验收；本地身份实现已完成，不能用隔离测试代替平台安装验证。
- Linux 视频工具、视频后端镜像／启动、数据库与素材存储配置；本机自动开通通过不等于平台容器中已可用。
- 多自动工作空间的完整备份与隔离恢复演练。
- 整理本机未提交的功能改动，排除真实资料和密钥，形成可复现的部署分支。当前 GitHub main 仍是旧版。
- 推送后重新分析，确认主站没有选错，并审核完整服务拓扑、资源、秘密配置和免费应用设置；随后才 Apply／构建／安装到经核对的目标组织。
- 实测平台登录、每用户 Key 隔离、任务与视频全流程、重启持久化及权限。公开发布前仍由用户确认，不以本地回归代替真实平台认证。

参考：[Teardown 部署声明](https://github.com/4yi-ai/teardown/blob/main/4yi-app.json)、[开发者上架指南](https://github.com/4yi-ai/teardown/blob/main/docs/4yi-app-developer-quickstart.md)。
