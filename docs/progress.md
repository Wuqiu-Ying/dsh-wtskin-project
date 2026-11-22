# 进度记录

> 2026-11-15。v3 开发中，代码全部已提交。
> 设计记录见 [v3-architecture.md](v3-architecture.md)；两者不一致时以本文为准（实现已偏离早期设计）。

## 一句话状态

v3 核心闭环已打通：**模式预设**、**悬浮取点器**、**多边面编辑**、**保存/删除/提交面数据**、**导出 DDS + blk**、**一键装进 UserSkins**、**格式转换**。剩下的是打包发布与一次完整流程实测。

## 已完成

### v2（M 模式）

- 工具：`project / layer / export / picker / presets`
- 引擎：调色、多边形校验、DDS、预览、调试图、法线贴图
- v1 工程自动迁移（去掉 `quadScale` 双重缩放）

### v3 插件（Host + Client）

- 预设「战雷画涂装模式」：运行时 `ctx.agentPresets.register()`，六行子插件健康
- `WTSP/<载具>_<名称>/` 建档：清洗、重名 `-2`、复用根目录，按**会话工作区**落盘
- 悬浮取点器（`shell.overlay`）：拖动、缩放、最小化、关闭、位置记忆
- 面板编辑：任意 3–64 点多边形、左键加点、右键删点、拖点、滚轮缩放、中键平移、彩色的边与可改边名、面颜色区分、删除此面、旋转 180°、弦长占比、保存后立即刷新
- 面数据：每次保存/删除写 `project.json` + `faces.json`；「提交面数据」把路径给用户，用户手动上传后模型用 `dsh_wtskin_import` 导入（**保存不再唤醒模型**，省 token）
- 状态持久化：`panel-state.json` + IndexedDB 预览，重开恢复图片与未完成的面
- 引擎尺寸模式：`chord` / `quadHeight` / `height` / `widthAdapt` / **`crop`**（源图 1:1 取块）/ **`cover`**（铺满包围盒）
- **`dsh_wtskin_convert`**：TGA / DDS / PNG / JPG → PNG
- **`dsh_wtskin_install`**：把导出物装进 `UserSkins/<文件夹>/`，blk 按**机型名**命名
- **`dsh_wtskin_theme`**：整机主题换色（原皮 + 渐变 palette），`detail=keep`（保留机械细节）/ `detail=flat`（抹平细节），自动丢弃会盖住底图的全画布图层
- **`dsh_wtskin_finalize`**：项目确认完成后清空 `WTSP/temporary`
- **`dsh_wtskin_reference`**：按 WT Live 标签下载参考涂装到 `WTSP/temporary/`（或导入 zip），解压并返回 blk 与贴图清单；自动走系统代理
- 面板「原皮 / 主题皮」一键切换编辑底图

### 触发（只有两条）

| 触发 | 实现 | 行为 |
| --- | --- | --- |
| 用户 `/wtspwds` | 命令写 `WTSP/.open`（时间戳） | 面板 2 秒内出现 |
| 模型 `dsh_wtskin_picker` | 同一标记 | 模型判断该量面时调用 |

启动时不出现、无常驻标签、标记 2 分钟内有效；客户端只读文件轮询，不执行命令。

## 关键坑（都是踩出来的）

1. **服务必须 inject**：直接取 `ctx.xxx` 会在加载期抛错；可选服务用 `ctx.get`，需要等待的用 `ctx.inject`。
2. **preset 子插件行必须是 `file://` 绝对 URL**；`file://` 可以指向 `app.asar` 内的包。
3. **子插件配置要满足必填 Schema**（例：`tool-todo` 需要 `allowParallelInProgress`）。
4. **remote 调用返回 `{ ok, value }`**：必须先 `unwrap`；命令结果还可能被包一层，用递归查找兜底。
5. **会话 cwd 不是 `workingDirectory.defaultDirectory`**；用 `workingDirectory.ensure(agent)`。
6. **命令会写进会话日志**：客户端轮询命令会在对话里刷屏，静默通道只能用文件/Remote。
7. `followup()` 要带内容；只 `inject` 不会唤醒模型。
8. **画布 ≠ 贴图**：模板贴图常是 2048，画布是 4096；面板的 ×2 只负责"预览 → 画布"，手工量坐标必须落在**画布空间**。
9. **`crop` 要按 `源图尺寸 / 画布尺寸` 换算裁剪框**，否则源图更小时裁错区域。
10. **blk 文件名必须 = 机型名**（`q_5l.blk`、`f-104g_china.blk`）；内容用 `replace_tex{from:t="<机型贴图前缀>*" to:t="<同目录文件>"}`。文件名不对，游戏直接不加载。
11. **DDS 格式**：游戏可读未压缩 32 位 RGBA（4096² = 64 MiB、无 mipmap），与现成皮肤一致；PNG 不能进 UserSkins。
12. 上翼面在贴图里常是**倒置**的（用 `rotate180`）；立绘取弦长 **85%** 最稳；放大 1.15~1.45 再沿翼展偏移可让胸完整。
13. **WT Live 的下载链接不在帖子页面里**：帖子页唯一的 `/dl/` 是 `og:image` 预览图（下下来是 JPEG）；真正的附件在 feed API 的 `item.file.link` 上，且帖子需按 `searchString="#tag"`（带 `#`）查询。

## 命令 / 工具清单

| 名称 | 面向 | 说明 |
| --- | --- | --- |
| `/wtskinp` | 用户 | 开始流程：问载具/命名、建档（不打开面板） |
| `/wtspwds` | 用户 | 打开取点面板 |
| `wtskin-save` | 内部 | 面板保存/删除/提交面数据（会显示在 `/` 菜单，暂无隐藏手段） |
| `dsh_wtskin_convert` | 模型 | TGA/DDS/PNG/JPG → PNG |
| `dsh_wtskin_install` | 模型 | 导出物装进 UserSkins，生成 `<机型>.blk` |
| `dsh_wtskin_import` | 模型 | 导入用户上传的 `faces.json` |
| `dsh_wtskin_theme` | 模型 | 主题换色（渐变色板重绘原皮） |
| `dsh_wtskin_finalize` | 模型 | 清空 `WTSP/temporary` |

已删除：`wtskin-diag`、`wtskin-whoami`。

## 实测问题记录（2026-11-22）

### 1. 涂装风格选项的语义不对（✅ 3.0.5 已修）

新会话里模型让用户选风格，卡片长这样：

1. 罗天依主题：整机换色 + 角色立绘/贴花
2. 军工复刻：只改配色 + 军标编号，保留铆钉面板线，做低可视度或复古配色，**不加人物立绘**
3. 自定义

用户反馈：

- **平涂风格的表述无误**；
- **军工复刻的表述有问题**。这个风格实际应该是：
  - 仅保留**铆钉、焊缝**等细节（对应 `detail=keep`）；
  - **仍然要整体换色**（不是只改局部配色）；
  - **去除机徽**（不是保留"军标编号"）；
  - **安装人物立绘**（不是"不加人物立绘"）。

即"军工复刻"= 保留机械细节的主题痛机，而不是纯写实军机。

**已修**：三种风格的固定文案与"军工复刻"的准确定义已写进 `lib/persona.js`；
去机徽用实心补丁层（`{fill:[r,g,b], quad:[...]}`），引擎已支持。

### 2. 主题换色偏差大（✅ 3.0.5 已修：levels + tint + 白锚点 + edgeGlow=0）

新会话实测：整机换色后整张图是"一片青蓝"，机体的明暗层次和白色蒙皮都变成了蓝色，
和预期的"天青 + 柠檬黄 + 白"差距很大。

**对照旧工作台（session-0297e24a，seq 1446/1460 的实际代码）**：

```python
stops = [(0.00,(3,6,16)),(0.22,(9,17,42)),(0.50,(20,41,90)),
         (0.76,(46,90,168)),(1.00,(140,200,255))]
col = palette(L) / 255.0
col = np.clip(col * (0.72 + 0.55 * L[..., None]), 0, 1)   # 保留明暗细节
```

结论：**算法和我们现在的 `build_base` 基本一致**（同样的亮度→调色板 + 细节乘子），
差别来自三个输入，而不是公式：

1. **源图不同**：旧工作台的底图是它自己做的 **低可视 stealth 贴图（偏暗）**，
   亮度落在调色板暗段 → 出来是深海军蓝；我们现在直接用**明亮的游戏模板**，
   亮度集中在 0.6~1.0 → 全部落进亮蓝/青色段。
2. **调色板缺"白"锚点**：本次 6 个色标全是蓝（`#060A12 → #0E2C50 → #1A5892 → #308CC4 → #66CCFF → #96E1FF`），
   没有白色/中性色，所以亮部也只能是青蓝；预期主题需要"暗→主题色→白/柠檬黄"的锚点。
3. **`edgeGlow: 80` + `dots`**：在密集贴图上叠加了一层青色描边和点阵，进一步把画面推向全青。

另外 `contast=1.15` 让细节乘子变成 `0.72 + 0.6325·L`，亮部更亮、更偏青。

**候选修法（待做）**：
- `dsh_wtskin_theme` 增加**亮度归一化**（按 1%/99% 分位拉伸），或暴露 `levels: [lo, hi]`；
- 调色板约定"最后一段 = 白/浅色"，或在工具里自动补一个白色锚点；
- 主题模式默认 `edgeGlow: 0`（细节已经在贴图里，不需要再加描边）；
- 可选"保色"模式：只对去饱和后的明度着色，白色区域保持中性。

### 3. 参考样本：中系 P-47「Ephnel」皮肤（UserSkins/P47D16+EPHNEL）

用户提供参考。实际查看结果：

- 贴图 **4000×4000 DXT5**（非 2 的幂），另有 4MB 法线贴图，2021 年的 WT Live 作品；
- 主体做法**不是全局调色**，而是**按 UV 岛手绘硬边纯色块**：
  - 大块**纯绿**（约 #3CB371）直接覆盖机翼/机身区域，块内没有铆钉或渐变；
  - 未覆盖的区域保留原贴图的深灰/机械细节；
  - 角色（SoulWorker 的 Ephnel）是**透明 cutout** 直接贴上去；
  - 配合白色粗体文字（MONYEY / DOUBT / REASON / FN.e1）与 logo。
- 这与旧工作台在 session-0297e24a 里总结的 WT Live 套路一致：
  "角色 cutout 硬边贴、低对比几何底纹、角色名 typography"。

**参考价值**：

1. 它佐证了"**平涂（flat）才是这类痛机的常见做法**"——纯色块 + cutout + 字，
   而不是把整张贴图按亮度映射成主题色；
2. 我们当前"整图亮度→渐变"会给所有区域染色（连白蒙皮都变青），
   而参考样本是"**只在需要的地方铺色**"，其余保持原样；
3. 若要靠近这种效果，可以给 `dsh_wtskin_theme` 增加：
   - `mode: "islands"`：按 UV 岛（四边形/多边形）填充主题色，岛外不动；
   - 或 `mode: "tint"`：用主题色与原始明度做 multiply/overlay（白→白、暗→暗），
     而不是全局换色；
4. 字体/文字层目前没有专门支持（只能作为图片层贴）。

## 待办

- [ ] 插图**手动贴面**：面板里选图 → 选面 → 缩放/旋转/拖动预览 → 写入 `image`/`factor`/`offset`/`rotate180`（用户提出，暂不做）
- [ ] 把 `wtskin-save` 从 `/` 菜单隐藏（改为 Host Remote 服务）
- [ ] 修正风格选项语义（实测问题 1）
- [ ] 修正主题换色偏差（实测问题 2：亮度归一化 / 白色锚点 / edgeGlow 默认）
- [ ] 模式内完整流程实测：问载具 → 查资料 → 建档 → 量面 → 提交 → 补图 → 导出 → 安装 → 试飞截图
- [ ] 打包发布 v3.0.0

## 调研（留档，不排期）

[face-detection.md](face-detection.md)：目标面**保持人工点选**，不做自动识别；四种方案（参考涂装差分 / 区域生长魔棒 / CDK UV 导出 / 法线分割）的实测结论都在里面。

## 文件地图

```
dsh-wtskin-project-02/
├─ lib/index.js          工具 + 命令 + 预设注册 + 面板桥 + 安装/转换
├─ lib/project.js        schema / 迁移 / 校验
├─ lib/projects.js       WTSP 目录与命名
├─ lib/persona.js        模式提示词
├─ lib/picker.js         备用取点页生成
├─ client/index.js       悬浮取点器
├─ preset/wtskin-mode.js 预设子插件
├─ python/wt_skin.py     引擎（export / info / convert）
├─ presets/vehicles.json 机型预设
├─ tools/find_face.py    区域生长原型（实验，未接入）
├─ assets/picker.html    备用取点页
├─ docs/                 架构、进度、面定位调研
└─ tests/smoke.mjs       端到端测试
```

## 下次继续

```bash
cd /d/DSH/dsh-wtskin-project-02 && node tests/smoke.mjs "<python>"
# 重装插件：
#   plugin_manager install_bundle target=D:/DSH/dsh-wtskin-project-02
#   plugin_manager set_bundle     target=dsh-wtskin-project
```

诊断文件（插件目录）：`.preset-status.json`（预设 roster / broken 原因）。

## 已知限制

- DDS 未压缩（4K 约 64MB）；法线贴图由亮度推导，属近似
- 一次一个工程（面板下拉切换）；面板尺寸不持久化（位置会记住）
- 恢复的图片是 ≤1400px 预览，仅用于量点
- 4K 每次全量导出，暂无按图层缓存
