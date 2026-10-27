# DASH/MPD 广告过滤功能实施任务计划

> **目标**：在 velo-extension 中新增 DASH 流媒体广告过滤能力，覆盖三大 manifest 来源（JSON Playurl / MPD XML / 纯分片），复用现有 HLS 广告过滤引擎架构，实现与 HLS 同等级别的广告检测、指纹过滤、自动学习闭环。
>
> **作者**：tekintian <tekintian@gmail.com>
> **日期**：2026-10-27
> **版本**：v2.0
> **依赖基线**：velo-extension v0.2.0（WXT + TypeScript + React + Tailwind CSS + Vitest）
> **样本来源**：`tmp/capture-1793081523116-isnfdsej`（B站完整页面数据录制，真实流量分析基线）

---

## 一、需求/问题评估

### 1.1 现状分析

velo-extension 当前已实现：

| 能力 | 状态 | 文件 |
|------|------|------|
| HLS m3u8 嗅探 + 广告过滤 | ✅ 完整 | `entrypoints/hls.content.ts` / `engine/hls/*` |
| DASH 媒体嗅探（.m4s 分片） | ✅ 仅嗅探下载 | `background/media/sniffer.ts` |
| DASH 音视频配对 | ✅ 仅配对下载 | `background/media/sniffer.ts` `pairDashItems()` |
| MPD / Playurl manifest 嗅探 | ❌ 未实现 | — |
| DASH 广告过滤 | ❌ 未实现 | — |
| MSE Hook（SHA-256 指纹） | ✅ 已就绪 | `entrypoints/mse-hook.content.ts` |
| PushClient velo 推送 | ✅ 已就绪 | `lib/push-client.ts`（含 `push_dash` action） |

### 1.2 问题定义

- **用户痛点**：YouTube、B站等大量平台使用 DASH 流媒体，当前扩展只能嗅探下载 DASH 分片，**无法过滤广告**，导致下载/播放包含广告内容。
- **技术债务**：HLS 广告过滤引擎（`engine/hls/`）已成熟（~3367 行），但 DASH 侧完全空白，架构能力不对等。
- **竞品差距**：AdGuard 已实现基础 MPD 级过滤，velo-extension 需补齐此能力以保持竞争力。

### 1.3 DASH Manifest 三大来源（v2.0 新增）

基于 B站真实样本分析 + 行业调研，DASH 流媒体的 manifest 来源分为**三种形态**，架构必须同时覆盖：

| 来源 | 代表平台 | Manifest 格式 | 广告表达 | 覆盖量 |
|------|---------|--------------|---------|--------|
| **模式 B: JSON Playurl** | B站 / YouTube | JSON API（扁平数组） | 独立广告轨 / 独立 playurl 请求 | **~90% 主流流量** |
| **模式 A: MPD XML** | dash.js / shaka-player 自托管、欧洲/韩国 IPTV、DASH-IF 参考服务器 | XML 文件（Period 嵌套树） | Period + EventStream(SCTE-35) / xlink 动态 Period | **~8% 小众场景** |
| **模式 C: 纯分片（无 manifest）** | 少量自定义播放器 | 无 manifest，直接 fetch `.m4s` 分片 | 无法在 manifest 层识别 | **~2% 边缘** |

**B站样本关键发现**（`tmp/capture-1793081523116-isnfdsej/api/088_playurl`）：

```json
{
  "duration": 486,
  "minBufferTime": 1.5,
  "video": [
    {
      "id": 80,
      "bandwidth": 932666,
      "width": 1920, "height": 1080,
      "codecs": "avc1.640032",
      "mimeType": "video/mp4",
      "SegmentBase": { "Initialization": "0-945", "indexRange": "946-2153" },
      "baseUrl": "https://upos-sz-mirror...m4s?sign=xxx&deadline=xxx&auth_key=xxx&..."
    }
  ],
  "audio": [ /* 结构同 video */ ]
}
```

- **无 Period 概念**：扁平 `video[]` + `audio[]` 数组
- **无 SegmentTemplate**：用 `SegmentBase` + 完整 `baseUrl`（CDN 签名直接内嵌）
- **无 EventStream/SCTE-35**：B站 JSON playurl 不含广告标记，如果有片头广告是前端播放器先请求**独立 playurl** 再切正片
- **分片配对**：同 capture 中 22 个 `*_video.m4s` + 22 个 `*_audio.m4s`，sniffer.ts `pairDashItems()` 已能正确配对

**YouTube 同理**：`/youtubei/v1/player` JSON API + `/videoplayback?itag=XXX&range=X-Y` 分块 URL，也不使用 MPD XML。

### 1.4 需求边界（v2.0 修正）

**In Scope**：
- **模式 B 高优**：JSON playurl 嗅探 / 解析 / 广告轨移除 / 重建（B站 playurl / YouTube player API）
- **模式 A 次优**：MPD XML 嗅探（fetch/XHR 拦截 `.mpd` / `/manifest`）/ 解析 / 广告 Period 移除 / 重建
- **模式 C 兜底**：无 manifest 场景 → 完全依赖 MSE Hook 分片指纹过滤（已就绪）
- DASH 广告检测（扩展信号集，JSON 场景 + XML 场景分别适配）
- 指纹二次过滤 + 自动学习闭环（复用 HLS）
- 站点规则系统（复用 HLS 规则格式）
- 处理模式：`data-url` / `manifest-file` / `passthrough` / `disabled`
- webRequest 层嗅探（`.mpd` + playurl JSON，类似 HLS `.m3u8` 双路径）
- content script 注入（MAIN world fetch/XHR hook）
- 与 velo 桌面端推送集成（清洗后 manifest 推送）

**Out of Scope**：
- DASH 直播动态 MPD (`type="dynamic"`) 实时更新（P2 迭代）
- DRM 保护内容过滤（Widevine/PlayReady，技术不可行 → 检测到 DRM 自动 disabled）
- DASH 下载合并格式扩展（保持现有 mp4/ts 支持）

---

## 二、技术实现方案

### 2.1 核心架构：三路径分发式（v2.0 重写）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     DASH 广告过滤架构（三路径分发式）                           │
├──────────────────────────────────────────────────────────────────────────────┤
│  Entry Layer (Content Scripts + webRequest Sniffer)                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ dash.content.ts          [MAIN world] 拦截 fetch/XHR                    │ │
│  │   检测范围：                                                             │ │
│  │     playurl(\?|$)           → 模式 B（B站/YouTube JSON Playurl）          │ │
│  │     youtubei/v\d+/player    → 模式 B（YouTube player API）               │ │
│  │     \.mpd(\?|$)             → 模式 A（MPD XML）                          │ │
│  │     /manifest(\?|$)         → 模式 A/B（根据 Content-Type 二次分发）       │ │
│  │     application/dash+xml    → 模式 A                                     │ │
│  │     application/json + dash → 模式 B                                     │ │
│  │ dash-bridge.content.ts   [ISOLATED] MAIN ↔ background 消息桥接            │ │
│  │ sniffer.ts 扩展          [SW] webRequest 层 .mpd + playurl 嗅探           │ │
│  │ mse-hook.content.ts      [MAIN world] 已就绪，分片指纹过滤兜底（模式 C）    │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────┤
│  Engine Layer (Service Worker)                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ engine/shared/           ← Phase 0 从 HLS 提取（消除代码重复）            │ │
│  │   ├── fingerprint.ts       computeFingerprint / lookupFingerprint         │ │
│  │   ├── rules.ts             SiteRule 接口 + 匹配逻辑 + 远程规则加载         │ │
│  │   └── suggest.ts           自动学习 + 规则建议生成（信号前缀可配置）       │ │
│  │                                                                         │ │
│  │ engine/dash/                                                             │ │
│  │   ├── types.ts             DASH 类型定义（含 JSON + XML 双结构）           │ │
│  │   ├── dash-filter.ts       主入口: processManifest() — 类型分发 → 三路径   │ │
│  │   ├── mpd-parser.ts        模式 A: MPD XML → 结构化对象（Phase 2）        │ │
│  │   ├── mpd-rebuilder.ts     模式 A: 移除广告 Period + 重建 XML（Phase 2）  │ │
│  │   ├── json-playurl-parser.ts   模式 B: playurl/player JSON 解析         │ │
│  │   ├── json-playurl-rebuilder.ts 模式 B: 移除广告轨 + 重建 JSON            │ │
│  │   ├── ad-detector.ts       扩展信号集（JSON 场景 + XML 场景分别适配）      │ │
│  │   └── resolve-first-url.ts  广告轨首分片 URL 解析（用于指纹计算）          │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────┤
│  Background Layer                                                            │
│  ├── background/dash/handler.ts   清洗后 manifest 推送到下载客户端             │
│  ├── background/media/sniffer.ts  扩展 setMpdProcessHandler + setPlayurlProcessHandler │
│  └── background/media/handler.ts  复用现有下载推送逻辑                        │
├──────────────────────────────────────────────────────────────────────────────┤
│  UI Layer                                                                    │
│  └── player-panel.content.ts      扩展显示 DASH 广告区间                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**处理流程（dash-filter.ts 内部）**：

```
processManifest(rawText, url, pageUrl, headers)
  │
  ├─→ detectManifestType(rawText, url, contentType)
  │     ├─ 检测 JSON?  ─→ 模式 B: json-playurl-parser → ad-detector(JSON 信号) → json-playurl-rebuilder
  │     └─ 检测 XML?   ─→ 模式 A: mpd-parser          → ad-detector(XML 信号) → mpd-rebuilder
  │
  ├─→ 指纹二次过滤（computeFingerprint + lookupFingerprint，复用 shared/fingerprint）
  ├─→ 自动学习（learnFingerprint + suggestRule，复用 shared/suggest）
  ├─→ DRM 检测（发现 Widevine/PlayReady → auto-disabled）
  ├─→ 空 manifest 保护（全广告 → passthrough）
  └─→ 返回 DashProcessResult（含 mode: data-url | manifest-file | passthrough | disabled）
```

### 2.2 与 HLS 模块的复用关系（v2.0 修正）

| 模块 | HLS 源文件 | DASH 目标 | 复用策略 | 估算代码量 |
|------|-----------|----------|---------|-----------|
| 指纹系统 | `hls/fingerprint.ts` | `shared/fingerprint.ts` | **Phase 0 提取**，函数协议无关，直接 import | 0（提取后 shared 共享） |
| 站点规则 | `hls/hls-rules.ts` | `shared/rules.ts` | **Phase 0 提取**，SiteRule 接口字段对 DASH 完全适用 | 0（提取后 shared 共享） |
| 自动学习 | `hls/suggest.ts` | `shared/suggest.ts` | **Phase 0 提取**，信号前缀可配置化 | 0（提取后 shared 共享） |
| 类型定义 | `hls/types.ts` | `dash/types.ts` | 新增 MpdManifest + JsonPlayurlManifest 双结构 | ~200 行 |
| JSON Playurl 解析器 | — | `dash/json-playurl-parser.ts` | **0% 全新**，JSON 解析 + 轨结构标准化 | ~250 行 |
| JSON Playurl 重建器 | — | `dash/json-playurl-rebuilder.ts` | **0% 全新**，从数组移除广告轨 + 重建 JSON | ~150 行 |
| MPD XML 解析器 | — | `dash/mpd-parser.ts` | **0% 全新**，XML DOM 解析（Phase 2） | ~300 行 |
| MPD XML 重建器 | — | `dash/mpd-rebuilder.ts` | **0% 全新**，XML 序列化 + Period 时间重排（Phase 2） | ~200 行 |
| 广告检测器 | `hls/ad-detector.ts` | `dash/ad-detector.ts` | **60% 复用**加权评分框架，信号集扩展（JSON 专属 + XML 专属） | ~320 行 |
| 主入口 | `hls/hls-filter.ts` | `dash/dash-filter.ts` | **75% 复用**流程骨架，新增 manifest 类型分发 | ~250 行 |
| 首分片 URL 解析 | — | `dash/resolve-first-url.ts` | **0% 全新**，SegmentBase / SegmentTemplate 首分片 URL 计算 | ~80 行 |
| content script | `hls/hls.content.ts` | `dash.content.ts` | **90% 复用**，URL/CT 检测扩展到 playurl + mpd | ~60 行 |
| bridge | `hls-bridge.content.ts` | `dash-bridge.content.ts` | **95% 复用**，消息类型替换 | ~30 行 |
| sniffer 扩展 | `media/sniffer.ts` | 同文件 | 新增 `.mpd` + playurl webRequest 嗅探路径 | ~60 行增量 |
| handler | `hls/handler.ts` | `dash/handler.ts` | **85% 复用**，推送逻辑高度相似 | ~90 行 |
| 单元测试 | — | `tests/engine/dash/` | parser + rebuilder + detector + filter | ~400 行 |
| **总计** | | | | **~2640 行**（含 Phase 0 shared 提取 + Phase 2 MPD XML） |
| **Phase 1 增量** | | | 排除 MPD XML（Phase 2）和 shared 提取 | **~1550 行** |

### 2.3 关键设计决策（v2.0 保留 + 新增）

#### 决策 1：manifest 类型分发机制

- **问题**：content script 拦截到一个 URL 后，怎么知道它是 JSON playurl 还是 MPD XML？
- **方案**：dash-filter.ts 内部 `detectManifestType()` 三层检测
  1. URL 模式：`playurl` / `youtubei/v1/player` → JSON；`.mpd` → XML
  2. Content-Type：`application/dash+xml` → XML；`application/json` → JSON
  3. 内容嗅探：`rawText.startsWith('{')` → JSON；`rawText.startsWith('<?xml')` 或含 `<MPD` → XML
- **决策**：**三层联合判断**，URL 优先，内容嗅探兜底（`/manifest` 这种模糊路径必须内容嗅探）

#### 决策 2：DOMParser 选型（MPD XML 场景）

- **选项 A**：浏览器原生 `DOMParser`
- **选项 B**：第三方 XML 解析库（`fast-xml-parser`）
- **决策**：**选项 A** — 零依赖，MV3 Service Worker 是 WorkerGlobalScope，DOMParser 为标准可用 API

#### 决策 3：分片指纹计算方式

- **选项 A**：拦截 `.m4s` fetch，下载前 64KB 计算 SHA-256（类似 HLS `.ts`）
- **选项 B**：复用现有 `mse-hook.content.ts` 的 `appendBuffer` 指纹
- **决策**：**选项 B 优先，选项 A 兜底** — MSE Hook 已就绪，DASH 分片前 64KB SHA-256 计算能力已有，无需额外开发

#### 决策 4：DRM 检测 + auto-disabled

- **新增**：MPD 含 `<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011">` 或 Widevine/PlayReady，playurl JSON 含加密字段 → 自动 `mode = 'disabled'`
- 理由：Out of Scope 说不支持 DRM，但不检测会导致"过滤失败 → 播放器报错 → 用户困惑"

#### 决策 5：空 manifest 保护

- **新增**：所有 Period / 所有轨都被判为广告时，rebuilder 返回 `passthrough` 而非空 XML / 空 JSON
- 理由：空 manifest 播放器无法加载，导致比不过滤更糟糕的体验

#### 决策 6：Phase 0 共享模块提取（消除代码重复）

- **问题**：如果 DASH 复制 fingerprint/rules/suggest，后续维护两套相似代码成本翻倍
- **方案**：Phase 0 提前从 HLS 提取到 `engine/shared/`，HLS 模块改 import 路径，回归测试确保不变
- **理由**：fingerprint.ts 本身协议无关（`computeFingerprint(url)` 接受任意 URL），rules.ts 的 SiteRule 接口 DASH 完全适用

#### 决策 7：storage key 通用化迁移

- **问题**：HLS 用 `hlsFingerprintsLearned` / `hlsUserRules` / `hlsRemoteRulesCache`，DASH 如果也用自己的前缀会分裂指纹库
- **方案**：Phase 0 统一改名为 `adFilterFingerprintsLearned` / `adFilterUserRules` / `adFilterRemoteRulesCache`，带一次性迁移逻辑（旧 key → 新 key 合并后删除旧 key）
- **理由**：HLS 和 DASH 广告指纹本质相同，统一指纹库命中率更高

---

## 三、落地实施任务计划

### 3.1 任务总览

```
Phase 0: 共享模块提取（0.5d — 必做前置，消除代码重复）
├── Task 0.1: 提取 fingerprint → engine/shared/fingerprint.ts
├── Task 0.2: 提取 rules → engine/shared/rules.ts
├── Task 0.3: 提取 suggest → engine/shared/suggest.ts（信号前缀可配置化）
├── Task 0.4: storage key 通用化迁移（hlsFingerprintsLearned → adFilterFingerprintsLearned）
└── Task 0.5: HLS 模块改 import 路径 + 回归测试

Phase 1: JSON Playurl 处理 + 管道接入（Week 1 — 最高优先级，覆盖 B站/YouTube）
├── Task 1.1: 目录结构 + 类型定义（JsonPlayurlManifest / BiliPlayurlTrack / YoutubePlayerResponse 等）
├── Task 1.2: json-playurl-parser.ts（B站 playurl + YouTube player API 解析 + 轨标准化）
├── Task 1.3: json-playurl-rebuilder.ts（从 video[]/audio[] 移除广告轨 + 重建 JSON）
├── Task 1.4: ad-detector.ts 扩展（新增 JSON 场景专属信号 + 原 8 信号标记 XML-only）
├── Task 1.5: resolve-first-url.ts（SegmentBase / SegmentTemplate 首分片 URL 计算，指纹接入前置）
├── Task 1.6: dash-filter.ts 主入口（manifest 类型分发 → 三路径）
├── Task 1.7: dash.content.ts + dash-bridge.content.ts（拦截 playurl + mpd）
├── Task 1.8: sniffer.ts 扩展 webRequest 嗅探（.mpd + playurl JSON，类似 .m3u8 双路径）
├── Task 1.9: background/dash/handler.ts（推送 + cleaned context 持久化）
├── Task 1.10: DRM 检测 + 空 manifest 保护 + enableDashAdFilter 配置入口
└── Task 1.11: 单元测试（capture 样本作为 B站测试向量）

Phase 2: MPD XML 处理（Week 2 — 次优先级，覆盖小众真实 .mpd XML 站点）
├── Task 2.1: mpd-parser.ts（DOMParser XML 解析 + resolveFirstSegmentUrl API）
├── Task 2.2: mpd-rebuilder.ts（移除广告 Period + Period@start 时间重排 + XML 序列化）
├── Task 2.3: mpd-parser + rebuilder 单元测试（DASH-IF 参考服务器样本）
├── Task 2.4: DRM ContentProtection 节点检测 + auto-disabled
└── Task 2.5: 动态 MPD type="dynamic" 检测 + auto-passthrough

Phase 3: 集成优化 + 自动学习闭环（Week 3）
├── Task 3.1: 站点规则系统（shared/rules 复用 + DASH 远程规则加载）
├── Task 3.2: 自动学习闭环（shared/suggest 复用 + 新广告轨/Period 指纹入库）
├── Task 3.3: 指纹策略 — 多码率轨选最高带宽 Representation 做首帧指纹
├── Task 3.4: MSE Hook 扩展 — per-tab manifest 上下文关联
├── Task 3.5: player-panel.content.ts DASH 广告区间显示
├── Task 3.6: 集成测试（端到端 B站 + YouTube + DASH-IF）
├── Task 3.7: 性能优化（大 manifest / 多 Period / DOMParser 内存释放）
└── Task 3.8: 错误恢复（解析/重建失败 → fallback passthrough）

Phase 4: 灰度发布（Week 4）
├── Task 4.1: 功能开关 enableDashAdFilter（Settings 集成，默认 false）
├── Task 4.2: 监控指标 + 日志分级
└── Task 4.3: 灰度发布 + 文档更新 + 代码审查
```

### 3.2 详细任务清单

#### Phase 0: 共享模块提取（0.5d）

**Task 0.1 — 0.3: 提取 fingerprint / rules / suggest 到 shared**

- [ ] 创建 `src/engine/shared/` 目录
- [ ] 提取 `hls/fingerprint.ts` → `shared/fingerprint.ts`
  - `computeFingerprint(url, headers?)` — 函数本身协议无关，直接迁移
  - `lookupFingerprint(hash)` / `learnFingerprint(hash, meta)` — 存储层通用化
  - HLS 的 `fingerprint.ts` 改为 `import { computeFingerprint } from '../shared/fingerprint'`
- [ ] 提取 `hls/hls-rules.ts` → `shared/rules.ts`
  - `SiteRule` 接口对 DASH 完全适用（`hostPattern` / `adUrlPatterns` / `forceKeep` / `scoreThreshold`）
  - 匹配逻辑 + 远程规则加载函数迁移
  - HLS 的 `hls-rules.ts` 改为 re-export
- [ ] 提取 `hls/suggest.ts` → `shared/suggest.ts`
  - `extractPatterns()` 函数硬编码了 `'url-pattern:'` 前缀 → 改为信号前缀可配置数组
  - HLS 默认前缀 `['url-pattern', 'origin-differs', 'path-differs']`
  - DASH JSON 场景额外前缀 `['track-count-anomaly', 'segmentbase-mismatch']`
- [ ] 回归测试：`bun run test` 确保 HLS 全部通过

**验收标准**：
- HLS 引擎行为完全不变（回归测试全绿）
- `shared/` 模块零协议特定逻辑

---

**Task 0.4: storage key 通用化迁移**

- [ ] 新增 storage key 迁移工具函数 `migrateAdFilterKeys()`（在 shared/fingerprint.ts 或 shared/rules.ts）：
  ```
  if (chrome.storage.local.get('hlsFingerprintsLearned')) {
    读取 hlsFingerprintsLearned / hlsUserRules / hlsRemoteRulesCache / hlsSuggestPending
    合并写入 adFilterFingerprintsLearned / adFilterUserRules / adFilterRemoteRulesCache / adFilterSuggestPending
    删除旧 key
  }
  ```
- [ ] HLS 模块内部 storage key 全部改为通用前缀 `adFilter*`

**验收标准**：
- 已有 HLS 用户数据不丢失（旧 key → 新 key 迁移）
- 新用户直接使用通用 key

---

#### Phase 1: JSON Playurl 处理 + 管道接入（Week 1）

**Task 1.1: 类型定义 + 目录结构**

- [ ] 创建目录：
  - `src/engine/dash/`
  - `src/entrypoints/dash.content.ts`（创建，空文件）
  - `src/entrypoints/dash-bridge.content.ts`（创建，空文件）
  - `src/background/dash/handler.ts`（创建，空文件）
- [ ] 实现 `src/engine/dash/types.ts`：
  - **JSON Playurl 类型**（B站 playurl / YouTube player API 通用化）：
    ```typescript
    interface JsonPlayurlManifest {
      type: 'json-playurl'
      source: 'bili-playurl' | 'youtube-player' | 'unknown'
      duration: number
      tracks: PlayurlTrack[]           // 标准化后的统一轨表示
      raw: Record<string, unknown>      // 原始 JSON（rebuilder 时保留未改动部分）
    }
    interface PlayurlTrack {
      id: string                        // 唯一标识
      kind: 'video' | 'audio'
      bandwidth: number
      mimeType: string
      codecs?: string
      width?: number
      height?: number
      baseUrl: string                   // 完整分片 URL（SegmentBase 场景）
      segmentBase?: SegmentBaseInfo
      segmentTemplate?: SegmentTemplateInfo  // YouTube videoplayback 场景
      byteRange?: { start: number; end: number }  // YouTube range 场景
      metadata: Record<string, unknown>  // 原始轨字段保留
    }
    ```
  - **MPD XML 类型**（Phase 2 用，提前定义避免循环依赖）：
    ```typescript
    interface MpdManifest {
      type: 'mpd-xml'
      mpdType: 'static' | 'dynamic'
      mediaPresentationDuration?: string
      minBufferTime?: string
      periods: MpdPeriod[]
      contentProtections?: ContentProtectionInfo[]
      rawXml: string
    }
    interface MpdPeriod {
      id?: string
      start?: string
      duration?: string
      xlinkHref?: string
      adaptations: MpdAdaptation[]
      eventStreams?: MpdEventStream[]
    }
    ```
  - **检测器输出**：
    ```typescript
    interface DashDetectionResult {
      adTrackIds: Set<string>           // JSON Playurl 场景：广告轨 ID
      adPeriodIds: Set<string>           // MPD XML 场景：广告 Period ID
      detections: DashDetection[]
      forceKeep: Set<string>
      summary: DashDetectionSummary
    }
    interface DashDetection {
      targetId: string                  // track ID 或 period ID
      targetType: 'track' | 'period'
      signal: string                    // 'url-pattern' / 'track-count-anomaly' 等
      score: number
      reason: string
      metadata?: Record<string, unknown>
    }
    ```
  - **ProcessResult**：
    ```typescript
    type DashAdDeliveryMode = 'disabled' | 'passthrough' | 'manifest-file' | 'data-url'
    type DashProcessResult =
      | { mode: 'no-ads'; summary: DashDetectionSummary }
      | { mode: 'manifest-file'; cleanedText: string; summary: DashDetectionSummary }
      | { mode: 'data-url'; dataUrl: string; summary: DashDetectionSummary }
      | { mode: 'passthrough'; summary: DashDetectionSummary; reason?: string }
      | { mode: 'disabled'; reason: string }
    ```
- [ ] 更新 `src/types/index.ts` 导出 DASH 类型
- [ ] 新增 `Settings.enableDashAdFilter` 配置字段（Phase 1 就加，方便测试开关）

**验收标准**：
- `bun run typecheck` 通过
- 类型定义覆盖 JSON Playurl + MPD XML 双结构
- `Settings` 含 `enableDashAdFilter: boolean`（默认 false）

---

**Task 1.2: json-playurl-parser.ts**

- [ ] 实现 `src/engine/dash/json-playurl-parser.ts`：
  ```typescript
  function parseJsonPlayurl(rawText: string, url: string): JsonPlayurlManifest
  function detectPlayurlSource(json: unknown, url: string): 'bili-playurl' | 'youtube-player' | 'unknown'
  ```
- [ ] B站 playurl 解析：
  - `data.duration` / `data.video[]` / `data.audio[]` → 标准化为 `tracks[]`
  - `SegmentBase.Initialization` + `baseUrl` → 计算首分片 URL（用于指纹）
  - `track.id` 格式：`v:{视频轨id}` / `a:{音频轨id}`（避免 video/audio 同 id 冲突）
- [ ] YouTube player API 解析（简化版）：
  - `adaptiveFormats[]` / `streamingData.adaptiveFormats[]` → 筛选 DASH 轨（`type='FORMAT_STREAM_TYPE_OTF'` 或 `initRange` 存在）
  - `SegmentBase` 信息：`initRange` + `indexRange` 字段
  - `track.id` 格式：`yt:{itag}`
- [ ] 轨标准化：
  - 统一 `PlayurlTrack` 接口，不同源的字段映射到统一结构
  - 保留 `raw` 原始 JSON（rebuilder 时只修改 tracks 部分）
- [ ] 错误处理：非法 JSON / 空轨道数组 → `passthrough` 模式

**验收标准**：
- 能正确解析 B站 capture 样本（`api/088_playurl`）
- 能正确解析脱敏 YouTube player JSON
- 单元测试覆盖 >80%

---

**Task 1.3: json-playurl-rebuilder.ts**

- [ ] 实现 `src/engine/dash/json-playurl-rebuilder.ts`：
  ```typescript
  function rebuildJsonPlayurl(manifest: JsonPlayurlManifest, adTrackIds: Set<string>): {
    success: boolean
    cleanedJson: Record<string, unknown> | null
    reason?: string
  }
  ```
- [ ] B站 playurl 重建：
  - 从 `data.video[]` 和 `data.audio[]` 中过滤掉 `trackIds` 对应的轨
  - 保留 `support_formats`、`duration`、`minBufferTime` 等顶层字段
- [ ] YouTube player API 重建：
  - 从 `adaptiveFormats[]` 中过滤掉广告轨
  - 保留 `playbackTracking`、`captions` 等非流相关字段
- [ ] 边界处理：
  - **空保护**：所有轨都被判定为广告 → 返回 `success: false, reason: 'all-tracks-ad'`（dash-filter 会 fallback 到 passthrough）
  - **无广告**：adTrackIds 为空 → 返回原始 JSON

**验收标准**：
- 重建后的 JSON 能被原播放器正常解析
- 全广告场景返回安全 fallback
- 单元测试覆盖边界

---

**Task 1.4: ad-detector.ts 扩展**

- [ ] 实现 `src/engine/dash/ad-detector.ts`：
  ```typescript
  function detectAds(manifest: JsonPlayurlManifest | MpdManifest, config: DashAdFilterConfig): DashDetectionResult
  ```
- [ ] **JSON Playurl 场景专属信号**（新实现）：
  | 信号 | 检测逻辑 | 权重 |
  |------|---------|------|
  | `url-pattern` | `track.baseUrl` 匹配 `SiteRule.adUrlPatterns` | 3 |
  | `origin-differs` | 某轨的 baseUrl 域名与大多数轨不同 | 2 |
  | `track-count-anomaly` | 广告轨通常单独出现（如 1 video + 0 audio），内容轨总是成组 video+audio | 2 |
  | `bandwidth-outlier` | 某轨带宽显著低于同 kind 其他轨（广告通常低码率） | 1 |
  | `referer-ad-server` | playurl 请求的 referer 指向已知 ad-server 域名 | 2 |
- [ ] **MPD XML 场景专属信号**（Phase 2 实现，预留接口）：
  | 信号 | 检测逻辑 | 权重 |
  |------|---------|------|
  | `event-scte35` | `EventStream@schemeIdUri="urn:scte:scte35:2013:bin"` | 4 |
  | `event-cue-out` | EventStream spliceType = "out" | 3 |
  | `ad-period-xlink` | Period@xlink:href 指向广告 CDN | 3 |
  | `ad-period-id-pattern` | Period@id 匹配广告关键词（ad/advert/commercial/sponsor/promo） | 2 |
  | `single-adaptation-period` | Period 只有 video AdaptationSet 无 audio（广告常见） | 2 |
  | `low-bitrate-representation` | 广告 Period 的 Representation 带宽显著低于内容 Period | 1 |
  | `duration-outlier` | Period 时长显著短于平均（广告通常 15s/30s/60s） | 1 |
- [ ] **跨场景通用信号**：
  - `forceKeep` 豁免（复用 HLS 机制）
  - `SiteRule.scoreThreshold` 覆盖全局阈值
- [ ] 加权评分框架（100% 复用 HLS ad-detector 的 score → 阈值判定逻辑）

**验收标准**：
- JSON 场景信号能正确识别含广告轨的 playurl
- 加权评分阈值=3 默认生效
- forceKeep 豁免正常工作

---

**Task 1.5: resolve-first-url.ts**

- [ ] 实现 `src/engine/dash/resolve-first-url.ts`：
  ```typescript
  function resolveTrackFirstSegmentUrl(track: PlayurlTrack, baseUrl: string): { url: string; headers?: Record<string, string> } | null
  function resolvePeriodFirstSegmentUrl(period: MpdPeriod, representationId: string, mpd: MpdManifest): { url: string; headers?: Record<string, string> } | null
  ```
- [ ] **SegmentBase 场景**（B站）：
  - `track.baseUrl` 本身就是完整 init 段 URL → 直接用
  - 如果 `SegmentBase.Initialization` 是字节范围 → 构造 `Range` header fetch baseUrl
- [ ] **SegmentTemplate 场景**（YouTube / 部分 MPD XML）：
  - 拼接 `BaseURL + SegmentTemplate@media.replace($RepresentationID$, repId).replace($Time$, startTime).replace($Bandwidth$, bw)`
- [ ] **SegmentTimeline 场景**（MPD XML）：
  - 从 `S@t` 取起始时间点，拼 SegmentTemplate
- [ ] 返回的首分片 URL 用于 `computeFingerprint()`（shared/fingerprint）

**验收标准**：
- B站 SegmentBase 轨能正确返回 init 段 URL
- YouTube segmentTemplate 轨能正确拼接首分片 URL
- 边界：无法解析时返回 null（dash-filter 跳过指纹步骤）

---

**Task 1.6: dash-filter.ts 主入口**

- [ ] 实现 `src/engine/dash/dash-filter.ts`：
  ```typescript
  async function processManifest(
    rawText: string,
    url: string,
    pageUrl: string,
    authHeaders?: Record<string, string>,
    config?: Partial<DashAdFilterConfig>
  ): Promise<DashProcessResult>
  ```
- [ ] manifest 类型分发：
  ```typescript
  function detectManifestType(rawText: string, url: string, contentType?: string): 'json-playurl' | 'mpd-xml' | 'unknown' {
    // 1. URL 模式检测
    if (/playurl/i.test(url) || /youtubei\/v\d+\/player/i.test(url)) return 'json-playurl'
    if (/\.mpd(\?|$)/i.test(url)) return 'mpd-xml'
    // 2. Content-Type 检测
    if (contentType) {
      if (/application\/dash\+xml/i.test(contentType)) return 'mpd-xml'
      if (/application\/json/i.test(contentType)) return 'json-playurl'
    }
    // 3. 内容嗅探兜底
    const trimmed = rawText.trimStart()
    if (trimmed.startsWith('{')) return 'json-playurl'
    if (trimmed.startsWith('<?xml') || trimmed.includes('<MPD')) return 'mpd-xml'
    return 'unknown'
  }
  ```
- [ ] 处理流程：
  ```
  1. 检测类型 → 分发到 json-playurl-parser 或 mpd-parser
  2. DRM 检测 → 发现 ContentProtection → auto-disabled
  3. 广告检测（ad-detector）
  4. 指纹二次过滤（shared/fingerprint）
  5. 自动学习（shared/suggest）
  6. 重建（json-playurl-rebuilder 或 mpd-rebuilder）
  7. 空 manifest 保护 → 全广告 → passthrough
  8. 返回 DashProcessResult
  ```
- [ ] 处理模式分支：`disabled` / `passthrough` / `manifest-file` / `data-url`

**验收标准**：
- JSON playurl 端到端流程能通过集成测试
- MPD XML 端返回 passthrough（Phase 2 实现后再测试）
- 空 manifest 保护生效

---

**Task 1.7: dash.content.ts + dash-bridge.content.ts**

- [ ] 实现 `src/entrypoints/dash.content.ts`（MAIN world）：
  ```typescript
  const isDashManifestUrl = (url: string) =>
    /playurl(\?|$)/i.test(url) ||
    /youtubei\/v\d+\/player/i.test(url) ||
    /\.mpd(\?|$)/i.test(url) ||
    /\/manifest(\?|$)/i.test(url)

  const isDashManifestContentType = (ct: string) =>
    /application\/dash\+xml/i.test(ct) ||
    (/application\/json/i.test(ct) && /dash|mpd|playurl|player/i.test(ct))

  // fetch() hook — 复用 hls.content.ts 模式
  const originalFetch = window.fetch
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url
    if (isDashManifestUrl(url)) {
      const response = await originalFetch.apply(this, arguments as any)
      if (isDashManifestContentType(response.headers.get('content-type') || '')) {
        // 读取 body → sendMessage → SW 处理 → 替换响应
        return interceptDashResponse(response, url)
      }
    }
    return originalFetch.apply(this, arguments as any)
  }
  ```
- [ ] 实现 `src/entrypoints/dash-bridge.content.ts`（ISOLATED world）：
  - 监听 `window.postMessage`（MAIN world 发送）
  - 通过 `chrome.runtime.sendMessage({ type: 'processDashManifest', payload })` 转发给 SW
  - 接收 SW 响应，通过 `postMessage` 回传 MAIN world
  - 3 秒超时处理
  - 完全复用 `hls-bridge.content.ts` 模式，仅消息类型改为 `processDashManifest`

**验收标准**：
- 在 B站测试页面中，playurl fetch 请求能被正确拦截
- 清洗后的 JSON 能替换原始响应
- 非 playurl/mpd 请求不受影响

---

**Task 1.8: sniffer.ts 扩展 webRequest 嗅探**

- [ ] 在 `src/background/media/sniffer.ts` 中新增：
  ```typescript
  let mpdProcessHandler: ((text: string, url: string, headers?: Record<string, string>) => Promise<string | null>) | null = null
  let playurlProcessHandler: ((text: string, url: string, headers?: Record<string, string>) => Promise<Record<string, unknown> | null>) | null = null

  export function setMpdProcessHandler(handler: typeof mpdProcessHandler) { mpdProcessHandler = handler }
  export function setPlayurlProcessHandler(handler: typeof playurlProcessHandler) { playurlProcessHandler = handler }
  ```
- [ ] 扩展 `beforeRequest` 监听器（类似现有 `.m3u8` 处理）：
  ```typescript
  if (/\.mpd(\?|$|$)/i.test(url) || isPlayurlUrl(url)) {
    // 注册 webRequest 响应拦截
    chrome.webRequest.onHeadersReceived.addListener(interceptManifestResponse, { urls: [url], types: ['xmlhttprequest'] }, ['responseHeaders', 'blocking'])
  }
  ```
- [ ] **与 content script 双路径**：content script fetch hook 是主路径，sniffer webRequest 是兜底（用户不使用页面播放、直接用 velo 下载时也能获取过滤后的 manifest）

**验收标准**：
- `.mpd` + playurl 请求能在 webRequest 层被嗅探
- 非 content script 触发的下载也能使用清洗后的 manifest

---

**Task 1.9: background/dash/handler.ts**

- [ ] 实现 `src/background/dash/handler.ts`：
  ```typescript
  interface CleanedDashContext {
    url: string
    pageUrl: string
    type: 'json-playurl' | 'mpd-xml'
    cleanedText: string
    adTrackCount: number
    originalTrackCount: number
    timestamp: number
  }

  async function handleDashManifestProcess(message: ProcessDashManifestMessage, sender: chrome.runtime.MessageSender) {
    const result = await processManifest(message.rawText, message.url, message.pageUrl, message.authHeaders, message.config)
    if (result.mode === 'manifest-file' || result.mode === 'data-url') {
      // 持久化 cleaned context → 供 sniffer 下载链路使用
      await storeCleanedDashContext({ url: message.url, cleanedText: result.cleanedText, ... })
      // 推送到 velo 桌面端（PushClient.push_dash）
      await pushToVeloDash(message.pageUrl, result.cleanedText, result.summary)
    }
    return result
  }
  ```
- [ ] 在 `background.ts` 中注册 handler + 初始化 sniffer：
  ```typescript
  registerMessageHandler('processDashManifest', handleDashManifestProcess)
  setPlayurlProcessHandler(async (text, url) => {
    const result = await processManifest(text, url, '', {})
    return result.mode === 'manifest-file' ? result.cleanedText : null
  })
  setMpdProcessHandler(async (text, url) => { /* 同上 */ })
  ```

**验收标准**：
- content script → bridge → SW → handler 链路完整
- 清洗后 manifest 能持久化到 storage
- PushClient 推送调用正确

---

**Task 1.10: DRM 检测 + 空 manifest 保护 + 配置入口**

- [ ] DRM 检测（dash-filter.ts 内部函数）：
  ```typescript
  function detectDrm(rawText: string, type: 'json' | 'xml'): { hasDrm: boolean; scheme?: string } {
    if (type === 'xml') {
      // 检测 <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011">
      // 或 Widevine / PlayReady / FairPlay
    } else {
      // 检测 JSON 中加密字段
    }
  }
  ```
- [ ] 空 manifest 保护（json-playurl-rebuilder / mpd-rebuilder）：
  ```typescript
  // 全广告场景
  if (remainingTracks.length === 0) {
    return { success: false, reason: 'all-tracks-ad', fallback: 'passthrough' }
  }
  ```
- [ ] `Settings.enableDashAdFilter` 配置：
  - 在 `src/types/index.ts` 的 `Settings` 接口加 `enableDashAdFilter: boolean`（默认 `false`）
  - 在 `dash-filter.ts` 入口检查此开关，关闭时直接 passthrough
  - **理由**：Phase 1 就能开关测试 + 灰度发布

**验收标准**：
- DRM content 自动 disabled，`DashProcessResult.mode === 'disabled'`，reason 含 DRM 类型
- 全广告场景自动 passthrough
- `enableDashAdFilter = false` 时所有 DASH 请求走 passthrough

---

**Task 1.11: 单元测试**

- [ ] 测试文件：
  - `tests/engine/dash/json-playurl-parser.test.ts`
  - `tests/engine/dash/json-playurl-rebuilder.test.ts`
  - `tests/engine/dash/ad-detector.test.ts`（JSON 信号场景）
  - `tests/engine/dash/resolve-first-url.test.ts`
  - `tests/engine/dash/dash-filter.test.ts`
- [ ] B站 capture 样本作为测试 fixture：
  - `tests/fixtures/dash/bili-playurl-capture.json`（脱敏后的 `api/088_playurl`）
  - 验证 parser 能正确解析 12 个 video 轨 + 3 个 audio 轨
- [ ] 模拟 YouTube player JSON fixture
- [ ] 覆盖率 >80%

**验收标准**：
- `bun run test` 全部通过
- 关键路径（parser → detector → rebuilder → filter）测试覆盖

---

#### Phase 2: MPD XML 处理（Week 2）

**Task 2.1: mpd-parser.ts**

- [ ] 实现 `src/engine/dash/mpd-parser.ts`：
  ```typescript
  function parseMpd(xmlText: string): MpdManifest
  function resolveFirstSegmentUrl(period: MpdPeriod, representationId: string, mpd: MpdManifest): { url: string } | null
  ```
- [ ] DOMParser 解析：
  - `MPD@type` / `@mediaPresentationDuration` / `@minBufferTime`
  - 所有 `Period`（`@id` / `@start` / `@duration` / `@xlink:href`）
  - `AdaptationSet`（`@mimeType` / `@lang` / `@contentType`）
  - `Representation`（`@id` / `@bandwidth` / `@width` / `@height` / `@codecs`）
  - `SegmentTemplate`（`@media` / `@initialization` / `@timescale` / `@duration` / `@startNumber`）
  - `BaseURL`（MPD 级 + Period 级 + Representation 级 → 继承链合并）
  - `EventStream`（`@schemeIdUri` / `@value` / `Event@presentationTime` / `Event@duration`）
  - `SegmentTimeline` / `S@t` / `S@d` / `S@r`
  - `ContentProtection`（DRM 检测）
- [ ] 命名空间处理（MPD 常用 `urn:mpeg:dash:schema:mpd:2011` → `getElementsByTagNameNS`）
- [ ] **resolveFirstSegmentUrl**（与 Task 1.5 的 resolveTrackFirstSegmentUrl 配合，用于 MPD XML 场景的指纹计算）
- [ ] 边界：`type="dynamic"` → 标记后 auto-passthrough（P2 迭代再支持）

**验收标准**：
- 能正确解析 DASH-IF 参考服务器 MPD（`https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd`）
- 能正确解析含 EventStream SCTE-35 的测试 MPD
- 单元测试覆盖 >80%

---

**Task 2.2: mpd-rebuilder.ts**

- [ ] 实现 `src/engine/dash/mpd-rebuilder.ts`：
  ```typescript
  function rebuildMpd(mpd: MpdManifest, adPeriodIds: Set<string>): { success: boolean; cleanedXml: string | null; reason?: string }
  ```
- [ ] 核心逻辑：
  - 从 DOMParser 解析的 DOM 树中移除 adPeriodIds 对应的 `<Period>` 节点
  - **Period@start 时间连续性修复**：
    ```
    假设原有 Period: A(start=0, dur=60), B(start=60, dur=15)[广告], C(start=75, dur=120)
    移除 B 后 → C.start 应该从 75 改为 60（即 A.start + A.duration）
    ```
    重排所有后续 Period 的 `@start` 属性
  - XML 序列化：保留原始命名空间 + XML 声明（`<?xml version="1.0" encoding="UTF-8"?>`）
- [ ] 边界处理：
  - 移除第一个 Period → 后续 Period 的 start 调整
  - 移除最后一个 Period → 只需要删除节点
  - 移除中间 Period → 前后 Period 的 start 都要重排
  - **空保护**：所有 Period 都是广告 → 返回 `success: false`（dash-filter fallback 到 passthrough）

**验收标准**：
- 重建后的 MPD 能被 `dash.js` / `shaka-player` 正常解析
- Period@start 时间连续性正确
- 单元测试覆盖所有边界场景

---

**Task 2.3: mpd-parser + rebuilder 单元测试**

- [ ] `tests/engine/dash/mpd-parser.test.ts`
- [ ] `tests/engine/dash/mpd-rebuilder.test.ts`
- [ ] DASH-IF 参考服务器 MPD fixture + 模拟广告 Period fixture
- [ ] 覆盖率 >80%

---

**Task 2.4: DRM ContentProtection 节点检测**

- [ ] 扩展 mpd-parser / dash-filter 的 DRM 检测函数：
  - 检测 `<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011">`（CENC）
  - Widevine: `schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"`
  - PlayReady: `schemeIdUri="urn:uuid:9a04f079-9840-4ab8-a5e8-5ab0385f3852"`
  - FairPlay: `schemeIdUri="urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2"`
  - 发现任一 → `mode = 'disabled'`，reason 含具体 DRM 类型

---

**Task 2.5: 动态 MPD 检测**

- [ ] 在 mpd-parser 中检测 `MPD@type="dynamic"` → dash-filter 返回 `mode = 'passthrough', reason = 'dynamic-mpd-not-supported'`
- [ ] 理由：动态 MPD 需要持续拦截更新请求，复杂度显著增加，P0 不支持

---

#### Phase 3: 集成优化 + 自动学习闭环（Week 3）

**Task 3.1: 站点规则系统**

- [ ] 复用 `shared/rules` 模块，DASH 的 `DashSiteRule` 与 HLS `SiteRule` 格式一致
- [ ] 远程规则加载（复用 HLS `remoteRulesUrl` 配置）
- [ ] 验证：能为 YouTube / B站配置 DASH 专属规则

**验收标准**：规则匹配 + 远程加载 + 热更新正常

---

**Task 3.2: 自动学习闭环**

- [ ] 复用 `shared/suggest` 模块
- [ ] DASH 新增的 JSON 专属信号前缀（`track-count-anomaly` / `segmentbase-mismatch`）加入配置
- [ ] 新广告轨 / 广告 Period 指纹自动入库
- [ ] 规则建议反向生成（从 ad-detector 的 detections → SiteRule 候选）

**验收标准**：自动学习开关正常工作，学习到的指纹能在后续命中过滤

---

**Task 3.3: 指纹策略**

- [ ] 一个广告 Period / Playurl 有多个 Representation（多码率）时 → 选**最高带宽 Representation** 做首帧指纹（质量最稳定，指纹碰撞率低）
- [ ] 逻辑：`tracks.filter(t => t.kind === 'video').sort((a, b) => b.bandwidth - a.bandwidth)[0]`

---

**Task 3.4: MSE Hook 扩展**

- [ ] 扩展 `src/entrypoints/mse-hook.content.ts`：
  - 当前已计算前 64KB SHA-256 → 关联当前页面的 manifest context
  - 需要 background 维护 per-tab 的 manifest URL → 关联 MSE 流
  - 广告分片识别：通过指纹匹配 → 标记日志（不强制替换分片数据，P2 再考虑）

---

**Task 3.5: player-panel.content.ts 广告区间显示**

- [ ] 扩展 `src/entrypoints/player-panel.content.ts`：
  - 接收 DASH `AdRange[]`（JSON Playurl 场景：广告轨对应的时长范围；MPD XML 场景：广告 Period 对应的 `@start` + `@duration`）
  - 在页面内显示广告跳过按钮（与 HLS 一致）
  - ⚠️ 注意：player-panel.content.ts 已经非常大（112k+ 字符），扩展逻辑提取到独立组件文件

---

**Task 3.6: 集成测试**

- [ ] `tests/integration/dash-filter-pipeline.test.ts`
- [ ] 完整流程：content script 拦截 → bridge → SW → processManifest → 清洗 → 替换响应
- [ ] 端到端测试：B站 playurl fixture + DASH-IF MPD fixture

---

**Task 3.7 — 3.8: 性能 + 错误恢复**

- [ ] 大 manifest 优化（>1MB）
- [ ] 多 Period 性能（>100 个 Period）
- [ ] DOMParser 内存及时释放
- [ ] 错误恢复：parser / detector / rebuilder 任何环节异常 → fallback `passthrough`，不影响正常播放

---

#### Phase 4: 灰度发布（Week 4）

**Task 4.1: 功能开关**

- [ ] `Settings.enableDashAdFilter` 在设置 UI 中暴露开关（默认 false）
- [ ] 可按 `mode` 单独开关（`data-url` / `manifest-file` / `passthrough` / `disabled`）

---

**Task 4.2: 监控指标**

- [ ] 日志分级 `logger.info` / `logger.warn` / `logger.error`
- [ ] 监控指标：
  - DASH manifest 拦截次数
  - 广告检测命中率
  - 清洗成功率
  - 指纹库命中率
  - 解析 / 重建失败率
  - DRM 检测次数

---

**Task 4.3: 代码审查 + 文档**

- [ ] `bun run typecheck` 零错误
- [ ] `bun run test` 全绿
- [ ] 测试覆盖率 >80%
- [ ] 无 `console.log` 残留
- [ ] 遵循项目代码规范
- [ ] README 更新（新增 DASH 功能说明）

---

## 四、风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| YouTube 广告可能通过多种 API 变体返回 | 高 | 高 | 优先覆盖 `/youtubei/v1/player` 主流路径，其他变体逐步适配；检测失败 fallback passthrough |
| B站片头广告可能通过独立 playurl 请求 | 中 | 中 | 前端多 playurl 请求关联检测（同一页面短时间内多个 playurl 请求，可能是"广告→正片"切换） |
| MPD XML 格式多样性（命名空间差异 / SegmentTemplate 复杂模板） | 高 | 中 | 优先支持 DASH-IF 参考服务器 + 主流平台，其他逐步适配；DOMParser 标准 DOM API 足够灵活 |
| 播放器对清洗后 manifest 兼容性差 | 中 | 高 | JSON Playurl 只删轨不改其他字段（兼容性高）；MPD XML 严格保留 XML Schema；提供 passthrough 模式 |
| 动态 MPD 未支持导致用户投诉 | 中 | 中 | P0 明确声明仅支持 VOD；检测 type="dynamic" auto-passthrough；P2 迭代支持 |
| DRM 内容 auto-disabled 导致期望落差 | 低 | 中 | 文档明确说明；UI 提示"检测到受 DRM 保护的内容，暂不支持过滤" |
| 指纹计算影响播放性能 | 低 | 中 | 仅计算前 64KB；异步不阻塞；shared/fingerprint 已有优化 |
| sniffer.ts 文件已较大（~1200 行），扩展后继续膨胀 | 中 | 低 | playurl + mpd 嗅探逻辑独立提取到 `background/media/manifest-sniffer.ts`，sniffer.ts 只做委派 |
| Phase 0 storage key 迁移丢失用户数据 | 低 | 高 | 迁移逻辑做双写验证（新 key 写入后，立即读回校验，校验成功再删旧 key） |
| Phase 0 shared 提取导致 HLS 回归 | 中 | 高 | 提取后 HLS 模块完全保留原 import 路径（re-export），先验证一周 DASH 稳定后再彻底清理 |

---

## 五、验收标准汇总

### 5.1 功能验收

- [ ] **Phase 1**：JSON Playurl 端到端流程正常（B站 playurl + YouTube player API）
- [ ] **Phase 1**：content script 拦截 playurl + mpd + manifest URL
- [ ] **Phase 1**：ad-detector JSON 场景信号正确识别广告轨（阈值=3）
- [ ] **Phase 1**：指纹二次过滤命中已知广告轨
- [ ] **Phase 1**：空 manifest 保护生效（全广告 → passthrough）
- [ ] **Phase 1**：DRM 检测 + auto-disabled
- [ ] **Phase 1**：`enableDashAdFilter` 开关正常
- [ ] **Phase 2**：MPD XML 端到端流程正常
- [ ] **Phase 2**：Period@start 时间连续性修复
- [ ] **Phase 2**：动态 MPD auto-passthrough
- [ ] **Phase 3**：自动学习闭环（shared/suggest）
- [ ] **Phase 3**：player-panel DASH 广告区间显示 + 跳过
- [ ] **Phase 0**：storage key 通用化迁移 + HLS 回归测试全绿

### 5.2 质量验收

- [ ] `bun run typecheck` 零错误
- [ ] `bun run lint` 零错误（max-warnings=10 内）
- [ ] `bun run test` 全部通过
- [ ] 测试覆盖率 >80%
- [ ] 无 `console.log` 残留（使用 `lib/logger.ts`）
- [ ] 代码审查通过

### 5.3 性能验收

- [ ] JSON Playurl 解析 < 30ms（典型 B站 playurl < 50KB）
- [ ] MPD XML 解析 < 50ms（典型 < 500KB）
- [ ] 广告检测 < 20ms（< 30 个 Period / < 30 个轨）
- [ ] manifest 重建 < 30ms
- [ ] 端到端流程 < 200ms（拦截 → 清洗 → 替换）
- [ ] 内存占用增长 < 10MB（长时间运行）

---

## 六、附录

### 6.1 参考文档

- [DASH-IF IOP Guidelines](https://dashif.org/guidelines/)
- [SCTE 35 2020 - Digital Program Insertion Cueing Message](https://www.scte.org/standards/library/catalog/scte-35-2020/)
- [MPEG-DASH Standard ISO/IEC 23009-1](https://www.iso.org/standard/83314.html)
- [Bilibili playurl API 文档](https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/video/playurl.md)
- velo-extension HLS 实现：`src/engine/hls/*`
- velo-extension B站样本：`tmp/capture-1793081523116-isnfdsej/`

### 6.2 测试样本来源

| 样本 | 来源 | 格式 | 阶段 |
|------|------|------|------|
| B站 playurl | `tmp/capture-1793081523116-isnfdsej/api/088_playurl`（脱敏） | JSON | Phase 1 Task 1.11 |
| YouTube player | 通过 yt-dlp 提取后脱敏 | JSON | Phase 1 Task 1.11 |
| DASH-IF VOD MPD | `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` | XML | Phase 2 Task 2.3 |
| SCTE-35 EventStream MPD | 手动构造（模拟广告 Period） | XML | Phase 2 Task 2.3 |

### 6.3 命名规范

- 文件命名：kebab-case（如 `dash-filter.ts`）
- 类型前缀：`Dash`（如 `DashProcessResult`）或按来源前缀（`JsonPlayurlManifest` / `MpdManifest`）
- 函数命名：camelCase（如 `processManifest()` / `detectManifestType()`）
- 常量命名：UPPER_SNAKE_CASE（如 `DEFAULT_DASH_CONFIG` / `DRM_SCHEME_ID_URIS`）
- 存储 key 前缀：`adFilter*`（通用化，HLS/DASH 共享）

### 6.4 变化记录

| 版本 | 日期 | 主要变化 |
|------|------|---------|
| v1.0 | 2026-10-25 | 初始版本，单路径 MPD XML 架构 |
| v2.0 | 2026-10-27 | 基于 B站真实样本修正：三路径分发式架构（JSON Playurl 高优 + MPD XML 次优 + 纯分片兜底）；新增 Phase 0 共享模块提取；扩展 ad-detector 信号集；新增 DRM 检测 + 空 manifest 保护；新增 storage key 通用化迁移 |