import { mountReact } from '@/lib/mount'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import { request } from '@/lib/messaging'
import '@/assets/options.css'

interface HlsStats {
  total: { ads: number; adDuration: number; contentDuration: number; reports: number }
  byHost: Record<string, { ads: number; adDuration: number; reports: number; lastSeen: number }>
  byRule: Record<string, { ads: number; reports: number }>
  recent: Array<{ host: string; ads: number; adDuration: number; rule: string | null; ts: number }>
}

type TabId = 'general' | 'fingerprint' | 'sites' | 'disabled'

const TABS: { id: TabId; labelKey: string; icon: string }[] = [
  { id: 'general', labelKey: 'options_hls_tab_general', icon: '⚙️' },
  { id: 'fingerprint', labelKey: 'options_hls_tab_fingerprint', icon: '🔍' },
  { id: 'sites', labelKey: 'options_hls_tab_sites', icon: '🌐' },
  { id: 'disabled', labelKey: 'options_hls_tab_disabled', icon: '🚫' },
]

function fmtDur(sec: number): string {
  const s = Math.round(sec || 0)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}m${r ? `${r}s` : ''}`
}

function HlsFilterPage() {
  const [activeTab, setActiveTab] = useState<TabId>('general')

  const [fpConfig, setFpConfig] = useState<{
    enableFingerprint: boolean
    fingerprintMode: string
    autoLearnFingerprints: boolean
    remoteFingerprintsUrl: string
  }>({ enableFingerprint: false, fingerprintMode: 'suspicious-only', autoLearnFingerprints: true, remoteFingerprintsUrl: '' })

  const [fullConfig, setFullConfig] = useState<{
    enableAdSkip: boolean
    showPageBadge: boolean
    keepDiscontinuityOnGap: boolean
    logToConsole: boolean
    scoreThreshold: number
  }>({ enableAdSkip: true, showPageBadge: true, keepDiscontinuityOnGap: true, logToConsole: false, scoreThreshold: 3 })

  const [saved, setSaved] = useState(false)
  const [stats, setStats] = useState<HlsStats | null>(null)

  const [runMode, setRunMode] = useState<'smart' | 'manual'>('smart')
  const [learnedSites, setLearnedSites] = useState<string[]>([])
  const [enabledSites, setEnabledSites] = useState<string[]>([])
  const [disabledSites, setDisabledSites] = useState<string[]>([])
  const [newSiteInput, setNewSiteInput] = useState('')
  const [newDisabledInput, setNewDisabledInput] = useState('')

  useEffect(() => {
    void loadConfig()
    void loadStats()
  }, [])

  async function loadConfig() {
    const fp = await request<{
      enableFingerprint?: boolean
      fingerprintMode?: string
      autoLearnFingerprints?: boolean
      remoteFingerprintsUrl?: string
    }>('getHlsFingerprintConfig')
    if (fp) {
      setFpConfig({
        enableFingerprint: fp.enableFingerprint ?? false,
        fingerprintMode: fp.fingerprintMode ?? 'suspicious-only',
        autoLearnFingerprints: fp.autoLearnFingerprints ?? true,
        remoteFingerprintsUrl: fp.remoteFingerprintsUrl ?? '',
      })
    }

    const full = await request<{
      enableAdSkip?: boolean
      showPageBadge?: boolean
      keepDiscontinuityOnGap?: boolean
      logToConsole?: boolean
      scoreThreshold?: number
    }>('getHlsFullConfig')
    if (full) {
      setFullConfig({
        enableAdSkip: full.enableAdSkip ?? true,
        showPageBadge: full.showPageBadge ?? true,
        keepDiscontinuityOnGap: full.keepDiscontinuityOnGap ?? true,
        logToConsole: full.logToConsole ?? false,
        scoreThreshold: full.scoreThreshold ?? 3,
      })
    }

    const siteMode = await request<{ runMode: 'smart' | 'manual'; learnedSites: string[]; enabledSites: string[]; disabledSites: string[] }>('hlsGetRunMode')
    if (siteMode) {
      setRunMode(siteMode.runMode)
      setLearnedSites(siteMode.learnedSites ?? [])
      setEnabledSites(siteMode.enabledSites ?? [])
      setDisabledSites(siteMode.disabledSites ?? [])
    }
  }

  async function loadStats() {
    const r = await request<Partial<HlsStats>>('getHlsStats')
    if (!r?.total) return
    setStats({
      total: r.total,
      byHost: r.byHost ?? {},
      byRule: r.byRule ?? {},
      recent: Array.isArray(r.recent) ? r.recent : [],
    })
  }

  async function handleSave() {
    const a = await request('setHlsFingerprintConfig', fpConfig)
    const b = await request('setHlsFullConfig', fullConfig)
    if (!a || !b) {
      alert(i18n('options_save_failed'))
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleRunModeChange(mode: 'smart' | 'manual') {
    setRunMode(mode)
    await request('hlsSetRunMode', { runMode: mode })
  }

  async function handleAddSite(list: 'enabled' | 'disabled' | 'learned') {
    const domain = newSiteInput.trim().toLowerCase()
    if (!domain) return
    const r = await request<{ sites?: string[] }>('hlsAddSite', { site: domain, list })
    if (r?.sites) {
      if (list === 'enabled') setEnabledSites(r.sites)
      else if (list === 'disabled') setDisabledSites(r.sites)
      else setLearnedSites(r.sites)
      setNewSiteInput('')
    }
  }

  async function handleAddDisabled() {
    const domain = newDisabledInput.trim().toLowerCase()
    if (!domain) return
    const r = await request<{ sites?: string[] }>('hlsAddSite', { site: domain, list: 'disabled' })
    if (r?.sites) {
      setDisabledSites(r.sites)
      setNewDisabledInput('')
    }
  }

  async function handleRemoveSite(site: string, list: 'enabled' | 'disabled' | 'learned') {
    const r = await request<{ sites?: string[] }>('hlsRemoveSite', { site, list })
    if (r?.sites) {
      if (list === 'enabled') setEnabledSites(r.sites)
      else if (list === 'disabled') setDisabledSites(r.sites)
      else setLearnedSites(r.sites)
    }
  }

  async function handleSupplementSeeds() {
    const r = await request<{ added?: number }>('hlsSupplementSeeds', { runMode })
    if (r) {
      const siteMode = await request<{ learnedSites: string[]; enabledSites: string[] }>('hlsGetRunMode')
      if (siteMode) {
        setLearnedSites(siteMode.learnedSites ?? [])
        setEnabledSites(siteMode.enabledSites ?? [])
      }
      alert(i18n('options_seeds_supplemented', [String(r.added ?? 0)]))
    }
  }

  const activeSites = runMode === 'smart' ? learnedSites : enabledSites

  return (
    <PageLayout title={i18n('options_nav_hls_filter')}>

      {stats && stats.total.reports > 0 && (
        <section className="options-section" style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="stat-num" style={{ fontSize: 16 }}>{stats.total.ads}</span>
              <span className="hint-text">{i18n('options_stats_total_ads')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="stat-num" style={{ fontSize: 16 }}>{fmtDur(stats.total.adDuration)}</span>
              <span className="hint-text">{i18n('options_stats_total_ad_duration')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="stat-num" style={{ fontSize: 16 }}>{stats.total.reports}</span>
              <span className="hint-text">{i18n('options_stats_total_detections')}</span>
            </div>
            <a
              href="/options-stats.html"
              title={i18n('options_view_full_stats')}
              aria-label={i18n('options_view_full_stats')}
              style={{ marginLeft: 'auto', color: '#1976d2', fontSize: 16, textDecoration: 'none', lineHeight: 1 }}
            >
              📊
            </a>
          </div>
        </section>
      )}

      <nav className="dash-tab-nav">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`dash-tab-btn ${activeTab === tab.id ? 'dash-tab-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="dash-tab-icon">{tab.icon}</span>
            <span className="dash-tab-label">{i18n(tab.labelKey)}</span>
          </button>
        ))}
      </nav>

      {activeTab === 'general' && (
        <>
          <section className="options-section">
            <h2>{i18n('options_hls_run_mode_title')}</h2>
            <p className="hint-text">{i18n('options_hls_run_mode_desc')}</p>

            <div className="btn-row" style={{ marginBottom: 16 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', border: runMode === 'smart' ? '2px solid #1976d2' : '1px solid #ccc', borderRadius: 6, cursor: 'pointer', background: runMode === 'smart' ? '#e3f2fd' : 'transparent' }}>
                <input
                  type="radio"
                  name="hlsRunMode"
                  checked={runMode === 'smart'}
                  onChange={() => void handleRunModeChange('smart')}
                />
                <strong>{i18n('options_hls_mode_smart')}</strong>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', border: runMode === 'manual' ? '2px solid #1976d2' : '1px solid #ccc', borderRadius: 6, cursor: 'pointer', background: runMode === 'manual' ? '#e3f2fd' : 'transparent' }}>
                <input
                  type="radio"
                  name="hlsRunMode"
                  checked={runMode === 'manual'}
                  onChange={() => void handleRunModeChange('manual')}
                />
                <strong>{i18n('options_hls_mode_manual')}</strong>
              </label>
            </div>
          </section>

          <section className="options-section options-section-highlight">
            <div className="config-global-switch">
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={fullConfig.enableAdSkip}
                  onChange={(e) => setFullConfig({ ...fullConfig, enableAdSkip: e.target.checked })}
                />
                <span className="switch-slider" />
              </label>
              <div className="switch-info">
                <span className="switch-label">{i18n('options_enable_ad_skip')}</span>
                <span className="switch-hint">{i18n('options_enable_filter_label')}</span>
              </div>
            </div>

            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #eee' }}>
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{i18n('options_threshold_label')}：</span>
                <input
                  type="number"
                  value={fullConfig.scoreThreshold}
                  onChange={(e) => setFullConfig({ ...fullConfig, scoreThreshold: Number(e.target.value) })}
                  min={0}
                  max={10}
                  style={{ width: 72, flex: '0 0 auto', padding: '6px 8px', border: '1px solid #ccc', borderRadius: 4 }}
                />
                <span className="switch-hint">{i18n('options_threshold_desc')}</span>
              </label>
            </div>
          </section>

          <section className="options-section">
            <h2>{i18n('options_filter_behavior_title')}</h2>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={fullConfig.showPageBadge}
                onChange={(e) => setFullConfig({ ...fullConfig, showPageBadge: e.target.checked })}
              />
              {i18n('options_show_page_badge')}
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={fullConfig.keepDiscontinuityOnGap}
                onChange={(e) => setFullConfig({ ...fullConfig, keepDiscontinuityOnGap: e.target.checked })}
              />
              {i18n('options_keep_discontinuity')}
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={fullConfig.logToConsole}
                onChange={(e) => setFullConfig({ ...fullConfig, logToConsole: e.target.checked })}
              />
              {i18n('options_log_to_console')}
            </label>
          </section>
        </>
      )}

      {activeTab === 'fingerprint' && (
        <section className="options-section">
          <h2>{i18n('options_fingerprint_title')}</h2>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fpConfig.enableFingerprint}
              onChange={(e) => setFpConfig({ ...fpConfig, enableFingerprint: e.target.checked })}
            />
            {i18n('options_enable_fingerprint')}
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fpConfig.autoLearnFingerprints}
              onChange={(e) => setFpConfig({ ...fpConfig, autoLearnFingerprints: e.target.checked })}
            />
            {i18n('options_auto_learn_fingerprint')}
          </label>
          <label>
            {i18n('options_fingerprint_mode')}
            <select
              value={fpConfig.fingerprintMode}
              onChange={(e) => setFpConfig({ ...fpConfig, fingerprintMode: e.target.value })}
            >
              <option value="off">{i18n('options_fp_mode_off')}</option>
              <option value="suspicious-only">{i18n('options_fp_mode_suspicious')}</option>
              <option value="all">{i18n('options_fp_mode_all')}</option>
            </select>
          </label>
          <label>
            {i18n('options_remote_fp_url')}
            <input
              type="url"
              value={fpConfig.remoteFingerprintsUrl}
              onChange={(e) => setFpConfig({ ...fpConfig, remoteFingerprintsUrl: e.target.value })}
              placeholder="https://example.com/fingerprints.json"
            />
          </label>
          <div className="btn-row">
            <button
              className="btn-secondary"
              onClick={async () => {
                const a = await request('setHlsFingerprintConfig', {
                  ...fpConfig,
                  enableFingerprint: true,
                  fingerprintMode: 'all',
                  autoLearnFingerprints: true,
                })
                if (!a) {
                  alert(i18n('options_save_failed'))
                  return
                }
                setFpConfig({ ...fpConfig, enableFingerprint: true, fingerprintMode: 'all', autoLearnFingerprints: true })
                const r = await request<{ learnedCount?: number }>('getHlsFingerprintConfig')
                alert(i18n('options_boost_result', [String(r?.learnedCount ?? 0)]))
              }}
            >
              🚀 {i18n('options_boost_detect')}
            </button>
            <button
              className="btn-danger"
              onClick={async () => {
                if (!confirm(i18n('options_confirm_clear_fingerprints'))) return
                const r = await request('clearHlsFingerprints')
                if (!r) return
                alert(i18n('options_clear_fingerprints_ok'))
              }}
            >
              🗑️ {i18n('options_clear_fingerprints')}
            </button>
          </div>
        </section>
      )}

      {activeTab === 'sites' && (
        <section className="options-section">
          <h2>
            {runMode === 'smart'
              ? `${i18n('options_hls_learned_sites')} (${activeSites.length})`
              : `${i18n('options_hls_enabled_sites')} (${activeSites.length})`}
          </h2>
          <p className="hint-text">
            {runMode === 'smart'
              ? i18n('options_hls_smart_desc')
              : i18n('options_hls_manual_desc')}
          </p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              value={newSiteInput}
              onChange={(e) => setNewSiteInput(e.target.value)}
              placeholder="example.com"
              style={{ flex: 1, padding: '6px 10px', border: '1px solid #ccc', borderRadius: 4 }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAddSite(runMode === 'smart' ? 'learned' : 'enabled') }}
            />
            <button className="btn-sm btn-primary" onClick={() => void handleAddSite(runMode === 'smart' ? 'learned' : 'enabled')}>
              + {i18n('options_add')}
            </button>
          </div>

          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6 }}>
            {activeSites.length === 0 ? (
              <p style={{ color: '#999', margin: 16, textAlign: 'center' }}>{i18n('options_hls_no_sites')}</p>
            ) : (
              activeSites.map((site) => (
                <div key={site} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ fontSize: 13, fontFamily: 'monospace' }}>{site}</span>
                  <button
                    className="btn-sm btn-danger"
                    style={{ padding: '2px 8px' }}
                    onClick={() => void handleRemoveSite(site, runMode === 'smart' ? 'learned' : 'enabled')}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>

          <p className="hint-text" style={{ marginTop: 8 }}>
            {i18n('options_hls_domain_hint')}
          </p>

          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn-secondary" onClick={() => void handleSupplementSeeds()}>
              🌱 {i18n('options_hls_seeds_supplement')}
            </button>
          </div>
        </section>
      )}

      {activeTab === 'disabled' && (
        <section className="options-section">
          <h2>🚫 {i18n('options_hls_disabled_sites')} ({disabledSites.length})</h2>
          <p className="hint-text">
            {i18n('options_hls_disabled_desc')}
          </p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              value={newDisabledInput}
              onChange={(e) => setNewDisabledInput(e.target.value)}
              placeholder="blocked-site.com"
              style={{ flex: 1, padding: '6px 10px', border: '1px solid #ccc', borderRadius: 4 }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAddDisabled() }}
            />
            <button className="btn-sm btn-primary" onClick={() => void handleAddDisabled()}>
              + {i18n('options_add')}
            </button>
          </div>

          <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6 }}>
            {disabledSites.length === 0 ? (
              <p style={{ color: '#999', margin: 16, textAlign: 'center' }}>{i18n('options_hls_no_disabled')}</p>
            ) : (
              disabledSites.map((site) => (
                <div key={site} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ fontSize: 13, fontFamily: 'monospace' }}>{site}</span>
                  <button
                    className="btn-sm btn-danger"
                    style={{ padding: '2px 8px' }}
                    onClick={() => void handleRemoveSite(site, 'disabled')}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      <div className="options-actions">
        <button className="btn-primary" onClick={() => void handleSave()}>
          {saved ? `✅ ${i18n('options_saved')}` : i18n('options_save_hls_filter_config')}
        </button>
      </div>
    </PageLayout>
  )
}

mountReact('root', <HlsFilterPage />)