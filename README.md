# dsh-wtskin-project v3

**战争雷霆用户涂装工作室**，以 DSH 插件形式发布。把「问载具 → 查资料 → 建档 → 量四边形 → 放图层 → 导出 DDS + blk」做成一条与模型协作的流程，并在 DSH 里内置了一个可拖拽缩放的取点悬浮窗。

## 三种东西，一次安装

一个 bundle 同时提供：

1. **Host 插件**：工具、导出引擎、面板桥；
2. **Client 半**：取点悬浮窗（`shell.overlay`）；
3. **Agent 预设「战雷画涂装模式」**：出现在会话的模式下拉里。

## 怎么开始

新开会话，模式选 **「战雷画涂装模式」**，然后：

```
/wtskinp
```

它会先把载具和涂装名问清楚，再查资料、建档。也可以直接带上参数：

```
/wtskinp 苏-27 海天
```

工程目录固定在**会话工作区**下：

```
<cwd>/WTSP/<载具>_<名称>/
├─ project.json
├─ picker.html        （备用取点页）
└─ out/               （导出产物）
```

`WTSP` 已存在就复用；同名工程自动加 `-2`、`-3`。

## 打开取点面板

只有两条触发方式：

| 触发 | 怎么做 |
| --- | --- |
| 用户 | 输入 `/wtspwds` |
| 模型 | 调用 `dsh_wtskin_picker`（描述为"打开取点面板"，模型认为该量面时会调） |

两者都只写一个 `WTSP/.open` 时间戳，面板 2 秒内轮询到就出现；标记 2 分钟内有效，重启不会重放旧请求。启动时**不会**自动弹出。

## 取点

1. 面板里「选择图片」，拖入或粘贴一张贴图预览（1600 左右最好，缩放按画布自动算）；
2. 点「四点框选」，按 **前缘 1、前缘 2、后缘 1、后缘 2** 点四个角；
3. 粉色的「弦」线就是引擎用来定图层高度的线——对不上说明点序不对；
4. 填面名，点「保存面」——四边形直接写进 `project.json`，模型会被自动叫醒接着干。

面板可拖动标题栏移动、右下角缩放、「—」最小化成小浮条、「×」关闭。

## 工具

| 工具 | 作用 |
| --- | --- |
| `dsh_wtskin_project` | 建 / 读 / 更新工程；`create` 可只给 `vehicle` + `name`，目录自动落在 WTSP |
| `dsh_wtskin_layer` | 图层增删改查、排序（`move`）、批量（`addMany`） |
| `dsh_wtskin_export` | 合成并输出 PNG、DDS、预览、四边形调试图、可选法线、blk，返回逐层报告 |
| `dsh_wtskin_picker` | 打开取点面板（模型侧触发） |
| `dsh_wtskin_presets` | 内置机型预设 |
| `dsh_wtskin_convert` | TGA / DDS / PNG / JPG 转 PNG（游戏素材转成可编辑格式） |
| `dsh_wtskin_install` | 把导出的 DDS + blk 装进 `UserSkins/<文件夹>/`，blk 自动按机型名命名 |
| `dsh_wtskin_theme` | 主题换色：按渐变调色板重绘原皮（`base.source`），`detail=keep` 保留铆钉细节 / `detail=flat` 抹成纯色块 |
| `dsh_wtskin_finalize` | 项目确认完成后清空 `WTSP/temporary`（下载的参考皮肤） |
| `dsh_wtskin_reference` | 从 WT Live 下载参考涂装到 `WTSP/temporary/`（或导入 zip），返回 blk 与贴图清单 |

## 坐标语义

`project.json` 里的每个坐标都是**最终贴图像素**。面板已经把预览坐标乘过一次缩放，工程里没有 `quadScale`，引擎也不会再乘。v1 的工程读取时会自动迁移（丢掉 `quadScale` 即可复原）。

## 导出产物

```
out/
├─ q_5l_c.png / .dds
├─ q_5l_c_n.png / _n.dds      （output.normal.enabled）
├─ preview.png                （模型用 read_image 自检）
├─ _preview_quads.png         （四边形调试图）
└─ q_5l.blk
```

导出报告包含逐层弦长、目标高度、包围盒、覆盖像素、重叠与警告。

## 安装

```bash
# 推荐：DSH 插件管理器
#   install_bundle target=<本目录>
# 或
dsh plugin --profile desktop add link:D:/path/to/dsh-wtskin-project-02
```

装完重启 DSH：工具、`/wtskinp`、`/wtspwds` 与模式预设都在启动时注册。

## 与 DSH 版本的关系

插件**不声明、不安装任何 DSH 宿主包**（没有 `dependencies` / `peerDependencies`）：
`dsh-tools`、`dsh-tool-*` 等在运行时按可用性解析（app.asar 或宿主提供），缺失时走内置回退。
因此升级 DSH 不会因为插件锁定的旧版本而崩。

## Python 环境

引擎需要 Python 3 + Pillow + numpy。查找顺序：工具参数 `pythonPath` → 插件配置 `pythonPath` → 环境变量 `DSH_PYTHON` → `python`。

```yaml
- id: dsh-wtskin-project
  name: dsh-wtskin-project
  config:
    pythonPath: C:/Users/you/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
```

## 命令

| 命令 | 面向 | 说明 |
| --- | --- | --- |
| `/wtskinp [载具] [名称]` | 用户 | 开始流程、建档 |
| `/wtspwds` | 用户 | 打开取点面板 |
| `wtskin-save` | 内部 | 面板保存通道（会出现在 `/` 菜单里，暂无隐藏手段） |

## 已知限制

- DDS 未压缩（4K 约 64MB）；法线贴图由亮度推导，属近似
- 取点靠人工；一次一个工程（面板下拉切换）
- 面板尺寸/位置不持久化
- 4K 每次全量导出，暂无按图层缓存

## 文档

- [docs/progress.md](docs/progress.md) —— 当前进度、踩坑与待办
- [docs/v3-architecture.md](docs/v3-architecture.md) —— 设计与实现变更

## 许可

MIT。用户素材（角色立绘等）的版权由使用者自行负责。
