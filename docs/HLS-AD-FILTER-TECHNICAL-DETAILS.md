# HLS 广告过滤技术详解：双站点自适应判据设计与实战验证

> **目标**：完整记录 velo-extension HLS 广告过滤引擎的核心判据设计、双链路职责边界、以及基于两套真实站点样本的精度验证方法，形成可复用的技术基线。
>
> **作者**：tekintian <tekintian@gmail.com>
> **日期**：2026-11-05
> **版本**：v1.0
> **验证基线**：53 个单元测试全通过 · 两站点 Precision/Recall 均 100%
> **样本来源**：`tmp/old.m3u8`（dytt-tvs 类，690 片）· `tmp/new.m3u8`（kkzy 类，1336 片）

---

## 一、核心前提：页面播放与媒体下载是两条独立链路

这是整个设计的地基，也是最容易被混淆的地方。

### 1.1 职责边界

| 链路 | 数据源 | 扩展的干预方式 |
|------|--------|---------------|
| **页面播放** | **原始 m3u8，永不替换** | 只下发 `adRanges` 时间区间，由 badge 在播放器内 seek 跳过 |
| **媒体下载** | 按投递模式生成 | 可输出清洗后的 m3u8 / data URL / 逐分片 / 透传 |

页面播放链路的实现铁律见 [hls.content.ts](file:///Volumes/work/projects/rust/velo/extensions/velo-extension/src/entrypoints/hls.content.ts#L96-L113)：

```typescript
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, _body?: ...) {
  ...
  const text = this.responseText
  // 只做检测，不覆写 responseText/response，页面播放数据源保持原样
  void detectPlaylistAdRanges(text, url)
  ...
}
```

**为什么不能替换播放源**：

1. **播放器兼容性**：`data:` URL 并非所有播放器都支持，尤其老旧播放器与部分内嵌 SDK
2. **相对路径解析**：m3u8 中分片路径可能是相对路径，替换为 `data:` URL 后失去 base 上下文，相对路径全部失效
3. **不可恢复**：一旦覆写响应，原始数据无法还原，出问题只能刷新页面

对应地，badge 侧的跳过逻辑也不做“时间轴是否含广告”的判断，直接 seek，见 [badge.content.ts](file:///Volumes/work/projects/rust/velo/extensions/velo-extension/src/entrypoints/badge.content.ts#L255-L264)：

```typescript
/**
 * 页面播放链路永不替换数据源，播放器拿到的始终是原始 m3u8，
 * 广告分片仍在时间轴上，因此只要下发了区间就必须 seek 跳过。
 */
function timelineHasAds(_video: HTMLVideoElement): boolean {
  return true
}
```

### 1.2 四种投递模式（仅作用于下载）

见 [hls-filter.ts](file:///Volumes/work/projects/rust/velo/extensions/velo-extension/src/engine/hls/hls-filter.ts#L278-L320)：

| 模式 | 输出 | 适用场景 |
|------|------|---------|
| `passthrough` | 原始 URL + 仅检测报告 | 只做检测、不清洗，下载客户端自取 |
| `m3u8-file` | 清洗后的 m3u8 文本 | 下载客户端需要标准 m3u8 文件 |
| `data-url` | `data:application/vnd.apple.mpegurl;base64,...` | 内联 base64，单文件交付 |
| 逐分片 | 广告分片剔除后的分片清单 | 下载器按片拉取 |

**关键点**：所有模式**均返回原始时间轴坐标的 `adRanges`**，因为投递模式改变的是下载内容，不改变页面播放时间轴。

---

## 二、master playlist 必须递归下钻

### 2.1 问题

多码率站点的播放器先请求 `index.m3u8`（master），再按带宽拉取变体媒体列表。master 本身只有几十字节的变体索引，**不含任何分片**，直接检测必然得到“0 广告”。

### 2.2 方案

见 [hls-filter.ts](file:///Volumes/work/projects/rust/velo/extensions/velo-extension/src/engine/hls/hls-filter.ts#L340-L360) 的 `resolveMediaVariant`：

```typescript
export async function resolveMediaVariant(
  masterText: string,
  masterUrl: string,
  config: AdFilterConfig,
  authHeaders?: Record<string, string>,
  fetcher?: (url: string) => Promise<string>,
): Promise<{ url: string; text: string } | null>
```

变体选择策略：

1. 优先选**带宽最高**的变体（分辨率最高、广告信号最完整）
2. 该变体拉取失败则依次回退到其余变体
3. 全部失败时返回 `null`，调用方按“无广告”处理，**不阻塞播放**

### 2.3 一次解析、多处复用

[handler.ts](file:///Volumes/work/projects/rust/velo/extensions/velo-extension/src/background/hls/handler.ts) 中对下钻结果**只做一次**，页面 hook 链路与下载链路共用同一份结果：

```typescript
let resolved: ProcessResult = raw
let mediaUrl = baseUrl
let mediaText = text
if (raw.mode === 'master') {
  const variant = await resolveMediaVariant(text, baseUrl, cfg, hlsAuthHeaders)
  if (!variant) {
    logger.info('[hls] master playlist has no usable variant, baseUrl:', baseUrl.slice(0, 80))
    return { mode: 'master' as const, adRanges: [], report: raw.report }
  }
  mediaUrl = variant.url
  mediaText = variant.text
  resolved = await processPlaylist(variant.text, variant.url, pageUrl, cfg, hlsAuthHeaders)
}
```

**为什么必须复用**：若两条链路各自再拉一次变体，可能拿到不同 CDN 节点、不同分片序号，导致 popup 显示的广告数与实际下发区间不一致。

---

## 三、9 信号加权检测模型

见 [ad-detector.ts](file:///Volumes/work/projects/rust/velo/extensions/velo-extension/src/engine/hls/ad-detector.ts#L1-L21)，默认阈值 3 分判定为广告：

| 信号 | 分值 | 判据 |
|------|------|------|
| `cueState=='out'` | +3 | 处于 `#EXT-X-CUE-OUT ... #EXT-X-CUE-IN` 之间（HLS 标准广告块） |
| `scte35` | +3 | 命中 `#EXT-X-SCTE35-OUT` / `#EXT-X-SCTE35-CMD` |
| `dateRangeAd` | +3 | `#EXT-X-DATERANGE` 且 CLASS 含 ad/sponsor/promo 或带 SCTE35 字段 |
| `sequence-jump` | +3 | discontinuity 块首片序列跳号（跳上→跑一段→跳回） |
| `short-block` | +3 | 短块夹在长块之间（**需 URL / 少数派目录佐证**） |
| `minority-path-block` | +3 | 块路径前缀属于少数派（正片 A 目录，广告整块换 B 目录） |
| `url-pattern` | +2 | 分片 URL 匹配广告正则 |
| `origin-differs` | +2 | origin 与多数分片不一致（跨域 CDN） |
| `path-differs` | +1 | path 前缀与多数分片不一致 |
| `duration-outlier` | +1 | 时长偏离中位数 >50%（分片数 ≥4 才启用） |

### 3.1 为什么 `sequence-jump` 在多数站点无效

[ad-detector.ts](file:///Volumes/work/projects/rust/velo/extensions/velo-extension/src/engine/hls/ad-detector.ts#L23-L80) 中 `detectSequenceJumps` 有一系列严格保护条件：

```typescript
// 0) 可解析尾号的分片占比 — hash 名常不足 50%, 跳号检测无意义
if (withSeq < segments.length * 0.5) return jumpSet
```

本次两套样本**均为 hash 文件名**（`3fe11d2f0789cd1dcd48ff8b3bc1afd3.ts?hash=...`、`6j9lL7if.ts`），几乎无可解析尾号，因此该信号完全沉默。这也是必须依赖结构与路径判据的原因。

---

## 四、两套真实样本的结构剖析

这是本次修复最关键的实证部分。

### 4.1 样本 A：dytt-tvs 类（`old.m3u8`）

**基本结构**：

| 指标 | 值 |
|------|-----|
| 分片数 | 690 |
| 总时长 | 2759.9s |
| 块数（discontinuity 分组） | 108 |
| 分片时长中位数 | 4.00s |
| 块时长中位数 | 20.28s |
| 块片数中位数 | 5 |

**块片数直方图**：`{1:1, 2:2, 3:2, 5:84, 9:1, 10:7, 15:8, 20:3}` — 绝大多数是 5 片 20s 的规整正片块。

**广告特征：纯同目录短块，URL 无任何可区分特征**

| 块 | 起始 | 片数 | 时长 | 相对中位比 | 分片时长 |
|----|------|------|------|-----------|---------|
| G11 | 310.8s | 2 | 4.87s | 0.240 | 3.33 / 1.53 |
| G59 | 1517.7s | 1 | 6.67s | 0.329 | 6.67 |
| G60 | 1524.4s | 3 | 9.10s | 0.449 | 2.13 / 3.23 / 3.73 |
| G107 | 2753.6s | 2 | 6.24s | 0.308 | 4.00 / 2.24 |

合计 **11 片 / 41.1s**，URL 全部为同目录 hash 命名，`<origin><path>/xxx.ts?hash=yyy` 形态完全一致。

**补充实证**：296.56–316.09s 实际是**两段相邻广告块**拼接：

```
G(74-76) @296.56–310.76  3 片 14.2s
G(77-78) @310.76–316.09  2 片  4.87s
```

### 4.2 样本 B：kkzy 类（`new.m3u8`）

**基本结构**：

| 指标 | 值 |
|------|-----|
| 分片数 | 1336 |
| 总时长 | 2699.1s |
| 块数 | 75 |
| 分片时长中位数 | 2.00s |
| 块时长中位数 | 39.76s |
| 块片数中位数 | 20 |

**块片数直方图**：`{4:3, 6:6, 7:1, 13:1, 16:3, 20:61}` — 61 个规整 20 片 40s 正片块。

**广告特征：跨目录整块投放，且文件名完全相同**

```
正片目录: /20221216/tnoQ2Gnh/2000kb/hls/
广告目录: /20261101/tkPlKg7b/10082kb/hls/    ← 日期/哈希/码率三者全不同
```

每个广告位固定 **6 片**，文件名恒定：

```
PWoMkrH7.ts / lg1f1L1w.ts / Tw2LPjdT.ts / dVXHeqcd.ts / YCzyZ08L.ts / 6j9lL7if.ts
```

时长序列 `3 + 3 + 5 + 3 + 3 + 0.64 = 17.64s`，**5 个广告位完全重复这套结构**。

**实测广告位**：

| 序号 | 起始 | 结束 | 时长 |
|------|------|------|------|
| 1 | 174.04s（02:54） | 191.68s（03:12） | 17.64s |
| 2 | 866.60s（14:27） | 884.24s | 17.64s |
| 3 | 1684.20s（28:04） | 1701.84s | 17.64s |
| 4 | 2501.00s（41:41） | 2518.64s | 17.64s |
| 5 | 2681.40s（44:41） | 2699.04s | 17.64s |

合计 **30 片 / 88.2s**，与用户实测的 5 个时间段精确吻合。

### 4.3 陷阱：正片碎块

样本 B 的广告块**前面紧邻一批正片碎块**，形态极具迷惑性：

| 块 | 起始 | 片数 | 时长 | 相对中位比 | 所属目录 |
|----|------|------|------|-----------|---------|
| G4 | 160.7s | 7 | 13.32s | 0.335 | 正片目录 |
| G23 | 858.0s | 4 | 8.64s | 0.217 | 正片目录 |
| G45 | 1675.9s | 4 | 8.28s | 0.208 | 正片目录 |
| G67 | 2493.7s | 4 | 7.32s | 0.184 | 正片目录 |
| G73 | 2671.0s | 6 | 10.48s | 0.264 | 正片目录 |

**它们的时长比例（0.18–0.34）与广告块（0.44）高度重叠，单纯靠“最短块”会把它们全部误判。** 这正是此前 30 片误判的直接来源。

关键判别依据：**它们属于正片目录**，而广告块属于广告目录。

### 4.4 两类站点的本质差异对照

| 维度 | 样本 A（dytt） | 样本 B（kkzy） |
|------|---------------|---------------|
| 广告 URL | 同目录，**无法区分** | **跨目录**，可区分 |
| 广告块比例 | 0.24–0.45 | 0.44 |
| 正片碎块 | 无 | **有，且与广告块比例重叠** |
| 可靠判据 | 相对时长 | 路径前缀 |
| 单信号可用性 | `short-block` 直接可用 | `short-block` **必须**加路径佐证 |

**结论：不存在单一判据同时适配两类站点，必须做站点自适应仲裁。**

---

## 五、自适应仲裁：`isShortBlockAdmissible`

### 5.1 设计

见 [ad-detector.ts](file:///Volumes/work/projects/rust/velo/extensions/velo-extension/src/engine/hls/ad-detector.ts#L243-L262)：

```typescript
function isShortBlockAdmissible(s: Segment, minoritySet: ReadonlySet<number>, hasCrossDirAds: boolean): boolean {
  if (minoritySet.has(s.index)) return true
  if (!hasCrossDirAds) return true
  if (!s.url) return false
  try {
    const u = new URL(s.url)
    return (
      u.pathname
        .toLowerCase()
        .split('/')
        .some((part) => /^ads?($|[-_.])|^advertis|^preroll|^midroll|^postroll|^spot/.test(part)) ||
      /[?&](ad|adid|ad_id|adbreak|spotid)=/i.test(u.search)
    )
  } catch {
    return false
  }
}
```

三档仲裁逻辑：

| 条件 | 判定 | 适用站点 |
|------|------|---------|
| 属于少数派目录块 | **采信** | 样本 B（广告目录） |
| 站点**不存在**跨目录广告 | **直接采信** | 样本 A（无正片碎块风险） |
| 站点存在跨目录广告，但本片不在少数派目录 | 需 URL 显式广告标识才采信 | 样本 B（正片碎块被拦截） |

`hasCrossDirAds` 由 `detectMinorityPathBlocks` 是否命中决定。**站点一旦表现出跨目录投放行为，就自动进入严格模式**，无需任何站点名单配置。

### 5.2 `minority-path-block` 的判据修正（本次核心修复）

**修复前**（有缺陷）：

```typescript
const globalBar = Math.max(4, Math.floor(segments.length * 0.05))
const globalCount = prefixCount.get(blockPrefix) ?? 0
const fewerSegs = medianSegs > 0 && b.segs.length <= medianSegs * 1.5
if (globalCount <= globalBar && blockPrefixCount >= 4 && fewerSegs) { ... }
```

**缺陷场景**：小样本或单广告位站点（89 片、1 个 6 片广告块）中 `globalBar = max(4, 4) = 4`，`globalCount = 6 > 4` → **被拦截** → `hasCrossDirAds = false` → 短块全部无条件放行 → 30 片误判。

**修复后**：改用**块形态**判据，彻底抛弃全局占比：

```typescript
// 4) 少数派块判定：块内多数分片前缀 != 多数派前缀，
//    且块片数不超多数派块典型片数（广告块通常显著短于正片块）。
//    同一前缀被多个块复用时更可信，但单块站点也必须识别，故不作为硬性条件。
const fewerSegs = medianSegs > 0 && b.segs.length <= medianSegs * 1.5
if (fewerSegs) {
  for (const s of b.segs) minoritySet.add(s.index)
}
```

**设计理由**：

- 广告结构的本质是“**块片数显著少于正片块**”，与站点切片粒度、样本大小无关
- `medianSegs * 1.5` 是纯相对阈值，1336 片与 89 片的样本表现一致
- 不使用“重复块”作为硬性条件，单广告位站点同样能识别

### 5.3 `short-block` 判据（纯相对）

见 [ad-detector.ts](file:///Volumes/work/projects/rust/velo/extensions/velo-extension/src/engine/hls/ad-detector.ts#L99-L148)：

```typescript
const durRatio = median * 0.5
const segCountThreshold = median * 0.75
const segLenRatio = medianSegs * 0.6
for (const b of blocks) {
  const isShort = b.dur > 0 && b.dur < durRatio
  const isFewSegs = b.dur > 0 && b.segs.length <= 3 && b.dur < segCountThreshold
  const isFewerSegs = b.dur > 0 && medianSegs >= 5 && b.segs.length < segLenRatio && b.dur < segCountThreshold
  if (isShort || isFewSegs || isFewerSegs) {
    for (const s of b.segs) shortSet.add(s.index)
  }
}
```

**三条判据全部基于中位数相对值，无任何硬编码秒数**，新增站点无需写规则即可自适应。

> **踩坑记录**：曾尝试追加“块时长必须 < 中位×0.45”的收紧条件，结果恰好把样本 A 的 G60（比例 0.449）卡在边缘，检测数从 11 掉到 8。**相对阈值区间必须留有足够余量。**

---

## 六、跨域 iframe 全量运行

部分站点把播放器放在跨域 iframe 中，顶层帧无法直接操作 `video` 元素。因此 badge 内容脚本在**每个 frame 都运行**，见 [badge.content.ts](file:///Volumes/work/projects/rust/velo/extensions/velo-extension/src/entrypoints/badge.content.ts#L528-L570)：

```typescript
function runAdSkipInFrame(): void {
  // 页面播放链路永不替换数据源，时间轴上广告始终存在，有区间即 seek
  ...
  const t = video.currentTime
  for (const r of ranges) {
    ...
    video.currentTime = r.end + 0.05
  }
}
```

区间通过 `postMessage` 从 bridge 下发到每个 frame，各 frame 独立 seek 本地 `video`。

---

## 七、验证方法与结果

### 7.1 验证脚本

`diagnose.ts` 作为回归基线，用**真实 m3u8 文件**跑完整 `detectAds`，输出混淆矩阵：

```bash
bun run diagnose.ts
```

真值定义方式：

- **样本 A**：按实测时间窗口（`296.56–316.09` / `1517.7–1534.0` / `2753.6–2760.0`）归属，用分片中点判定
- **样本 B**：按**路径前缀**归属（非正片目录即广告），这是客观结构事实

### 7.2 最终结果

```
===== old.m3u8 (dytt/qianbianse) =====
  真值广告片=11  检测=11
  正确=11 误判=0 漏检=0
  Precision=100.0%  Recall=100.0%

===== new.m3u8 (kkzy/mknypx) =====
  真值广告片=30  检测=30
  正确=30 误判=0 漏检=0
  Precision=100.0%  Recall=100.0%
```

### 7.3 完整质量门禁

`t.sh` 统一执行五级验证：

| 阶段 | 内容 | 结果 |
|------|------|------|
| 1 | 双站点广告检测精度 | 两站点均 100% / 100% |
| 2 | 单元测试 | **53/53 通过** |
| 3 | 类型检查（`tsc --noEmit`） | 0 错误 |
| 4 | 构建（`wxt build`） | 成功，652.66 kB |
| 5 | 产物校验 | `minority-path-block` / `short-block` 均在产物中 |

### 7.4 单元测试覆盖策略

[ad-detector.test.ts](file:///Volumes/work/projects/rust/velo/extensions/velo-extension/tests/unit/engine/hls/ad-detector.test.ts) 中两条互斥用例锁死了自适应仲裁的两个分支：

```typescript
it('keeps same-path content fragments out of ad set when site uses cross-dir ads', () => {
  // 站点有跨目录广告时，主路径短碎块必须全部放行
  const misjudged = [...result.adSegments].filter((i) => parsed.segments[i]!.url.startsWith(mainPrefix))
  expect(misjudged.length).toBe(0)
})

it('detects same-path short block ads when site has no cross-dir ads', () => {
  // 站点无跨目录广告时，同路径短块必须被识别
  expect(result.adSegments.size).toBe(2)
})
```

**这两条用例必须同时存在**：任何单方面“收紧”或“放开”都会让另一条失败，从而防止回归。

---

## 八、可复用要点清单

| 要点 | 说明 |
|------|------|
| **播放与下载分离** | 页面播放永不替换数据源；投递模式只作用于下载 |
| **相对阈值** | 全部判据基于中位数比值，不写死秒数 |
| **master 必须下钻** | 主列表只有索引，广告在变体媒体列表 |
| **下钻结果复用** | 一次解析、多链路共享，避免结果漂移 |
| **站点自适应** | 由站点自身结构（是否跨目录）决定严格程度，无需白名单 |
| **双重信号互证** | 结构信号（短块）+ 路径信号（少数派目录）交叉验证 |
| **阈值留余量** | 相对阈值区间不能贴边，否则真实广告会被卡掉 |
| **真实样本回归** | 两个形态迥异的站点同时纳入基线，防止单侧过拟合 |
| **互斥单测锁死** | 两个方向的反例同时存在，避免回归 |

---

## 九、已知边界

| 边界情况 | 当前行为 |
|---------|---------|
| 变体全部拉取失败 | 返回 `null`，按无广告处理，不阻塞播放 |
| 分片无可解析尾号 | `sequence-jump` 静默，依赖结构与路径判据 |
| 广告与正片完全同目录且块形态一致 | 单一信号无法区分，需指纹库或人工样本介入 |
| 跨域 iframe | 每个 frame 独立运行，独立 seek 本地 video |