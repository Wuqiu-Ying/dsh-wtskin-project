# 发布清单（3.0.9）

明天起床后照这个顺序做，每步都验证输出再进下一步。

## 0. 现状

- 版本：**3.0.9**（`package.json`）
- 产物：`dist/dsh-wtskin-project-3.0.9.tgz`
- 哈希：`1f0f120fab2c383b656e085f652a2b78258db480906c67c985d8168e2b9fb9c9`
- 校验清单：`dist/SHA256SUMS.txt`、`dist/manifest.json`
- 测试：`node tests/smoke.mjs "<python 路径>"` → `all checks passed`
- 本机已装 3.0.9（21/21 文件哈希一致）

## 1. 打包（如无改动可跳过）

```powershell
cd D:\DSH\dsh-wtskin-project-02
node tests/smoke.mjs "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
rm -r python\__pycache__, dist -ErrorAction SilentlyContinue
mkdir dist
npm pack --pack-destination dist
```

## 2. 打 tag

```powershell
git add -A
git commit -m "chore: release 3.0.9"
git tag -a v3.0.9 -m "3.0.9: import output fix, bvvd template guidance, theme/UV picker fixes"
git push origin main --tags
```

## 3. 发布 GitHub Release

仓库：<https://github.com/Wuqiu-Ying/dsh-wtskin-project>

- Tag：`v3.0.9`
- 附件：`dist/dsh-wtskin-project-3.0.9.tgz`、`dist/SHA256SUMS.txt`
- 说明直接用 `CHANGELOG.md` 里 3.0.9 / 3.0.8 / 3.0.7 三段。

## 4. 发布后自检

```powershell
dsh plugin install D:\DSH\dsh-wtskin-project-02\dist\dsh-wtskin-project-3.0.9.tgz
```

确认：工具列表有 10 个 `dsh_wtskin_*`；`/wtspwds` 能开面板；`dsh_wtskin_import` 不再报 `"value" must be a string`。

## 5. 已知遗留

- `/` 菜单还能看到内部的 `wtskin-save`（需要 Host Remote service 才能隐藏）。
- 面板尺寸不持久化。
- `out/uv_reference.png` 与 `base.source` 内容重复；确认面板能直接读绝对路径后可以去掉。
