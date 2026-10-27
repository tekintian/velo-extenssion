import { createRoot } from 'react-dom/client'
import { useState, useEffect, useCallback } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

interface SiteList {
  builtin: readonly string[]
  user: string[]
}

interface FpEntry {
  hash: string
  adName: string
  source: string
  firstSeen: number
}

interface RuleItem {
  id: string
  name: string
  hostPattern: string
  adUrlPatterns: readonly string[]
  scoreThreshold?: number
  forceKeep: readonly string[]
  _builtin?: boolean
  _user?: boolean
  _remote?: boolean
}

interface SuggestionItem {
  id: string
  hostPattern: string
  adUrlPatterns: readonly string[]
  scoreThreshold: number
  createdAt: number
}

type TabId = 'general' | 'fingerprint' | 'rules' | 'sites'

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'general', label: '基础设置', icon: '⚙️' },
  { id: 'fingerprint', label: '指纹库', icon: '🔍' },
  { id: 'rules', label: '规则管理', icon: '📋' },
  { id: 'sites', label: '启用站点', icon: '🌐' },
]

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function DashFilterPage() {
  const [activeTab, setActiveTab] = useState<TabId>('general')
  const [enabled, setEnabled] = useState(true)
  const [scoreThreshold, setScoreThreshold] = useState(3)
  const [mode, setMode] = useState('manifest-file')
  const [logToConsole, setLogToConsole] = useState(false)
  const [enableFingerprint, setEnableFingerprint] = useState(true)
  const [fingerprintMode, setFingerprintMode] = useState('suspicious-only')
  const [autoLearnFingerprints, setAutoLearnFingerprints] = useState(true)
  const [remoteFingerprintsUrl, setRemoteFingerprintsUrl] = useState('')
  const [remoteRulesUrl, setRemoteRulesUrl] = useState('')
  const [saved, setSaved] = useState(false)
  const [fpStats, setFpStats] = useState<{ learned: number } | null>(null)
  const [siteList, setSiteList] = useState<SiteList>({ builtin: [], user: [] })
  const [newSite, setNewSite] = useState('')

  const [fpList, setFpList] = useState<FpEntry[]>([])
  const [rules, setRules] = useState<RuleItem[]>([])
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])

  const [newRuleName, setNewRuleName] = useState('')
  const [newRuleHost, setNewRuleHost] = useState('')
  const [newRulePatterns, setNewRulePatterns] = useState('')
  const [newRuleThreshold, setNewRuleThreshold] = useState(3)

  const loadFpList = useCallback(async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'listDashLearnedFingerprints' })
      if (r?.fingerprints) setFpList(r.fingerprints as FpEntry[])
    } catch { /* ignore */ }
  }, [])

  const loadRules = useCallback(async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'listDashRules' })
      if (r) setRules(r as RuleItem[])
    } catch { /* ignore */ }
  }, [])

  const loadSuggestions = useCallback(async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'listDashSuggestPending' })
      if (r) setSuggestions(r as SuggestionItem[])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [])

  useEffect(() => {
    if (activeTab === 'fingerprint') void loadFpList()
    if (activeTab === 'rules') {
      void loadRules()
      void loadSuggestions()
    }
  }, [activeTab, loadFpList, loadRules, loadSuggestions])

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get('dashFilterConfig')
      const cfg = stored?.dashFilterConfig as Record<string, unknown> | undefined
      if (cfg) {
        setEnabled((cfg.enabled as boolean) ?? true)
        setScoreThreshold((cfg.scoreThreshold as number) ?? 3)
        setMode((cfg.mode as string) ?? 'manifest-file')
        setLogToConsole((cfg.logToConsole as boolean) ?? false)
        setEnableFingerprint((cfg.enableFingerprint as boolean) ?? true)
        setFingerprintMode((cfg.fingerprintMode as string) ?? 'suspicious-only')
        setAutoLearnFingerprints((cfg.autoLearnFingerprints as boolean) ?? true)
        setRemoteFingerprintsUrl((cfg.remoteFingerprintsUrl as string) ?? '')
        setRemoteRulesUrl((cfg.remoteRulesUrl as string) ?? '')
      }
    } catch { /* ignore */ }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'getDashFingerprintStats' })
      if (r) setFpStats(r as { learned: number })
    } catch { /* ignore */ }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'getDashSites' })
      if (r) setSiteList(r as SiteList)
    } catch { /* ignore */ }
  }

  async function handleSave() {
    try {
      const dashFilterConfig = {
        enabled,
        scoreThreshold,
        mode,
        logToConsole,
        enableFingerprint,
        fingerprintMode,
        autoLearnFingerprints,
        remoteFingerprintsUrl,
        remoteRulesUrl,
      }
      await chrome.storage.local.set({ dashFilterConfig })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      alert(i18n('options_save_failed') + ': ' + (e as Error).message)
    }
  }

  async function handleClearFingerprints() {
    if (!confirm(i18n('options_confirm_clear_fingerprints') ?? '确定清空所有已学习的指纹？')) return
    try {
      await chrome.runtime.sendMessage({ type: 'clearDashFingerprints' })
      setFpStats({ learned: 0 })
      setFpList([])
      alert(i18n('options_clear_fingerprints_ok') ?? '指纹库已清空')
    } catch (e) { alert(String(e)) }
  }

  async function handleRemoveFingerprint(hash: string) {
    try {
      await chrome.runtime.sendMessage({ type: 'removeDashLearnedFingerprint', payload: { hash } })
      setFpList((prev) => prev.filter((fp) => fp.hash !== hash))
      setFpStats((prev) => prev ? { learned: prev.learned - 1 } : prev)
    } catch (e) { alert(String(e)) }
  }

  async function handleRefreshRules() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'refreshDashRemoteRules', payload: { url: remoteRulesUrl } })
      alert(`规则已刷新: ${r?.rules ?? 0} 条`)
      void loadRules()
    } catch (e) { alert(String(e)) }
  }

  async function handleAddUserRule() {
    const name = newRuleName.trim()
    const host = newRuleHost.trim()
    const pats = newRulePatterns.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!host || pats.length === 0) {
      alert('域名匹配和广告 URL 模式不能为空')
      return
    }
    try {
      const rule = {
        id: `user-dash-${Date.now()}`,
        name: name || `自定义 (${host})`,
        hostPattern: host,
        adUrlPatterns: pats,
        scoreThreshold: newRuleThreshold,
        forceKeep: [] as string[],
      }
      await chrome.runtime.sendMessage({ type: 'addDashUserRule', payload: { rule } })
      setNewRuleName('')
      setNewRuleHost('')
      setNewRulePatterns('')
      setNewRuleThreshold(3)
      void loadRules()
    } catch (e) { alert(String(e)) }
  }

  async function handleRemoveUserRule(id: string) {
    try {
      await chrome.runtime.sendMessage({ type: 'removeDashUserRule', payload: { id } })
      void loadRules()
    } catch (e) { alert(String(e)) }
  }

  async function handleApproveSuggestion(id: string) {
    try {
      await chrome.runtime.sendMessage({ type: 'approveDashSuggest', payload: { id } })
      void loadSuggestions()
      void loadRules()
    } catch (e) { alert(String(e)) }
  }

  async function handleDismissSuggestion(id: string) {
    try {
      await chrome.runtime.sendMessage({ type: 'dismissDashSuggest', payload: { id } })
      void loadSuggestions()
    } catch (e) { alert(String(e)) }
  }

  async function handleAddSite() {
    const domain = newSite.trim().toLowerCase()
    if (!domain) return
    try {
      const r = await chrome.runtime.sendMessage({ type: 'addDashSite', payload: { domain } })
      if (r) setSiteList((prev) => ({ ...prev, user: (r as { sites: string[] }).sites }))
      setNewSite('')
    } catch (e) { alert(String(e)) }
  }

  async function handleRemoveSite(domain: string) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'removeDashSite', payload: { domain } })
      if (r) setSiteList((prev) => ({ ...prev, user: (r as { sites: string[] }).sites }))
    } catch (e) { alert(String(e)) }
  }

  return (
    <PageLayout title="DASH 广告过滤">

      <nav className="dash-tab-nav">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`dash-tab-btn ${activeTab === tab.id ? 'dash-tab-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="dash-tab-icon">{tab.icon}</span>
            <span className="dash-tab-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      {activeTab === 'general' && (
        <>
          <section className="options-section options-section-highlight">
            <div className="config-global-switch">
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span className="switch-slider" />
              </label>
              <div className="switch-info">
                <span className="switch-label">启用 DASH 广告过滤</span>
                <span className="switch-hint">拦截 DASH manifest（JSON Playurl / MPD XML）中的广告轨/Period，仅在启用站点上生效</span>
              </div>
            </div>
          </section>

          <section className="options-section">
            <h2>检测参数</h2>
            <label>
              评分阈值
              <input
                type="number"
                value={scoreThreshold}
                onChange={(e) => setScoreThreshold(Number(e.target.value))}
                min={0}
                max={10}
              />
            </label>
            <p className="hint-text">信号加权总分 ≥ 阈值时判定为广告。默认 3，越大越保守。</p>
          </section>

          <section className="options-section">
            <h2>过滤行为</h2>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={logToConsole}
                onChange={(e) => setLogToConsole(e.target.checked)}
              />
              控制台日志
            </label>
            <label>
              输出模式
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="manifest-file">manifest-file（替换响应体）</option>
                <option value="data-url">data-url（Data URL 替换）</option>
                <option value="passthrough">passthrough（仅检测不替换）</option>
                <option value="disabled">disabled（完全禁用）</option>
              </select>
            </label>
          </section>

          <section className="options-section">
            <h2>支持的协议</h2>
            <div className="protocol-list">
              <div className="protocol-item">
                <span className="protocol-badge badge-high">高优</span>
                <span>JSON Playurl（B站 playurl / YouTube player API）</span>
              </div>
              <div className="protocol-item">
                <span className="protocol-badge badge-mid">次优</span>
                <span>MPD XML（DASH-IF / IPTV / 自托管 DASH）</span>
              </div>
              <div className="protocol-item">
                <span className="protocol-badge badge-low">兜底</span>
                <span>纯分片（MSE Hook 指纹匹配）</span>
              </div>
            </div>
            <p className="hint-text">
              ⚠️ DRM 保护内容自动跳过（Widevine / PlayReady / FairPlay）
            </p>
            <p className="hint-text">
              ⚠️ 动态 MPD（type="dynamic"）暂不支持，自动 passthrough
            </p>
          </section>
        </>
      )}

      {activeTab === 'fingerprint' && (
        <>
          <section className="options-section">
            <h2>指纹设置</h2>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={enableFingerprint}
                onChange={(e) => setEnableFingerprint(e.target.checked)}
              />
              启用指纹二次过滤
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={autoLearnFingerprints}
                onChange={(e) => setAutoLearnFingerprints(e.target.checked)}
              />
              自动学习新广告指纹
            </label>
            <label>
              指纹模式
              <select value={fingerprintMode} onChange={(e) => setFingerprintMode(e.target.value)}>
                <option value="off">关闭</option>
                <option value="suspicious-only">仅可疑轨</option>
                <option value="all">所有轨</option>
              </select>
            </label>
            <label>
              远程指纹库 URL
              <input
                type="url"
                value={remoteFingerprintsUrl}
                onChange={(e) => setRemoteFingerprintsUrl(e.target.value)}
                placeholder="https://example.com/dash-fingerprints.json"
              />
            </label>
          </section>

          <section className="options-section">
            <div className="section-header-with-action">
              <h2>已学习指纹</h2>
              <span className="hint-text">{fpStats?.learned ?? fpList.length} 条</span>
            </div>
            {fpList.length === 0 ? (
              <p className="hint-text">暂无已学习指纹，启用自动学习后会在检测到广告时自动入库。</p>
            ) : (
              <div className="fp-list">
                {fpList.map((fp) => (
                  <div key={fp.hash} className="fp-item">
                    <span className="fp-hash" title={fp.hash}>{shortHash(fp.hash)}</span>
                    <span className="fp-name">{fp.adName}</span>
                    <span className="fp-source">{fp.source}</span>
                    <span className="fp-time">{fmtTime(fp.firstSeen)}</span>
                    <button
                      className="fp-remove"
                      onClick={() => void handleRemoveFingerprint(fp.hash)}
                      title="删除"
                    >×</button>
                  </div>
                ))}
              </div>
            )}
            <div className="btn-row">
              <button className="btn-danger" onClick={() => void handleClearFingerprints()}>
                🗑️ 清空全部
              </button>
            </div>
          </section>
        </>
      )}

      {activeTab === 'rules' && (
        <>
          {suggestions.length > 0 && (
            <section className="options-section">
              <h2>待审建议 ({suggestions.length})</h2>
              <p className="hint-text">系统自动从检测记录中提取的规则建议，审核后加入自定义规则。</p>
              <div className="suggestion-list">
                {suggestions.map((s) => (
                  <div key={s.id} className="suggestion-item">
                    <div className="suggestion-info">
                      <span className="suggestion-host">{s.hostPattern}</span>
                      <span className="suggestion-patterns">{s.adUrlPatterns.join(', ')}</span>
                    </div>
                    <div className="suggestion-actions">
                      <button className="btn-sm btn-primary" onClick={() => void handleApproveSuggestion(s.id)}>
                        采纳
                      </button>
                      <button className="btn-sm btn-secondary" onClick={() => void handleDismissSuggestion(s.id)}>
                        忽略
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="options-section">
            <h2>自定义规则</h2>
            <label>
              规则名称
              <input
                type="text"
                value={newRuleName}
                onChange={(e) => setNewRuleName(e.target.value)}
                placeholder="可选，如：B站广告轨"
              />
            </label>
            <label>
              域名匹配（正则）
              <input
                type="text"
                value={newRuleHost}
                onChange={(e) => setNewRuleHost(e.target.value)}
                placeholder="如：bilibili\.com"
              />
            </label>
            <label>
              广告 URL 模式（每行一个正则）
              <textarea
                className="textarea-mono"
                value={newRulePatterns}
                onChange={(e) => setNewRulePatterns(e.target.value)}
                placeholder={'/ad/\ndoubleclick\\.com'}
              />
            </label>
            <label>
              评分阈值
              <input
                type="number"
                value={newRuleThreshold}
                onChange={(e) => setNewRuleThreshold(Number(e.target.value))}
                min={0}
                max={10}
              />
            </label>
            <div className="btn-row">
              <button className="btn-primary" onClick={() => void handleAddUserRule()}>
                添加规则
              </button>
            </div>
          </section>

          <section className="options-section">
            <h2>远程规则</h2>
            <label>
              远程规则 URL
              <input
                type="url"
                value={remoteRulesUrl}
                onChange={(e) => setRemoteRulesUrl(e.target.value)}
                placeholder="https://example.com/dash-rules.json"
              />
            </label>
            <div className="btn-row">
              <button className="btn-secondary" onClick={() => void handleRefreshRules()}>
                🔄 刷新远程规则
              </button>
            </div>
          </section>

          <section className="options-section">
            <h2>规则列表</h2>
            {rules.length === 0 ? (
              <p className="hint-text">暂无规则</p>
            ) : (
              <div className="rule-list">
                {rules.map((rule) => (
                  <div key={rule.id} className="rule-item">
                    <div className="rule-header">
                      <span className="rule-name">{rule.name || rule.id}</span>
                      <span className={`rule-source ${rule._builtin ? 'source-builtin' : rule._remote ? 'source-remote' : 'source-user'}`}>
                        {rule._builtin ? '内置' : rule._remote ? '远程' : '自定义'}
                      </span>
                    </div>
                    <div className="rule-detail">
                      {rule.hostPattern && <span>host: {rule.hostPattern}</span>}
                      <span>阈值: {rule.scoreThreshold ?? 3}</span>
                    </div>
                    <div className="rule-patterns">
                      {rule.adUrlPatterns.join(' | ')}
                    </div>
                    {rule._user && (
                      <div className="btn-row" style={{ marginTop: 6 }}>
                        <button className="btn-sm btn-danger" onClick={() => void handleRemoveUserRule(rule.id)}>
                          删除
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {activeTab === 'sites' && (
        <section className="options-section">
          <h2>启用站点</h2>
          <p className="hint-text">
            仅在以下站点上激活 DASH 广告过滤，其他站点不注入 hook（零开销）。
          </p>
          <div className="site-list">
            <h3>内置站点（不可删除）</h3>
            <div className="site-tags">
              {siteList.builtin.map((site) => (
                <span key={site} className="site-tag site-tag-builtin">{site}</span>
              ))}
            </div>
            <h3>自定义站点</h3>
            <div className="site-tags">
              {siteList.user.length === 0 && (
                <span className="hint-text">暂无自定义站点</span>
              )}
              {siteList.user.map((site) => (
                <span key={site} className="site-tag site-tag-user">
                  {site}
                  <button
                    className="site-tag-remove"
                    onClick={() => void handleRemoveSite(site)}
                    title="移除"
                  >×</button>
                </span>
              ))}
            </div>
            <div className="site-add-row">
              <input
                type="text"
                value={newSite}
                onChange={(e) => setNewSite(e.target.value)}
                placeholder="example.com"
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAddSite() }}
              />
              <button className="btn-secondary" onClick={() => void handleAddSite()}>
                添加站点
              </button>
            </div>
            <p className="hint-text">
              输入域名（如 vimeo.com），支持主域名及所有子域名匹配。
            </p>
          </div>
        </section>
      )}

      <div className="options-actions">
        <button className="btn-primary" onClick={() => void handleSave()}>
          {saved ? `✅ ${i18n('options_saved')}` : '保存 DASH 过滤配置'}
        </button>
      </div>
    </PageLayout>
  )
}

const rootEl = document.getElementById('root')!
if (!(rootEl as any)._reactRoot) {
  ;(rootEl as any)._reactRoot = createRoot(rootEl)
}
;(rootEl as any)._reactRoot.render(<DashFilterPage />)