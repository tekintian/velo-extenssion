# HLS 运行模式（智能/手动双模式）实施任务计划

> **目标**：为 HLS 广告过滤引入运行模式开关（智能启用 / 手动开启），解决当前 content script 全量注入、fetch/XHR hook 全页面覆盖导致的性能浪费与潜在冲突。DASH 侧已有站点白名单机制（`dash-sites.ts`），HLS 侧 `getHlsDelegation` 却硬编码返回 `active`，形同虚设。本次改动让 HLS 对齐 DASH 的守卫模式，并在此基础上增加自动学习、popup 临时启用、黑白名单等完整站点管理能力。
>
> **作者**：tekintian <tekintian@gmail.com>
> **日期**：2026-11-03
> **版本**：v1.0
> **依赖基线**：velo-extension（WXT + TypeScript + React + Tailwind CSS + Vitest）
> **改动规模**：新增 ~400 行 + 修改 ~80 行，风险极低

---

## 一、需求/问题评估

### 1.1 现状分析

velo-extension HLS 检测链路当前问题：

| 环节 | 现状 | 问题 |
|------|------|------|
| Content Script 注入 | `manifest.json` `matches: <all_urls>` + `runAt: document_start`，所有 http/https 页面 + 所有 iframe 无条件注入 `hls.content.ts` + `hls-bridge.content.ts` | **95%+ 页面永远不会触发 m3u8 检测，白装 fetch/XHR hook** |
| `getHlsDelegation` | `background.ts:60-62` 硬编码 `return { mode: 'active' }`，完全忽略配置 | **bridge → background 往返检查白跑，守卫机制形同虚设** |
| hook 安装 | MAIN world 无条件替换 `window.fetch` + `XMLHttpRequest.prototype.open/send` | 每个 iframe 每次网络请求都要过 `isM3u8Url()` 检查，低端设备累积开销可感知；与其他插件 hook fetch 存在链式冲突风险 |
| 站点管理 | ❌ 不存在 | 无种子数据、无黑名单、无用户自定义站点列表 |
| 与 DASH 对比 | DASH 已有 `dash-sites.ts` 站点白名单 + `getDashDelegation` 守卫检查 | **HLS 侧架构落后 DASH 一截** |

### 1.2 问题根因

```
页面加载（document_start）
  │
  ├─ hls.content.ts 立即注入 → MAIN world
  │    └─ installHlsHook() 无条件覆盖 window.fetch / XHR
  │         │
  │         ├─ isM3u8Url(url) → 每次请求都跑一次
  │         │   （95%+ 请求不是 m3u8，白跑）
  │         │
  │         └─ 是 m3u8 → postMessage → bridge
  │              └─ bridge → getHlsDelegation()
  │                   └─ 硬编码 active → 白跑！
  │
  └─ hls-bridge.content.ts 注入 → ISOLATED world
       └─ 等待 MAIN world postMessage
```

**核心矛盾**：hook 安装时机（`document_start`）必须早于任何页面代码，所以不能等配置加载。但 MAIN world 没有 `chrome.storage` 访问权限，必须通过 bridge → background 拿配置。background 的 `getHlsDelegation` 就是用来干这个的——**但它被硬编码了**。

### 1.3 需求边界

**In Scope**：

| 能力 | 说明 |
|------|------|
| `hlsRunMode` 运行模式 | `'smart'`（默认）或 `'manual'` |
| HLS hook 注入守卫 | `getHlsDelegation` 真正读配置 + 站点判定，决定返回 `active` / `delegated` |
| 智能模式自动学习 | sniffer 检测到 m3u8 → 自动把当前 tab hostname 加入 `hlsLearnedSites` |
| 手动模式站点列表 | 用户手动维护 `hlsEnabledSites` 启用列表 |
| 站点黑名单 | `hlsDisabledSites`，两种模式都生效，优先级最高 |
| HLS 站点种子数据 | `HLS_SITE_SEEDS`，首次安装写入用户启用列表，与学习/手动添加完全等价 |
| popup 临时启用入口 | popup 显示当前站点 HLS 状态 + 一键"为当前站点启用 HLS 过滤"按钮 |
| options 管理页面 | 运行模式选择 + 站点列表可视化管理（学习列表/启用列表/黑名单） |
| 动态补注入 | popup 启用后，用 `chrome.scripting.executeScript` 给当前 tab 补注入 hook |

**Out of Scope**：

- DASH 侧改造（DASH 已有站点机制，本次不动）
- hook 卸载机制（已安装的 hook 不支持运行时卸载，关闭页签重新打开生效；或者刷新页面）
- 域名匹配通配符（如 `*.example.com`）——本次只做精确域名 + 子域名后缀匹配

### 1.4 收益预估

| 维度 | 收益 |
|------|------|
| 非 HLS 站点 | hook 完全不安装 → 零 fetch/XHR 覆盖 → 零 per-request 检查开销 |
| 内存占用 | 非 HLS 站点 MAIN world 没有 hook 闭包 → 减少每个 iframe 几 KB |
| 冷启动 | 种子初始化让主流站点零冷启动（B 站等新用户第一次就能用），小众站点 sniffer 自动学习 |
| 用户体验 | 智能模式省心（自动学 + 种子覆盖主流），手动模式可控（启用列表制），popup 一键启用即时生效 |
| 与其他扩展共存 | hook 链更短（只在 HLS 站点存在），冲突风险降低 |

---

## 二、技术实现方案

### 2.1 核心架构：三层守卫模型

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    HLS hook 注入判定流程                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  hls.content.ts 注入 → bridge 发 getHlsDelegation                          │
│                                                                             │
│  background.ts 路由到 handler.getHlsDelegation(sender)                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Guard 0: 扩展总开关（extensionGlobalConfig.enabled）                  │  │
│  │   false → delegated                                                   │  │
│  │   ↓                                                                   │  │
│  │ Guard 1: HLS 过滤开关（settings.enableHlsAdFilter）                   │  │
│  │   false → delegated                                                   │  │
│  │   ↓                                                                   │  │
│  │ Guard 2: 黑名单（hlsDisabledSites）                                   │  │
│  │   hostname ∈ disabled → delegated（最高优先级）                        │  │
│  │   ↓                                                                   │  │
│  │ Guard 3: 运行模式 + 启用列表                                          │  │
│  │   （种子已在扩展启动时初始化写入，与学习/手动添加完全等价）            │  │
│  │                                                                       │  │
│  │   mode === 'smart'（默认）:                                           │  │
│  │     hostname ∈ hlsLearnedSites → active                   │  │
│  │     其他 → delegated（等 sniffer 自动学习后下次生效）                  │  │
│  │                                                                       │  │
│  │   mode === 'manual':                                                  │  │
│  │     hostname ∈ hlsEnabledSites → active                                │  │
│  │     其他 → delegated                                                  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  delegated → hls.content.ts 不安装 hook，只设置 namespace 标记              │
│  active   → hls.content.ts 安装 fetch/XHR hook（当前行为）                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Settings 新增字段

```typescript
// src/types/index.ts — Settings 接口扩展

interface Settings {
  // ... 现有字段保持不变 ...
  enableHlsAdFilter: boolean       // 已有，本次让它真正参与守卫
  enableDashAdFilter: boolean       // 已有
  enableLogging: boolean            // 已有
  enableAdSkip: boolean             // 已有
  showPageBadge: boolean            // 已有
  downloadClient: 'aria2' | 'ndm' | 'velo' | 'native'  // 已有
  rpcUrl: string                    // 已有
  rpcSecret: string                 // 已有

  // ===== 本次新增 =====
  hlsRunMode: 'smart' | 'manual'    // 运行模式，默认 'smart'
  hlsLearnedSites: string[]         // 智能模式自动学习的站点
  hlsEnabledSites: string[]         // 手动模式用户显式启用的站点
  hlsDisabledSites: string[]        // 黑名单（两种模式都生效，优先级最高）
}

const DEFAULT_SETTINGS: Settings = {
  // ... 现有默认值 ...
  enableHlsAdFilter: true,          // 已有
  enableDashAdFilter: true,          // 已有
  enableLogging: false,              // 已有
  enableAdSkip: true,                // 已有
  showPageBadge: true,               // 已有
  downloadClient: 'velo',            // 已有
  rpcUrl: 'http://127.0.0.1:16888/jsonrpc',  // 已有
  rpcSecret: '',                     // 已有

  // ===== 本次新增默认值 =====
  hlsRunMode: 'smart',
  hlsLearnedSites: [],
  hlsEnabledSites: [],
  hlsDisabledSites: [],
}
```

### 2.3 关键设计决策

#### 决策 1：为什么需要站点种子数据（而非只读内置白名单）？

**核心问题**：`BUILTIN_DASH_SITES` 作为运行时只读内置，存在以下缺陷：
- 用户没法"从内置列表移除某个站点"（只能加黑名单绕路）
- 内置和用户列表分离，`isDashSite()` 需要两套检查逻辑，维护成本高
- 语义上"内置"暗示不可修改，但用户实际上应该对自己启用 HLS 的站点有**完全控制权**

**解决方案**：把 `HLS_SITE_SEEDS` 定义为**种子数据（Seed）**：
- 首次安装扩展时，种子写入 settings 对应的站点列表（智能模式写入 `hlsLearnedSites`，手动模式写入 `hlsEnabledSites`）
- 写入后种子数据**即成为用户列表的一部分**，用户可以自由增删
- 种子只在"首次安装"时写入，已存在用户数据的老升级用户不覆盖
- options 页面提供"一键补全种子数据"按钮，老用户如果想补齐已知站点可以手动触发

**优势**：
- 用户对站点列表**完全可控**——想删就删，想加就加
- 守卫逻辑极大简化：`isHlsSite(domain, list)` 只需检查一个数组，不再需要 builtin + user 双层检查
- DASH 后续可以跟进这个模式（Phase 2 迭代）

**扩展更新时的种子扩充策略**：
- 种子数据只在**首次安装**写入，已初始化过的用户不受影响（保护用户自定义删除）
- 新版本如果扩充了种子列表，只给**全新安装**的用户生效
- options 页面的"一键补全种子数据"按钮会合并当前缺失的种子条目（已有的不重复，已删除的不恢复尊重用户选择）

#### 决策 2：种子未覆盖小众站点的首次不 hook 弥补路径

种子初始化覆盖了 40+ 主流站点（国内三大视频平台、YouTube、Netflix、Twitch 等），**绝大多数用户（~80%）第一次打开就能用**。只有种子未覆盖的小众新站点才会遇到首次访问时 hook 不装的情况——此时 sniffer 是全局 webRequest，**仍然能检测到 m3u8**。弥补路径：

1. sniffer 检测到 m3u8 → 自动把 host 加入 `hlsLearnedSites` → **下次访问自动生效**
2. popup 角标照常显示"发现 HLS 媒体" → 用户点 popup → 一键临时启用 → 用 `chrome.scripting.executeScript` **当前 tab 立即补注入 hook** → 刷新页面生效
3. 可选 `chrome.notifications` 提示"已为 xxx.com 启用 HLS 过滤，刷新后生效"

**为什么可以接受？** 主流站点种子已覆盖，首次不 hook 只影响小众站点。第二次访问就无感了。如果某个小众站点用户高频使用，popup 一键启用后永久生效。

#### 决策 3：黑名单优先级最高

用户明确不想在某些站点启用 HLS 过滤时（比如内部测试环境、隐私敏感站点），即使 sniffer 自动学习也**绝对不能**把它加入 `hlsLearnedSites`。这在守卫里作为 Guard 2（最早检查），同时在 sniffer 自动学习处也加一次拦截。

#### 决策 4：与 DASH 站点列表独立

- DASH 有独立的 `dash-sites.ts` + `BUILTIN_DASH_SITES` + `dashAdFilterUserSites` storage key
- HLS 新增独立的 `hls-sites.ts` + `HLS_SITE_SEEDS` + settings 内嵌数组
- **不复用**——不同协议的站点列表天然不同，硬合并反而增加维护成本

#### 决策 5：popup 临时启用的补注入方案

用户在 popup 点"为当前站点启用 HLS 过滤"后：

```
1. 获取当前 tab hostname → 加入 hlsLearnedSites（智能模式）或 hlsEnabledSites（手动模式）
2. 如果 delegation 守卫已经判定过（页面已加载完 hook 没装）：
   → chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/hls.js'] })
   → 补注入 hook
   → 但 MAIN world hook 装了之后，页面已经在跑了，fetch 之前已经发出去的请求不会被拦截
   → **提示用户刷新页面**
3. 如果页面还在加载中（极少见），守卫在后续 iframe 检查时会返回 active → hook 正常安装
```

### 2.4 HLS 站点种子数据

```typescript
// src/engine/hls/hls-sites.ts

// 种子数据：首次安装时写入用户站点列表，写入后即成为用户数据的一部分
// 用户可以自由增删——删除种子条目后不会自动恢复
export const HLS_SITE_SEEDS: string[] = [
  'iqiyi.com',
  'youku.com',
  'mgtv.com',
  'pptv.com',
  'ixigua.com',
  'migu.cn',
  'le.com',
  'pplive.cn',
  'letv.com',
  'youtube.com',
  'youtu.be',
  'netflix.com',
  'qiqi89.com',
  'vidhub.tv',
  'www.qianbianse.com',
]

// 种子初始化标记（存储在 persistentStorage）
const SEED_INIT_KEY = 'hlsSitesSeeded'

// 首次安装时调用，把种子写入对应的站点列表
// 已初始化过的用户不再执行（保护用户自定义删除）
export async function initSeedSitesIfNeeded(runMode: 'smart' | 'manual'): Promise<void> {
  const alreadySeeded = await persistentStorage.get<boolean>(SEED_INIT_KEY)
  if (alreadySeeded) return

  const settings = await settingsStore.get<Partial<Settings>>()
  const targetList = runMode === 'smart'
    ? settings.hlsLearnedSites ?? []
    : settings.hlsEnabledSites ?? []

  // 只合并当前缺失的种子条目（尊重用户已有的数据）
  const merged = [...new Set([...HLS_SITE_SEEDS, ...targetList])]

  if (runMode === 'smart') {
    await settingsStore.set({ ...settings, hlsLearnedSites: merged })
  } else {
    await settingsStore.set({ ...settings, hlsEnabledSites: merged })
  }
  await persistentStorage.set(SEED_INIT_KEY, true)
}

// "一键补全种子数据"——options 页面按钮调用
// 合并种子中当前列表缺失的条目，已删除的不恢复（尊重用户选择）
export async function supplementSeedSites(runMode: 'smart' | 'manual'): Promise<{ added: number }> {
  const settings = await settingsStore.get<Partial<Settings>>()
  const targetList = runMode === 'smart'
    ? settings.hlsLearnedSites ?? []
    : settings.hlsEnabledSites ?? []

  const currentSet = new Set(targetList)
  const missingSeeds = HLS_SITE_SEEDS.filter((s) => !currentSet.has(s))

  if (missingSeeds.length === 0) return { added: 0 }

  const merged = [...targetList, ...missingSeeds]
  if (runMode === 'smart') {
    await settingsStore.set({ ...settings, hlsLearnedSites: merged })
  } else {
    await settingsStore.set({ ...settings, hlsEnabledSites: merged })
  }
  return { added: missingSeeds.length }
}
```

> 注：种子站点**不代表**一定用 HLS——只是这些站点已知**可能**出现 HLS 流。实际 hook 安装后，只有真的检测到 m3u8 才会执行过滤逻辑。非 HLS 流 hook 只做一次 `isM3u8Url()` 字符串检查（微秒级），开销可忽略。种子写入后与 sniffer 学习、用户手动添加的站点**完全等价**，用户可以统一管理，没有任何"只读"约束。

### 2.5 文件改动清单

| 操作 | 文件 | 改动量 | 说明 |
|------|------|--------|------|
| **新增** | `src/engine/hls/hls-sites.ts` | ~120 行 | 种子数据 + 种子初始化 + 统一站点列表管理（不再区分 builtin/user） |
| **修改** | `src/types/index.ts` | ~8 行 | Settings 新增 4 字段 + DEFAULT_SETTINGS 默认值 |
| **修改** | `src/entrypoints/background.ts` | ~30 行 | 把硬编码的 `getHlsDelegation` 改成真正的守卫逻辑 + 启动时调用种子初始化 |
| **修改** | `src/background/media/sniffer.ts` | ~15 行 | m3u8 检测点加自动学习逻辑（不再需要 builtin 检查，种子已合并） |
| **修改** | `src/background/hls/handler.ts` | ~5 行 | 可选：如果把 delegation handler 从 background.ts 移过来 |
| **修改** | `src/entrypoints/popup/main.tsx` | ~50 行 | HLS 状态显示 + 临时启用按钮 + 补注入 |
| **修改** | `src/entrypoints/options-hls-filter/main.tsx` | ~180 行 | 运行模式选择 + 统一站点列表管理 UI + 一键补全种子数据按钮 |
| **新增** | `tests/engine/hls/hls-sites.test.ts` | ~80 行 | 单元测试（种子初始化 + 补全 + 守卫判定） |

---

## 三、落地实施任务计划

### 3.1 任务总览

```
Step 1: 基础设施（1h）
├── Task 1.1: 新建 engine/hls/hls-sites.ts（种子数据 + 种子初始化 + 统一列表管理）
├── Task 1.2: types/index.ts Settings 接口扩展（4 字段 + 默认值）
├── Task 1.3: background.ts getHlsDelegation 守卫逻辑实现（替换硬编码 + 启动时调用种子初始化）
└── Task 1.4: 单元测试 hls-sites.test.ts（守卫判定 + 种子初始化 + 补全）

Step 2: sniffer 自动学习（30min）
├── Task 2.1: sniffer.ts m3u8 检测点加自动学习逻辑（智能模式，带 MAX_LEARNED_SITES 上限）
└── Task 2.2: 黑名单拦截（学习前先检查 hlsDisabledSites）

Step 3: popup 交互（2h）
├── Task 3.1: popup 显示当前 tab HLS 启用状态
├── Task 3.2: popup "为当前站点启用 HLS 过滤"按钮
├── Task 3.3: 点击后站点加入学习/启用列表
└── Task 3.4: 补注入 hook（chrome.scripting.executeScript）+ 刷新提示

Step 4: options 管理页面（3h）
├── Task 4.1: 运行模式切换（smart / manual）
├── Task 4.2: 统一站点列表可视化（启用站点 / 黑名单 两个 Tab，随运行模式联动）
├── Task 4.3: 单个站点增删操作
├── Task 4.4: 批量清空 / 导入导出
└── Task 4.5: 一键补全种子数据按钮

Step 5: 集成验证（1h）
├── Task 5.1: 智能模式端到端测试（首次访问 → sniffer 学习 → 刷新后生效）
├── Task 5.2: 手动模式端到端测试（手动加白 → 直接生效）
├── Task 5.3: 黑名单优先级测试
├── Task 5.4: popup 临时启用 + 补注入测试
└── Task 5.5: 回归测试（bun run test 全绿）
```

### 3.2 详细任务清单

#### Step 1: 基础设施（1h）

**Task 1.1 — 新建 `src/engine/hls/hls-sites.ts`**

- [ ] 实现站点种子数据 + 统一列表管理（**不再区分 builtin / user**，种子已合并到用户列表）：
  - `HLS_SITE_SEEDS: string[]` — 种子数据数组（见 2.4 节完整列表）
  - `initSeedSitesIfNeeded(runMode)` — 首次安装时把种子写入对应站点列表（智能→hlsLearnedSites，手动→hlsEnabledSites），已初始化过的跳过
  - `supplementSeedSites(runMode)` — "一键补全种子数据"，合并当前缺失的种子条目（尊重用户已删除的）
  - 通用列表操作（三个列表通用，接受 `string[]` 参数）：
    ```typescript
    function addSite(list: string[], domain: string): string[]
    function removeSite(list: string[], domain: string): string[]
    function isInList(list: string[], domain: string): boolean
    function matchDomain(domain: string, pattern: string): boolean  // 精确 + 子域名后缀
    function extractDomain(url: string): string
    ```
  - 守卫判定核心函数：
    ```typescript
    // 根据运行模式取出"有效启用站点列表"
    function getActiveSiteList(settings: Settings): string[] {
      return settings.hlsRunMode === 'smart'
        ? settings.hlsLearnedSites
        : settings.hlsEnabledSites
    }

    // 三层判定：黑名单拦截 → 启用列表匹配 → 返回是否激活
    function isHlsSite(domain: string, settings: Settings): boolean {
      if (!domain) return false
      // Guard 1: 黑名单最高优先级
      if (isInList(settings.hlsDisabledSites, domain)) return false
      // Guard 2: 启用列表匹配（智能模式=hlsLearnedSites，手动模式=hlsEnabledSites）
      return isInList(getActiveSiteList(settings), domain)
    }
    ```
- [ ] 种子初始化在 background.ts 的扩展启动流程中调用一次：`initSeedSitesIfNeeded(settings.hlsRunMode)`

**验收标准**：
- `bun run typecheck` 通过
- `isHlsSite()` 只需 **两层**判定（黑名单 + 启用列表），没有 builtin 第三层——因为种子已在初始化时合并进启用列表
- `initSeedSitesIfNeeded()` 对同一用户只执行一次（通过 `hlsSitesSeeded` storage key 标记）
- `supplementSeedSites()` 只补缺失的种子条目，不恢复用户已删除的

---

**Task 1.2 — `src/types/index.ts` Settings 扩展**

- [ ] Settings 接口新增：
  ```typescript
  hlsRunMode: 'smart' | 'manual'
  hlsLearnedSites: string[]
  hlsEnabledSites: string[]
  hlsDisabledSites: string[]
  ```
- [ ] DEFAULT_SETTINGS 新增默认值：
  ```typescript
  hlsRunMode: 'smart',
  hlsLearnedSites: [],
  hlsEnabledSites: [],
  hlsDisabledSites: [],
  ```
- [ ] **向后兼容**：旧用户没有这 4 个字段 → DEFAULT_SETTINGS 会兜底，`{ ...DEFAULT_SETTINGS, ...stored }` spread 模式天然兼容

**验收标准**：
- `bun run typecheck` 通过
- 旧用户数据加载不报错（settingsStore.get 返回的可能是旧结构）

---

**Task 1.3 — `background.ts` getHlsDelegation 守卫逻辑**

找到 background.ts 中：
```typescript
// 当前硬编码位置（约 60-62 行）
registerHandler('getHlsDelegation', async () => {
  return { mode: 'active', reason: 'ad-filter-enabled' }
})
```

替换为完整守卫：
```typescript
registerHandler('getHlsDelegation', async (_message, sender) => {
  try {
    const stored = await settingsStore.get<Partial<Settings>>()
    const settings: Settings = { ...DEFAULT_SETTINGS, ...stored }

    // Guard 0: 扩展总开关
    const globalCfg = await persistentStorage.get<{ enabled?: boolean }>('extensionGlobalConfig')
    if (globalCfg?.enabled === false) {
      return { mode: 'delegated' as const, reason: 'extension-disabled' }
    }

    // Guard 1: HLS 过滤开关
    if (!settings.enableHlsAdFilter) {
      return { mode: 'delegated' as const, reason: 'hls-filter-disabled' }
    }

    // Guard 2 + 3: 站点判定（黑名单优先 → 启用列表匹配）
    const pageUrl = sender.tab?.url ?? ''
    const domain = extractDomain(pageUrl)
    if (domain && !isHlsSite(domain, settings)) {
      // isHlsSite 内部已处理：黑名单拦截 + 启用列表匹配
      // 具体 reason 在 isHlsSite 内部可返回，这里简化为 site-not-allowed
      return { mode: 'delegated' as const, reason: 'site-not-allowed' }
    }

    return { mode: 'active' as const, reason: undefined }
  } catch {
    return { mode: 'active' as const, reason: 'error-fallback' }
  }
})
```

**验收标准**：
- HLS 过滤关闭 → 返回 delegated，hook 不装
- 黑名单站点 → 返回 delegated
- 智能模式下，未学习站点 → delegated；学习后 → active（种子已在初始化时合并进 hlsLearnedSites，所以新安装用户第一次就能用）
- 手动模式下，未启用站点 → delegated；启用后 → active
- 任何异常 → fallback active（安全降级，不因守卫错误阻断 HLS 功能）

---

**Task 1.4 — 单元测试**

- [ ] 新建 `tests/engine/hls/hls-sites.test.ts`：
  ```
  describe('isHlsSite (守卫判定)', isInList / matchDomain / extractDomain
    ✓ 智能模式 + hlsLearnedSites 包含该域名 → true
    ✓ 智能模式 + hlsLearnedSites 不包含 → false
    ✓ 手动模式 + hlsEnabledSites 包含 → true
    ✓ 手动模式 + hlsEnabledSites 不包含 → false
    ✓ 两种模式 + hlsDisabledSites 包含（黑名单）→ false（最高优先级）
    ✓ 子域名匹配（www.bilibili.com 匹配 bilibili.com）
    ✓ 空 domain → false
    ✓ 大小写不敏感
  describe('getActiveSiteList (运行模式分发)
    ✓ smart 返回 hlsLearnedSites
    ✓ manual 返回 hlsEnabledSites
  describe('initSeedSitesIfNeeded (种子初始化)
    ✓ 首次安装 → 种子写入 hlsLearnedSites（智能模式）
    ✓ 首次安装 → 种子写入 hlsEnabledSites（手动模式）
    ✓ 已初始化过的用户 → 跳过，不重复写入
    ✓ 已存在用户数据 → 只合并缺失种子条目，不覆盖用户已有
  describe('supplementSeedSites (一键补全)
    ✓ 当前列表不含种子 → 补全所有
    ✓ 部分含 → 只补缺失的
    ✓ 全部已含 → added=0
    ✓ 用户删除过的种子 → 不恢复（尊重用户选择）
  describe('addSite / removeSite (列表操作)
    ✓ addSite 去重
    ✓ removeSite 正确移除
    ✓ removeSite 移除不存在的 → 不报错
  describe('extractDomain
    ✓ 正常 URL → 正确提取
    ✓ 非法 URL → 空字符串
  ```
- [ ] 覆盖率 >90%（函数逻辑简单，容易覆盖）

**验收标准**：
- `bun run test` 全绿
- `bun run coverage` 新模块覆盖率达标

---

#### Step 2: sniffer 自动学习（30min）

**Task 2.1 + 2.2 — sniffer.ts 自动学习**

找到 `src/background/media/sniffer.ts` 中 m3u8 检测点（约 818 行）：
```typescript
// 当前代码
if ((ext.toLowerCase() === 'm3u8' || ext.toLowerCase() === 'm3u') && pending.tabId >= 0) {
  if (_m3u8ProcessHandler) {
    void _m3u8ProcessHandler(pending.url, pending.tabId, pending.requestHeaders)
  } else {
    void processM3u8InBackground(pending.url, pending.tabId, pending.requestHeaders)
  }
}
```

在前面加自动学习逻辑：
```typescript
if ((ext.toLowerCase() === 'm3u8' || ext.toLowerCase() === 'm3u') && pending.tabId >= 0) {
  // ===== 自动学习（智能模式）=====
  try {
    const settings = await settingsStore.get<Partial<Settings>>()
    const fullSettings: Settings = { ...DEFAULT_SETTINGS, ...settings }

    if (fullSettings.hlsRunMode === 'smart' && fullSettings.enableHlsAdFilter) {
      // 1. 取页面 URL（从 tabId 获取）
      const tab = await chrome.tabs.get(pending.tabId).catch(() => null)
      const pageHost = tab ? extractDomain(tab.url) : ''

      if (pageHost) {
        // 2. Guard: 黑名单绝对不能加
        if (!isInList(fullSettings.hlsDisabledSites, pageHost)) {
          // 3. Guard: 已在学习列表 → 跳过（种子已合并进 hlsLearnedSites，
          //    这里只需要检查 hlsLearnedSites 一个列表即可，无需 builtin 检查）
          if (!isInList(fullSettings.hlsLearnedSites, pageHost)) {
            // 4. 加入学习列表（带 MAX_LEARNED_SITES 上限保护）
            const MAX_LEARNED_SITES = 500
            const trimmed = fullSettings.hlsLearnedSites.length >= MAX_LEARNED_SITES
              ? fullSettings.hlsLearnedSites.slice(fullSettings.hlsLearnedSites.length - MAX_LEARNED_SITES + 1)
              : fullSettings.hlsLearnedSites
            const updated = [...trimmed, pageHost]
            await settingsStore.set({ ...fullSettings, hlsLearnedSites: updated })
            logger.info('[hls-sites] auto-learned site:', pageHost)
          }
        }
      }
    }
  } catch (e) {
    logger.warn('[hls-sites] auto-learn failed:', (e as Error).message)
  }

  // ===== 原有逻辑保持不变 =====
  if (_m3u8ProcessHandler) {
    void _m3u8ProcessHandler(pending.url, pending.tabId, pending.requestHeaders)
  } else {
    void processM3u8InBackground(pending.url, pending.tabId, pending.requestHeaders)
  }
}
```

**注意**：sniffer 是 webRequest 全局嗅探，**不区分哪个页面的 m3u8**。学习的是"包含此 m3u8 请求的那个 tab 的页面域名"，而非 m3u8 请求本身的域名。这个逻辑在 `chrome.tabs.get(tabId)` 中获取。

**验收标准**：
- 智能模式下，在未学习且种子未覆盖的站点上播放 HLS 视频 → sniffer 检测到 → hlsLearnedSites 自动加入该域名
- 黑名单中的域名即使 sniffer 检测到 m3u8 → 也不加入 hlsLearnedSites
- 手动模式下 sniffer 不执行学习逻辑
- enableHlsAdFilter = false 时不执行学习逻辑

---

#### Step 3: popup 交互（2h）

**Task 3.1 — popup 显示当前 tab HLS 状态**

在 popup main.tsx 中：
- 获取当前 tab 的 hostname
- 检查该 hostname 在当前 settings 下的 HLS 激活状态
- 显示一个状态指示：

```
┌────────────────────────────────────────────┐
│  当前站点                                  │
│  bilibili.com ✅ HLS 过滤已启用            │
│                                            │
│  or                                       │
│                                            │
│  999px.com ⚠️ HLS 过滤未启用               │
│  [ 为当前站点启用 HLS 过滤 ]               │
│                                            │
│  or                                       │
│                                            │
│  private-site.com ❌ 已禁用 (黑名单)        │
│  [ 从黑名单移除 ]                          │
└────────────────────────────────────────────┘
```

**Task 3.2 — "为当前站点启用 HLS 过滤"按钮**

点击后：
1. 获取当前 tab hostname
2. 根据 hlsRunMode 加入对应列表：
   - `smart` → 加 `hlsLearnedSites`
   - `manual` → 加 `hlsEnabledSites`
3. 检查当前 tab 是否已注入 hook（可发消息让 hls.content.ts 自查）
4. 如果 hook 未安装 → `chrome.scripting.executeScript` 补注入
5. 提示用户刷新页面（因为 MAIN world hook 必须在页面脚本前安装才能拦截 fetch/XHR）

**补注入实现**：
```typescript
async function enableHlsForCurrentTab(tabId: number, hostname: string, runMode: 'smart' | 'manual') {
  // 1. 加入对应列表
  const settings = await settingsStore.get<Partial<Settings>>()
  if (runMode === 'smart') {
    const learned = [...new Set([...(settings.hlsLearnedSites || []), hostname])]
    await settingsStore.set({ ...settings, hlsLearnedSites: learned })
  } else {
    const enabled = [...new Set([...(settings.hlsEnabledSites || []), hostname])]
    await settingsStore.set({ ...settings, hlsEnabledSites: enabled })
  }

  // 2. 补注入 hook（因为 delegation 守卫只在首次注入时跑）
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content-scripts/hls.js', 'content-scripts/hls-bridge.js'],
    })
  } catch (e) {
    // 补注入可能失败（MV3 权限限制、页面已关闭等），不阻断流程
    console.warn('补注入失败，用户需手动刷新页面')
  }

  // 3. 提示刷新
  showToast({
    message: `已为 ${hostname} 启用 HLS 过滤，请刷新页面`,
    action: { label: '刷新', onClick: () => chrome.tabs.reload(tabId) },
  })
}
```

**Task 3.3 + 3.4 — 补注入 hook + 刷新提示**

（已在上面的代码骨架中体现）

**验收标准**：
- popup 打开即显示当前 tab HLS 状态
- 未启用的站点显示临时启用按钮
- 点击后站点加入对应列表
- 补注入执行 + 刷新提示
- 刷新页面后 hook 正常安装，HLS 过滤生效

---

#### Step 4: options 管理页面（3h）

**Task 4.1 — 运行模式切换**

在 `options-hls-filter` 页面（或新建独立 section）增加：

```
┌─────────────────────────────────────────────────────┐
│  HLS 运行模式                                       │
│                                                     │
│  ○ 智能启用（推荐）                                 │
│    浏览器检测到含 HLS 视频的站点后自动启用，首次     │
│    访问小众站点时需要刷新或点击 popup 启用。         │
│                                                     │
│  ○ 手动开启                                         │
│    只在你明确添加的站点上启用 HLS 过滤，其他站点     │
│    完全不安装 hook，开销为零。                       │
└─────────────────────────────────────────────────────┘
```

切换智能/手动模式后，页面下方显示的站点列表 Tab 自动联动切换。

**Task 4.2 — 站点列表可视化管理**

**两个 Tab（统一列表，不再区分 builtin/user）**：

| Tab | 内容 | 来源 | 增删权限 |
|-----|------|------|---------|
| **启用站点** | 智能模式 = sniffer 学习 + 种子初始化合并的站点<br>手动模式 = 用户手动添加 + 种子初始化合并的站点 | `hlsLearnedSites` 或 `hlsEnabledSites`（随运行模式自动切换） | ✅ 完全可控（想删就删，种子也可以删） |
| **禁用站点（黑名单）** | 两种模式都屏蔽的站点 | `hlsDisabledSites` | ✅ 完全可控 |

每个站点卡片显示：
- 域名
- 一键操作：删除 / 移入黑名单（启用列表）

**Task 4.3 + 4.4 — 增删操作 + 批量操作**

- 单个输入框 + 添加按钮（手动添加域名）
- 每个站点卡片的删除按钮
- 启用列表支持"一键清空"
- 导出为 JSON + 导入 JSON（用户换浏览器/手动迁移）

**Task 4.5 — 一键补全种子数据按钮**

启动站点列表底部加一个按钮：
```
┌─────────────────────────────────────────────────────┐
│  启用站点                             [一键补全已知站点] │
│  (共 42 个)                                          │
│                                                      │
│  bilibili.com  🗑️  🚫                              │
│  youtube.com   🗑️  🚫                              │
│  ...                                                 │
│                                                      │
│  输入域名添加...                          [添加]      │
└─────────────────────────────────────────────────────┘
```

点击"一键补全已知站点"：
- 调用 `supplementSeedSites(runMode)`
- 合并种子中当前列表缺失的条目（已删除的不恢复，尊重用户选择）
- 弹出 toast 提示"已补全 N 个已知站点"

**为什么不需要"种子站点只读"Tab？** 种子数据写入后与 sniffer 学习、用户手动添加的站点**完全等价**，用户可能想删除某个种子站点（比如"我就是不想在 bilibili 上用 HLS 过滤"），只读 Tab 反而给用户制造困惑——"为什么这个我删不了？"统一列表 + 一键补全按钮是最清晰的设计。

**验收标准**：
- 运行模式切换即时保存
- 站点列表增删即时生效（下次页面加载 delegation 守卫读到新值）
- 导入导出格式正确
- "一键补全已知站点"按钮文案清晰可理解，补全结果 toast 提示

---

#### Step 5: 集成验证（1h）

**Task 5.1 — 智能模式端到端测试**

- [ ] 清空 `hlsLearnedSites`
- [ ] 访问一个未学习的小众 HLS 站点
- [ ] sniffer 检测到 m3u8 → `hlsLearnedSites` 自动加入
- [ ] 刷新页面 → `getHlsDelegation` 返回 active → hook 安装 → HLS 过滤生效
- [ ] **另一个未学习站点** → 不 hook → 过滤不生效（预期行为）

**Task 5.2 — 手动模式端到端测试**

- [ ] 切换到 manual 模式
- [ ] `hlsEnabledSites` 为空时访问任何站点 → 不 hook → 过滤不生效（包括种子站点）
- [ ] 手动添加一个站点到 `hlsEnabledSites` → 刷新页面 → hook 安装 → 过滤生效

**Task 5.3 — 黑名单优先级测试**

- [ ] 把种子站点 bilibili.com 加入 `hlsDisabledSites`
- [ ] 访问该站点 → `getHlsDelegation` 返回 delegated → hook 不装
- [ ] 不管 runMode 是 smart 还是 manual → 都黑名单优先
- [ ] sniffer 检测到该站点的 m3u8 → 自动学习逻辑不触发

**Task 5.4 — popup 临时启用 + 补注入测试**

- [ ] 智能模式 + 访问未学习站点 → hook 未装 → 视频正在播放但没过滤
- [ ] 点 popup → 显示"未启用" → 点"为当前站点启用"
- [ ] 站点加入 `hlsLearnedSites` → `chrome.scripting.executeScript` 补注入
- [ ] 提示刷新 → 刷新后 hook 生效 → HLS 过滤正常工作

**Task 5.5 — 回归测试**

- [ ] `bun run typecheck` 通过
- [ ] `bun run test` 全绿（包括 HLS 引擎现有单元测试）
- [ ] B 站视频播放正常，HLS 过滤生效
- [ ] 关闭 `enableHlsAdFilter` → delegation 返回 delegated → hook 不装 → 视频播放正常（无过滤）
- [ ] DASH 侧功能不受影响（独立代码路径）

---

## 四、风险与回滚

### 4.1 可能风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| delegation 返回 delegated 但 hook 已经被安装（页面加载 race condition） | 低 | 无实际影响——hook 装了也只是多几次 isM3u8Url 检查，不会执行过滤 | 已装 hook 后 delegation 返回什么都不影响，只有"不装 hook"才有效 |
| sniffer 自动学习把非 HLS 站点加入列表（误判） | 低 | 该站点 hook 白装，无功能损失 | 用户可在 options 页手动删除；黑名单可永久屏蔽 |
| popup 补注入失败（MV3 scripting 权限问题） | 低 | 用户需要手动刷新页面 | 补注入失败时 catch 不阻断流程，刷新提示始终显示 |
| 种子站点覆盖不全 | 中 | 部分主流站点首访不 hook | 智能模式自动学习会补；用户可手动加；options 页"一键补全"可补齐种子 |
| 种子站点过长，初始化列表占用内存 | 极低 | 约 40 条字符串，内存忽略不计 | — |
| 用户误删种子站点想恢复 | 极低 | 启用列表不再含该站点，hook 不装 | options 页"一键补全已知站点"按钮可随时补回缺失种子 |

### 4.2 回滚策略

改动的所有新逻辑都有**开关可关**：
- `hlsRunMode: 'smart' | 'manual'` — 切到 manual + 把 `hlsEnabledSites` 用"一键补全种子"补满 → 退回到"种子全覆盖"的模式
- 更进一步 → 把 `enableHlsAdFilter` 设为 false → delegation 返回 delegated → 所有 hook 都不装
- `getHlsDelegation` 的 catch 块已经做了 fallback active → 守卫逻辑出错不会阻断 HLS 功能

**最安全的默认配置**：首次安装时种子初始化自动把主流站点写入启用列表，**新用户第一次打开 B 站就能用 HLS 过滤**，零冷启动成本。

---

## 五、后续迭代（Out of Scope）

| 方向 | 说明 | 优先级 |
|------|------|--------|
| hook 运行时卸载 | 已安装的 hook 支持运行时卸载（比如用户在 popup 把当前站点拉黑后，不需要刷新就能卸载 hook） | P2 |
| 域名通配符 | `*.example.com` 通配符匹配 | P3 |
| DASH 站点列表统一 | HLS + DASH 站点列表合并成一套，减少维护 | P3 |
| `chrome.notifications` 自动学习提示 | sniffer 第一次检测到新站点时弹通知，用户体验更好 | P2 |
| 访问频率统计 + 学习建议 | 学习列表按访问频率排序，低频站点可提示清理 | P3 |
| SSRF 安全检查 | sniffer 学习时检查 pageHost 是否为内网 IP（防止恶意站点诱导学习） | P2 |

---

## 六、全局复盘校验

### 第一次复盘：需求遗漏、边界场景、逻辑漏洞

| 检查点 | 结论 |
|--------|------|
| 冷启动场景是否影响核心功能？ | ✅ **种子初始化让新用户零冷启动**——首次安装时种子自动写入启用列表，B 站/爱奇艺等主流站点 hook 立即生效。只有种子未覆盖的小众新站点才会遇到首次不 hook 的情况，sniffer 会自动学习，或用户 popup 一键启用 |
| 黑名单学习拦截是否只在 sniffer 加了？ | ✅ sniffer 自动学习逻辑开头就检查黑名单，双重保险 |
| delegation 守卫 catch 块 fallback 是否合理？ | ✅ fallback 到 active（安全降级），不因守卫错误阻断 HLS |
| 自动学习是否会学习到同一域名多个子域名？ | ✅ `matchDomain()` 只做精确 + 子域名后缀匹配，不会把 `sub1.bili.com` 和 `sub2.bili.com` 各加一条——实际只加 `bili.com` 就够了 |
| 学习列表无限增长怎么办？ | ⚠️ **发现潜在问题**——没有上限保护。如果用户访问过几千个站点，`hlsLearnedSites` 会无限增长。**修正**：加一个 `MAX_LEARNED_SITES = 500` 上限，超过时按 FIFO 淘汰最老的 |
| popup 补注入是否需要检查扩展是否开启？ | ✅ 不需要——delegation 守卫在 hook 安装时已经做了。补注入后 hook 装了，但 hook 内部 bridge → delegation 会再次检查，返回 delegated → hook 不执行过滤逻辑。没有双重问题 |

**复盘修正项**：自动学习加 `MAX_LEARNED_SITES = 500` FIFO 上限。

### 第二次复盘：全项目架构、兼容性、迭代成本

| 检查点 | 结论 |
|--------|------|
| 与 DASH 架构一致性 | ⚠️ **有意差异**——HLS 用"种子初始化 + 统一列表"模式（用户完全可控），DASH 用"builtin + user 分离"模式（用户无法直接移除内置）。HLS 模式更优，后续 DASH 可以跟进迁移。守卫逻辑位置对称（`getDashDelegation` / `getHlsDelegation`），函数签名同风格 |
| 与现有 settings 存储格式兼容性 | ✅ 新增字段用 spread 模式 `{ ...DEFAULT_SETTINGS, ...stored }`，旧用户零迁移成本 |
| 后续能否复用到 DASH？ | ✅ 如果未来 DASH 也要"自动学习"，只需把 sniffer 学习逻辑里的协议分支加一下，站点列表管理代码不需要改 |
| 是否影响 push 客户端 / 桌面端？ | ✅ 完全不影响——改动都在 content script 注入守卫层，桌面端通信走的是另一条独立链路 |
| manifest.json 是否需要改？ | ✅ 不需要——content script 的 `matches` 还是全量（因为 document_start 时机太早，WXT 的 manifest 是构建时固定的）。**守卫决策推迟到 background 运行时**，这是正确的设计——manifest 无法按域名条件性注入，只能 runtime 决策 |
| 代码量是否可控？ | ✅ 新增 ~400 行（其中 UI 占 200+），核心逻辑 ~150 行，非常克制 |
| 能否先做 MVP（跳过 Step 4 options UI）？ | ✅ 可以——MVP 做完 Step 1-3 后功能已经闭环（智能模式自动学习 + popup 临时启用 + delegation 守卫生效），Step 4 的 options 管理是锦上添花 |

### 复盘最终结论

**方案通过**，仅需在自动学习环节补上 `MAX_LEARNED_SITES = 500` FIFO 上限。可以落地实施。

---

## 七、执行优先级建议

| 阶段 | 内容 | 理由 |
|------|------|------|
| **MVP 先做** | Step 1 + Step 2 + Step 3（智能模式闭环） | 核心价值最高：hook 守卫生效 + 自动学习 + popup 临时启用。options 管理页可以等 MVP 跑起来验证没问题再做 |
| **第二阶段** | Step 4（options 管理页） | UI 层，不影响核心逻辑 |
| **第三阶段** | P2 迭代（hook 卸载、通知提示等） | 按需 |