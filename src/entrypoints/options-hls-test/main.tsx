import { mountReact } from '@/lib/mount'
import { useState } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import { request } from '@/lib/messaging'
import '@/assets/options.css'

interface TestResult {
  mode: string
  matchedRule: string | null
  totalSegments: number
  adSegments: number
  adDuration: number
  contentDuration: number
  reasons: Array<{ index: number; url?: string; isAd: boolean; reason: string }>
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
    const r = await request<Partial<TestResult> & { error?: string }>('testM3u8', {
      url: url.trim(),
      host: host.trim() || undefined,
    })
    if (!r) {
      setError('请求失败：后台未响应，请重新加载扩展后重试')
    } else if (typeof r.error === 'string') {
      setError(r.error)
    } else if (!Array.isArray(r.reasons)) {
      setError('返回数据结构异常：缺少分片分析结果')
    } else {
      setResult(r as TestResult)
    }
    setLoading(false)
  }

  return (
    <PageLayout title={i18n('options_nav_test')}>
      <section className="options-section">
        <h2>{i18n('options_test_input_title')}</h2>
        <label>
          {i18n('options_test_url_label')}
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/stream.m3u8"
          />
        </label>
        <label>
          {i18n('options_test_host_label')}
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="www.example.com"
          />
        </label>
        <button
          className="btn-primary"
          onClick={handleTest}
          disabled={loading}
        >
          {loading ? i18n('options_test_running') : i18n('options_test_run')}
        </button>
      </section>

      {error && (
        <div className="options-notice options-notice-error">
          ❌ {error}
        </div>
      )}

      {result && (
        <section className="options-section">
          <h2>{i18n('options_test_result_title')}</h2>
          <div className="hls-data-grid hls-data-grid-5">
            <div className="hls-stat-card">
              <span className="hls-stat-label">{i18n('options_test_mode')}</span>
              <span className="hls-stat-value-sm">{result.mode}</span>
            </div>
            <div className="hls-stat-card">
              <span className="hls-stat-label">{i18n('options_test_matched_rule')}</span>
              <span className="hls-stat-value-sm">{result.matchedRule ?? '-'}</span>
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
            <div className="sub-section">
              <h3 className="sub-title">{i18n('options_test_segment_reasons')}</h3>
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
            <div className="sub-section">
              <h3 className="sub-title">{i18n('options_test_cleaned_m3u8')}</h3>
              <textarea
                readOnly
                value={result.cleanedM3u8}
                className="textarea-mono textarea-mono-lg"
              />
            </div>
          )}
        </section>
      )}
    </PageLayout>
  )
}

mountReact('root', <TestPage />)