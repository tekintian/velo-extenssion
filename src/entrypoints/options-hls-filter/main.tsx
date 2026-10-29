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

function fmtDur(sec: number): string {
  const s = Math.round(sec || 0)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}m${r ? `${r}s` : ''}`
}

function HlsFilterPage() {
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
    mode: string
  }>({ enableAdSkip: true, showPageBadge: true, keepDiscontinuityOnGap: true, logToConsole: false, scoreThreshold: 3, mode: 'm3u8-file' })

  const [saved, setSaved] = useState(false)
  const [stats, setStats] = useState<HlsStats | null>(null)

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
      mode?: string
    }>('getHlsFullConfig')
    if (full) {
      setFullConfig({
        enableAdSkip: full.enableAdSkip ?? true,
        showPageBadge: full.showPageBadge ?? true,
        keepDiscontinuityOnGap: full.keepDiscontinuityOnGap ?? true,
        logToConsole: full.logToConsole ?? false,
        scoreThreshold: full.scoreThreshold ?? 3,
        mode: full.mode ?? 'm3u8-file',
      })
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
    const b = await request('setHlsFullConfig', {
      enableAdSkip: fullConfig.enableAdSkip,
      showPageBadge: fullConfig.showPageBadge,
      keepDiscontinuityOnGap: fullConfig.keepDiscontinuityOnGap,
      logToConsole: fullConfig.logToConsole,
      scoreThreshold: fullConfig.scoreThreshold,
      mode: fullConfig.mode,
    })
    if (!a || !b) {
      alert(i18n('options_save_failed'))
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleClearStats() {
    if (!confirm(i18n('options_confirm_clear_stats') ?? '确定清除所有统计数据？')) return
    const r = await request('clearHlsStats')
    if (r) setStats(null)
  }

  return (
    <PageLayout title={i18n('options_nav_hls_filter')}>
      {/* 统计概览 — 精简展示，详情见统计页面 */}
      {stats && stats.total.reports > 0 && (
        <section className="options-section">
          <div className="stat-block">
            <h3 className="stat-block-title">{i18n('options_stats_summary_title')}</h3>
            <div className="report-grid">
              <span className="report-label">{i18n('options_stats_total_ads')}</span>
              <span><b className="stat-num">{stats.total.ads}</b> {i18n('options_stats_unit_ads')}</span>
              <span className="report-label">{i18n('options_stats_total_ad_duration')}</span>
              <span><b className="stat-num">{fmtDur(stats.total.adDuration)}</b></span>
              <span className="report-label">{i18n('options_stats_total_content_duration')}</span>
              <span>{fmtDur(stats.total.contentDuration)}</span>
              <span className="report-label">{i18n('options_stats_total_detections')}</span>
              <span>{stats.total.reports}</span>
            </div>
            <div className="btn-row stat-actions" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #eee' }}>
              <a href="/options-stats.html" className="btn-sm btn-secondary">
                {i18n('options_view_full_stats') ?? '查看详细统计'}
              </a>
              <button className="btn-sm btn-danger" onClick={() => void handleClearStats()}>
                {i18n('options_clear_stats')}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* 核心开关 */}
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
      </section>

      {/* 评分阈值 */}
      <section className="options-section">
        <h2>{i18n('options_filter_title')}</h2>
        <label>
          {i18n('options_threshold_label')}
          <input
            type="number"
            value={fullConfig.scoreThreshold}
            onChange={(e) => setFullConfig({ ...fullConfig, scoreThreshold: Number(e.target.value) })}
            min={0}
            max={10}
          />
        </label>
      </section>

      {/* 过滤行为 */}
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
        <label>
          {i18n('options_output_mode')}
          <select
            value={fullConfig.mode}
            onChange={(e) => setFullConfig({ ...fullConfig, mode: e.target.value })}
          >
            <option value="m3u8-file">{i18n('options_mode_m3u8_file')}</option>
            <option value="data-url">{i18n('options_mode_data_url')}</option>
            <option value="enumerate">{i18n('options_mode_enumerate')}</option>
            <option value="passthrough">{i18n('options_mode_passthrough')}</option>
            <option value="disabled">{i18n('options_mode_disabled')}</option>
          </select>
        </label>
      </section>

      {/* 指纹库 */}
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
              if (!confirm(i18n('options_confirm_clear_fingerprints') ?? '确定清空所有已学习的指纹？')) return
              const r = await request('clearHlsFingerprints')
              if (!r) return
              alert(i18n('options_clear_fingerprints_ok') ?? '指纹库已清空')
            }}
          >
            🗑️ {i18n('options_clear_fingerprints') ?? '清空学习库'}
          </button>
        </div>
      </section>

      <div className="options-actions">
        <button className="btn-primary" onClick={() => void handleSave()}>
          {saved ? `✅ ${i18n('options_saved')}` : i18n('options_save_hls_filter_config')}
        </button>
      </div>
    </PageLayout>
  )
}

mountReact('root', <HlsFilterPage />)