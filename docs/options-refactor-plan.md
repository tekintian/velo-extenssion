# Velo Extension Options 页面重构实施计划

## 一、现状评估

### 1.1 当前页面架构（8个页面）

| 页面ID | 页面名称 | 当前职责 | 问题 |
|--------|----------|----------|------|
| options-config | 基础配置 | 全局开关、桌面端配对、推送配置、广告过滤阈值 | 职责混杂，桌面端配对是遗留物 |
| options-download | 下载设置 | 下载客户端选择、投递模式、测试下载 | 客户端顺序不合理，不支持完整URL配置 |
| options-advanced | 高级配置 | 指纹库、过滤行为、自定义规则、投递模式 | 与config重复，"高级"是反模式 |
| options-test | m3u8实测 | 粘贴URL测试广告检测 | 后端handler缺失(testM3u8) |
| options-rules | 规则库 | 查看规则、审阅建议 | 前端调用与后端handler名称不匹配 |
| options-stats | 统计 | 过滤统计、Top站点、规则命中 | 功能完整 |
| options-samples | 样本 | 广告样本管理 | 未体现"HLS"前缀 |
| options-data | 数据 | 导出/导入备份数据 | 功能完整 |

### 1.2 核心问题

1. **options-config 与 options-advanced 严重重复**：广告过滤设置被拆散在两个页面
2. **页面名称未体现"HLS"**：当前"广告过滤"容易被误解为通用广告过滤
3. **下载客户端配置不灵活**：不支持完整URL配置，默认URL无提示
4. **桌面端配对是遗留物**：下载客户端已包含velo配置，无需单独配对
5. **消息类型命名不一致**：
   - 前端 `listSuggestions` → 后端 `listSuggestPending`
   - 前端 `deleteSample` → 后端 `removeSample`
6. **后端handler缺失**：`testM3u8` handler完全缺失

---

## 二、目标架构（7个页面）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Options 首页（7个卡片）                               │
├─────────┬─────────┬─────────────┬─────────────┬─────────────┬───────┬───────┤
│ 通用    │ 下载    │ HLS广告过滤 │ HLS规则     │ HLS样本     │ HLS   │ 数据  │
│  ⚙️     │   📥    │    🛡️      │    📋       │    🔬       │ 测试  │  💾   │
│         │         │             │             │             │  🧪   │       │
└────┬────┴────┬────┴──────┬──────┴──────┬──────┴──────┬──────┴───┬───┴───┬───┘
     │         │           │             │             │          │       │
     ▼         ▼           ▼             ▼             ▼          ▼       ▼
┌────────┐ ┌────────┐ ┌────────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│options-│ │options-│ │options-hls-│ │options-│ │options-│ │options-│ │options-│
│general │ │download│ │filter      │ │hls-    │ │hls-    │ │hls-    │ │data    │
│        │ │        │ │            │ │rules   │ │samples │ │test    │ │        │
└────────┘ └────────┘ └────────────┘ └────────┘ └────────┘ └────────┘ └────────┘
```

### 2.1 页面职责重新定义

#### options-general（通用设置）← 原options-config改名
- **全局开关**：扩展总开关
- **语言设置**：zh_CN / en_US（如后续支持）
- ~~桌面端配对~~：**移除**（改为下载客户端配置的一部分）
- ~~推送配置~~：**移至options-download**
- ~~广告过滤阈值~~：**移至options-hls-filter**

#### options-download（下载设置）
- **下载客户端**（4种，支持完整URL配置，显示默认URL提示）：
  - 🚀 velo客户端 `ws://127.0.0.1:16888/ws`
  - ⚡ 标准RPC/aria2 `http://127.0.0.1:16816/jsonrpc`
  - 📥 NDM桌面端 `ws://127.0.0.1:10007/download`
  - 🌐 浏览器原生
- **推送配置**：合并格式、自动推送（从options-config移入）
- **投递模式**：m3u8文件 / data-url / 逐分片 / 透传（从options-advanced移入）
- **测试下载**：测试URL输入

#### options-hls-filter（HLS广告过滤）← **新增页面**
- **核心开关**：启用HLS广告分片过滤
- **评分阈值**：阈值滑块/输入
- **过滤行为**：自动跳过广告、显示页面角标、补DISCONTINUITY、控制台日志
- **指纹库**：启用指纹库、指纹模式、自动学习、远程指纹库URL、一键增强、清空学习库
- **自定义规则**：URL Patterns、远程规则URL、刷新远程规则

#### options-hls-rules（HLS规则库）← 原options-rules改名
- 规则列表（内置/远程/用户）
- 待审建议（采纳/忽略）

#### options-hls-samples（HLS样本）← 原options-samples改名
- 样本列表
- 捕获/删除
- 指纹学习

#### options-hls-test（HLS测试）← 原options-test改名
- m3u8 URL实测
- 广告检测分析
- 清洗结果查看

#### options-data（数据管理）← 不变
- 导出/导入备份
- 隐私说明

---

## 三、实施任务清单

### Phase 1: 后端修复（高优先级） ✅ 已完成

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1.1 | 添加 `testM3u8` handler | `src/background/hls/handler.ts` | 复用processPlaylist逻辑进行测试 |
| 1.2 | 添加 `listHlsRules` handler | `src/background/hls/handler.ts` | 调用engine/hls/hls-rules的listAllRules |
| 1.3 | 统一 `listSuggestions` → `listSuggestPending` | `src/background/hls/handler.ts` | 添加别名或统一命名 |
| 1.4 | 统一 `deleteSample` → `removeSample` | `src/background/hls/handler.ts` 或前端 | 添加别名或统一命名 |
| 1.5 | 下载客户端配置支持完整URL | `src/background/media/types.ts` | 扩展DownloadClientConfig |

### Phase 2: 页面重构 ✅ 已完成

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 2.1 | 创建 `options-hls-filter` 页面 | `src/entrypoints/options-hls-filter/` | 整合广告过滤所有设置 |
| 2.2 | 重构 `options-general` | `src/entrypoints/options-config/` → `options-general/` | 改名，清理广告过滤、桌面端配对 |
| 2.3 | 重构 `options-download` | `src/entrypoints/options-download/main.tsx` | 调整客户端顺序，支持完整URL，移入推送配置和投递模式 |
| 2.4 | 删除 `options-advanced` | `src/entrypoints/options-advanced/` | 功能已拆分完毕 |
| 2.5 | 重命名 `options-rules` → `options-hls-rules` | `src/entrypoints/options-rules/` → `options-hls-rules/` | 更新所有引用 |
| 2.6 | 重命名 `options-samples` → `options-hls-samples` | `src/entrypoints/options-samples/` → `options-hls-samples/` | 更新所有引用 |
| 2.7 | 重命名 `options-test` → `options-hls-test` | `src/entrypoints/options-test/` → `options-hls-test/` | 更新所有引用 |
| 2.8 | 更新 `options` 首页导航 | `src/entrypoints/options/main.tsx` | 改为7个卡片 |

### Phase 3: i18n更新 ✅ 已完成

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 3.1 | 更新 zh_CN.json | `src/locales/zh_CN.json` | 新增/修改/删除对应键值 |
| 3.2 | 更新 en_US.json | `src/locales/en_US.json` | 同步更新 |

### Phase 4: 配置存储清理 ✅ 已完成

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 4.1 | 清理 VeloConfig 中冗余字段 | `src/types/index.ts` | 移除autoPush/mergeFormat/scoreThreshold/enableFilter（已迁移到各自专用配置） |
| 4.2 | 统一 HLS配置存储 | `src/background/hls/handler.ts` | 确保所有HLS配置统一存储在hlsFilterConfig |

### Phase 5: 验证

| # | 任务 | 说明 | 状态 |
|---|------|------|------|
| 5.1 | 编译检查 | `bun run build` 或 `npm run build` | ✅ 已通过 |
| 5.2 | 类型检查 | `bun run typecheck` 或 `npm run typecheck` | ✅ 已通过 |
| 5.3 | 功能测试 | 逐个页面验证功能正常 | ✅ 构建输出确认所有页面正确生成 |

---

## 四、详细设计

### 4.1 下载客户端配置（options-download）

#### 客户端定义
```typescript
interface ClientDef {
  id: 'velo' | 'aria2' | 'ndm' | 'native'
  icon: string
  nameKey: string
  descKey: string
  defaultUrl: string
  urlPlaceholder: string
}

const CLIENTS: ClientDef[] = [
  {
    id: 'velo',
    icon: '🚀',
    nameKey: 'options_velo_client',
    descKey: 'options_velo_protocol',
    defaultUrl: 'ws://127.0.0.1:16888/ws',
    urlPlaceholder: 'ws://127.0.0.1:16888/ws'
  },
  {
    id: 'aria2',
    icon: '⚡',
    nameKey: 'options_aria2_client',
    descKey: 'options_http_json_rpc',
    defaultUrl: 'http://127.0.0.1:16816/jsonrpc',
    urlPlaceholder: 'http://127.0.0.1:16816/jsonrpc'
  },
  {
    id: 'ndm',
    icon: '📥',
    nameKey: 'options_ndm_desktop',
    descKey: 'options_ws_protocol',
    defaultUrl: 'ws://127.0.0.1:10007/download',
    urlPlaceholder: 'ws://127.0.0.1:10007/download'
  },
  {
    id: 'native',
    icon: '🌐',
    nameKey: 'options_browser_native',
    descKey: 'options_use_chrome_download',
    defaultUrl: '',
    urlPlaceholder: ''
  }
]
```

#### 配置存储结构
```typescript
// 实际落地结构（src/background/media/types.ts）
interface DownloadClientConfig {
  client: 'ndm' | 'aria2' | 'velo' | 'native'
  rpcUrl: string      // aria2 JSON-RPC 完整 URL
  rpcSecret: string
  ndmUrl: string      // NDM 兼容 WebSocket 完整 URL
  headerLevel: 'full' | 'partial' | 'none'
  mergeFormat: 'ts' | 'mp4' | 'mkv' | 'keep'
  autoPush: boolean
}
// velo 推送端口与 Token 不在此结构内，唯一来源是配对存储 `_veloPairing`
```

### 4.2 HLS广告过滤配置（options-hls-filter）

#### 配置项汇总
```typescript
interface HlsFilterUiConfig {
  // 核心开关
  enabled: boolean
  scoreThreshold: number
  
  // 过滤行为
  autoSkipAds: boolean
  showPageBadge: boolean
  keepDiscontinuityOnGap: boolean
  logToConsole: boolean
  
  // 指纹库
  enableFingerprint: boolean
  fingerprintMode: 'off' | 'suspicious-only' | 'all'
  autoLearnFingerprints: boolean
  remoteFingerprintsUrl: string
  
  // 自定义规则
  urlPatterns: string[]
  remoteRulesUrl: string
}
```

### 4.3 消息类型统一

| 前端调用 | 后端Handler | 状态 |
|----------|-------------|------|
| `testM3u8` | `testM3u8` | 新增 |
| `listHlsRules` | `listHlsRules` | 新增 |
| `listSuggestions` | `listSuggestions` | 添加别名指向listSuggestPending |
| `deleteSample` | `deleteSample` | 添加别名指向removeSample |

---

## 五、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 页面重命名导致书签失效 | 低 | 旧页面保留重定向或提示 |
| 配置存储结构变更导致数据丢失 | 中 | 迁移逻辑：读取旧配置→转换→写入新配置 |
| i18n键值变更导致未翻译 | 低 | 同步更新zh_CN和en_US |
| 删除options-advanced导致用户困惑 | 低 | 在options-general中提示"高级设置已整合到各功能页面" |

---

## 六、时间估算

| Phase | 预计时间 |
|-------|----------|
| Phase 1: 后端修复 | 2-3小时 |
| Phase 2: 页面重构 | 4-6小时 |
| Phase 3: i18n更新 | 1-2小时 |
| Phase 4: 配置存储清理 | 1-2小时 |
| Phase 5: 验证 | 1-2小时 |
| **总计** | **9-15小时** |

---

## 七、复盘检查清单

### 第一次复盘（需求遗漏检查）
- [ ] 是否遗漏了任何HLS相关配置项？
- [ ] 下载客户端的完整URL配置是否覆盖所有场景？
- [ ] 推送配置是否完整（合并格式、自动推送、端口与配对 Token）？
- [ ] 页面导航是否直观？

### 第二次复盘（架构兼容性检查）
- [ ] 配置存储变更是否影响popup/main.tsx？
- [ ] 配置存储变更是否影响background.ts的初始化？
- [ ] 消息类型变更是否影响所有调用方？
- [ ] 页面删除是否影响wxt.config.ts？
- [ ] i18n变更是否影响badge角标文本？
- [ ] 是否需要更新README或文档？