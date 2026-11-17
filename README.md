# Velo Extension

浏览器嗅探 + 广告分片过滤 + 推送到 Velo 桌面端下载。支持 **HLS (m3u8)** 和 **DASH (mpd / JSON playurl)** 两种流媒体协议。

基于 **WXT 0.21 +  TypeScript + React 19 + TailwindCSS 4 + Vitest**，同时构建 Chrome MV3 和 Firefox MV2。

---

## ✨ 功能

| 功能 | 技术 | 说明 |
|---|---|---|
| HLS 嗅探 | webRequest + fetch/XHR hook + MSE hook | 三通道覆盖所有 m3u8 加载路径 |
| DASH 嗅探 | webRequest + MPD 解析 + JSON playurl 解析 | 支持 MPD 文件和动态 JSON playurl |
| 广告分片过滤 | 7 信号加权评分 + SHA-256 指纹 + 站点规则 | HLS / DASH 独立引擎 |
| 自动推送 | WebSocket → Velo PushServer (port 16888) | 双协议支持（velo-ext / NDM） |
| 离线队列 | chrome.storage.local 持久化 | 断网时入队，重连后补发 |
| 播放器角标 | content script 注入 | 显示广告过滤状态 + 快捷下载按钮 |
| Context Menu | chrome.contextMenus | 右键链接 / 媒体直接推送 |
| i18n | zh-CN / en-US | `src/locales/*.json` |

---

## 📁 项目结构

```
velo-extension/
├── src/
│   ├── entrypoints/                     # WXT 自动识别入口
│   │   ├── background.ts                # Service Worker（消息路由 + 生命周期）
│   │   ├── hls.content.ts               # MAIN world: fetch/XHR hook（HLS 嗅探）
│   │   ├── hls-bridge.content.ts        # ISOLATED world: MAIN ↔ ISOLATED 桥
│   │   ├── mse-hook.content.ts          # MAIN world: MediaSource API hook
│   │   ├── dash.content.ts              # MAIN world: DASH MPD 嗅探
│   │   ├── dash-bridge.content.ts       # ISOLATED world: DASH 桥
│   │   ├── site-sniffer.content.ts      # 站点特定嗅探器（YouTube/Bilibili…）
│   │   ├── player-panel.content.ts      # 播放器浮层面板
│   │   ├── badge.content.ts             # 广告过滤角标 + 状态提示
│   │   ├── delete-key.content.ts        # 解密密钥清理 hook
│   │   ├── popup/main.tsx               # 浏览器图标弹窗（React）
│   │   ├── options/main.tsx             # 设置页入口（React）
│   │   └── options-*/main.tsx           # 10 个独立设置面板
│   │
│   ├── engine/                          # 广告过滤引擎（纯 TS，可脱离扩展运行）
│   │   ├── hls/                         # HLS 引擎（21 文件）
│   │   │   ├── playlist-parser.ts       # m3u8 解析（Master + Media）
│   │   │   ├── playlist-rebuilder.ts    # 重建过滤后的 m3u8
│   │   │   ├── ad-detector.ts           # 广告分片检测（7 信号）
│   │   │   ├── fingerprint.ts           # SHA-256 分片指纹
│   │   │   ├── hls-rules.ts             # 内置 + 远程规则集
│   │   │   ├── hls-filter.ts            # 主过滤管道
│   │   │   └── io.ts / stats.ts / suggest.ts / samples.ts / types.ts
│   │   ├── dash/                        # DASH 引擎（11 文件）
│   │   │   ├── mpd-parser.ts            # MPD XML 解析
│   │   │   ├── mpd-rebuilder.ts         # 重建过滤后的 MPD
│   │   │   ├── json-playurl-parser.ts   # JSON playurl 解析
│   │   │   ├── json-playurl-rebuilder.ts
│   │   │   ├── ad-detector.ts           # DASH 广告时段检测
│   │   │   ├── ad-ranges.ts             # 广告时间范围
│   │   │   ├── dash-filter.ts           # 主过滤管道
│   │   │   └── dash-sites.ts / metrics.ts / resolve-first-url.ts / types.ts
│   │   └── shared/                      # HLS/DASH 共用基础设施
│   │       ├── fingerprint.ts           # SHA-256 指纹算法
│   │       ├── rules.ts                 # 规则引擎
│   │       ├── storage.ts               # chrome.storage 封装
│   │       ├── suggest.ts               # 建议推送
│   │       └── types.ts
│   │
│   ├── background/                      # Service Worker 业务逻辑
│   │   ├── messaging/router.ts          # Content Script ↔ Background 消息路由
│   │   ├── media/                       # 媒体嗅探核心
│   │   │   ├── sniffer.ts               # 嗅探主入口（webRequest.onBeforeRequest）
│   │   │   ├── site-sniffers.ts         # 站点特定嗅探（YouTube itags 等）
│   │   │   ├── youtube-itags.ts         # YouTube 码率表
│   │   │   ├── download-client.ts       # 下载客户端
│   │   │   ├── download-whitelist.ts    # 下载白名单
│   │   │   ├── mime-table.ts            # MIME → 扩展名映射
│   │   │   ├── post-body-parser.ts      # POST 请求体解析
│   │   │   ├── delete-key-state.ts      # 解密密钥状态管理
│   │   │   └── handler.ts               # 媒体下载统一 handler
│   │   ├── hls/handler.ts               # HLS 请求处理流水线
│   │   ├── dash/handler.ts              # DASH 请求处理流水线
│   │   ├── pairing.ts                   # 桌面端配对认证
│   │   └── push-client.ts               # WebSocket 推送客户端（含自动重连 + 离线队列）
│   │
│   ├── lib/                             # 基础设施
│   │   ├── logger.ts                    # 日志（dev/prod 分级）
│   │   ├── i18n.ts                      # i18next 封装
│   │   ├── messaging.ts                 # Chrome 消息通信封装
│   │   ├── runtime.ts                   # chrome.runtime 封装
│   │   ├── mount.tsx                    # React 挂载辅助（Content Script 用）
│   │   ├── cast.ts                      # 类型转换辅助
│   │   ├── naming.ts                    # 文件名/标题生成
│   │   └── storage/index.ts             # chrome.storage 封装
│   │
│   ├── components/                      # 共享 React 组件
│   ├── types/index.ts                   # 全局 TypeScript 类型
│   └── locales/                         # 语言包（→ public/_locales/ 由 WXT 同步）
│       ├── zh_CN.json
│       └── en_US.json
│
├── public/_locales/                     # Chrome/i18n 语言目录（wxt.config.ts 同步生成）
├── wxt.config.ts                        # WXT 配置（manifest / vite / aliases）
├── vitest.config.ts                     # 单元测试配置
├── tsconfig.json
├── package.json
└── update.xml                            # Firefox 附加组件更新清单
```

---

## 架构流程

```
浏览器网络请求
    │
    ├──▶ webRequest.onBeforeRequest (background)
    │   │  sniffer.ts → handler.ts
    │   ├── m3u8 → hls/handler.ts → engine/hls/*
    │   └── mpd / json → dash/handler.ts → engine/dash/*
    │
    ├──▶ fetch / XHR hook (hls.content.ts, MAIN world)
    │   └── 通过 hls-bridge.content.ts (ISOLATED) → postMessage → background
    │
    └──▶ MediaSource API hook (mse-hook.content.ts)
        └── 拦截 addSourceBuffer → 截获真实 m3u8 URL

engine/hls 或 engine/dash
    │  parser → ad-detector → fingerprint → rebuilder
    ▼
生成 cleaned m3u8 / mpd

background/push-client.ts
    │  WebSocket: ws://127.0.0.1:16888/download
    │  消息: { protocol, type: "hls_push"|"dash_push", payload: { url, title, cookies, ... } }
    ▼
Velo 桌面端 HlsPushServer → HlsTaskManager
```

---

## 开发

### 环境

| 依赖 | 版本 |
|---|---|
| bun | ≥ 1.1 |
| Chrome | ≥ 116 |
| Firefox | 最近稳定版（MV2） |

### 命令

```bash
cd extensions/velo-extension

# 安装依赖
bun install

# 开发模式（Chrome MV3，HMR 热更新）
bun run dev

# 开发模式（Firefox MV2）
bun run dev:firefox

# 类型检查
bun run typecheck

# Lint
bun run lint              # 最多 10 warning
bun run lint:fix

# 单元测试（Vitest + jsdom）
bun run test
bun run test:watch
bun run test:coverage

# 构建
bun run build             # Chrome MV3 → .output/chrome-mv3/
bun run build:firefox     # Firefox MV2 → .output/firefox-mv2/

# 打包 zip（发布用）
bun run zip
bun run zip:firefox

# 清理
bun run clean
```

---

## 安装

### Chrome / Edge / Brave

1. `cd extensions/velo-extension && bun run build`
2. 打开 `chrome://extensions/`（Edge: `edge://extensions/`）
3. 右上角开启 **开发者模式**
4. 点击 **加载已解压的扩展程序**
5. 选择 `extensions/velo-extension/.output/chrome-mv3/` 目录

### Firefox

1. `bun run build:firefox`
2. 打开 `about:debugging#/runtime/this-firefox`
3. 点击 **临时载入附加组件**
4. 选择 `.output/firefox-mv2/manifest.json`

### WXT dev 模式

- Chrome — `bun run dev` 后访问 `chrome://extensions/` → 加载 `.output/chrome-mv3-dev/`
- 支持 HMR：修改代码后 Service Worker / Content Script 自动热更新

---

## 桌面端配对

扩展首次连接 Velo 桌面端时需要配对（严格模式下）：

| 步骤 | 操作 |
|---|---|
| 1 | Velo 桌面端 → **设置 → 集成 → 推送服务器** → 启用 → 点击「生成配对码」 |
| 2 | 扩展 → 点击浏览器工具栏图标 → Popup 输入 **配对码 + 端口**（默认 16888） |
| 3 | 点击「配对桌面端」→ Connection status 变为 ✅ Connected |
| 4 | 桌面端将扩展身份（extension_id）持久化到 `paired_extensions` 表 |

宽松模式下（Velo 设置 `push_strict_auth = false`），任意扩展可直接连接，无需配对。

---

## Manifest 权限（`wxt.config.ts`）

| 权限 | 用途 |
|---|---|
| `webRequest` | 嗅探 m3u8 / mpd / JSON playurl 网络请求 |
| `webNavigation` | 页面导航事件监听 |
| `cookies` | 嗅探到有 cookie 认证的流媒体时透传 cookies |
| `contextMenus` | 右键菜单：「用 Velo 下载」|
| `storage` | 扩展设置 / 离线推送队列持久化 |
| `scripting` | 动态注入 Content Script |
| `notifications` | 推送成功/失败通知 |
| `activeTab` | 当前页面 URL / 标题读取 |
| `downloads` | 扩展内下载功能 |
| `tabs` | 标签页事件监听 |

Host permissions: `http://*/*`, `https://*/*`, `ftp://*/*`, `file:///*`

---

## 测试

```bash
cd extensions/velo-extension
bun run test
```

测试分布：

```
tests/
├── unit/
│   ├── engine/hls/           # ad-detector · fingerprint · hls-filter · playlist-parser · playlist-rebuilder · io
│   ├── engine/dash/          # dash-filter · mpd-parser
│   ├── background/           # pairing · push-client · router · youtube-itags
│   └── lib/                  # naming
└── integration/
    └── dash-filter-pipeline.test.ts
```

---

## 调试

### Content Script

打开目标页面 DevTools → Console，选择扩展 Content Script 的执行上下文：
- Chrome DevTools 右上角下拉 → 扩展上下文 → `hls.content.js`

### Service Worker

- Chrome — `chrome://extensions/` → 扩展卡片 → **Service Worker (Inspect)**
- Firefox — `about:debugging#/runtime/this-firefox` → 扩展卡片 → **调试**

### 日志

```ts
import { logger } from '@lib/logger'
logger.debug('...')   // dev 模式输出
logger.info('...')    // 始终输出
logger.warn('...')
logger.error('...')
```

---

## Troubleshooting

| 问题 | 排查 |
|---|---|
| 扩展显示「连接失败」| 检查 Velo 推送服务器是否启用 + 端口（默认 16888）+ 本地防火墙 |
| HLS 分片 403 | 嗅探 payload 已携带 cookies + user_agent，确认扩展配对状态 |
| 广告分片仍被下载 | 检查引擎规则是否启用；远程规则拉取可能被防火墙拦截 |
| Content Script 不注入 | 确认目标页面已匹配 host permissions；`chrome://extensions/` 重新加载扩展 |
| DASH JSON playurl 不支持 | 确保 engine/dash 已编译（默认构建包含）；特定站点嗅探可能需要 site-sniffers |
| Service Worker 注册失败 (Status: 15) | `wxt.config.ts` 已禁用 Vite `modulePreload` polyfill（会在 SW 环境引用 document）|

---

## 与 Velo 桌面端集成

扩展推送协议（`background/push-client.ts`）：

```
WebSocket 连接: ws://127.0.0.1:16888/download

握手:
  → { protocol: "velo-ext", version: "1.0.0", extension_id, extension_name }
  ← { type: "ready" } 或 { type: "pairing_required", pairing_code }

推送:
  → {
      type: "hls_push" | "dash_push",
      payload: {
        url: "https://...master.m3u8",
        title: "Video Title",
        referer: "...",
        cookies: "session=xxx",
        user_agent: "...",
        auto_start: true
      }
    }
  ← { type: "hls_push_response" | "dash_push_response", status: "ok", task_id: "..." }
```

详见项目主文档 [docs/extensions.md](../../docs/extensions.md)。

---

## License

MIT © Tekin