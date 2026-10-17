import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

type DataCategory = 'userRules' | 'suggestions' | 'fullConfig' | 'learnedFingerprints' | 'adSamples'

function DataPage() {
  const [exportCategories, setExportCategories] = useState<Set<DataCategory>>(
    new Set(['userRules', 'suggestions', 'fullConfig', 'learnedFingerprints', 'adSamples'])
  )
  const [importStrategy, setImportStrategy] = useState<'merge' | 'replace'>('merge')

  const toggleCategory = (cat: DataCategory) => {
    setExportCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  const handleExport = async () => {
    try {
      const backup = await chrome.runtime.sendMessage({
        type: 'exportHlsBackup',
        payload: { categories: Array.from(exportCategories) },
      })
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `velo-hls-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) { alert(String(e)) }
  }

  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        await chrome.runtime.sendMessage({
          type: 'importHlsBackup',
          payload: { data, strategy: importStrategy },
        })
        alert(i18n('options_import_success'))
      } catch (err) { alert(i18n('options_import_failed') + ': ' + (err as Error).message) }
    }
    input.click()
  }

  const categories: Array<{ key: DataCategory; labelKey: string }> = [
    { key: 'userRules', labelKey: 'options_data_user_rules' },
    { key: 'suggestions', labelKey: 'options_data_suggestions' },
    { key: 'fullConfig', labelKey: 'options_data_full_config' },
    { key: 'learnedFingerprints', labelKey: 'options_data_learned_fingerprints' },
    { key: 'adSamples', labelKey: 'options_data_ad_samples' },
  ]

  return (
    <PageLayout title={i18n('options_nav_data')}>
      <section className="options-section">
        <h2>{i18n('options_export_title')}</h2>
        <p className="desc-text">{i18n('options_export_desc')}</p>
        {categories.map((cat) => (
          <label key={cat.key} className="checkbox-label">
            <input
              type="checkbox"
              checked={exportCategories.has(cat.key)}
              onChange={() => toggleCategory(cat.key)}
            />
            {i18n(cat.labelKey)}
          </label>
        ))}
        <button className="btn-primary" onClick={() => void handleExport()}>
          {i18n('options_export_button')}
        </button>
      </section>

      <section className="options-section">
        <h2>{i18n('options_import_title')}</h2>
        <p className="desc-text">{i18n('options_import_desc')}</p>
        <div className="radio-group">
          <label className="checkbox-label">
            <input
              type="radio"
              name="importStrategy"
              checked={importStrategy === 'merge'}
              onChange={() => setImportStrategy('merge')}
            />
            {i18n('options_strategy_merge')}
          </label>
          <label className="checkbox-label">
            <input
              type="radio"
              name="importStrategy"
              checked={importStrategy === 'replace'}
              onChange={() => setImportStrategy('replace')}
            />
            {i18n('options_strategy_replace')}
          </label>
        </div>
        <button className="btn-primary" onClick={handleImport}>
          {i18n('options_import_button')}
        </button>
      </section>

      <section className="options-section">
        <h2>{i18n('options_privacy_title')}</h2>
        <div className="privacy-notice">
          <p><strong>{i18n('options_privacy_scope')}</strong> {i18n('options_privacy_scope_desc')}</p>
          <p><strong>{i18n('options_privacy_storage')}</strong> {i18n('options_privacy_storage_desc')}</p>
          <p><strong>{i18n('options_privacy_headers')}</strong> {i18n('options_privacy_headers_desc')}</p>
        </div>
      </section>
    </PageLayout>
  )
}

createRoot(document.getElementById('root')!).render(<DataPage />)