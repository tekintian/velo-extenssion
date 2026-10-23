import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

function GeneralPage() {
  const [enabled, setEnabled] = useState(true)
  const [hlsEnabled, setHlsEnabled] = useState(true)
  const [language, setLanguage] = useState('zh_CN')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void loadConfig()
  }, [])

  async function loadConfig() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'getExtensionEnabled' }) as { enabled?: boolean }
      if (r) setEnabled(r.enabled ?? true)
    } catch { /* ignore */ }
    try {
      const full = await chrome.runtime.sendMessage({ type: 'getHlsFullConfig' })
      if (full) setHlsEnabled(full.enableAdSkip ?? true)
    } catch { /* ignore */ }
    try {
      const stored = await chrome.storage.local.get('language')
      if (stored.language) setLanguage(String(stored.language))
    } catch { /* ignore */ }
  }

  async function handleSave() {
    try {
      await chrome.runtime.sendMessage({ type: 'setExtensionEnabled', payload: { enabled } })
      await chrome.runtime.sendMessage({
        type: 'setHlsFullConfig',
        payload: { enableAdSkip: hlsEnabled },
      })
      await chrome.storage.local.set({ language })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      alert(i18n('options_save_failed') + ': ' + (e as Error).message)
    }
  }

  return (
    <PageLayout title={i18n('options_nav_config')}>
      {/* 扩展总开关 */}
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
            <span className="switch-label">{i18n('options_extension_enabled') ?? '扩展总开关'}</span>
            <span className="switch-hint">{i18n('options_extension_enabled_desc') ?? '关闭后将暂停所有嗅探、过滤和推送功能'}</span>
          </div>
        </div>
      </section>

      {/* 语言设置 */}
      <section className="options-section">
        <h2>{i18n('options_language_title') ?? '语言设置'}</h2>
        <label>
          {i18n('options_language_label') ?? '界面语言'}
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="zh_CN">简体中文</option>
            <option value="en_US">English</option>
          </select>
        </label>
      </section>

      {/* HLS 广告过滤开关 */}
      <section className="options-section">
        <h2>{i18n('options_hls_filter_title') ?? 'HLS 广告过滤'}</h2>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={hlsEnabled}
            onChange={(e) => setHlsEnabled(e.target.checked)}
          />
          {i18n('options_enable_hls_filter') ?? '启用 HLS 广告分片过滤'}
        </label>
        <p className="options-hint">
          {i18n('options_hls_filter_desc') ?? '开启后自动识别并过滤 m3u8 流媒体中的广告分片'}
        </p>
      </section>

      <div className="options-actions">
        <button className="btn-primary" onClick={() => void handleSave()}>
          {saved ? `✅ ${i18n('options_saved')}` : i18n('options_save_config')}
        </button>
      </div>
    </PageLayout>
  )
}

const rootEl = document.getElementById('root')!
if (!(rootEl as any)._reactRoot) {
  ;(rootEl as any)._reactRoot = createRoot(rootEl)
}
;(rootEl as any)._reactRoot.render(<GeneralPage />)