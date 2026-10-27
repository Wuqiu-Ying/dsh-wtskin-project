# 进度记录

> 2026-10-27。v3 开发中，随时可能断电，所有代码都已提交。
> 详细设计见 [v3-architecture.md](v3-architecture.md)。

## 一句话状态

v2（M 模式）功能完整、测试全过；v3 的 **「战雷画涂装模式」已出现在模式菜单**、**右栏取点面板可用**、**WTSP 目录与保存桥已就位**。剩下的是「模式内完整流程实测 + 保存后通知模型 + 收尾文档」。

## 已完成

### v2（可用，M 模式）

- 5 个工具：`project / layer / export / picker / presets`
- 引擎：调色、四边形校验、DDS、预览、四边形调试图、法线贴图
- v1 工程自动迁移（去掉 `quadScale` 双重缩放）
- `node tests/smoke.mjs` 全过（含像素落位、自交检测、迁移）
- 提交：`5c2968b`

### v3 基础设施

- Host + Client 双半插件（`lib/` + `client/index.js`）
- `/wtskinp` 命令、`wtskin-save` 内部命令
- `WTSP/<载具>_<名称>/` 建档（清洗、重名 -2、复用 WTSP）
- 右栏 tab「涂装取点」：工程下拉、载入贴图、四点、弦线、保存、面列表
- 面板 ↔ Host 通道：`ctx.remote.workspaceFiles` 读、`ctx.remote.commands.execute` 写
- Step 0 探针结论记录在 [v3-architecture.md](v3-architecture.md) 第 8 节
- 提交：`70e519f` 起，最新 `ef30ce1`

### 预设（这轮踩了很久的坑）

「战雷画涂装模式」现在是健康状态（`broken: null`），六行子插件：

```
mode（本地工作流提示词） + time-context + tool-fs + tool-ask-user + tool-todo + tool-web
```

**必须记住的五条**：

1. YAML 声明的 preset 行在这个 profile 里不会进 Web roster；
2. 运行时注册要走 `ctx.inject(['agentPresets'], …)`——激活时 `ctx.get` 还拿不到；
3. **子插件行必须是 `file://` 绝对 URL**：裸包名（profile 解析不到）和 Windows 路径（Loader 不认）都会显示 active 但 `never started`；
4. `file://` 指向 **app.asar** 里的包**可以**启动，不需要复制官方工具；
5. 每行配置要满足插件必填 Schema（例：`tool-todo` 需要 `allowParallelInProgress: true`）。

另有一条通用规则：**任何服务都不能直接取属性，必须在 `inject` 里声明，或走 `ctx.get('…')`**，否则插件加载即抛错（曾把 DSH 启动打崩）。

## 尚未验证 / 待办

- [ ] 模式内完整流程实测：新会话选模式 → 问载具/命名 → 查资料 → 建档 → 面板取点 → 补立绘 → 导出 → `read_image` 自检
- [ ] 面板保存后主动通知模型（`agent.inject` + `followup`）
- [ ] 把 `wtskin-save` 从 `/` 菜单隐藏（需改成 Host Remote 服务）
- [ ] 自动打开面板的 `.open` 标记链路实测（依赖上一条完整流程）
- [ ] README / CHANGELOG 更新到 v3（目前仍描述 v2）
- [ ] `assets/picker.html` 备用页在新流程下的说明
- [ ] 打包/发布流程（v3.0.0）

## 文件地图

```
dsh-wtskin-project-02/
├─ lib/index.js        工具 + /wtskinp + 内部命令 + 预设注册
├─ lib/project.js      schema / 迁移 / 校验
├─ lib/projects.js     WTSP 目录与命名
├─ lib/persona.js      模式提示词（Host 与预设共用）
├─ lib/picker.js       备用取点页生成
├─ client/index.js     右栏面板 + 打开标记 watcher
├─ preset/wtskin-mode.js  预设的子插件（注入 systemPrompt）
├─ python/wt_skin.py   引擎
├─ assets/picker.html  备用取点页
├─ docs/               架构与进度
└─ tests/smoke.mjs     端到端测试
```

## 下次怎么继续

```bash
# 1. 确认代码与测试
cd /d/DSH/dsh-wtskin-project-02 && node tests/smoke.mjs "<python路径>" && git status

# 2. 若 profile 里没装好
#    plugin_manager install_bundle target=D:/DSH/dsh-wtskin-project-02
#    plugin_manager set_bundle     target=dsh-wtskin-project

# 3. 诊断文件（预设 roster 与 broken 原因）
cat D:/DSH/dsh-wtskin-project-02/.preset-status.json
```

重启后：右栏如果被上次布局恢复出来，点一次 ×；新会话选「战雷画涂装模式」即可。

## 已知限制

- DDS 未压缩（4K 约 64MB）；法线贴图由亮度推导，属近似
- 取点依赖人工；面板一次一个工程，多工程靠下拉切换
- 4K 每次全量导出，暂无按图层缓存
