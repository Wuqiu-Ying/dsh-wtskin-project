# dsh-wtskin-project

[English](README.en.md) | 中文

**战争雷霆用户涂装工作室**，以 DSH 插件形式发布。把「量 UV → 逐面放角色 → 合成 → 导出 DDS + blk」这套流程变成模型可调用的工具，并内置了四点多边形取点器。

## 工具

| 工具 | 作用 |
| --- | --- |
| `dsh_wtskin_project` | 创建 / 读取 / 更新 `project.json`（画布尺寸、底漆、输出设置） |
| `dsh_wtskin_layer` | 增删改查图层：图片 + 4 点四边形 + 旋转 / 翻转 / 偏移 / 裁切线 |
| `dsh_wtskin_export` | 合成底漆与全部图层，输出 PNG、DDS、预览图和 `.blk` |
| `dsh_wtskin_presets` | 列出内置机型预设（贴图名与 blk 条目） |
| `dsh_wtskin_measure` | 启动本地取点页（四点多边形模式）并返回 URL |

## 取点器

`dsh_wtskin_measure` 会在 `127.0.0.1` 上起一个只服务单页的本地服务器（随机端口），把内置的
`assets/measure.html`（基于 `image-pixel-coords.html` 扩展）发给你：

- 拖入 / 粘贴一张贴图预览
- 点「四点框选」，依次点 4 个点，自动画出四边形
- 「缩放 ×」默认取工程的 `quadScale`（比如 1600 预览对应 2.56）
- **保存到工程**：直接把四边形写进 `project.json` 的指定图层（该图层带自己的 `quadScale`，不会被二次缩放）
- **复制**：输出 `[[x,y],[x,y],[x,y],[x,y]]`，可以手动交给 `dsh_wtskin_layer`

页面只用原生 JS，不依赖网络。

## 快速开始

```text
dsh_wtskin_project  dir=D:/skins/q5l action=create data={"quadScale":2.56,"width":4096,"height":4096}
dsh_wtskin_measure  dir=D:/skins/q5l id=wing_u scale=2.56
# 打开返回的 URL，量完点「保存到工程」
dsh_wtskin_layer    dir=D:/skins/q5l action=update id=wing_u layer={"image":"p8.png","size":"chord","factor":1.3,"rotate180":true}
dsh_wtskin_export   dir=D:/skins/q5l
```

### 尺寸模式

- `chord`：按四边形前后缘中点距离缩放（最常用）
- `quadHeight`：按四边形包围盒高度
- `height`：直接给像素高度
- `widthAdapt`：窄条面板（翼根）用，按宽度适配

### 图层字段

```json
{
  "image": "path/to/character.png",
  "quad": [[x0,y0],[x1,y1],[x2,y2],[x3,y3]],
  "quadScale": 1,
  "size": "chord",
  "factor": 1.2,
  "offset": [0, -40],
  "rotate180": true,
  "flip": false,
  "clipLine": [[x0,y0],[x1,y1]],
  "expand": 8,
  "opacity": 1
}
```

前两个点是前缘，后两个点依次是后缘 —— 引擎用它算弦长和中点。`quadScale` 是该图层自己的坐标缩放，覆盖工程级设置。

## 安装

```bash
# 有 dsh CLI
dsh plugin --profile desktop add link:D:/path/to/dsh-wtskin-project

# 没有 CLI
node install.mjs --profile desktop
```

然后重启 DSH（工具在启动时注册）。卸载：删掉 `profiles/<profile>/node_modules/dsh-wtskin-project` 和 patch 里对应的行。

## Python 环境

引擎需要 Python 3 + Pillow + numpy。DSH 自带运行时里就有：

```
C:\Users\<用户>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
```

查找顺序：调用参数 `pythonPath` → 插件配置 `pythonPath` → 环境变量 `DSH_PYTHON` → `python`。
建议在插件配置里写死一次：

```yaml
- id: dsh-wtskin-project
  name: dsh-wtskin-project
  config:
    pythonPath: C:/Users/you/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
```

## 产物

```
out/
├── q_5l_c.png       合成结果（4096）
├── q_5l_c.dds       32 位未压缩 DDS（约 64MB）
├── preview.png      1600 预览
└── q_5l.blk         引导文件
```

整个 `out` 复制进 `War Thunder/UserSkins/` 即可。

## 原理

1. **底漆**：读一张现有贴图做细节载体（铆钉、蒙皮线），按亮度映射到自定义色带，可选边缘发光与点阵。
2. **图层**：仿射变换（旋转 → 缩放 → 平移到四边形中心），再用四边形做 alpha 裁切，可选沿直线做半平面裁切。
3. **导出**：Pillow 写 32 位未压缩 DDS（BGRA），并生成 blk。

## 已知限制

- 不自动测量 UV：四边形要靠取点器人工量。
- DDS 未压缩：4K 约 64MB；需要 DXT5 请用 PS + NVIDIA DDS 插件另存。
- 法线贴图（`_n`）不自动生成。

## 许可

MIT。用户素材（角色立绘等）的版权由使用者自行负责。
