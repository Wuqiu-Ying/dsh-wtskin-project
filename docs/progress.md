# 进度记录

> 2026-10-31。v3 开发中，代码全部已提交。
> 设计记录见 [v3-architecture.md](v3-architecture.md)；两者不一致时以本文为准（实现已偏离早期设计）。

## 一句话状态

v2（M 模式）完整可用；v3 的 **「战雷画涂装模式」出现在模式菜单**、**取点器是可拖拽缩放的悬浮窗**、**两条触发通道已生效**、**工程落在会话工作区**。**尚未验证**：面板保存 → 写盘 → 唤醒模型的端到端链路，以及模式内的完整制作流程。

## 已完成

### v2（M 模式，可用）

- 工具：`dsh_wtskin_project / layer / export / picker / presets`
- 引擎：调色、四边形校验、DDS、预览、四边形调试图、法线贴图
- v1 工程自动迁移（去掉 `quadScale` 双重缩放）
- `node tests/smoke.mjs` 全过

### v3 插件（Host + Client）

- 预设「战雷画涂装模式」：运行时经 `ctx.agentPresets.register()` 注册，六行子插件全部健康（`broken: null`）
- `WTSP/<载具>_<名称>/` 建档：清洗、重名 `-2`、复用根目录，按**会话工作区**落盘
- 悬浮取点器：`shell.overlay` 上的浮窗，标题栏拖动、右下角缩放、最小化、关闭
- 面板读写：`workspaceFiles`（读）＋ 内部命令 `wtskin-save`（写）
- 保存后唤醒模型：`followup({ content, source })`
- **面板状态持久化**：项目里写 `panel-state.json`（图片名/路径/尺寸 + 面的点、边名、颜色），浏览器端在 IndexedDB 缓存一份 ≤1400px 预览，重开面板自动恢复图片与未完成的面

### 触发（只有两条）

| 触发 | 实现 | 行为 |
| --- | --- | --- |
| 用户 `/wtspwds` | 命令写 `WTSP/.open`（时间戳） | 面板 2 秒内出现 |
| 模型 `dsh_wtskin_picker` | 同一标记 | 模型判断该量面时调用 |

- 启动时**不出现**任何面板；
- 没有常驻小标签；
- 标记 **2 分钟**内有效，避免重启后重放旧请求；
- 客户端只读文件轮询（2 秒），**不执行任何命令**——这点很关键，见下方"命令会进会话日志"。

## 关键坑（都是踩出来的）

1. **服务必须 inject**：直接取 `ctx.xxx`（例如 `ctx.workingDirectory`）会在加载期抛错，甚至让 DSH 起不来；可选服务用 `ctx.get('…')`，需要等待的用 `ctx.inject([...], cb)`。
2. **preset 子插件行必须是 `file://` 绝对 URL**：裸包名（profile 解析不到）和 Windows 路径（Loader 不认）都会显示 active 但 `never started`。
3. **`file://` 可以指向 `app.asar` 内的包**，不必把官方工具复制出来。
4. **子插件配置要满足必填 Schema**（例：`tool-todo` 需要 `allowParallelInProgress`）。
5. **remote 调用返回 `{ ok, value }`**：读 `listing.entries` / `file.text` 永远是 `undefined`，必须先 `unwrap`。
6. **会话 cwd 不是 `workingDirectory.defaultDirectory`**（那是进程目录/profile 目录）；工具与命令里用 `workingDirectory.ensure(agent)`。
7. **命令会写进会话日志**：客户端轮询命令会在对话里刷屏（之前 `wtskin-whoami` 就是这样），客户端与 Host 的静默通道只能用文件/Remote，不能用命令。
8. `followup()` 要带内容：`followup({ content: [{ type:'text', text }], source: { kind:'user' } })`；只 `inject` 不会唤醒模型。

## 命令清单

| 命令 | 面向 | 说明 |
| --- | --- | --- |
| `/wtskinp` | 用户 | 开始流程：问载具/命名、建档（不打开面板） |
| `/wtspwds` | 用户 | 打开取点面板 |
| `wtskin-save` | 内部 | 面板保存四边形（会显示在 `/` 菜单，暂无隐藏手段） |

已删除：`wtskin-diag`、`wtskin-whoami`。

## 待验证 / 待办

- [ ] 面板保存 → `project.json` 出现 `image: ""` 的图层（写通道）
- [ ] 保存后模型被唤醒（会话里出现"面板刚保存了…"的下一回合）
- [ ] 模式内完整流程：问载具 → 查资料 → 建档 → `/wtspwds` 量面 → 补立绘 → `export` → `read_image` 自检
- [ ] 把 `wtskin-save` 从 `/` 菜单隐藏（改成 Host Remote 服务）
- [ ] README / CHANGELOG 更新到 v3
- [ ] 打包发布 v3.0.0

## 文件地图

```
dsh-wtskin-project-02/
├─ lib/index.js        工具 + 命令 + 预设注册 + 面板桥
├─ lib/project.js      schema / 迁移 / 校验
├─ lib/projects.js     WTSP 目录与命名
├─ lib/persona.js      模式提示词
├─ lib/picker.js       备用取点页生成
├─ client/index.js     悬浮取点器（读标记、读写工程、保存）
├─ preset/wtskin-mode.js  预设子插件（注入 systemPrompt）
├─ python/wt_skin.py   引擎
├─ assets/picker.html  备用取点页
├─ docs/               架构与进度
└─ tests/smoke.mjs     端到端测试
```

## 下次继续

```bash
cd /d/DSH/dsh-wtskin-project-02 && node tests/smoke.mjs "<python>"
# 需要重装插件时：
#   plugin_manager install_bundle target=D:/DSH/dsh-wtskin-project-02
#   plugin_manager set_bundle     target=dsh-wtskin-project
```

诊断文件（都在插件目录）：`.preset-status.json`（预设 roster / broken 原因）。

## 已知限制

- DDS 未压缩（4K 约 64MB）；法线贴图由亮度推导，属近似
- 取点仍靠人工；一次一个工程（面板下拉切换）
- 面板尺寸不持久化（位置会记住）；恢复的图片是 ≤1400px 预览，仅用于量点，导出仍用真实贴图
- 4K 每次全量导出，暂无按图层缓存
