# velo Extension

浏览器嗅探 m3u8 + 广告分片过滤 + 推送到 velo 桌面端下载。

基于 **WXT + TypeScript + React + Tailwind CSS + Vitest** 技术栈构建。

## 开发

```bash
# 安装依赖
bun install

# 开发模式（HMR 热更新）
bun run dev

# 开发模式（Firefox）
bun run dev:firefox

# 类型检查
bun run typecheck

# Lint
bun run lint

# 单元测试
bun run test

# 测试覆盖率
bun run test:coverage

# 构建（Chrome MV3）
bun run build

# 构建（Firefox MV2）
bun run build:firefox

# 打包 zip
bun run zip

# 清理
bun run clean
```

## 安装

### Chrome / Edge

1. `bun run build`
2. 打开 `chrome://extensions/`（或 Edge 的 `edge://extensions/`）
3. 开启「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择 `.output/chrome-mv3/` 目录

### Firefox

1. `bun run build:firefox`
2. 打开 `about:debugging#/runtime/this-firefox`
3. 点击「临时载入附加组件」
4. 选择 `.output/firefox-mv2/manifest.json`

## 配对

1. 在 velo 桌面端设置面板点击「生成配对码」
2. 浏览器扩展 popup 输入 Token + 端口
3. 点击「配对桌面端」验证

## 功能

- HLS m3u8 嗅探（webRequest + fetch/XHR hook + MSE hook）
- 广告分片过滤（7 信号加权评分 + SHA-256 指纹库 + 站点规则）
- 自动推送 cleaned m3u8 到桌面端
- 三通道：WebSocket / HTTP RPC / deep-link
- 离线队列持久化 + 自动重连
- 广告角标显示 + 自动跳过

## 项目结构

```
src/
├── entrypoints/          # WXT 自动识别入口
│   ├── background.ts     # Service Worker
│   ├── hls.content.ts    # MAIN world: fetch/XHR hook
│   ├── hls-bridge.content.ts  # ISOLATED world: 消息桥
│   ├── mse-hook.content.ts    # MAIN world: MSE API hook
│   ├── badge.content.ts  # 角标 + 下载按钮
│   ├── popup/            # React 弹窗 UI
│   └── options/          # React 设置页
├── engine/hls/           # HLS 广告过滤引擎（来自 AdClear v6）
├── background/           # Background 业务逻辑
│   ├── messaging/router.ts
│   ├── media/            # 嗅探 + 下载客户端
│   ├── pairing.ts
│   └── push-client.ts
├── lib/                  # 基础设施（logger + storage）
├── types/                # 全局类型定义
└── locales/              # i18n（zh_CN + en_US）
```

## License

MIT © tekin <ai@tekin.cn>