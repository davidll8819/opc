# 视频流程修复与验收记录（2026-10-21）

## 结论

视频后端剩余失败与两个空测试文件已修好。创建任务、生成文件、保存结果、页面预览、下载到电脑均已实际走通。**整体仍是部分验收通过：这次选择9:16竖屏，返回的视频却是1920×1080横屏。** 页面现已正确标红提示规格不符，不能把它当成符合要求的最终成片。本轮没有开发剪辑功能。

办公室动画、员工技能绑定和模型配置均未修改；与本轮开始时的文件基线核对一致。只新增了一次验收任务及其视频，不改已有业务记录，不发布作品。未输出任何完整密钥。

## 已修复内容与位置

路径相对于项目根目录。下面的AiToEarn路径前缀为 `integrations/aitoearn/source/project/aitoearn-backend/`。

| 修复 | 位置 | 验证 |
|---|---|---|
| 工具协议测试改为真正连接客户端、列出并调用工具，不再读取SDK已不存在的内部字段。SDK就是供程序调用的工具包。 | 前缀 + `apps/aitoearn-ai/src/core/agent/mcp/util.mcp.spec.ts:153`；`mcp/volcengine/aideo.mcp.spec.ts` 的 server 测试 | AI整套201项通过 |
| 补齐聊天服务的5个测试：成功与用量、未知模型、上游失败、图片存储、模型筛选。 | 前缀 + `apps/aitoearn-ai/src/core/ai/chat/chat.service.spec.ts:20` | 不再是空测试；使用模拟服务，不消耗真实模型额度 |
| 补齐草稿生成的6个测试：创建、权限、进度、失败、重试复用已有素材。 | 前缀 + `apps/aitoearn-ai/src/core/draft-generation/draft-generation.service.spec.ts:28` | 不再是空测试；验证重试不会重复生成已有视频 |
| 上传中转服务返回缺少上传地址时，按系统统一的业务错误返回，避免普通异常破坏错误处理约定。 | 前缀 + `apps/aitoearn-server/src/core/channels/relay/relay-client.service.ts:62`及相邻测试 | server整套721项通过 |
| 视频成果增加明确的下载按钮；下载接口验证登录、任务归属、已完成的视频和企业存储地址，拒绝任意网址及跳转。 | `apps/web/src/saas/operations/OperationsWorkspace.tsx:211`；`apps/api/src/operations/routes.mjs:218`；`apps/api/src/operations/video-download.mjs:4` | 接口权限/地址校验/上游失败/文件流4项通过；真实文件下载与原文件校验一致 |
| 兼容服务返回的大写1080P，避免整段规格验收信息被丢掉。现在显示要求、实际尺寸和不通过提示。 | `apps/web/src/saas/operations/models.ts:99`；`tests/operations-rendering.test.mjs` | 下载及显示专项共14项通过；真实页面显示规格不通过 |
| 视频浏览器测试不再强制依赖本机安装Edge；使用匹配版本的Chromium，依赖预编译和缓存独立，避免首次运行刷新测试页。 | `apps/web/tests/operations-workspace.test.mjs:10`及启动浏览器处 | 全新缓存下12项通过，0失败、0跳过 |

## 实际操作验收

在已登录的本地页面，从“任务成果→打开运营工作台→新建任务”开始，选择9:16、1080p，提交“视频全流程验收-蓝色小球”：要求一段5秒蓝色玻璃球视频，只生成一次，不制作封面、不剪辑、不发布。

- 任务编号：`6ad8613d5f830b5fd028af6f`。
- 视频编号：`6ad8615a5f830b5fd028af81`。
- 生成提交于北京时间14:53:10，完成于14:55:54，约164秒。
- 数据核对：1条提交、1个视频、0条发布申请，没有重复付费生成。
- 任务完成后重启主应用，再打开历史任务，视频仍可访问。
- 浏览器实际播放至结束，时长5.038005秒，无播放错误。
- 实际点击“下载视频1”，文件保存为 `/Users/david/Downloads/video-6ad8613d5f830b5fd028af6f.mp4`。
- 文件为H.264编码的MP4，9,791,450字节；与存储原文件逐字节及SHA-256校验一致。校验值用于确认下载文件没有缺损。
- **规格验收失败：请求9:16、1080P；实际1920×1080横屏。** 视频已保存，但不视为竖屏交付合格。

截图：`outputs/2026-10-21-video-check/视频预览与下载验收.png`。精简机器证据保存在本目录的 `video-evidence-2026-10-21/`。

## 测试命令与实际输出

根目录运行命令前使用项目随附Node：

```sh
export PATH="$PWD/.local/bin:$PATH"
npm test
# 后端374通过、0失败、5跳过；前端51通过、0失败、44跳过
# 合计425通过、0失败、49跳过

node --test tests/operations-video-download.test.mjs tests/operations-rendering.test.mjs
# 14通过、0失败

npm run build
# 退出码0，前端构建成功
npm run lint
# 0 errors, 1 warning
# 既有 DepartmentChat.tsx useMemo 的 language 依赖警告，本轮未改该组件
```

在AiToEarn后端目录运行，PATH仍指向主项目 `.local/bin`：

```sh
NX_DAEMON=false NX_TUI=false NX_NO_CLOUD=true NX_ISOLATE_PLUGINS=false NX_WORKSPACE_DATA_DIRECTORY=/private/tmp/wishtaday-video-check/nx-tests CI=1 ./node_modules/.bin/nx run-many -t test -p aitoearn-ai aitoearn-server --parallel=2 --args=run
# AI: Test Files 26 passed; Tests 201 passed
# server: Test Files 129 passed; Tests 721 passed
# Successfully ran target test for 2 projects
# 合计922通过，无失败、无空测试文件

NX_DAEMON=false NX_TUI=false NX_NO_CLOUD=true NX_ISOLATE_PLUGINS=false ./node_modules/.bin/nx build aitoearn-server
# 退出码0
```

主项目根目录的浏览器检查：

```sh
PLAYWRIGHT_BROWSERS_PATH=/private/tmp/wishtaday-video-check/browsers node node_modules/playwright/cli.js install chromium --only-shell

PLAYWRIGHT_BROWSERS_PATH=/private/tmp/wishtaday-video-check/browsers OPERATIONS_UI_BROWSER_TESTS=1 node --test apps/web/tests/operations-workspace.test.mjs
# tests 12; pass 12; fail 0; skipped 0
```

浏览器测试覆盖：笔记本/手机尺寸的叶凡对话框、视频参数提交与恢复、不合格规格显示、下载链接、提交结果不确定时防止重复付费、恢复提交记录、停止/切换任务的迟到回复隔离、流式连接中断后继续核对真实状态。模拟接口用于安全验证失败和延迟场景；上述真实生成、播放和下载是另外实际操作的。

测试曾暴露两类测试环境问题：本机没有Edge，以及Vite首次依赖预编译刷新页面。已修正启动方式与独立缓存，再从全新缓存运行全部12项通过；没有靠跳过用例掩盖失败。主测试仍有49项跳过，其中本次视频浏览器12项已另外开启执行，其余跳过项不能视为已验证。

服务已重新构建、链接并重启。只读复核确认AI/server均READY，旧签名被拒绝；31个日志文件凭据匹配0、权限错误0。详细临时日志在 `/private/tmp/wishtaday-video-check/`；长期保留的精简证据见 `docs/video-evidence-2026-10-21/`。

## 尚未解决或未验证

1. **竖屏输出仍未解决。** 保存的生成请求在顶层及extra_body中均含9:16与1080P，本地转发保留这些媒体字段；返回文件为横屏。服务商模型目录和任务状态接口没有提供已采用的比例参数，也没有取得可核实的该模型接口参数文档。目前证据不足以断言一定是服务商故障，可能涉及该接入方式的参数支持或解释。后续需要核对服务商对 `wan3.0-video-prime` 的有效比例参数及本次任务记录，再做一次有针对性的验证。没有猜参数反复生成，也没有改模型配置。
2. 真正的剪辑、字幕、拼接、配乐与最终成片验收尚未实现/验证，留待下一阶段。不能用自动裁切掩盖本轮原生生成规格不符。
3. 外部平台发布、所有供应商及所有视频尺寸没有验证；本轮不包含发布授权。视频下载对本机企业素材存储已实测，其他存储部署未验证。
4. 本轮只做一次真实短视频，不能据此证明多用户并发或长期稳定性。

## 下一步

先解决或明确服务商的竖屏参数支持，再基于已保存的视频补剪辑：优先裁剪/拼接、字幕、配乐、预览与导出，避免重复生成付费素材。本轮到此交付结果，尚未开始剪辑改动。
