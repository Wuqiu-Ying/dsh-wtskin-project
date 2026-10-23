# Changelog

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
