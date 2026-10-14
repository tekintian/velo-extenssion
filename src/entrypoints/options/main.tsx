import { createRoot } from 'react-dom/client'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

const PAGES = [
  {
    id: 'config',
    icon: '⚙️',
    titleKey: 'options_nav_config',
    descKey: 'options_nav_config_desc',
  },
  {
    id: 'test',
    icon: '🧪',
    titleKey: 'options_nav_test',
    descKey: 'options_nav_test_desc',
  },
  {
    id: 'rules',
    icon: '📋',
    titleKey: 'options_nav_rules',
    descKey: 'options_nav_rules_desc',
  },
  {
    id: 'stats',
    icon: '📊',
    titleKey: 'options_nav_stats',
    descKey: 'options_nav_stats_desc',
  },
  {
    id: 'samples',
    icon: '🔬',
    titleKey: 'options_nav_samples',
    descKey: 'options_nav_samples_desc',
  },
  {
    id: 'data',
    icon: '💾',
    titleKey: 'options_nav_data',
    descKey: 'options_nav_data_desc',
  },
] as const

function OptionsIndex() {
  return (
    <div className="options-container">
      <header className="options-header">
        <img src="/icons/icon48.png" alt="velo" className="options-logo" />
        <div>
          <h1>{i18n('options_title')}</h1>
          <p className="options-subtitle">{i18n('options_subtitle')}</p>
        </div>
      </header>

      <div className="options-notice">
        {i18n('options_notice_auth')}
      </div>

      <div className="options-nav-grid">
        {PAGES.map((page) => (
          <a
            key={page.id}
            href={`/options-${page.id}.html`}
            className="options-nav-card"
          >
            <span className="nav-card-icon">{page.icon}</span>
            <span className="nav-card-title">
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

createRoot(document.getElementById('root')!).render(<OptionsIndex />)