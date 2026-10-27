# dsh-wtskin-project v2

**战争雷霆用户涂装工作室**，以 DSH 插件形式发布。把「问载具 → 查资料 → 建档 → 量四边形 → 放图层 → 导出 DDS + blk」变成一条与模型协作的完整流程。

v2 的关键变化：**所有四边形坐标统一为最终贴图像素**（v1 会缩放两次），**取点页在 DSH 右侧预览里打开**（不再起本地 HTTP 服务），**导出会生成预览图和调试图**让模型自己检查结果。

## 怎么开始

在对话输入：

```
/wtskinp
```

或带上型号：

```
/wtskinp Q-5L
```

命令会：

1. 检查当前会话有没有浏览器控制能力（没有就提示先装插件，不进入工作流）；
2. 在 `wt-skins/` 下建一个工程（`project.json` + `picker.html`）；
3. 把后续步骤交给模型：问载具 → 搜索资料 → 补全工程 → 等你取点。

## 取点流程（M 模式）

1. 在 DSH 右侧文件预览里打开工程目录的 `picker.html`；
2. 拖入或粘贴一张贴图预览（建议 1600 宽），缩放会按画布自动算好（4096 画布 / 1600 预览 = 2.56）；
3. 点「四点框选」，按 **前缘 1、前缘 2、后缘 1、后缘 2** 的顺序点 4 个角；
4. 看粉色的「弦」线是否是你要的那条——它就是引擎用来定图层高度的线；
5. 填面名，点「添加面」，继续量下一个面；
6. 量完点「复制全部」，得到：

   ```
   wing_l=[[614,604],[2662,604],[2662,1833],[614,1833]]
   wing_r=[[2918,604],[4966,604],[4966,1833],[2918,1833]]
   ```

7. 粘回对话，模型会用 `dsh_wtskin_layer action=addMany` 一次写入。

## 工具

| 工具 | 作用 |
| --- | --- |
| `dsh_wtskin_project` | 建 / 读 / 更新工程：画布、机型预设、底漆、输出设置；建档时顺手生成取点页 |
| `dsh_wtskin_layer` | 图层增删改查 + 排序（`move`）+ 批量添加（`addMany`） |
| `dsh_wtskin_export` | 合成并输出 PNG、DDS、预览、四边形调试图、可选法线贴图、blk，返回逐层报告 |
| `dsh_wtskin_picker` | 重新生成取点页（工程改了之后） |
| `dsh_wtskin_presets` | 内置机型预设（贴图名、blk 条目） |

## 坐标语义（v2 唯一规则）

**`project.json` 里的每个坐标都是最终贴图像素。** 取点页已经把预览坐标乘过一次缩放，工程里不再有任何 `quadScale`，引擎也不会再乘。

v1 的工程会被自动迁移：v1 存的本来就是乘过的坐标，所以只要丢掉 `quadScale`，位置就回到正确的地方，不需要重新量。

## 导出产物

```
out/
├── q_5l_c.png          合成结果
├── q_5l_c.dds          32 位未压缩 DDS
├── q_5l_c_n.png/_n.dds 法线贴图（output.normal.enabled）
├── preview.png         1600 预览（模型用 read_image 检查）
├── _preview_quads.png  四边形调试图（哪一层贴在哪儿）
└── q_5l.blk            引导文件
```

`dsh_wtskin_export` 还会返回逐层报告：弦长、目标高度、包围盒、覆盖像素、重叠像素，以及「点序不构成四边形」这类警告。

## v1 问题 → v2 修复

| v1 问题 | v2 |
| --- | --- |
| 取点页存的坐标已乘 scale，引擎又乘 `quadScale`，位置翻倍 | 删除 `quadScale`，坐标即最终像素；v1 工程自动迁移 |
| 重新测量会清空图层已有的 `image` | 取点页不再写工程（M 模式），不存在覆盖 |
| 四点顺序错了不报错 | 引擎校验自交 / 非平行边；取点页直接画出「弦」线 |
| 图层顺序无法调整 | `dsh_wtskin_layer action=move` |
| 调色带没覆盖 0..1 时出现黑块 | `np.interp` 端点钳制，不再有黑带 |
| 预览固定 1600，缩放靠手填 | 按工程画布 / 图片宽度自动算，可手动覆盖 |
| 单点读坐标和四点标记两套叠加 | 四点模式下隐藏单点标记 |
| 缺图层的 `image` 被静默跳过 | 导出前校验并直接报错，指明图层 |
| 只能一层一层加 | `addMany` 一次写入所有面 |
| 没有法线贴图 | `output.normal` 生成 `_n.dds` 并自动加 blk 条目 |
| 导出结果模型看不见 | 额外输出 `preview.png`、`_preview_quads.png`、逐层报告 |
| 引擎结果走 stdout，受限运行时抓不到 | 引擎写结果文件，子进程 `stdio: 'ignore'` |
| `@deepseek-ai/dsh-tools` 不在 profile 里时插件加载即失败 | 解析不到时退回定义直传，插件仍可加载 |

## 安装

```bash
# 有 dsh CLI
dsh plugin --profile desktop add link:D:/path/to/dsh-wtskin-project-02

# 没有 CLI
node install.mjs --profile desktop
```

装完重启 DSH（工具和 `/wtskinp` 在启动时注册）。

## Python 环境

引擎需要 Python 3 + Pillow + numpy。DSH 自带运行时里就有：

```
C:\Users\<用户>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
```

查找顺序：工具参数 `pythonPath` → 插件配置 `pythonPath` → 环境变量 `DSH_PYTHON` → `python`。

```yaml
- id: dsh-wtskin-project
  name: dsh-wtskin-project
  config:
    pythonPath: C:/Users/you/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
    projectsDir: D:/skins
```

## 已知限制

- 取点结果要手动复制粘回（Client 半的自动回传排在 v3）。
- 不自动测量 UV，四边形仍靠人工点。
- DDS 未压缩：4K 约 64MB；需要 DXT5 请用 PS + NVIDIA DDS 插件另存。
- 法线贴图由成品亮度推导，是近似值，不能替代真实高模烘焙。
- 4K 每次导出全量重算，暂无按图层缓存。

## 下一步（v3）

v3 的设计记录见 [docs/v3-architecture.md](docs/v3-architecture.md)，当前进度与踩坑记录见 [docs/progress.md](docs/progress.md)：模式下拉入口「战雷画涂装模式」、右侧栏原生取点面板、`WTSP` 目录规则，以及面板与模型通过 Host 中转的通信方式。

## 许可

MIT。用户素材（角色立绘等）的版权由使用者自行负责。
