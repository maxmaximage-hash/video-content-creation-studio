# 安装、升级与卸载

## 支持范围

当前桌面版只支持 macOS。Apple Silicon 是主要验证平台；Intel 构建入口存在，但每个发布版本仍需在 Intel 真机验收。Windows/Linux 尚未实现 Finder、codesign 和桌面桥接的等价能力。

## 推荐：让 Codex 安装

把仓库链接和下面的指令交给 Codex：

```text
请安装 https://github.com/maxmaximage-hash/video-content-creation-studio 。
完整读取 INSTALL_WITH_CODEX.md 后执行，不要操作我已有的 .library，不要读取或复制 Cookie。完成构建、签名、唯一应用安装和真实应用启动检查后，把结果逐项汇报。
```

## 手动安装

### 1. 安装 Node.js 22

使用已有版本管理器即可。例如：

```bash
nvm install 22
nvm use 22
```

### 2. 克隆并安装依赖

```bash
git clone https://github.com/maxmaximage-hash/video-content-creation-studio.git
cd video-content-creation-studio/prototype
npm ci
npx playwright install chromium
```

Chromium 是抖音、小红书专用登录会话和采集链路的运行依赖。

### 3. 构建并安装

```bash
npm run desktop:install
```

默认目标为：

```text
/Applications/视频内容创作中台.app
```

没有 `/Applications` 写权限时，可以安装到用户应用目录：

```bash
node scripts/install-macos.mjs --target "$HOME/Applications" --open
```

### 4. 验证

```bash
codesign --verify --deep --strict '/Applications/视频内容创作中台.app'
plutil -p '/Applications/视频内容创作中台.app/Contents/Info.plist' \
  | grep com.yinli.video-content-creation-studio
```

## 只构建，不安装

```bash
npm run desktop:pack
```

明确架构：

```bash
npm run desktop:pack:arm64
npm run desktop:pack:x64
```

产物位于 `prototype/release/`，不会提交到 Git。

## 升级

```bash
cd video-content-creation-studio
git pull --ff-only
cd prototype
npm ci
npm run desktop:install
```

仓库 `main` 只保留已验收稳定版本。安装后可在应用导航栏右侧查看版本号和 Git commit；如果显示“未提交”，说明安装包来自本机尚未进入 Git 历史的开发改动。

安装脚本只替换 Bundle ID 为 `com.yinli.video-content-creation-studio` 的应用，不会修改：

- 用户选择的 `.library`。
- `~/Library/Application Support/视频内容创作中台/library-session.json`。
- `~/Library/Application Support/视频内容创作中台/auth-browser/`。

## 卸载

只卸载应用：

```bash
osascript -e 'tell application id "com.yinli.video-content-creation-studio" to quit' || true
rm -rf '/Applications/视频内容创作中台.app'
```

上面的命令不会删除 Library 和登录 profile。删除用户数据属于不可恢复操作，应由用户明确指定准确路径后单独执行，不要把 `.library` 和应用一起删除。

## Gatekeeper

从源码本机构建的应用使用 ad-hoc 签名，不是 Apple 公证发行包。正常情况下本机构建不会带下载隔离属性。如果 macOS 仍阻止打开，先核对源码仓库、Bundle ID 和签名，不要直接对未知应用执行全局安全放行。
