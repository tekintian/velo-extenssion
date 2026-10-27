import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

const PAGES = [
  {
    id: 'general',
    icon: '⚙️',
    titleKey: 'options_nav_config',
    descKey: 'options_nav_config_desc',
    color: '#4a90d9',
  },
  {
    id: 'download',
    icon: '📥',
    titleKey: 'options_nav_download',
    descKey: 'options_nav_download_desc',
    color: '#fa541c',
  },
  {
    id: 'hls-filter',
    icon: '🛡️',
    titleKey: 'options_nav_hls_filter',
    descKey: 'options_nav_hls_filter_desc',
    color: '#722ed1',
  },
  {
    id: 'dash-filter',
    icon: '🎬',
    titleKey: 'options_nav_dash_filter',
    descKey: 'options_nav_dash_filter_desc',
    color: '#1890ff',
  },
  {
    id: 'hls-test',
    icon: '🧪',
    titleKey: 'options_nav_test',
    descKey: 'options_nav_test_desc',
    color: '#13c2c2',
  },
  {
    id: 'hls-rules',
    icon: '📋',
    titleKey: 'options_nav_rules',
    descKey: 'options_nav_rules_desc',
    color: '#52c41a',
  },
  {
    id: 'hls-samples',
    icon: '🔬',
    titleKey: 'options_nav_samples',
    descKey: 'options_nav_samples_desc',
    color: '#fa8c16',
  },
  {
    id: 'stats',
    icon: '📊',
    titleKey: 'options_nav_stats',
    descKey: 'options_nav_stats_desc',
    color: '#1890ff',
  },
  {
    id: 'data',
    icon: '💾',
    titleKey: 'options_nav_data',
    descKey: 'options_nav_data_desc',
    color: '#eb2f96',
  },
  {
    id: 'about',
    icon: 'ℹ️',
    titleKey: 'options_nav_about',
    descKey: 'options_nav_about_desc',
    color: '#666',
  },
] as const

function OptionsIndex() {
  const [paired, setPaired] = useState(false)
  const [hlsEnabled, setHlsEnabled] = useState(true)
  const [version] = useState(() => chrome.runtime.getManifest().version)

  useEffect(() => {
    void loadStatus()
  }, [])

  async function loadStatus() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'velo-get-status' })
      if (resp) setPaired(resp.paired ?? false)
    } catch { /* ignore */ }
    try {
      const full = await chrome.runtime.sendMessage({ type: 'getHlsFullConfig' })
      if (full) setHlsEnabled(full.enableAdSkip ?? true)
    } catch { /* ignore */ }
  }

  return (
    <div className="options-container">
      <header className="options-header">
        <img src="/icons/icon48.png" alt="velo" className="options-logo" />
        <div>
          <h1>{i18n('options_title')}</h1>
          <p className="options-subtitle">v{version} · {i18n('options_subtitle')}</p>
        </div>
        <div className="options-header-badges">
          <span className={`options-badge ${paired ? 'badge-ok' : 'badge-err'}`}>
            {paired ? `✅ ${i18n('popup_connected')}` : `❌ ${i18n('popup_not_paired')}`}
          </span>
          <span className={`options-badge ${hlsEnabled ? 'badge-ok' : 'badge-err'}`}>
            {hlsEnabled ? `🟢 ${i18n('popup_enabled')}` : `⚪ ${i18n('popup_disabled')}`}
          </span>
        </div>
      </header>

      <div className="options-nav-grid">
        {PAGES.map((page) => (
          <a
            key={page.id}
            href={`/options-${page.id}.html`}
            className="options-nav-card"
          >
            <span className="nav-card-icon">{page.icon}</span>
            <span className="nav-card-title" style={{ color: page.color }}>
              {i18n(page.titleKey)}
            </span>
            <span className="nav-card-desc">
              {i18n(page.descKey)}
            </span>
          </a>
        ))}
      </div>

      <footer className="options-footer">
        <p>{i18n('options_footer_privacy')}</p>
      </footer>
    </div>
  )
}

const rootEl = document.getElementById('root')!
if (!(rootEl as any)._reactRoot) {
  ;(rootEl as any)._reactRoot = createRoot(rootEl)
}
;(rootEl as any)._reactRoot.render(<OptionsIndex />)