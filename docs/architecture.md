# 架构和数据模型

## 运行结构

```text
Electron 主进程
  -> 启动仅监听 127.0.0.1 的 Vite preview/API
  -> BrowserWindow 加载本地前端
  -> preload 暴露受限的原生拖拽桥接

React 前端
  -> /api/library
  -> /api/inspirations/*
  -> /api/extract
  -> /api/covers
  -> /api/project-media
  -> /api/project-actions

服务端
  -> Library Manager
  -> 平台适配器
  -> 独立登录会话
  -> 采集调度与质量门禁
  -> 本地媒体安全写入
```

## 源码目录

```text
prototype/
  desktop/                 Electron 主进程、preload、原生拖拽
  server/                  Library、路径安全、采集与平台适配器
  src/
    features/inspirations/ 灵感模型和卡片
    pages/creation/        创作工作台
    pages/inspirations/    灵感库
    pages/queue/           待发布
    pages/archive/         归档
    services/              项目媒体 API 与四槽位模型
  scripts/                 构建、安装和维护脚本
  tests/                   单元与 Playwright 隔离回归
```

## 内容 ID

- `I000001`：灵感。
- `C000001`：自主创作。
- ID 是跨页面、索引、manifest 和文件系统的稳定关联键。
- 页面序号 `01/02/03` 只是排序显示，不是实体 ID。

## 媒体角色

| role | 含义 | 默认目录 |
| --- | --- | --- |
| `cover_image` | 创作或发布封面 | `covers/` |
| `content_image` | 小红书正文图片 | `media/images/` |
| `captured_video` | 线上采集的灵感视频 | `media/captured-video/` |
| `source_video` | 自己拍摄的原素材 | `media/source-video/` |
| `finished_video` | 剪辑完成的成品 | `media/finished-video/` |

创作视频额外使用 `accountRole`：

- `blogger`：博主号。
- `ip`：IP 号。

## 索引关系

`library.json` 保存页面投影和 v2 关系集合：

- `contentUnits`：内容实体。
- `assets`：媒体实体。
- `assetLinks`：内容与媒体的角色关系。
- `contentRelations`：创作引用灵感等关系。
- `metricsSnapshots`：互动数据时间快照。
- `duplicateGroups`：同一平台来源的重复候选。

每个 `content-units/<ID>/manifest.json` 同时保存该内容单元可独立解释的元数据和相对路径。

## 平台来源去重

采集入口根据平台和作品 ID 生成 `canonicalSourceKey`。同一来源重复提交时应返回已有卡片，而不是分配新内容 ID。

## 写入安全

- 相对路径必须位于当前 Library 或允许的旧版目录。
- 拒绝绝对路径、`..`、反斜线、NUL 和符号链接逃逸。
- 媒体先写临时文件，再原子重命名。
- Library 索引也通过临时文件原子替换。
- 删除先核对内容 ID、路径边界和索引关系。

## 当前并发边界

`sessionId`、`revision` 和写入队列只在一个应用进程内有效。原子重命名能防止半写文件，但不能防止两台电脑最后写入覆盖。

因此当前支持：

- 单机完整读写。
- 多机只读同一 NAS Library。

当前不支持：

- 两台电脑同时编辑同一 Library。
- 手机直接连接本机 API。
- 互联网多用户协作。

实现这些能力需要一个唯一协作服务作为 Library 唯一写入者。
