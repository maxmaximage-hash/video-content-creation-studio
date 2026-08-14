# 版本开发与 GitHub 发布流程

这套项目按“一个完整版本”同步 GitHub。修复一个小问题后仍然会构建并安装到本机验证，但不会为每个小问题单独发布，也不会让公开 `main` 长期处于半完成状态。

## 用户可见版本规则

- 应用界面只显示 `VX.Y` 两段版本号，例如 `V1.0`、`V1.1`，不显示第三段。
- 每完成一轮小问题修复，递增后一位；累计 10 轮后进入下一前位并归零，例如 `V1.9` 后为 `V2.0`。
- 重大调整可以直接进入下一前位。
- Electron、npm、Git 标签和发布校验仍使用合法的三段 SemVer；用户版本 `V1.1` 对应内部版本 `1.1.0`。
- Git commit 和“未提交”状态可以作为开发诊断信息显示，但不属于版本号。

## 分支职责

- `main`：始终表示已经完成本地安装和真实应用验收的稳定版本。
- `codex/vX.Y.Z-workbench`：下一版本的开发分支，例如 `codex/v0.2.0-workbench`。
- `vX.Y.Z`：稳定版本标签。标签内容必须与 `prototype/package.json` 的版本完全一致。

开发版使用 `X.Y.Z-dev.N`，例如 `0.2.0-dev.0`。准备正式发布时才改为 `0.2.0`。

## 一个版本如何形成

1. 从最新 `main` 创建下一版本开发分支。
2. 把同一轮的小修复和功能改进记录在 `CHANGELOG.md` 的 `Unreleased` 下。
3. 每次完成可体验的改动后，运行必要的自动化防回退检查，并默认覆盖安装到本机唯一应用。
4. 在真实安装版中验证本轮受影响的操作。平台采集必须使用有权访问的真实链接；自动化和模拟网络只算防回退证据。
5. 一轮内容稳定后，将多个小改动整理成少量有意义的版本提交。无需一个 bug 对应一个提交。
6. 把版本从 `X.Y.Z-dev.N` 改为 `X.Y.Z`，将 `Unreleased` 内容收口为带日期的正式版本记录。
7. 合并到 `main`，创建 `vX.Y.Z` 标签，并一次性推送 `main` 和标签。
8. 标签会触发 GitHub Actions：重新执行检查、构建 Apple Silicon 应用、校验签名、生成 SHA-256，并创建 GitHub Release。

## 日常状态检查

在项目根执行：

```bash
cd prototype
npm run version:status
```

输出包含版本、分支、完整 commit 和工作区是否干净。应用导航栏品牌区显示两段用户版本，右侧开发诊断同时显示 commit：

```text
V1.1 · 2db004a502 · 未提交
```

看到“未提交”说明当前安装包包含尚未进入 Git 历史的本地改动。正式版本不得显示“未提交”。

## 版本收口门禁

正式发布前依次完成：

```bash
cd prototype
npm run test:unit
npm run test:ui
npm run build
npm run desktop:install
```

然后在 `/Applications/Video Hub.app` 中完成真实应用验收，并核对界面版本号。只有以下条件都满足才进入发布：

- 本轮功能在真实安装版中可用。
- 用户指定的真实平台链接完成实际采集；未涉及采集的版本明确记录“不适用”。
- `.library` 重启后数据和本地媒体仍然存在。
- 没有读取或写入测试以外的真实数据，除非该动作就是用户明确授权的验收步骤。
- `package.json` 与 `package-lock.json` 版本一致。
- `CHANGELOG.md` 有对应的正式版本和日期。
- Git 工作区干净。

稳定版本提交完成后运行：

```bash
cd prototype
npm run release:check
```

该命令只检查发布元数据和 Git 状态，不会自动提交、推送或打标签。

## 推送与发布

完成最终审核后执行：

```bash
git switch main
git merge --ff-only codex/vX.Y.Z-workbench
git tag -a vX.Y.Z -m "Video Hub vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

推送标签后，`.github/workflows/release.yml` 会生成 GitHub Release。发布页中的应用是 ad-hoc 签名构建，不是 Apple 公证安装包；用户也可以继续按 `INSTALL_WITH_CODEX.md` 从源码安装。

## 哪些内容何时同步

| 内容 | 本机开发期 | 版本发布时 |
| --- | --- | --- |
| 源码改动 | 保存在开发分支工作区 | 合并并推送到 `main` |
| 本地应用 | 每个可体验阶段默认重装 | 用稳定版本再构建一次 |
| GitHub 开发分支 | 只在阶段检查点推送 | 可保留或发布后删除 |
| GitHub `main` | 不接收半成品 | 只接收真实验收后的版本 |
| GitHub Release | 不创建 | 标签触发后创建一次 |

GitHub 不是对本地文件的实时镜像。没有提交和推送的改动不会出现在远端，这是为了确保别人复制仓库链接时默认拿到的是稳定版本。

## 回滚

发现新版本有严重问题时，不改写已经发布的标签。创建新的补丁版本，例如 `0.2.1`，修复并走完相同门禁。需要立即恢复本机时，可从上一稳定标签重新构建安装；Library 和登录 profile 不随应用回滚或删除。
