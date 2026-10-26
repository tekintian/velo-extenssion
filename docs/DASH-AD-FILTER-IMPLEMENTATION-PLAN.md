# DASH/MPD 广告过滤功能实施任务计划

> **目标**：在 velo-extension 中新增 DASH/MPD 广告分片过滤能力，复用现有 HLS 广告过滤引擎架构，实现与 HLS 同等级别的广告检测、指纹过滤、自动学习闭环。
>
> **作者**：tekintian <tekintian@gmail.com>
> **日期**：2026-10-25
> **版本**：v1.0
> **依赖基线**：velo-extension v0.2.0（WXT + TypeScript + React + Tailwind CSS + Vitest）

---

## 一、需求/问题评估

### 1.1 现状分析

velo-extension 当前已实现：

| 能力 | 状态 | 文件 |
|------|------|------|
| HLS m3u8 嗅探 + 广告过滤 | ✅ 完整 | `entrypoints/hls.content.ts` / `engine/hls/*` |
| DASH 媒体嗅探（.m4s 分片） | ✅ 仅嗅探下载 | `background/media/sniffer.ts` |
| DASH 音视频配对 | ✅ 仅配对下载 | `background/media/sniffer.ts` `pairDashItems()` |
| MPD manifest 嗅探 | ❌ 未实现 | — |
| MPD 解析 | ❌ 未实现 | — |
| DASH 广告过滤 | ❌ 未实现 | — |
| MSE Hook（SHA-256 指纹） | ✅ 已就绪 | `entrypoints/mse-hook.content.ts` |

### 1.2 问题定义

- **用户痛点**：YouTube、B站、Twitch 等平台大量使用 DASH 流媒体，当前扩展只能嗅探下载 DASH 分片，**无法过滤广告 Period**，导致下载/播放包含广告内容。
- **技术债务**：HLS 广告过滤引擎（`engine/hls/`）已成熟，但 DASH 侧完全空白，架构能力不对等。
- **竞品差距**：AdGuard 已实现基础 MPD 级过滤，velo-extension 需补齐此能力以保持竞争力。

### 1.3 需求边界

**In Scope**：
- MPD manifest 嗅探（fetch/XHR 拦截 `.mpd`）
- MPD XML 解析 → 结构化对象
- DASH 广告检测（7 信号加权体系，复用 HLS）
- 清洗后 MPD 重建（移除广告 Period）
- 指纹二次过滤 + 自动学习闭环（复用 HLS）
- 站点规则系统（复用 HLS 规则格式）
- 处理模式：`data-url` / `mpd-file` / `passthrough` / `disabled`
- content script 注入（MAIN world fetch/XHR hook）
- 与 velo 桌面端推送集成（清洗后 MPD 推送）

**Out of Scope**：
- DASH 直播动态 MPD (`type="dynamic"`) 实时更新（P2 迭代）
- DRM 保护内容过滤（Widevine/PlayReady，技术不可行）
- 非 MPD 的纯 MSE 流广告过滤（无 manifest 场景）
- DASH 下载合并格式扩展（保持现有 mp4/ts 支持）

---

## 二、技术实现方案

### 2.1 核心架构：复用 HLS 双轨设计

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        DASH 广告过滤架构（复用 HLS）                      │
├─────────────────────────────────────────────────────────────────────────┤
│  Entry Layer (Content Scripts)                                          │
│  ├── dash.content.ts          [MAIN world] 拦截 fetch/XHR .mpd 请求     │
│  ├── dash-bridge.content.ts   [ISOLATED] MAIN ↔ background 消息桥接      │
│  └── mse-hook.content.ts      [MAIN world] 已就绪，可选扩展 DASH 指纹    │
├─────────────────────────────────────────────────────────────────────────┤
│  Engine Layer (Service Worker)                                          │
│  └── engine/dash/                                                       │
│      ├── dash-filter.ts       主入口: processManifest()                 │
│      ├── mpd-parser.ts        MPD XML → 结构化对象                      │
│      ├── mpd-rebuilder.ts     移除广告 Period，重建 MPD XML              │
│      ├── ad-detector.ts       DASH 广告检测（7 信号加权）                │
│      ├── fingerprint.ts       SHA-256 指纹库（复用 engine/hls/）         │
│      ├── dash-rules.ts        站点规则管理（复用 hls-rules.ts 格式）     │
│      ├── suggest.ts           自动学习 + 规则建议（复用 engine/hls/）    │
│      └── types.ts             DASH 类型定义                             │
├─────────────────────────────────────────────────────────────────────────┤
│  Background Layer                                                       │
│  ├── background/dash/handler.ts   清洗后 MPD 推送到下载客户端             │
│  └── background/media/handler.ts  复用现有下载推送逻辑                    │
├─────────────────────────────────────────────────────────────────────────┤
│  UI Layer                                                               │
│  └── player-panel.content.ts      扩展显示 DASH 广告区间（P1）           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 与 HLS 模块的复用关系

| 模块 | HLS 源文件 | DASH 目标文件 | 复用策略 | 估算代码量 |
|------|-----------|--------------|---------|-----------|
| 类型定义 | `engine/hls/types.ts` | `engine/dash/types.ts` | 30% 复用，新增 MPD 结构 | ~150 行 |
| 广告检测 | `engine/hls/ad-detector.ts` | `engine/dash/ad-detector.ts` | 60% 复用，信号体系映射 | ~250 行 |
| 指纹系统 | `engine/hls/fingerprint.ts` | `engine/dash/fingerprint.ts` | **90% 复用**，直接复制改命名 | ~30 行包装 |
| 站点规则 | `engine/hls/hls-rules.ts` | `engine/dash/dash-rules.ts` | **80% 复用**，规则格式相同 | ~50 行包装 |
| 自动学习 | `engine/hls/suggest.ts` | `engine/dash/suggest.ts` | **90% 复用**，直接复制改命名 | ~30 行包装 |
| MPD 解析器 | — | `engine/dash/mpd-parser.ts` | **0% 全新**，XML DOM 解析 | ~300 行 |
| MPD 重建器 | — | `engine/dash/mpd-rebuilder.ts` | **0% 全新**，XML 序列化 | ~200 行 |
| 主入口 | `engine/hls/hls-filter.ts` | `engine/dash/dash-filter.ts` | 70% 复用，流程相同 | ~200 行 |
| content script | `entrypoints/hls.content.ts` | `entrypoints/dash.content.ts` | **90% 复用**，URL 检测不同 | ~50 行 |
| bridge | `entrypoints/hls-bridge.content.ts` | `entrypoints/dash-bridge.content.ts` | **95% 复用**，消息类型不同 | ~30 行 |
| handler | `background/hls/handler.ts` | `background/dash/handler.ts` | **80% 复用**，推送逻辑相同 | ~100 行 |
| **总计** | | | | **~1590 行** |

### 2.3 关键设计决策

#### 决策 1：MPD 解析器选型

- **选项 A**：使用浏览器原生 `DOMParser`（已在 MV3 content script / SW 中可用）
- **选项 B**：引入第三方 XML 解析库（如 `fast-xml-parser`）
- **决策**：**选项 A** — 零依赖，原生支持，性能足够，避免增加 bundle 体积。

#### 决策 2：DASH 分片指纹计算方式

- **选项 A**：拦截 `.m4s` 分片 fetch，下载前 64KB 计算 SHA-256（类似 HLS `.ts`）
- **选项 B**：复用现有 `mse-hook.content.ts` 的 `appendBuffer` 指纹（已计算前 64KB SHA-256）
- **决策**：**选项 B 优先，选项 A 兜底** — MSE Hook 已就绪，可直接复用；对于非 MSE 场景（如直接 fetch `.m4s`）再启用选项 A。

#### 决策 3：广告 Period 判定后处理

- **选项 A**：移除整个广告 Period，重建 MPD（彻底过滤）
- **选项 B**：保留 Period 但替换 `BaseURL` 为空白分片（占位跳过）
- **决策**：**选项 A** — 与 HLS 的 "移除广告分片" 策略一致，简单直接，播放器兼容性更好。

#### 决策 4：动态 MPD（直播）支持

- **选项 A**：P0 阶段即支持 `type="dynamic"` MPD 的实时更新监听
- **选项 B**：P0 阶段仅支持 `type="static"` VOD，直播放到 P2
- **决策**：**选项 B** — 动态 MPD 需要持续拦截更新请求，复杂度显著增加，VOD 场景覆盖 80% 广告过滤需求。

---

## 三、落地实施任务计划

### 3.1 任务总览

```
Phase 1: 基础设施（Week 1）
├── Task 1.1: 目录结构搭建 + 类型定义
├── Task 1.2: MPD XML 解析器实现
├── Task 1.3: MPD XML 重建器实现
└── Task 1.4: 单元测试基座（parser + rebuilder）

Phase 2: 核心引擎（Week 2）
├── Task 2.1: DASH 广告检测器（7 信号映射）
├── Task 2.2: 指纹系统接入（复用 HLS）
├── Task 2.3: dash-filter.ts 主入口整合
└── Task 2.4: 单元测试（detector + filter）

Phase 3: 管道接入（Week 3）
├── Task 3.1: dash.content.ts + dash-bridge.content.ts
├── Task 3.2: background/dash/handler.ts 推送逻辑
├── Task 3.3: 站点规则系统（复用 HLS 格式）
├── Task 3.4: 自动学习闭环（复用 HLS）
└── Task 3.5: 集成测试（端到端）

Phase 4: 集成优化（Week 4）
├── Task 4.1: player-panel.content.ts DASH 广告区间显示
├── Task 4.2: MSE Hook 扩展（DASH 分片指纹关联）
├── Task 4.3: 性能优化 + 边界场景处理
├── Task 4.4: 文档更新 + 代码审查
└── Task 4.5: 灰度发布 + 监控
```

### 3.2 详细任务清单

#### Phase 1: 基础设施（Week 1）

**Task 1.1: 目录结构搭建 + 类型定义**

- [ ] 创建 `src/engine/dash/` 目录
- [ ] 创建 `src/entrypoints/dash.content.ts`
- [ ] 创建 `src/entrypoints/dash-bridge.content.ts`
- [ ] 创建 `src/background/dash/handler.ts`
- [ ] 实现 `src/engine/dash/types.ts`：
  - `MpdManifest` / `Period` / `AdaptationSet` / `Representation` / `SegmentTemplate`
  - `EventStream` / `Event`
  - `DashDetectionResult` / `DashDetectionReport`
  - `DashProcessResult`（discriminated union，类比 HLS `ProcessResult`）
  - `DashAdDeliveryMode` = `'data-url' | 'passthrough' | 'mpd-file' | 'disabled'`
  - `DashSiteRule`（复用 HLS `SiteRule` 格式）
- [ ] 更新 `src/types/index.ts` 导出 DASH 类型

**验收标准**：
- `bun run typecheck` 通过
- 类型定义覆盖所有 MPD 结构元素

---

**Task 1.2: MPD XML 解析器实现**

- [ ] 实现 `src/engine/dash/mpd-parser.ts`：
  - `parseMpd(xmlText: string): MpdManifest`
  - 使用 `DOMParser` 解析 XML
  - 提取 `MPD@type` / `MPD@mediaPresentationDuration`
  - 提取所有 `Period`（`@id` / `@start` / `@duration` / `@xlink:href`）
  - 提取 `AdaptationSet`（`@mimeType` / `@lang`）
  - 提取 `Representation`（`@id` / `@bandwidth` / `@width` / `@height`）
  - 提取 `SegmentTemplate`（`@media` / `@initialization` / `@timescale` / `@duration` / `@startNumber`）
  - 提取 `BaseURL`
  - 提取 `EventStream`（`@schemeIdUri` / `@value` / `Event@presentationTime` / `Event@duration`）
  - 提取 `SegmentTimeline` / `S@t` / `S@d` / `S@r`
- [ ] 处理命名空间（MPD 常用 `urn:mpeg:dash:schema:mpd:2011`）
- [ ] 错误处理：非法 XML / 缺失必需元素

**验收标准**：
- 能正确解析 YouTube / B站 / 标准 DASH-IF 测试 MPD
- 单元测试覆盖 >80%

---

**Task 1.3: MPD XML 重建器实现**

- [ ] 实现 `src/engine/dash/mpd-rebuilder.ts`：
  - `rebuildMpd(mpd: MpdManifest, adPeriodIds: Set<string>): string`
  - 过滤掉 `adPeriodIds` 中的 Period
  - 调整后续 `Period@start`（时间连续性）
  - 重建 `SegmentTemplate` `$Number$` 连续性（如果断点需要）
  - 序列化为合法 XML（含 XML 声明）
  - 保留原始命名空间
- [ ] 处理边界：移除第一个 Period / 移除最后一个 Period / 移除所有 Period

**验收标准**：
- 重建后的 MPD 能被 `dash.js` / `shaka-player` 正常解析
- 单元测试覆盖所有边界场景

---

**Task 1.4: 单元测试基座**

- [ ] 创建 `tests/engine/dash/mpd-parser.test.ts`
- [ ] 创建 `tests/engine/dash/mpd-rebuilder.test.ts`
- [ ] 准备测试 MPD 样本：
  - 标准 VOD MPD（DASH-IF 测试向量）
  - YouTube DASH MPD（脱敏）
  - 含广告 Period 的 MPD（模拟）
  - 含 EventStream SCTE-35 的 MPD（模拟）

**验收标准**：
- `bun run test` 全部通过
- 测试覆盖率 >80%

---

#### Phase 2: 核心引擎（Week 2）

**Task 2.1: DASH 广告检测器（7 信号映射）**

- [ ] 实现 `src/engine/dash/ad-detector.ts`：
  - `detectAds(mpd: MpdManifest, config: DashAdFilterConfig): DashDetectionResult`
  - **信号 1: `event-scte35`** — `EventStream` 含 `urn:scte:scte35:2013:bin`，事件标记为广告
  - **信号 2: `event-cue-out`** — `EventStream` 含 `spliceType="out"` 或等价值
  - **信号 3: `ad-period`** — `Period` 含 `xlink:href` 指向广告 CDN，或 `@id` 匹配广告模式
  - **信号 4: `low-bitrate-representation`** — 广告 Period 的 Representation 带宽显著低于内容 Period
  - **信号 5: `single-adaptation-period`** — 广告 Period 只有单个 AdaptationSet（内容通常有 video+audio）
  - **信号 6: `url-pattern`** — `BaseURL` / `SegmentTemplate@media` 匹配已知广告域名正则
  - **信号 7: `origin-differs`** — 广告 Period 的 `BaseURL` 域名与内容 Period 不同
  - **信号 8: `duration-outlier`** — Period 时长显著短于平均（广告通常 15s/30s）
  - **加权评分**：默认阈值 = 3（可配置）
  - `forceKeep` 豁免机制（与 HLS 相同）
- [ ] 信号权重配置（与 HLS 对齐）

**验收标准**：
- 能正确识别含 SCTE-35 EventStream 的测试 MPD 中的广告 Period
- 单元测试覆盖所有 8 个信号

---

**Task 2.2: 指纹系统接入**

- [ ] 复用 `src/engine/hls/fingerprint.ts`：
  - 创建 `src/engine/dash/fingerprint.ts` 作为薄包装
  - 或提取公共指纹逻辑到 `src/engine/shared/fingerprint.ts`
- [ ] DASH 分片指纹计算：
  - 复用 `computeFingerprint(url, headers)`（已支持任意 URL）
  - 广告 Period 的首分片 URL 作为指纹来源
- [ ] 指纹库查询：`lookupFingerprint(hash)`（完全复用）
- [ ] 自动学习：`learnFingerprint(hash, meta)`（完全复用）

**验收标准**：
- DASH 指纹流程与 HLS 指纹流程行为一致
- 共享同一指纹存储（`chrome.storage.local`）

---

**Task 2.3: dash-filter.ts 主入口整合**

- [ ] 实现 `src/engine/dash/dash-filter.ts`：
  - `processManifest(xmlText: string, baseUrl: string, pageUrl: string, authHeaders?: Record<string, string>): Promise<DashProcessResult>`
  - 流程：
    1. 解析 MPD（`mpd-parser.ts`）
    2. 检测广告（`ad-detector.ts`）
    3. 指纹二次过滤（`fingerprint.ts`）
    4. 自动学习（`suggest.ts`）
    5. 重建 MPD（`mpd-rebuilder.ts`）
    6. 返回 `DashProcessResult`
- [ ] 处理模式分支：`disabled` / `passthrough` / `mpd-file` / `data-url`
- [ ] 统计报告生成（与 HLS `DetectionReport` 对齐）

**验收标准**：
- 端到端流程能通过集成测试
- 无广告 MPD 返回 `no-ads` 模式
- 含广告 MPD 返回 `mpd-file` 或 `data-url` 模式

---

**Task 2.4: 单元测试**

- [ ] `tests/engine/dash/ad-detector.test.ts`
- [ ] `tests/engine/dash/dash-filter.test.ts`
- [ ] 测试覆盖：
  - 无广告 MPD
  - 含 1 个广告 Period
  - 含多个广告 Period
  - 全广告 MPD（边界）
  - forceKeep 豁免
  - 指纹命中过滤

---

#### Phase 3: 管道接入（Week 3）

**Task 3.1: dash.content.ts + dash-bridge.content.ts**

- [ ] 实现 `src/entrypoints/dash.content.ts`（MAIN world）：
  - 拦截 `fetch()` — 检测 `.mpd` URL
  - 拦截 `XMLHttpRequest` — 检测 `.mpd` URL
  - `isMpdUrl(url): boolean` — `.mpd` 后缀 + `/manifest` 路径
  - `isMpdContentType(ct): boolean` — `application/dash+xml` + `text/plain`
  - 通过 `postMessage` 发送给 bridge
- [ ] 实现 `src/entrypoints/dash-bridge.content.ts`（ISOLATED world）：
  - 监听 `window.postMessage`
  - 通过 `chrome.runtime.sendMessage` 转发给 SW
  - 接收 SW 响应，通过 `postMessage` 回传
  - 3 秒超时处理

**验收标准**：
- 在测试页面中，`.mpd` fetch 请求能被正确拦截
- 清洗后的 MPD 能替换原始响应

---

**Task 3.2: background/dash/handler.ts 推送逻辑**

- [ ] 实现 `src/background/dash/handler.ts`：
  - `handleCleanedMpd(ctx: CleanedMpdContext)` — 类比 `background/hls/handler.ts`
  - 推送到 velo 桌面端（WebSocket / HTTP RPC）
  - aria2 / ndm / native 下载模式支持
  - 文件名生成（`{title}_cleaned.mpd`）
- [ ] 更新 `background/media/handler.ts`：
  - 检测 `.mpd` 下载请求，优先使用 cleaned context
  - 复用现有 `sendToVeloM3u8` / `sendToAria2` / `sendToNdm` 逻辑

**验收标准**：
- 清洗后的 MPD 能成功推送到 velo 桌面端
- 下载客户端切换（velo/aria2/ndm/native）正常工作

---

**Task 3.3: 站点规则系统**

- [ ] 复用 `src/engine/hls/hls-rules.ts`：
  - 创建 `src/engine/dash/dash-rules.ts` 作为薄包装
  - 或提取公共规则逻辑到 `src/engine/shared/rules.ts`
- [ ] DASH 站点规则格式：
  ```typescript
  interface DashSiteRule {
    id: string
    name: string
    hostPattern: string
    adUrlPatterns: string[]
    scoreThreshold?: number
    mode?: DashAdDeliveryMode
    forceKeep: string[]
  }
  ```
- [ ] 远程规则加载（复用 HLS `remoteRulesUrl` 配置）

**验收标准**：
- 能为特定站点（如 YouTube）配置 DASH 广告规则
- 规则热更新正常工作

---

**Task 3.4: 自动学习闭环**

- [ ] 复用 `src/engine/hls/suggest.ts`：
  - 创建 `src/engine/dash/suggest.ts` 作为薄包装
  - 或提取公共逻辑到 `src/engine/shared/suggest.ts`
- [ ] DASH 广告 Period 指纹自动入库
- [ ] 规则建议生成（反向生成 `DashSiteRule`）

**验收标准**：
- 自动学习开关正常工作
- 学习到的指纹能在后续播放中命中过滤

---

**Task 3.5: 集成测试**

- [ ] 创建 `tests/integration/dash-filter-pipeline.test.ts`
- [ ] 模拟完整流程：
  1. content script 拦截 `.mpd` fetch
  2. bridge 转发到 SW
  3. SW 调用 `processManifest()`
  4. 返回清洗后 MPD
  5. content script 替换响应
- [ ] 端到端测试（使用真实测试 MPD）

---

#### Phase 4: 集成优化（Week 4）

**Task 4.1: player-panel.content.ts DASH 广告区间显示**

- [ ] 扩展 `src/entrypoints/player-panel.content.ts`：
  - 接收 DASH `AdRange[]`（广告时间区间）
  - 在页面内显示广告跳过按钮（与 HLS 一致）
  - 点击跳过到广告结束时间点

**验收标准**：
- DASH 广告区间能正确显示在播放器面板上
- 跳过按钮功能正常

---

**Task 4.2: MSE Hook 扩展**

- [ ] 扩展 `src/entrypoints/mse-hook.content.ts`：
  - 当前仅上报 `mimeType` / `byteLength` / `hash`
  - 新增：关联 MSE 流与当前页面的 MPD context
  - 在 `appendBuffer` 中识别广告分片（通过指纹匹配）
  - 可选：替换广告分片为空白数据（高级功能，P2）

**验收标准**：
- MSE 分片指纹能与 DASH 广告检测关联
- 广告分片能被标记（不强制替换，先标记）

---

**Task 4.3: 性能优化 + 边界场景**

- [ ] 大 MPD 文件优化（>1MB 的 MPD 罕见，但需处理）
- [ ] 多 Period MPD 性能（>100 个 Period）
- [ ] `SegmentTemplate` 复杂模板（`$RepresentationID$` / `$Bandwidth$` / `$Time$`）
- [ ] 错误恢复：MPD 解析失败时 fallback 到 passthrough
- [ ] 内存泄漏检查（DOMParser 大对象及时释放）

---

**Task 4.4: 文档更新 + 代码审查**

- [ ] 更新 `README.md` — 新增 DASH 功能说明
- [ ] 更新 `docs/` — 新增 DASH 架构文档
- [ ] 代码审查 checklist：
  - [ ] 类型安全（`bun run typecheck`）
  - [ ] Lint 通过（`bun run lint`）
  - [ ] 测试通过（`bun run test`）
  - [ ] 测试覆盖率 >80%
  - [ ] 无 console.log 残留（使用 `lib/logger.ts`）

---

**Task 4.5: 灰度发布 + 监控**

- [ ] 功能开关：`dashAdFilter.enabled`（默认 `false`，灰度开启）
- [ ] 监控指标：
  - DASH MPD 拦截次数
  - 广告 Period 检测命中率
  - 清洗后 MPD 推送成功率
  - 指纹库命中率
  - 错误率（解析失败 / 重建失败）
- [ ] 日志分级：`logger.info` / `logger.warn` / `logger.error`

---

## 四、风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| MPD 格式多样性导致解析器覆盖不全 | 高 | 高 | 优先支持 YouTube/B站/标准 DASH-IF，其他平台逐步适配；解析失败 fallback passthrough |
| 播放器对清洗后 MPD 兼容性差 | 中 | 高 | 严格保留 XML Schema 结构；重建后进行 XML 合法性校验；提供 `passthrough` 模式 |
| 动态 MPD（直播）未支持导致用户投诉 | 中 | 中 | P0 明确声明仅支持 VOD；P2 迭代支持直播；文档清晰说明 |
| DRM 内容无法过滤导致期望落差 | 低 | 中 | 文档明确声明不支持 DRM；检测到 DRM 时自动 disabled |
| 指纹计算影响播放性能 | 低 | 中 | 仅计算前 64KB；异步计算不阻塞 appendBuffer；提供关闭开关 |
| 与 HLS 代码耦合导致维护困难 | 中 | 中 | Phase 4 提取公共逻辑到 `engine/shared/`；明确接口边界 |

---

## 五、验收标准汇总

### 5.1 功能验收

- [ ] `.mpd` fetch/XHR 请求能被 content script 正确拦截
- [ ] MPD XML 能被正确解析为结构化对象
- [ ] 广告 Period 能被 7 信号检测器正确识别（阈值=3）
- [ ] 指纹二次过滤能命中已知广告 Period
- [ ] 清洗后的 MPD 能被正确重建（移除广告 Period）
- [ ] 清洗后 MPD 能成功推送到 velo 桌面端下载
- [ ] `passthrough` / `disabled` 模式正常工作
- [ ] 站点规则系统能加载远程 DASH 规则
- [ ] 自动学习能将新广告 Period 指纹入库

### 5.2 质量验收

- [ ] `bun run typecheck` 零错误
- [ ] `bun run lint` 零错误（max-warnings=10 内）
- [ ] `bun run test` 全部通过
- [ ] 测试覆盖率 >80%
- [ ] 无 `console.log` 残留（使用 `lib/logger.ts`）
- [ ] 代码审查通过（遵循项目代码规范）

### 5.3 性能验收

- [ ] MPD 解析 < 50ms（标准 VOD MPD < 500KB）
- [ ] 广告检测 < 20ms（< 20 个 Period）
- [ ] MPD 重建 < 30ms
- [ ] 端到端流程 < 200ms（拦截 → 清洗 → 替换）
- [ ] 内存占用增长 < 10MB（长时间运行）

---

## 六、附录

### 6.1 参考文档

- [DASH-IF IOP Guidelines](https://dashif.org/guidelines/)
- [SCTE 35 2020 - Digital Program Insertion Cueing Message](https://www.scte.org/standards/library/catalog/scte-35-2020/)
- [MPEG-DASH Standard ISO/IEC 23009-1](https://www.iso.org/standard/83314.html)
- velo-extension HLS 实现：`src/engine/hls/*`

### 6.2 测试 MPD 样本来源

- DASH-IF Test Assets: https://testassets.dashif.org/
- YouTube DASH MPD（通过 yt-dlp 提取，脱敏后使用）
- 模拟广告 MPD（手动构造含 EventStream SCTE-35 的 MPD）

### 6.3 命名规范

- 文件命名：kebab-case（如 `dash-filter.ts`）
- 类型前缀：`Dash`（如 `DashProcessResult`）
- 函数命名：camelCase（如 `processManifest()`）
- 常量命名：UPPER_SNAKE_CASE（如 `DEFAULT_DASH_CONFIG`）
