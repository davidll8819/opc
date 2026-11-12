# 李婉儿角色库新版场景试用

2026-11-04。按用户要求，先把李婉儿放入办公室看效果，其余角色不替换。

## 本次效果

- 深棕低盘发、香槟白蝴蝶结衬衫、黑色包臀裙、黑丝袜，沿用已确认的小巧比例。
- 三张真实透明动作图集：背面起身落座、迈腿行走、八向转身，每张 4×2 共 8 帧。
- 场景中仅现有员工 `marvis` 的视觉使用该素材，未改员工技能绑定、模型配置或业务数据。
- 高清对话形象仍保留在同一角色组 `li-waner-anime-v3`，本次不接入对话框。
- 现有特殊表情按钮仍使用原版 Spine 形象；点击后会切回原版，可从形象选择框切回新版。尚未制作这套服装的完整表情动画。

## 实际验证

| 检查 | 结果 |
|---|---|
| `PATH="$PWD/.local/bin:$PATH" npm run build` | 通过，退出码 0；保留已有大包体积提示 |
| `npm test --workspace=@office/web` | 120 项：61 通过、0 失败、59 跳过；跳过的是需另行启用的用例，不算通过 |
| `npm run lint` | 0 错误；1 条已有警告：DepartmentChat.tsx:336 useMemo 依赖 |
| `git diff --check` | 通过，无输出 |
| PNG 原图与透明通道 | 三张动作素材 CRC、透明通道通过；详情见素材目录 motion-verification.json |
| 办公室浏览器实测 | 登录后新版正常显示；坐姿背对屏幕观察者，椅背遮挡正常；点击与同事互动，观察离座、移动和回座；保存场景截图 |
| 原版恢复 | 切换“原版（恢复）”，看到旧角色；再选新版，正确显示新素材 |
| 回退脚本 | 默认只检查，输出 `Backup verified; two preview source files safe to restore.`，没有执行回退 |

当前预览是小尺寸场景美术试用；不是每个动作帧都已达到最终美术质量的承诺。行走、起身的流畅度和缩小后细节仍以用户实际观感为准。

![办公室坐姿](li-waner-library-evidence-2026-11-04/office.png)

![离开工位后的角色](li-waner-library-evidence-2026-11-04/walking.png)

## 素材与备份

- 设计原图：`design/characters/anime-v3-2026-11-03/li-waner/motion/`。
- 场景素材：`apps/web/public/assets/characters/li-waner-library-v3/`。
- 同一人物的高清、卡通和动作对应关系记录在角色库 `manifest.json` 与 `CATALOG.md`。
- 本次只修改两个现有应用源文件：`LiWanerCharacter.ts` 和 `OfficeCanvas.tsx`；新增素材，保留所有旧素材。
- 修改前备份：`.local/backups/li-waner-library-scene-20261104-114539/`。

## 如何恢复

最快：办公室上方“李婉儿形象”选择“原版（恢复）”。不需要重启。

若要恢复到本次修改前的上一套紧凑比例素材配置，在项目根目录执行以下命令。脚本会核对备份和当前文件的哈希值（文件指纹）；若后续有人改过文件，它会拒绝覆盖。

```sh
python3 .local/backups/li-waner-library-scene-20261104-114539/restore.py
# 确认需要回退时才加 --apply：
python3 .local/backups/li-waner-library-scene-20261104-114539/restore.py --apply
PATH="$PWD/.local/bin:$PATH" npm run build
```

恢复源文件后重新构建并刷新页面即可。本轮只运行过第一条只读核对命令。
