# 故障排查

## 应用打不开

先验证：

```bash
codesign --verify --deep --strict '/Applications/视频内容创作中台.app'
plutil -p '/Applications/视频内容创作中台.app/Contents/Info.plist' \
  | grep com.yinli.video-content-creation-studio
```

源码构建失败时删除 `node_modules` 并重新 `npm ci`，不要删除 Library 或 Application Support。

## 提示找不到 Chromium

```bash
cd prototype
npx playwright install chromium
npm run desktop:install
```

Chromium 缓存属于当前 macOS 用户，换用户或清理缓存后需要重新安装。

## 登录窗口反复打开或平台不一致

1. 退出应用和两个专用登录窗口。
2. 重新打开应用。
3. 只点击目标平台的登录按钮一次。
4. 在可见窗口中完成登录或安全验证。
5. 返回应用重试原卡片。

不要同时启动多个使用同一调试端口的采集浏览器，也不要复制其他浏览器 profile。

## 一直显示“完成验证”但没有验证内容

检查专用窗口顶部 URL 是否仍是目标平台。如果正常作品页已登录而应用仍等待验证，记录：

- 平台。
- 卡片内容 ID。
- 发生时间。
- 应用显示的错误码。

不要提交 Cookie、完整 token 或带敏感查询参数的截图。

## 采集失败

先区分：

- `waiting_login`：需要登录。
- `waiting_verification`：需要人工验证。
- `retry_wait`：网络、限流或平台临时异常，应用会按冷却时间续跑。
- `content_unavailable`：内容删除、私密或不可查看。
- `failed`：解析结构变化、本地写入或不可恢复错误。

真实验收必须用用户有权访问的真实链接。不要用模拟接口通过替代真实结果。

## 已经本地保存但卡片媒体不显示

1. 右键媒体尝试“在访达中显示”。
2. 检查 Library 是否在线并具有读权限。
3. 检查卡片的 `relativePath` 是否仍位于同一内容 ID 目录。
4. 不要因为 NAS 暂时离线删除记录。

## Library 打不开

确认：

- 目录名以 `.library` 结尾。
- 根目录存在 `library.json`。
- `libraryKind` 为视频内容创作中台类型。
- 当前用户具有目录读写权限。
- NAS 已稳定挂载。

不要手工编辑损坏的 `library.json`。先复制整个 Library 做只读诊断。

## 两台电脑的内容互相覆盖

当前版本不支持两台电脑同时写同一个 NAS Library。立即停止其中一个写入端，保留 NAS 快照和所有 `library.json*.bak`，不要继续反复保存。

## 删除很慢或失败

删除需要同步处理索引、引用和内容目录。NAS 延迟、权限或文件占用都可能导致失败。失败时应用应保留卡片，不应只删界面。

不要在 Finder 中直接删除内容单元后再要求应用自行猜测索引。
