import { createRoot } from 'react-dom/client'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

function AboutPage() {
  const manifest = chrome.runtime.getManifest()

  return (
    <PageLayout title={i18n('options_nav_about') ?? '关于'}>
      <section className="options-section">
        <div className="options-info-grid">
          <div className="info-row">
            <span className="info-label">{i18n('options_name_label') ?? '名称'}</span>
            <span className="info-value">{manifest.name}</span>
          </div>
          <div className="info-row">
            <span className="info-label">{i18n('options_version_label') ?? '版本'}</span>
            <span className="info-value">v{manifest.version}</span>
          </div>
          <div className="info-row">
            <span className="info-label">{i18n('options_description_label') ?? '描述'}</span>
            <span className="info-value">{manifest.description}</span>
          </div>
        </div>
      </section>

      <section className="options-section">
        <h2>{i18n('options_about_features') ?? '功能特性'}</h2>
        <ul className="privacy-notice">
          <li>{i18n('options_about_feature_1') ?? 'm3u8 / mpd 流媒体嗅探与提取'}</li>
          <li>{i18n('options_about_feature_2') ?? 'HLS 广告分片智能过滤'}</li>
          <li>{i18n('options_about_feature_3') ?? '一键推送到 Velo 桌面端下载'}</li>
          <li>{i18n('options_about_feature_4') ?? '支持 Aria2、NDM、浏览器原生等多种下载方式'}</li>
        </ul>
      </section>

      <section className="options-section">
        <h2>{i18n('options_about_links') ?? '相关链接'}</h2>
        <div className="options-info-grid">
          <div className="info-row">
            <span className="info-label">GitHub</span>
            <a href="https://github.com/tekintian/velo" target="_blank" rel="noopener noreferrer" className="info-value" style={{ color: 'var(--color-primary)' }}>
              github.com/tekintian/velo
            </a>
          </div>
          <div className="info-row">
            <span className="info-label">{i18n('options_about_author') ?? '作者'}</span>
            <span className="info-value">tekintian</span>
          </div>
        </div>
      </section>
    </PageLayout>
  )
}

const rootEl = document.getElementById('root')!
if (!(rootEl as any)._reactRoot) {
  ;(rootEl as any)._reactRoot = createRoot(rootEl)
}
;(rootEl as any)._reactRoot.render(<AboutPage />)