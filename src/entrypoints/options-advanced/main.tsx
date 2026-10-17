import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

function AdvancedPage() {
  const [fpConfig, setFpConfig] = useState<{
    enableFingerprint: boolean
    fingerprintMode: string
    autoLearnFingerprints: boolean
    remoteFingerprintsUrl: string
  }>({ enableFingerprint: false, fingerprintMode: 'suspicious-only', autoLearnFingerprints: true, remoteFingerprintsUrl: '' })
  const [fullConfig, setFullConfig] = useState<{
    showPageBadge: boolean
    keepDiscontinuityOnGap: boolean
    logToConsole: boolean
    mode: string
    urlPatterns: string
    remoteRulesUrl: string
  }>({ showPageBadge: true, keepDiscontinuityOnGap: true, logToConsole: false, mode: 'm3u8-file', urlPatterns: '', remoteRulesUrl: '' })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void loadConfig()
  }, [])

  async function loadConfig() {
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
        showPageBadge: full.showPageBadge ?? true,
        keepDiscontinuityOnGap: full.keepDiscontinuityOnGap ?? true,
        logToConsole: full.logToConsole ?? false,
        mode: full.mode ?? 'm3u8-file',
        urlPatterns: Array.isArray(full.urlPatterns) ? full.urlPatterns.join('\n') : '',
        remoteRulesUrl: full.remoteRulesUrl ?? '',
      })
    } catch { /* ignore */ }
  }

  async function handleSave() {
    try {
      await chrome.runtime.sendMessage({ type: 'setHlsFingerprintConfig', payload: fpConfig })
      await chrome.runtime.sendMessage({
        type: 'setHlsFullConfig',
        payload: {
          ...fullConfig,
          urlPatterns: fullConfig.urlPatterns.split('\n').filter(Boolean),
        },
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      alert(i18n('options_save_failed') + ': ' + (e as Error).message)
    }
  }

  return (
    <PageLayout title={i18n('options_nav_advanced')}>
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
        <button
          className="btn-secondary"
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

      <section className="options-section">
        <h2>{i18n('options_custom_rules_title')}</h2>
        <label>
          {i18n('options_url_patterns')}
          <textarea
            className="textarea-mono"
            value={fullConfig.urlPatterns}
            onChange={(e) => setFullConfig({ ...fullConfig, urlPatterns: e.target.value })}
            placeholder={'/ads?/\ndoubleclick\\.com'}
          />
        </label>
        <label>
          {i18n('options_remote_rules_url')}
          <input
            type="url"
            value={fullConfig.remoteRulesUrl}
            onChange={(e) => setFullConfig({ ...fullConfig, remoteRulesUrl: e.target.value })}
            placeholder="https://example.com/velo-rules.json"
          />
        </label>
      </section>

      <div className="options-actions">
        <button className="btn-primary" onClick={() => void handleSave()}>
          {saved ? `✅ ${i18n('options_saved')}` : i18n('options_save_advanced_config')}
        </button>
      </div>
    </PageLayout>
  )
}

createRoot(document.getElementById('root')!).render(<AdvancedPage />)