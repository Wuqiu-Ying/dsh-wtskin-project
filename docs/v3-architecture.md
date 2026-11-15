# dsh-wtskin-project v3 架构记录

> 状态：**设计定稿，尚未实现**。仓库里当前可运行的是 v2（M 模式，取点页 + 复制粘贴），提交 `5c2968b`。
> 记录时间：2026-10-27

---

## 1. 目标

把「选模式 → 问载具与命名 → 查资料 → 建档 → 取点 → 出图」做成一条**不需要复制粘贴**的闭环，入口是模式下拉里的「战雷画涂装模式」。

对比：

| | v1 | v2（现在） | v3（本文） |
| --- | --- | --- | --- |
| 入口 | 工具调用 | `/wtskinp` 命令 | 模式下拉「战雷画涂装模式」 |
| 取点 | 独立浏览器窗口 + 本地 HTTP | 右侧文件预览 + 复制粘贴 | 右侧栏自有面板，直接落盘 |
| 坐标回传 | 用户复制 | 用户复制 | 面板写入，模型被通知 |
| 模型自检 | 无 | 预览图 + 调试图 | 同 v2 |

---

## 2. 决策记录

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 面板形态 | **A：原生 React 面板**，取消 `postMessage` |
| 2 | 入口 | **只要模式**，删掉 `/wtskinp` 命令 |
| 3 | v2 的取点页 | **保留** `assets/picker.html` 作为离线备用与交互参考，不进主流程 |
| 4 | 目录命名 | 默认下划线 `载具_自定义名`，用户指定分隔符时照办 |
| 5 | 自定义名 | 模型在**首轮回复**里连同载具一起问；用户直接说了就不问 |
| 6 | 工程目录 | `<工作目录>/WTSP/<载具>_<自定义名>/`，`WTSP` 已存在则复用 |
| 7 | 建目录时机 | 不在激活模式时建；**第一次落盘**（`project.json`）时建 |

---

## 3. 现状（v2，可运行）

```
bundle: cordis.patch.yml
  └─ Host 插件 dsh-wtskin-project
       ├─ lib/index.js    5 个工具 + /wtskinp + systemPrompt + 浏览器能力检测
       ├─ lib/project.js  project.json v2 schema / v1 迁移 / 校验
       ├─ lib/picker.js   生成 <project>/picker.html
       └─ python/wt_skin.py  导出：PNG / DDS / preview / _preview_quads / _n / blk / report
```

链路：`/wtskinp` → 建工程 + 生成 `picker.html` → 用户在右侧文件预览手动打开 → 四点取点 → 复制 → 粘回对话 → `dsh_wtskin_layer addMany` → `dsh_wtskin_export` → `read_image` 自检。

已完成（`node tests/smoke.mjs` 全过）：双缩放修正、调色带钳制、四边形自交校验、图层排序、批量添加、法线贴图、v1 工程迁移、导出报告。

---

## 4. v3 目标架构

### 4.1 一个 bundle，三类产物

```
dsh-wtskin-project（一次 install_bundle）
├─ Host 插件行        工具 + 引擎 + 内部保存命令 + 浏览器检查 + WTSP 建档
├─ Client 半（dsh.client）  右栏 tab 类型「涂装取点」+ 面板组件
└─ preset 行          preset-wtskin = 模式下拉里的「战雷画涂装模式」
```

### 4.2 目录结构（目标）

```
dsh-wtskin-project-02/
├─ package.json          dsh.bundle.patch + dsh.client
├─ cordis.patch.yml      Host 插件行 + preset-wtskin 行
├─ lib/
│  ├─ index.js           工具注册、浏览器能力检查、面板桥
│  ├─ project.js         schema / 迁移 / 校验（沿用 v2）
│  ├─ projects.js        WTSP 目录规划与命名（新增）
│  ├─ engine.js          python 子进程（从 index.js 拆出）
│  └─ bridge.js          面板与工具共用的保存方法（新增）
├─ client/
│  └─ index.js           右栏 tab + 面板（新增）
├─ python/wt_skin.py     引擎（沿用 v2）
├─ assets/picker.html    备用取点页（保留）
├─ presets/vehicles.json
└─ tests/
```

### 4.3 用户路径

```
下拉选「战雷画涂装模式」
  → 新会话挂载 preset-wtskin（persona 已含工作流）
  → 首轮：模型一次问两件事（载具 / 涂装名），并检查浏览器能力
  → web_search / web_fetch 查资料，写入 notes
  → dsh_wtskin_project create
        ├─ 确保 <cwd>/WTSP 存在（已存在则复用）
        ├─ 建 WTSP/<载具>_<名称>（重名加 -2）
        └─ 写 project.json（首个文件，触发建目录）
  → Client：ctx.sidebarRight.openTab('wtskin-picker')
  → 用户取点 → 面板保存 → project.json
  → Host 通知模型 → 补 image → export → read_image 自检 → 迭代
```

### 4.4 预设声明（草案）

```yaml
- insert:
    - id: dsh-wtskin-project
      name: dsh-wtskin-project

    - id: preset-wtskin
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: wtskin
        name: 战雷画涂装模式
        description: 与 AI 一起做战争雷霆载具涂装：查资料、量 UV、放立绘、导出 DDS。
        order: 10
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                你在「战雷画涂装模式」下工作。首轮先问清载具与涂装名，
                再查资料、建档，然后引导用户在右栏面板取点。
              complete: true
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config: { read: true, readImage: true, write: true, edit: true }
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
          # 浏览器工具行按 profile 实际包名补（待确认）
```

预设只对**新会话**生效；已有会话保留启动时的 revision。

---

## 5. 面板设计

### 5.1 注册（两步，都在 `ctx.effect` 里）

```js
ctx.sidebarRightTabs.register({
  id: 'dsh-wtskin-project/picker',
  kind: 'wtskin-picker',
  title: () => '涂装取点',
  guide: [{ id: 'picker', title: '涂装取点', description: '量机身四边形' }],
  keepMounted: true,
});

ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: 'dsh-wtskin-project/picker' },
  PickerPanel,
);
```

打开：

```js
ctx.sidebarRight.openTab('wtskin-picker', { params: { dir } });
```

`openTab` 会展开右栏并聚焦该 tab。Ctrl+Alt+B 是右栏的显隐开关（`ctx.shortcuts` 注册，Windows 上 Mod=Ctrl），不需要我们自己实现。

### 5.2 布局

```
┌ 涂装取点 ────────────────────────────────┐
│ 工程: [WTSP/Q-5L_霓虹夜航 ▾]  4096×4096   │
├──────────────────────────────────────────┤
│                                          │
│   <img> + SVG 覆盖层                     │
│   · 已保存面（青色实线 + 名字）          │
│   · 当前四点（编号）                     │
│   · 弦线（粉色虚线 + 长度）              │
│                                          │
├──────────────────────────────────────────┤
│ [选择图片] [四点框选] [撤销] [保存]      │
│ 面列表: face_1 ×  face_2 ×               │
│ 状态: 已保存 2 个面 / 保存失败: …        │
└──────────────────────────────────────────┘
```

### 5.3 状态与数据

- 唯一真相是 `project.json`；面板不缓存权威状态。
- 读取：`ctx.remote.workspaceFiles`（`list` / `read` / `stat`）。
- 写入：`ctx.remote.commands.execute()` → Host 内部命令 `wtskin-save` → 与工具共用的保存方法。
- 刷新：打开时、保存后、窗口重新聚焦时各拉一次（比对 mtime）。
- 样式只用 `--dsw-alias-*` token；不 import 宿主内部组件包。

### 5.4 打开时机

1. 首选：Client 能读到当前会话的预设 id（`ctx.sessions.binding()` 待验证），是 `wtskin` 就 `openTab`。
2. 退路：第一次手动打开后，右栏布局按会话持久化（localStorage），以后自动恢复。

---

## 6. 模型与面板的通信

### 6.1 原则

**模型和面板不直连，都通过 Host；`project.json` 是唯一真相。**

```
              ┌──────────────────────────────┐
              │            Host              │
              │  工具        内部命令/桥      │
              │  project.json ←→ 校验/引擎    │
              └───────┬──────────────┬───────┘
      工具调用/结果    │              │ ctx.remote
      agent.inject     │              │
                       ▼              ▼
                  ┌────────┐    ┌──────────┐
                  │  模型  │    │   面板    │
                  └────────┘    └──────────┘
                    （两者之间没有通道）
```

### 6.2 四个方向

| 方向 | 机制 | 例子 |
| --- | --- | --- |
| 模型 → Host | 工具调用 | `dsh_wtskin_layer action=addMany`、`dsh_wtskin_export` |
| Host → 模型 | 工具结果；主动唤醒 | 面板保存后 `agent.inject()` + `followup()` |
| 面板 → Host | `ctx.remote.commands.execute()`（内部命令） | 保存四点、删除面 |
| Host → 面板 | 面板自己拉 `ctx.remote.workspaceFiles` | 打开/保存后/聚焦时读取 |

### 6.3 一次保存的时序

1. 用户点「保存」。
2. 面板 `ctx.remote.commands.execute('wtskin-save', { dir, faces })`。
3. Host 校验（自交 / 越界 / 重名）→ 写 `project.json` → 返回 `{ ok, warnings }`。
4. 面板显示结果；失败时显示原因并保留本地编辑。
5. Host 若检测到模型在等，`agent.inject('已保存 face_1、face_2')` + `followup()`。
6. 模型调用 `export`，输出预览；面板下次拉取时看到新画布。

### 6.4 为什么不直连

- Client 没有文件写权限，模型也没有"读界面"的能力。
- 所有改动都落在磁盘上，面板重开、换会话、模型重试都不会丢。
- Host 是唯一校验点，工具调用和面板操作走同一套规则。

---

## 7. WTSP 目录与命名

```
<会话工作目录>/
└─ WTSP/
   ├─ Q-5L_霓虹夜航/
   │  ├─ project.json
   │  ├─ q_5l_c.png / .dds / .blk
   │  └─ out/
   └─ Su-27_海天/
```

| 项 | 规则 |
| --- | --- |
| 根目录 | `<cwd>/WTSP`；存在就复用；同名但是文件则报错，不覆盖 |
| 子目录 | `载具_自定义名`（默认下划线）；用户指定分隔符则照办 |
| 载具名 | 用户输入优先，其次预设 id（`q_5l`） |
| 自定义名 | 模型首轮提问获得；用户直接说了就不问 |
| 清洗 | 去掉 `\ / : * ? " < > |`、首尾空格与点，最长 60 字符 |
| 重名 | 追加 `-2`、`-3`，不覆盖旧工程 |
| 时机 | 第一次落盘时创建；`project.json` 记录 `vehicle` / `name` / 目录 |

---

## 8. Step 0 结论（已实测）

在一个临时探针 bundle 上跑通了，结论如下。

| 待验证项 | 结论 |
| --- | --- |
| 右栏 tab 注册 + 自动打开 | ✅ `ctx.sidebarRightTabs.register` + `ctx.slots.register` + `ctx.sidebarRight.openTab(kind)` 生效，右栏自动展开并选中该 tab |
| 面板读工程 | ✅ `ctx.remote.workspaceFiles.list(sessionId, path, signal)` 返回目录项 |
| 面板写回 Host | ✅ `ctx.remote.commands.execute(sessionId, line, [])` → `{commandId, result:{kind:'success', text:'pong:hi'}}` |
| session id 来源 | ✅ `ctx.sidebarRight.mounted.getSnapshot()` → `"session-<uuid>"`；**必须带前缀**，裸 uuid 报 `gateway/lookup-not-found` |

### 必须记住的两条规则

1. **每个 remote 命名空间都要单独 inject**：`inject: ['remote', 'remote.workspaceFiles', 'remote.commands', …]`。只 inject `remote` 会在第一次访问时报 `cannot get property "remote.workspaceFiles" without inject`。
2. **远端方法的第一个参数是会话 id 字符串**，不是对象：
   - `workspaceFiles.list(sessionId, path, signal)`
   - `workspaceFiles.read(sessionId, path, {offset,limit}, signal)`
   - `commands.execute(sessionId, line, attachments, signal)`
   （传 `{sessionId, workspaceRoot}` 会报 `gateway/input-invalid: workspaceFileScopeId`。）

### 打开时机

`openTab` 在没有挂载会话时会抛错，所以面板的自动打开写成「轮询重试直到成功」，成功一次就停止；页面重载时再执行一次。

### Step 0 未覆盖、留给后续

- 预设 `plugins` 引用我们自己的包（探针预设只挂了 persona）。
- 切换预设只对新会话生效的边界。
- 浏览器能力检测在预设模式下的表现。

---

## 9. 实施步骤

| 步骤 | 产出 | 预计 |
| --- | --- | --- |
| Step 0 探针 | 预设行 + 空面板 + `openTab` + 一次 `wtskin-save` 往返 | 半天 |
| Step 1 面板 | 取点 UI 移植（载图、四点、弦线、面列表、撤销、保存） | 1–2 天 |
| Step 2 串链 | 建档（WTSP）→ 自动打开 → 保存通知模型 → 导出自检 | 1 天 |
| Step 3 收尾 | 预设文案/图标、README/CHANGELOG、v3.0.0 打包 | 半天 |

---

## 10. 风险与退路

| 风险 | 影响 | 退路 |
| --- | --- | --- |
| 读不到 preset id | 面板不能按模式自动开 | 首次手动开，之后靠右栏按会话持久化 |
| `commands.execute` 签名不符 | 面板存不了 | 改为 Host Remote 服务方法（更重，需要 typert 声明） |
| 预设解析不到本地包 | 模式起不来 | 预设只放 persona/工具，插件保持 Host 级 |
| 4K 面板性能 | 拖动卡顿 | 面板只渲染 1600 缩略图，保存时换算回画布坐标 |

---

## 11. 附录：API 速查

```js
// 右栏 tab 类型
ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })

// 面板本体
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)
// Body 内: useTabInfo() → { sidebar, panel, tab }
// tab.navigation.params / tab.actions / tab.visible

// 导航
ctx.sidebarRight.openTab(kind, { params, paneId?, replaceTab?, preferNewPane?, revealIfOpened? })
ctx.sidebarRight.openResource(address, { params })
ctx.sidebarRight.close(tabId) / active() / isExpanded() / toggleExpanded() / toggleFullscreen(target)
ctx.layout.openRightbar(track, fullscreen) / closeRightbar()

// 客户端读写（第一个参数都是会话 id 字符串）
ctx.remote.workspaceFiles.list(sessionId, path, signal)
ctx.remote.workspaceFiles.read(sessionId, path, { offset?, limit? }, signal)
ctx.remote.commands.execute(sessionId, line, attachments, signal)

// 会话 id（带 session- 前缀）
ctx.sidebarRight.mounted.getSnapshot()   // → "session-<uuid>"
ctx.sessions.binding(sessionId)          // 自有字段：sessionId / session / eventSource / ctx

// 叫醒模型
agent.inject(text) + agent.followup()

// 预设
@deepseek-ai/dsh-agent-preset  config: { id, name, description, order, plugins: [...] }
```

---

## 12. 实现变更（2026-10-31）

第 5、6 节是早期设计，实际实现有几处偏离，以本节为准。

| 设计 | 实现 |
| --- | --- |
| 右栏 tab 面板（`sidebar.right.pane.tab`） | **`shell.overlay` 悬浮窗**：标题栏拖动、右下角缩放、可最小化；右栏 tab 方案因注册/可见性问题放弃 |
| 自动打开 / 常驻小标签 | **两条显式触发**：用户 `/wtspwds`、模型 `dsh_wtskin_picker`；两者只写 `WTSP/.open`（epoch 毫秒），面板 **2 秒轮询**读取，**2 分钟**内有效 |
| 客户端通过命令查询状态 | 已删除 `wtskin-diag`、`wtskin-whoami`：**命令执行会写进会话日志**，客户端与 Host 的静默通道只能用文件或 Remote |
| 面板读写用 remote 返回值 | remote 返回 **`{ ok, value }`**，必须先解包；`read` 的正文在 `value.text` |
| 工程按默认目录 | 必须用 **会话 cwd**：`workingDirectory.ensure(agent)`；`defaultDirectory` 是进程目录 |
| — | preset 子插件行必须是 **`file://` 绝对 URL**；指向 `app.asar` 内的模块可以启动 |
| — | 保存后唤醒模型用 `followup({ content, source })`；只 `inject` 不会唤醒 |

命令面：`/wtskinp`（开始流程）、`/wtspwds`（开面板）、`wtskin-save`（内部保存通道，暂时无法从 `/` 菜单隐藏）。

---

## 13. 后续变更（2026-11-15）

| 主题 | 现状 |
| --- | --- |
| 面 | 任意 3–64 点多边形（`quad` 数组），边名/颜色随面保存；4 点仍走弦长语义，多于 4 点用包围盒高度 |
| 尺寸模式 | 新增 `crop`（源图 1:1 取块，按源图/画布比例换算）与 `cover`（铺满包围盒） |
| 面板 | 左键加点、右键删点、拖点、滚轮缩放、中键平移、旋转 180°、弦长占比、删除此面 |
| 保存 | 不再唤醒模型；写 `project.json` + `faces.json`，用户点「提交面数据」后自行上传，模型 `dsh_wtskin_import` 导入 |
| 交付 | `dsh_wtskin_install` 复制 DDS 到 `UserSkins/<文件夹>/` 并按**机型名**写 blk；`dsh_wtskin_convert` 做 TGA/DDS→PNG |
| 面定位 | **不做自动化**：用户鼠标点选最准；调研见 [face-detection.md](face-detection.md) |
