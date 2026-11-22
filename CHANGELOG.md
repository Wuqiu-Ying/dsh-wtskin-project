# Changelog

## 3.0.2

### Changed

- 去掉 `peerDependencies` / `peerDependenciesMeta`：插件**不再声明任何宿主包版本**。
  宿主工具按运行时可用性解析（app.asar 路径 / 动态 import），缺失时使用内置回退，
  避免插件与 DSH 版本互相绑定。


## 3.0.1

### Fixed

- 6 个 `@deepseek-ai/*` 宿主包被精确版本写在 `dependencies` 里，会随插件装进 profile 并遮住宿主自己的新版本；宿主升级后旧副本顶替新副本，导致 DSH 启动失败。
- 改为 `peerDependencies`（`>=0.1.1-rc.2 <0.3.0`）并标记 optional，不再实体化进 profile；运行时由宿主提供，缺失时插件回退到内置的 JSON Schema 转换与 app.asar 路径。


## 3.0.0

v3 的目标：把取点器搬进 DSH，并让它成为「模式」的一部分。

### Added

- Agent 预设 **「战雷画涂装模式」**，经 `ctx.agentPresets.register()` 运行时注册，子插件以 `file://` 指向可加载的模块。
- **取点悬浮窗**（`shell.overlay`）：标题栏拖动、右下角缩放、最小化、关闭；不再依赖右栏 tab。
- `/wtspwds` 打开取点面板；`dsh_wtskin_picker` 成为模型侧触发，两者都经 `WTSP/.open` 时间戳。
- `WTSP/<载具>_<名称>/` 工程布局：清洗、重名 `-2`、复用根目录、按会话工作区落盘。
- 面板保存写 `project.json` + `faces.json`；保存不唤醒模型，用户手动「提交面数据」后模型 `dsh_wtskin_import` 导入。
- `/wtskinp` 回归，支持 `vehicle` + `name` 直接建档。
- **主题换色** `dsh_wtskin_theme`：按渐变调色板重绘原皮；`detail=keep` 保留铆钉细节，`detail=flat` 抹平成纯色块。
- **`dsh_wtskin_convert`**：TGA / DDS / PNG / JPG → PNG。
- **`dsh_wtskin_install`**：导出物装进 `UserSkins/<文件夹>/`，blk 按机型名命名。
- **`dsh_wtskin_finalize`**：项目完成时清空 `WTSP/temporary`。
- 取点面板：任意 3–64 点多边形、拖点/右键删点、滚轮缩放、中键平移、彩色的边与边名、每面「旋转 180°」「弦长占比」、删除此面、原皮/主题皮底图切换。

### Changed

- 面板读写改走 `ctx.remote.workspaceFiles`（读）与内部命令 `wtskin-save`（写）。
- 预设的注册、面板触发、工程路径全部以会话上下文为准。

### Fixed

- remote 返回 `{ ok, value }`：取 `entries` / `text` 前必须解包（之前面板永远读不到工程、标记恒为 0）。
- 会话 cwd 用 `workingDirectory.ensure(agent)`，不再落到 profile 目录。
- `followup()` 带消息内容；只 `inject` 不会唤醒模型。
- 预设子插件行必须 `file://` 绝对 URL（裸包名与 Windows 路径都会 "never started"）。
- `crop` 按画布坐标裁源图时未换算尺寸比（源图更小时会裁错区域）。
- 建工程时未写入 `vehicle`，导致安装工具无法确定机型名。
- `tool-todo` 必填 `allowParallelInProgress`。
- 服务访问一律 inject 或 `ctx.get`，避免加载期崩溃。

### Removed

- 右栏 tab 面板与"自动打开/常驻小标签"方案。
- 调试命令 `wtskin-diag`、`wtskin-whoami`（命令执行会写进会话日志）。

### Known

- `wtskin-save` 仍会出现在 `/` 菜单，隐藏它需要改成 Host Remote 服务。
- 面板保存 → 写盘 → 唤醒模型的端到端链路尚未人工验证。


## 2.0.0

v2 的目标：让「和 AI 一起做涂装」这件事真正闭环——坐标不再错、模型能看见结果、取点在 DSH 里完成。

### Added

- `/wtskinp [载具]` 命令：检查浏览器能力 → 建工程 → 生成取点页 → 把工作流交给模型。
- `dsh_wtskin_picker`：为工程生成 `picker.html`（取点页）。
- 取点页：自动缩放、面名、面列表、已添加面回显、弦线可视化、`复制全部` 输出 `name=[[x,y],…]`。
- `dsh_wtskin_layer action=addMany`：一次写入多个面。
- `dsh_wtskin_layer action=move`：调整图层叠放顺序。
- `dsh_wtskin_project preset=<id>`：按机型预设补全贴图名与 blk 条目。
- 导出产物新增 `preview.png`、`_preview_quads.png`、逐层报告（弦长 / 覆盖像素 / 重叠 / 警告）。
- `output.normal`：从成品亮度推导法线贴图，输出 `_n.png` / `_n.dds` 并自动补 blk 条目。
- 引擎支持 `--out <file>`，结果写文件而不是 stdout。
- 冒烟测试覆盖像素落位、点序、自交检测、迁移、取点页与命令。

### Changed

- **坐标语义**：`project.json` 中所有四边形均为最终贴图像素；删除项目级与图层级 `quadScale`。
- 引擎不再重排四边形点序（重排会交换前后缘）；改为校验自交与非平行边。
- 取点器从「Host 起随机端口 + 独立浏览器窗口」改为「工程内 HTML，用 DSH 右侧文件预览打开」。
- `@deepseek-ai/dsh-tools` 解析失败时退回直传定义，插件仍可加载。

### Fixed

- 双重缩放：v1 取点页存的坐标已乘 scale，引擎又乘 `quadScale`。
- 调色带未覆盖 0..1 时出现黑色条带。
- 缺图层的 `image` 被静默跳过。
- 四点顺序错误时无任何提示。
- 预览缩放靠人工填写。
- 四点模式下单点标记与四点标记叠加。
- 受限运行时无法捕获子进程 stdout 导致导出失败。

### Removed

- `lib/measure-server.js`（本地取点服务器）。
- `quadScale` 字段及其配置。

### Deferred to v3

- Client 半：`postMessage` 回传坐标、自动打开右栏、插件自有面板。
- 左右镜像 / 对称图层、DXT1/DXT5 压缩、一键装入 UserSkins、按图层缓存。
