# 现有员工形象更新记录

2026-11-04，按用户认可的李婉儿场景效果，将对应姓名的角色接入现有办公室。

## 已更新与保留

| 员工 | 固定员工编号 | 角色组 | 处理结果 |
|---|---|---|---|
| 李婉儿 | marvis | li-waner-anime-v3 | 沿用本日已确认的新版动作 |
| 龙傲天 | code-agent | long-aotian-anime-v3 | 新版蓝衬衫、黑裤 |
| 赵雅梦 | file-agent | zhao-yameng-anime-v3 | 新版侧辫、眼镜、紫色针织裙装 |
| 叶凡 | app-agent | ye-fan-anime-v3 | 新版铜棕发、耳机、浅色夹克 |
| 刘市 | review-agent | liu-shi-anime-v3 | 新版眼镜、棕色马甲 |
| 派阿奇 | data-agent | pai-aqi-anime-v3 | 新版盘发、墨绿职业裤装 |
| 林幼薇 | new-agent-7 | lin-youwei-anime-v3 | 新版卷发、青绿连衣裙 |
| 西罗 | new-agent-8 | xi-luo-anime-v3 | 新版深色西装、红领带 |

实习生保持原版。许知宁、程知遥、苏映、沈清岚的配套素材继续保留为储备，不新增员工、不占工位。高清对话形象仍与同一人物配对保存，尚未替换对话框。

本次只改角色视觉接入和选择控件，未修改员工注册表、岗位职责、技能绑定、模型配置或真实业务数据。秘书拆分任务与现有任务执行逻辑不变。

## 动作素材和程序处理

7 位员工新增 21 张透明动作图，全部通过内置 imagegen 生成；每人 3 张，每张 4×2 共 8 帧：背面起身落座、右向行走、八向转身。左向行走沿用现有翻转方式。李婉儿的 3 张原素材保持原文件。

设计原图存放在 `design/characters/anime-v3-2026-11-03/<characterId>/motion/`，运行素材存放在 `apps/web/public/assets/characters/<characterId>-library-v3/`。生成提示词、输出来源分别记录在角色目录的 `roster-motion-prompts.json`、`roster-motion-results.json`。

复用已确认的紧凑比例和动作状态控制。角色根据固定员工编号匹配，不依赖工位顺序；完整的三张图加载成功后才启用该人的新版形象，失败者保留原版。现有桌椅、工位、场景背景及业务任务不改。

## 验证结果

| 命令或实际操作 | 结果 |
|---|---|
| `PATH="$PWD/.local/bin:$PATH" npm run build` | 退出码 0，构建通过；已有超过 500 kB 的打包提示仍存在 |
| `PATH="$PWD/.local/bin:$PATH" npm test --workspace=@office/web` | 125 项：66 通过、0 失败、59 跳过；跳过项不算通过 |
| 新增身份/素材测试 | 核对 8 位员工姓名和固定编号、不同工位顺序、24 张不重复的 PNG、4 位储备角色不启用 |
| `PATH="$PWD/.local/bin:$PATH" npm run lint` | 0 错误，1 条已有警告：DepartmentChat.tsx:336 的 useMemo 依赖 |
| `git diff --check` | 通过，无输出 |
| 24 张动作图校验 | CRC 和真实透明通道通过，设计原图与发布文件逐一哈希一致；见 `roster-motion-verification.json` |
| 浏览器全员加载 | 页面显示“新版 8/8 位”；逐人查看初始背面坐姿、姓名与工位；实习生保持原版 |
| 场景动作抽查 | 点击赵雅梦与同事互动并观察回座；连续截图实测龙傲天起身、向左迈腿，林幼薇向右迈腿；完整动作状态的回归测试通过 |
| 原版恢复与刷新 | 全员切换原版后显示旧角色，刷新后保持原版；切回新版并再次刷新，显示 8/8 位新版 |
| 回退核对 | `python3 .local/backups/roster-library-20261104-130359/restore.py` 输出 `PASS: backups and current files verified; rollback is safe.`；仅核对，没有回退 |

不是所有员工的所有行走帧都逐帧在浏览器验证；动作图已逐张视觉检查，场景行走按上述样本实测。未做长时间、多设备帧率测试，也未故意破坏线上素材来制造加载失败。

![更新后的办公室](roster-library-evidence-2026-11-04/office.png)

![龙傲天向左行走](roster-library-evidence-2026-11-04/long-walking.png)

![林幼薇向右行走](roster-library-evidence-2026-11-04/lin-walking.png)

## 已知限制

特殊表情动作（挥手、欢呼等）仍会切换该员工到原版 Spine 人物。需要回到新版时，可将“员工形象”切换为原版再切回新版。本次未声称完成每人的全部表情动画。

首次加载需要读取 24 张动作图；图片已按角色缓存，但未做专门的低性能设备优化。后续可按实际设备表现决定是否压缩或按需加载。

## 如何恢复

直接在办公室上方“员工形象”选择“原版（恢复）”，可一键切回所有旧角色。

若需恢复到本次修改前、仅李婉儿更新的代码状态，备份位于 `.local/backups/roster-library-20261104-130359/`。先运行下列只读检查；确认需要回退后再加 `--apply`。遇到后续修改时脚本会拒绝覆盖。

```sh
python3 .local/backups/roster-library-20261104-130359/restore.py
python3 .local/backups/roster-library-20261104-130359/restore.py --apply
PATH="$PWD/.local/bin:$PATH" npm run build
```

脚本恢复源文件与角色目录记录，新模块和新增测试移入备份，所有生成素材和验证截图保留。构建后刷新办公室。

## 后续功能

左侧“雇佣员工”、新增岗位、用户自选团队的需求已记录在 [雇佣员工方案](employee-hiring-plan.md)。当前未添加空入口；后续应把选员工、真实保存、分配工位、秘书派工和独立技能/记忆一起接通。
