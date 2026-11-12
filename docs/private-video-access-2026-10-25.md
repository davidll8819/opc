# 私有视频链接保护与过期机制：本地验收

日期：2026-10-25。状态：**本地已部署并实测通过，L02 继续保持部分完成，尚未公开发布。**

## 现在有什么变化

- 原片、剪辑成片、归档视频的播放和下载先检查登录、企业、本人归属，再生成 **5 分钟有效**的临时访问地址。该地址只适用于获取它的当前登录会话，转发给其他账号、其他浏览器会话或未登录的人不能观看。
- 每次读取都重新检查权限。退出登录、移出企业、删除归档后，后续读取不能继续；接口支持主动撤销单个临时地址。撤销和过期返回 410，表示地址已失效。
- 页面用临时地址播放，草稿仍保存稳定的素材引用。因地址失效产生播放错误时，播放器自动尝试更新一次；失败会显示重试入口。点击下载时重新获取地址，不需要重新生成视频。
- 原始存储地址也已保护。本机现有 **18 个视频对象**逐个匿名请求均返回 403（拒绝访问），不能通过跳过应用直接读取原片或成片。
- 服务端用已有存储凭据读取视频，凭据不发送给浏览器。剪辑引擎也能读取私有原片，不影响导出；响应禁止缓存，支持分段读取，方便拖动进度。
- 启动脚本改为设置相同保护策略，正常启动不会重新开放全部视频。应用已重启，守护服务已恢复运行。

办公室动画、员工技能绑定和模型配置没有修改。模型配置、技能记录、原工作区、文件、用量记录、`.env` 和配置加密主密钥前后校验一致；没有新建收费模型调用。31 个存储对象的数量、大小和存储校验标记一致，没有移动、删除或重新编码真实视频。

## 实际验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 标准回归 | 后端 433 通过、8 条件跳过；前端 53 通过、58 条件跳过。合计 **486 通过、0 失败、66 跳过** | [标准测试摘要](private-video-evidence-2026-10-25/full-tests-summary.txt) |
| 私有访问与下载专项 | 6 项通过：登录、企业/个人/会话隔离、过期、撤销、权限变更、分段读取、下载与存储策略 | [专项测试](private-video-evidence-2026-10-25/focused-tests.txt) |
| 实际私有对象存储 + 剪辑引擎 | 临时桶中的原片和成片匿名读取 403；非视频示例仍 200；用 FFmpeg（视频编码工具）读取私有原片并完成 1280×720、约 0.619 秒导出 | [隔离完整验证](private-video-evidence-2026-10-25/real-storage-browser.txt) |
| 实际浏览器 | 3 个预览成功解码，草稿播到结束；过期地址 410，自动更新后可读；浏览器下载字节一致；无登录 401。1440/768/390 宽度验证页无横向溢出 | 同上；同目录 `preview-*.png` 是合成素材验证页，不是产品视觉验收截图 |
| 既有视频工作台回归 | 24 通过、0 失败：草稿、导出、字幕/配乐同步、单镜头替换、版本对照等；本轮使用虚拟音频输出 | [浏览器回归](private-video-evidence-2026-10-25/video-ui-tests.txt) |
| 真实账户已有成果 | 原片、成片、归档分别下载 200、匿名 401、撤销后 410，下载内容与存储/数据库副本一致 | [运行中服务验证](private-video-evidence-2026-10-25/live-runtime.json) |
| 现有原始链接 | 18 个视频全部拒绝匿名访问；31 个对象元数据不变 | [策略应用结果](private-video-evidence-2026-10-25/storage-applied.json)、[最终只读检查](private-video-evidence-2026-10-25/storage-final.json) |
| 受保护业务和配置 | 所有本轮采样表与配置文件校验一致 | [一致性结果](private-video-evidence-2026-10-25/preserved-data.json) |
| 构建与静态检查 | 构建成功；lint 0 错误、1 项既有警告；保留原有大文件包提示 | [构建和检查摘要](private-video-evidence-2026-10-25/build-lint-summary.txt) |

过期验证通过调整隔离缓存中的到期时间触发，不是等待 5 分钟；同时验证签发到期时间为 300 秒。真实业务缓存不参与这种修改。当前短片会完整缓存，浏览器专项强制一次未缓存读取，证明过期地址确实拒绝、随后组件能更新访问。

### 音频测试边界

正常音频输出模式中，一项配乐同步测试出现“显示播放但时间不前进”。临时换回原生视频标签的对照测试同样失败；使用虚拟音频输出后该项及完整 24 项全部通过。本机处于锁屏状态，**无法确认问题的具体系统原因，也未验证实体扬声器出声**。没有修改产品播放逻辑来绕过断言。测试的可选开关 `PLAYWRIGHT_FAKE_AUDIO=1` 只为 Chrome 测试添加 `--disable-audio-output`；它保留音频处理、替换系统输出流，参见 [Chromium 官方实现说明](https://chromium.googlesource.com/chromium/src/+/f29eb01290cd36a30177ecf8197f906c01088a0d)。

## 可以重复执行的命令

在项目根目录使用现有 Node 24：

```sh
PATH="$PWD/.local/bin:$PATH" npm test
PATH="$PWD/.local/bin:$PATH" node --test tests/private-video.test.mjs tests/operations-video-download.test.mjs
PATH="$PWD/.local/bin:$PATH" PRIVATE_VIDEO_BROWSER=1 node scripts/verify-private-video.mjs
PATH="$PWD/.local/bin:$PATH" PLAYWRIGHT_FAKE_AUDIO=1 OPERATIONS_UI_BROWSER_TESTS=1 PLAYWRIGHT_CHANNEL=chrome node --test apps/web/tests/operations-workspace.test.mjs
PATH="$PWD/.local/bin:$PATH" node scripts/protect-video-storage.mjs
PATH="$PWD/.local/bin:$PATH" npm run build
PATH="$PWD/.local/bin:$PATH" npm run lint
```

第三条连接本机现有 RustFS（兼容 S3 接口的文件存储），新建临时桶、临时内存数据库、合成视频，实际调用本机 FFmpeg 和 Chrome；结束后清理临时资源。不会生成收费视频。第五条只读检查，不修改策略；返回的布尔值 `anonymousReadsBlocked` 应为 `true`。

本次已执行策略应用脚本的 `--apply` 模式。它仅接受本机服务及可识别的原公开策略/更窄策略，修改前将原策略保存到 `.local/security-backups/video-policy-*.json`，目录权限 0700、文件 0600。**不要为解决播放故障直接恢复旧的公开策略。** 如出现播放问题，先检查登录、任务归属、缓存及服务端存储读取。

## 适用范围与尚未验证

1. 这是当前本地视频访问保护，不等于整个素材桶私有化。策略保护视频生成/剪辑路径和常用视频扩展名（包括大小写组合）；其他图片等文件保持原有读取行为。不在这些路径且没有视频扩展名的新文件不能自动视为受保护，接入新的上传渠道时应复核。
2. 旧草稿和旧任务中的原始地址没有批量重写；应用播放/下载时转换为新地址，直接打开原始视频地址会被拒绝。原先已鉴权的稳定下载接口保留兼容，仍要求当前权限；**5 分钟限制作用于新临时访问地址**，并不阻止有权限的人再次获取新地址。
3. 已下载或已经进入播放器缓冲区的内容不能远程收回；到期限制后续请求，不会中途强行截断已经允许的传输。
4. 不提供“任何人拿到即可访问”的公开分享。撤销接口已验证，尚无独立的分享管理/撤销页面；如果以后需要给客户审片，应单独设计分享范围、期限和撤销管理。
5. 尚未验证云端 S3/CDN、HTTPS、外部视频发布、第三方云处理工具读取、长期大视频连续播放和公网带宽压力；本次没有发布任何视频。现有读取仍经应用转发，云端容量和流量成本需预发布验收。
6. 新访问授权存于缓存，服务重启或缓存丢失后旧临时地址可能失效，用户可重新获取；不会删除真实视频。

## 关键代码位置

- `apps/api/src/operations/video-access.mjs`：授权签发、会话绑定、到期、权限复核、撤销、播放和下载。
- `apps/api/src/operations/video-download.mjs`：已完成任务校验、素材路径校验、服务端签名读取。
- `apps/web/src/saas/operations/PrivateVideo.tsx`：私有播放、失败更新、下载时获取新地址。
- `scripts/private-video-policy.mjs`、`scripts/protect-video-storage.mjs`、`scripts/operations-mac.mjs`：本机存储策略和持久启动保护。
- `tests/private-video.test.mjs`、`scripts/verify-private-video.mjs`：权限测试与真实存储/浏览器演练。

下一步建议：在独立预发布环境验收云端私有存储、HTTPS 和登录链路，再做备份恢复与真实混合负载。第三批采购价/支付沙箱等未验证项目仍保留原状态。
