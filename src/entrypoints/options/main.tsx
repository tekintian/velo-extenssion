import { createRoot } from 'react-dom/client'
import { useState, useEffect, useCallback } from 'react'
import type { SdownConfig } from '@/types'
import { DEFAULT_CONFIG } from '@/types'
import '@/assets/options.css'

function Options() {
  const [config, setConfig] = useState<SdownConfig>({ ...DEFAULT_CONFIG })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void loadConfig()
  }, [])

  async function loadConfig() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'sdown-get-config' })
      if (resp) setConfig({ ...DEFAULT_CONFIG, ...resp })
    } catch { /* ignore */ }
  }

  const handleSave = useCallback(async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'sdown-save-config', config })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch { /* ignore */ }
  }, [config])

  const update = useCallback(<K extends keyof SdownConfig>(key: K, value: SdownConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }, [])

  return (
    <div className="options-container">
      <h1>{chrome.i18n.getMessage('options_title')}</h1>

      <section className="options-section">
        <h2>{chrome.i18n.getMessage('options_pairing_title')}</h2>
        <label>
          {chrome.i18n.getMessage('options_port_label')}
          <input
            type="number"
            value={config.port}
            onChange={(e) => update('port', Number(e.target.value))}
            min={1024}
            max={65535}
          />
        </label>
        <label>
          {chrome.i18n.getMessage('options_token_label')}
          <input
            type="text"
            value={config.token}
            onChange={(e) => update('token', e.target.value)}
            placeholder="Token"
          />
        </label>
      </section>

      <section className="options-section">
        <h2>{chrome.i18n.getMessage('options_push_title')}</h2>
        <label>
          {chrome.i18n.getMessage('options_push_channel_label')}
          <select value={config.pushChannel} onChange={(e) => update('pushChannel', e.target.value as SdownConfig['pushChannel'])}>
            <option value="ws">WebSocket</option>
            <option value="http">HTTP</option>
            <option value="deep-link">Deep Link</option>
          </select>
        </label>
        <label>
          {chrome.i18n.getMessage('options_merge_format_label')}
          <select value={config.mergeFormat} onChange={(e) => update('mergeFormat', e.target.value as SdownConfig['mergeFormat'])}>
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
          {chrome.i18n.getMessage('options_auto_push_label')}
        </label>
      </section>

      <section className="options-section">
        <h2>{chrome.i18n.getMessage('options_filter_title')}</h2>
        <label>
          {chrome.i18n.getMessage('options_threshold_label')}
          <input
            type="number"
            value={config.scoreThreshold}
            onChange={(e) => update('scoreThreshold', Number(e.target.value))}
            min={1}
            max={10}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.enableFilter}
            onChange={(e) => update('enableFilter', e.target.checked)}
          />
          {chrome.i18n.getMessage('options_enable_filter_label')}
        </label>
      </section>

      <div className="options-actions">
        <button className="btn-primary" onClick={handleSave}>
          {chrome.i18n.getMessage('options_save_config')}
        </button>
        {saved && <span className="save-indicator">✅ 已保存</span>}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Options />)
