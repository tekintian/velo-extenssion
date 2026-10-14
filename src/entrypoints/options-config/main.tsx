import { createRoot } from 'react-dom/client'
import { useState, useEffect, useCallback } from 'react'
import type { VeloConfig } from '@/types'
import { DEFAULT_CONFIG } from '@/types'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

function ConfigPage() {
  const [config, setConfig] = useState<VeloConfig>({ ...DEFAULT_CONFIG })
  const [saved, setSaved] = useState(false)
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
    mode: string
    urlPatterns: string
    remoteRulesUrl: string
  }>({ enableAdSkip: true, showPageBadge: true, keepDiscontinuityOnGap: true, logToConsole: false, mode: 'm3u8-file', urlPatterns: '', remoteRulesUrl: '' })
  const [advancedSaved, setAdvancedSaved] = useState(false)

  useEffect(() => {
    void loadConfig()
  }, [])

  async function loadConfig() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'velo-get-config' })
      if (resp) setConfig({ ...DEFAULT_CONFIG, ...resp })
    } catch { /* ignore */ }
    try {
      const fp = await chrome.runtime.sendMessage({ type: 'getHlsFingerprintConfig' })
      if (fp) setFpConfig({
        enableFingerprint: fp.enableFingerprint ?? false,
        fingerprintMode: fp.fingerprintMode ?? 'suspicious-only',
        autoLearnFingerprints: fp.autoLearnFingerprints ?? true,
        remoteFingerprintsUrl: fp.remoteFingerprintsUrl ?? '',
      })
    } catch { /* ignore */ }
    try {
      const full = await chrome.runtime.sendMessage({ type: 'getHlsFullConfig' })
      if (full) setFullConfig({
        enableAdSkip: full.enableAdSkip ?? true,
        showPageBadge: full.showPageBadge ?? true,
        keepDiscontinuityOnGap: full.keepDiscontinuityOnGap ?? true,
        logToConsole: full.logToConsole ?? false,
        mode: full.mode ?? 'm3u8-file',
        urlPatterns: Array.isArray(full.urlPatterns) ? full.urlPatterns.join('\n') : '',
        remoteRulesUrl: full.remoteRulesUrl ?? '',
      })
    } catch { /* ignore */ }
  }

  const handleSave = useCallback(async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'velo-save-config', config })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch { /* ignore */ }
  }, [config])

  const update = useCallback(<K extends keyof VeloConfig>(key: K, value: VeloConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }, [])

  return (
    <PageLayout title={i18n('options_nav_config')}>
      <section className="options-section">
        <h2>{i18n('options_pairing_title')}</h2>
        <label>
          {i18n('options_port_label')}
          <input
            type="number"
            value={config.port}
            onChange={(e) => update('port', Number(e.target.value))}
            min={1024}
            max={65535}
          />
        </label>
        <label>
          {i18n('options_token_label')}
          <input
            type="text"
            value={config.token}
            onChange={(e) => update('token', e.target.value)}
            placeholder="Token"
          />
        </label>
      </section>

      <section className="options-section">
        <h2>{i18n('options_push_title')}</h2>
        <label>
          {i18n('options_merge_format_label')}
          <select value={config.mergeFormat} onChange={(e) => update('mergeFormat', e.target.value as VeloConfig['mergeFormat'])}>
            <option value="ts">TS</option>
            <option value="mp4">MP4</option>
            <option value="mkv">MKV</option>
            <option value="keep">Keep Original</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.autoPush}
            onChange={(e) => update('autoPush', e.target.checked)}
          />
          {i18n('options_auto_push_label')}
        </label>
      </section>

      <section className="options-section">
        <h2>{i18n('options_filter_title')}</h2>
        <label>
          {i18n('options_threshold_label')}
          <input
            type="number"
            value={config.scoreThreshold}
            onChange={(e) => update('scoreThreshold', Number(e.target.value))}
            min={0}
            max={10}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.enableFilter}
            onChange={(e) => update('enableFilter', e.target.checked)}
          />
          {i18n('options_enable_filter_label')}
        </label>
      </section>

      <section className="options-section">
        <h2>{i18n('options_advanced_config_title')}</h2>

        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '13px', marginBottom: '8px' }}>{i18n('options_fingerprint_title')}</h3>
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
          <label style={{ display: 'block', marginTop: '8px' }}>
            {i18n('options_fingerprint_mode')}
            <select
              value={fpConfig.fingerprintMode}
              onChange={(e) => setFpConfig({ ...fpConfig, fingerprintMode: e.target.value })}
              style={{ marginLeft: '8px' }}
            >
              <option value="off">{i18n('options_fp_mode_off')}</option>
              <option value="suspicious-only">{i18n('options_fp_mode_suspicious')}</option>
              <option value="all">{i18n('options_fp_mode_all')}</option>
            </select>
          </label>
          <label style={{ display: 'block', marginTop: '8px' }}>
            {i18n('options_remote_fp_url')}
            <input
              type="url"
              value={fpConfig.remoteFingerprintsUrl}
              onChange={(e) => setFpConfig({ ...fpConfig, remoteFingerprintsUrl: e.target.value })}
              placeholder="https://example.com/fingerprints.json"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
          <button
            className="btn-secondary"
            style={{ marginTop: '8px' }}
            onClick={async () => {
              try {
                await chrome.runtime.sendMessage({
                  type: 'setHlsFingerprintConfig',
                  payload: {
                    ...fpConfig,
                    enableFingerprint: true,
                    fingerprintMode: 'all',
                    autoLearnFingerprints: true,
                  },
                })
                setFpConfig({ ...fpConfig, enableFingerprint: true, fingerprintMode: 'all', autoLearnFingerprints: true })
                const r = await chrome.runtime.sendMessage({ type: 'getHlsFingerprintConfig' })
                alert(i18n('options_boost_result', [String(r?.learnedCount ?? 0)]))
              } catch (e) { alert(String(e)) }
            }}
          >
            🚀 {i18n('options_boost_detect')}
          </button>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '13px', marginBottom: '8px' }}>{i18n('options_filter_behavior_title')}</h3>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fullConfig.enableAdSkip}
              onChange={(e) => setFullConfig({ ...fullConfig, enableAdSkip: e.target.checked })}
            />
            {i18n('options_enable_ad_skip')}
          </label>
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
          <label style={{ display: 'block', marginTop: '8px' }}>
            {i18n('options_output_mode')}
            <select
              value={fullConfig.mode}
              onChange={(e) => setFullConfig({ ...fullConfig, mode: e.target.value })}
              style={{ marginLeft: '8px' }}
            >
              <option value="m3u8-file">{i18n('options_mode_m3u8_file')}</option>
              <option value="data-url">{i18n('options_mode_data_url')}</option>
              <option value="passthrough">{i18n('options_mode_passthrough')}</option>
              <option value="disabled">{i18n('options_mode_disabled')}</option>
            </select>
          </label>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '13px', marginBottom: '8px' }}>{i18n('options_custom_rules_title')}</h3>
          <label style={{ display: 'block' }}>
            {i18n('options_url_patterns')}
            <textarea
              value={fullConfig.urlPatterns}
              onChange={(e) => setFullConfig({ ...fullConfig, urlPatterns: e.target.value })}
              placeholder={'/ads?/\ndoubleclick\\.com'}
              style={{ width: '100%', minHeight: '60px', marginTop: '4px', fontFamily: 'monospace', fontSize: '12px' }}
            />
          </label>
          <label style={{ display: 'block', marginTop: '8px' }}>
            {i18n('options_remote_rules_url')}
            <input
              type="url"
              value={fullConfig.remoteRulesUrl}
              onChange={(e) => setFullConfig({ ...fullConfig, remoteRulesUrl: e.target.value })}
              placeholder="https://example.com/velo-rules.json"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
        </div>

        <button
          className="btn-primary"
          style={{ marginTop: '8px' }}
          onClick={async () => {
            try {
              await chrome.runtime.sendMessage({ type: 'setHlsFingerprintConfig', payload: fpConfig })
              await chrome.runtime.sendMessage({
                type: 'setHlsFullConfig',
                payload: {
                  ...fullConfig,
                  urlPatterns: fullConfig.urlPatterns.split('\n').filter(Boolean),
                },
              })
              setAdvancedSaved(true)
              setTimeout(() => setAdvancedSaved(false), 2000)
            } catch (e) { alert(i18n('options_save_failed') + ': ' + (e as Error).message) }
          }}
        >
          {i18n('options_save_advanced_config')}
        </button>
        {advancedSaved && <span className="save-indicator">✅ {i18n('options_saved')}</span>}
      </section>

      <div className="options-actions">
        <button className="btn-primary" onClick={handleSave}>
          {i18n('options_save_config')}
        </button>
        {saved && <span className="save-indicator">✅ {i18n('options_saved')}</span>}
      </div>
    </PageLayout>
  )
}

createRoot(document.getElementById('root')!).render(<ConfigPage />)