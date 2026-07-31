# 配置、登录与 API Key

## 普通用户不需要 API Key

当前版本没有 OpenAI、第三方解析服务或云存储 API Key 的必填项。灵感采集依赖：

- 抖音或小红书真实链接。
- 本机专用 Chromium。
- 用户在可见窗口中完成的平台登录和人工验证。
- 当前 `.library` 的读写权限。

不要把平台 Cookie、token 或账号密码填写到 `.env`。

## Library 配置

首次启动时选择：

- “新建资料库”：创建新的 `.library`。
- “打开资料库”：打开已有资料库。

应用只在本机保存上次打开的 Library 路径：

```text
~/Library/Application Support/视频内容创作中台/library-session.json
```

该文件不是业务索引，删除它不会删除 Library，但会让应用下次回到选择资料库页面。

## 平台登录 profile

默认位置：

```text
~/Library/Application Support/视频内容创作中台/auth-browser/douyin/
~/Library/Application Support/视频内容创作中台/auth-browser/xiaohongshu/
```

特性：

- 与日常浏览器 profile 完全分离。
- 应用不会复制其他浏览器 Cookie。
- profile 跨应用重启保留。
- 是否需要重新登录由平台会话有效期和风控决定，不保证固定每日一次。
- 验证码只允许用户在可见窗口中手动完成。

## 开发者环境变量

环境变量只用于开发、自动化或受控部署。普通 Finder 启动的桌面应用不需要它们。

### `VIDEO_CONTENT_LIBRARY_ROOT`

开发服务器默认 Library 的父目录。示例：

```bash
VIDEO_CONTENT_LIBRARY_ROOT="$PWD/.dev-data" npm run dev
```

不要把它指向生产 Library 后运行测试。

### `VIDEO_CONTENT_AUTH_ROOT`

专用登录 profile 根目录：

```bash
VIDEO_CONTENT_AUTH_ROOT="$PWD/.dev-auth" npm run dev
```

### `PLAYWRIGHT_PORT`

Playwright 隔离测试服务器端口，默认 `4174`。

## NAS

可以通过“打开资料库”选择已挂载的 NAS `.library`。要求：

- NAS 路径稳定挂载。
- 当前用户拥有读写、创建、重命名权限。
- NAS 离线时不要把 unavailable 当成 missing。
- 当前版本只允许一个桌面实例写入该 Library。

两台 PC 同时完整编辑需要唯一协作服务，不能靠 SMB/NFS 共享 `library.json` 解决。

## 代理与网络

应用沿用当前系统网络环境。当前没有独立代理设置页面。需要代理时应在启动进程的系统环境或网络层配置，并确保抖音、小红书和媒体 CDN 均可访问。
