# 贡献指南

## 开发环境

```bash
cd prototype
npm ci
npx playwright install chromium
npm run dev
```

推荐 Node.js 22 LTS。

## 数据安全

- 永远不要提交 `.library`、登录 profile、Cookie、真实平台 token、NAS 路径或用户媒体。
- 测试必须使用项目隔离 Library。
- 真实链接验收只能在获得用户授权后执行，不能写入公开测试夹具。
- 删除、迁移和去重脚本必须先支持 dry-run、备份和明确确认。
- NAS 离线不是文件缺失。

## 提交前检查

```bash
cd prototype
npm run test:unit
npm run test:ui
npm run build
```

涉及 Electron、安装或采集运行时的修改，还要执行：

```bash
npm run desktop:pack
codesign --verify --deep --strict 'release/mac-arm64/视频内容创作中台.app'
```

实际输出目录会随架构变化。

## 代码边界

- `src/`：React 界面和前端状态接线。
- `server/`：Library、采集、平台适配器和路径安全。
- `desktop/`：Electron 主进程、preload 和原生能力。
- 不要在页面组件中重新实现路径安全或平台解析。
- 不要把平台差异继续堆回一个通用解析函数；使用独立适配器。
- `contentId` 是稳定实体键，页面顺序不是。

## Pull Request

PR 应说明：

- 用户可见变化。
- 修改的数据或路径边界。
- 是否涉及真实 Library、登录 profile 或安装。
- 自动化结果。
- 真实应用验收是否执行；未执行时必须明确写“未执行”。
- 回滚方式。
