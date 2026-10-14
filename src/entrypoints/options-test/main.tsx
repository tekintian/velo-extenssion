import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

interface TestResult {
  mode: string
  matchedRule: string | null
  totalSegments: number
  adSegments: number
  adDuration: number
  contentDuration: number
  reasons: Array<{ index: number; url: string; isAd: boolean; reason: string }>
  cleanedM3u8: string
}

function TestPage() {
  const [url, setUrl] = useState('')
  const [host, setHost] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [error, setError] = useState('')

  const handleTest = async () => {
    if (!url.trim()) return
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'testM3u8',
        payload: { url: url.trim(), host: host.trim() || undefined },
      })
      if (r?.error) {
        setError(r.error)
      } else {
        setResult(r)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <PageLayout title={i18n('options_nav_test')}>
      <section className="options-section">
        <h2>{i18n('options_test_input_title')}</h2>
        <label style={{ display: 'block' }}>
          {i18n('options_test_url_label')}
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/stream.m3u8"
            style={{ width: '100%', marginTop: '4px' }}
          />
        </label>
        <label style={{ display: 'block', marginTop: '8px' }}>
          {i18n('options_test_host_label')}
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="www.example.com"
            style={{ width: '100%', marginTop: '4px' }}
          />
        </label>
        <button
          className="btn-primary"
          style={{ marginTop: '12px' }}
          onClick={handleTest}
          disabled={loading}
        >
          {loading ? i18n('options_test_running') : i18n('options_test_run')}
        </button>
      </section>

      {error && (
        <div className="options-notice" style={{ background: '#fff2f0', borderColor: '#ffccc7' }}>
          ❌ {error}
        </div>
      )}

      {result && (
        <section className="options-section">
          <h2>{i18n('options_test_result_title')}</h2>
          <div className="hls-data-grid">
            <div className="hls-stat-card">
              <span className="hls-stat-label">{i18n('options_test_mode')}</span>
              <span className="hls-stat-value" style={{ fontSize: '14px' }}>{result.mode}</span>
            </div>
            <div className="hls-stat-card">
              <span className="hls-stat-label">{i18n('options_test_matched_rule')}</span>
              <span className="hls-stat-value" style={{ fontSize: '14px' }}>{result.matchedRule ?? '-'}</span>
            </div>
            <div className="hls-stat-card">
              <span className="hls-stat-label">{i18n('options_test_ad_segments')}</span>
              <span className="hls-stat-value">{result.adSegments}/{result.totalSegments}</span>
            </div>
            <div className="hls-stat-card">
              <span className="hls-stat-label">{i18n('options_test_ad_duration')}</span>
              <span className="hls-stat-value">{result.adDuration.toFixed(1)}s</span>
            </div>
            <div className="hls-stat-card">
              <span className="hls-stat-label">{i18n('options_test_content_duration')}</span>
              <span className="hls-stat-value">{result.contentDuration.toFixed(1)}s</span>
            </div>
          </div>

          {result.reasons.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <h3 style={{ fontSize: '13px', marginBottom: '8px' }}>{i18n('options_test_segment_reasons')}</h3>
              <div className="reason-list">
                {result.reasons.map((r, i) => (
                  <div key={i} className={`reason-item ${r.isAd ? 'reason-ad' : 'reason-content'}`}>
                    <span className="reason-index">#{r.index}</span>
                    <span className="reason-tag">{r.isAd ? 'AD' : 'OK'}</span>
                    <span className="reason-text">{r.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.cleanedM3u8 && (
            <div style={{ marginTop: '16px' }}>
              <h3 style={{ fontSize: '13px', marginBottom: '8px' }}>{i18n('options_test_cleaned_m3u8')}</h3>
              <textarea
                readOnly
                value={result.cleanedM3u8}
                style={{ width: '100%', minHeight: '120px', fontFamily: 'monospace', fontSize: '11px', padding: '8px', border: '1px solid #d9d9d9', borderRadius: '6px' }}
              />
            </div>
          )}
        </section>
      )}
    </PageLayout>
  )
}

createRoot(document.getElementById('root')!).render(<TestPage />)