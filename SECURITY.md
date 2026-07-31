# 安全策略

## 支持版本

当前只维护 `main` 分支最新版本。

## 报告漏洞

请通过 GitHub 仓库的 Security Advisories 私下报告以下问题：

- Library 路径逃逸或符号链接逃逸。
- 未经确认删除 Library 外文件。
- Cookie、token、authorization header 或平台签名泄漏。
- Electron preload 权限扩大。
- 本地 API 被非本机访问。
- 安装脚本覆盖 Bundle ID 不匹配的应用。

报告中不要附带真实 Cookie、账号密码、私密媒体或完整生产 Library。使用最小脱敏复现。

## 凭证边界

平台登录 profile 仅保存在当前 macOS 用户的 Application Support。仓库和 Library 都不应包含凭证。

当前版本不要求 API Key。如果后续引入第三方 API，必须使用系统钥匙串或明确的本机秘密存储，禁止把密钥写入 `library.json`、manifest、日志、截图或 Git。

## 本地 API

开发服务和桌面 preview 必须只监听回环地址。不要通过路由器端口映射、公开 tunnel 或反向代理直接暴露当前本地 API；它不是多用户认证服务。
