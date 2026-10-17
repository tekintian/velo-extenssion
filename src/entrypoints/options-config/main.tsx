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
  const [fullConfig, setFullConfig] = useState<{
    enableAdSkip: boolean
  }>({ enableAdSkip: true })

  useEffect(() => {
    void loadConfig()
  }, [])

  async function loadConfig() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'velo-get-config' })
      if (resp) setConfig({ ...DEFAULT_CONFIG, ...resp })
    } catch { /* ignore */ }
    try {
      const full = await chrome.runtime.sendMessage({ type: 'getHlsFullConfig' })
      if (full) setFullConfig({
        enableAdSkip: full.enableAdSkip ?? true,
      })
    } catch { /* ignore */ }
  }

  const handleSave = useCallback(async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'velo-save-config', config })
      await chrome.runtime.sendMessage({
        type: 'setHlsFullConfig',
        payload: { enableAdSkip: fullConfig.enableAdSkip },
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch { /* ignore */ }
  }, [config, fullConfig.enableAdSkip])

  const update = useCallback(<K extends keyof VeloConfig>(key: K, value: VeloConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }, [])

  return (
    <PageLayout title={i18n('options_nav_config')}>
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