# Codex 安装任务书

这份文件面向拿到仓库链接后负责配置和安装的 Codex。目标是安装唯一、可验证的 macOS 本地应用，同时保留用户现有资料库和登录状态。

## 最终目标

- 源码仓库：`https://github.com/maxmaximage-hash/video-content-creation-studio`
- 应用路径：`/Applications/Video Hub.app`
- Bundle ID：`com.yinli.video-content-creation-studio`
- 资料库：由用户在首次启动时新建或打开，不由安装脚本创建真实业务数据。
- 登录 profile：`~/Library/Application Support/视频内容创作中台/auth-browser/`

## 绝对禁止

- 不删除、移动、重命名或迁移任何现有 `.library`。
- 不把自动化测试指向用户的真实 Library 或 NAS。
- 不读取、复制或输出浏览器 Cookie、token、authorization header。
- 不复制 Safari、Chrome 或其他浏览器 profile。
- 不用测试夹具覆盖真实 `library.json`。
- 不在 Bundle ID 不匹配时覆盖 `/Applications` 中的同名应用。
- 不把模拟测试通过称为任何平台的真实采集成功。

## 1. 预检

只读执行：

```bash
uname -s
uname -m
sw_vers
git --version
node --version
npm --version
df -h /
```

要求：

- 操作系统为 macOS。
- 架构为 `arm64` 或 `x86_64`。
- 推荐 Node.js 22 LTS；项目接受 `>=20.19 <25`。
- 至少有 3 GB 可用空间。

Node 不满足时，优先使用用户已有的 `nvm`、`fnm` 或 Homebrew 安装 Node 22。不要修改用户无关的全局开发环境。

## 2. 获取源码

如果用户没有指定目录，使用一个明确的新目录：

```bash
git clone https://github.com/maxmaximage-hash/video-content-creation-studio.git
cd video-content-creation-studio
git status --short --branch
git remote -v
```

升级已有克隆时，先检查工作区。存在用户修改时不得执行会覆盖修改的 reset、checkout 或 clean。

默认安装 `main`，因为它只保存已经完成真实应用验收的稳定版本。除非用户明确指定开发分支或 commit，不要自行安装 `codex/*-workbench`。

## 3. 安装依赖

```bash
cd prototype
npm ci
npx playwright install chromium
```

不要创建包含真实凭证的 `.env`。平台采集不需要 API Key；腾讯云转写是可选功能，必须由用户在安装应用的界面中配置，密钥只允许进入 macOS 钥匙串。

## 4. 防回退验证

先运行不会访问真实平台、不会操作真实 Library 的隔离检查：

```bash
npm run test:unit
npm run test:ui
npm run build
```

如果失败：

1. 保存第一个真实错误和命令输出。
2. 确认测试 Library 位于仓库的隔离目录。
3. 不要通过删除真实数据、关闭测试或放宽断言来制造通过。
4. 修复后从失败项开始，再跑完整检查。

这些检查只证明代码没有已知回退，不证明第三方平台真实采集成功。

## 5. 构建和安装

```bash
npm run desktop:install
```

安装脚本会按当前架构构建、ad-hoc 签名、验证 Bundle ID，并用临时路径更新唯一应用。它不会删除 Library 或登录 profile。

安装后只读核对：

```bash
plutil -p '/Applications/Video Hub.app/Contents/Info.plist' \
  | grep -E 'CFBundleIdentifier|CFBundleDisplayName|CFBundleShortVersionString'
codesign --verify --deep --strict '/Applications/Video Hub.app'
mdfind 'kMDItemCFBundleIdentifier == "com.yinli.video-content-creation-studio"'
```

同时记录源码版本：

```bash
npm run version:status
```

应用导航栏右侧的版本、commit 应与命令输出一致；正式稳定版不应显示“未提交”。

`mdfind` 应只返回一个可启动应用。如果发现旧副本，先核对 Bundle ID 和路径，再向用户报告；不要未经确认删除用户其他项目。

## 6. 首次启动

```bash
open '/Applications/Video Hub.app'
```

预期：

- 新用户看到“新建资料库 / 打开资料库”，应用不会自动连接仓库作者的 NAS。
- 升级用户继续看到上次打开的 Library。
- Library 不可用时显示关闭或离线状态，不创建替代业务数据。

如果用户没有 Library，让用户通过界面选择位置和名称。不要替用户假定 NAS 路径。

## 7. 平台登录

在灵感库中为用户需要的平台打开对应专用登录窗口。登录由用户手动完成：

- 不自动填写账号密码。
- 不绕过验证码或平台风控。
- 登录状态只写入本机专用 profile。
- 不承诺固定“一天只登录一次”；实际有效期由平台决定。

## 8. 真实应用验收

必须在 `/Applications/Video Hub.app` 中完成。让用户提供自己有权访问的真实作品与主页链接，只对本版本实际涉及的平台分别验证：

1. 链接只生成一个灵感 ID，不重复建卡。
2. 标题、正文、作者、互动数据和媒体与目标作品一致。
3. 图文顺序正确，视频可本地播放。
4. 刷新或重启后卡片和本地媒体仍存在。
5. 从灵感新建创作可以进入创作页。
6. 删除专用测试卡后，索引和该内容单元同时消失。
7. 多条链接不重复建卡，主页扫描能在中断后从原任务继续。
8. 有平台字幕时直接使用；否则腾讯云免费额度优先，不可用时本地转写，卡片可展开和复制逐字稿。

不要使用用户已有的重要内容做删除验收。

## 9. 最终回报格式

向用户报告：

```text
源码目录：
版本：
Git commit：
应用路径：/Applications/Video Hub.app
Bundle ID：com.yinli.video-content-creation-studio
架构：
签名验证：
当前 Library：未打开 / 路径
防回退检查：
真实链接验收：未执行 / 抖音结果 / 小红书结果
仍需用户动作：平台登录、验证码或 Library 选择
```

只有真实链接在真实安装应用中成功，才能把对应平台采集标记为真实验收通过。
