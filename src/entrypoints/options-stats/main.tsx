import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

interface StatsData {
  total: { ads: number; adDuration: number; contentDuration: number; detections: number }
  topHosts: Array<{ host: string; ads: number; adDuration: number }>
  topRules: Array<{ ruleId: string; hits: number }>
  recentReports: Array<{ timestamp: number; host: string; adSegments: number; totalSegments: number; ruleId: string }>
}

function StatsPage() {
  const [stats, setStats] = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(true)

  const loadStats = async () => {
    setLoading(true)
    try {
      const r = await chrome.runtime.sendMessage({ type: 'getHlsStats' })
      if (r) setStats(r)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { void loadStats() }, [])

  return (
    <PageLayout title={i18n('options_nav_stats')}>
      <section className="options-section">
        <h2>{i18n('options_stats_summary_title')}</h2>
        {loading ? (
          <p>{i18n('options_loading')}</p>
        ) : stats ? (
          <div className="hls-data-grid hls-data-grid-4">
            <div className="hls-stat-card">
              <span className="hls-stat-label">{i18n('options_stats_total_ads')}</span>
              <span className="hls-stat-value">{stats.total.ads}</span>
            </div>
            <div className="hls-stat-card">
              <span className="hls-stat-label">{i18n('options_stats_total_ad_duration')}</span>
              <span className="hls-stat-value">{stats.total.adDuration.toFixed(0)}s</span>
            </div>
            <div className="hls-stat-card">
              <span className="hls-stat-label">{i18n('options_stats_total_detections')}</span>
              <span className="hls-stat-value">{stats.total.detections}</span>
            </div>
            <div className="hls-stat-card">
              <span className="hls-stat-label">{i18n('options_stats_total_content_duration')}</span>
              <span className="hls-stat-value">{stats.total.contentDuration.toFixed(0)}s</span>
            </div>
          </div>
        ) : (
          <p>{i18n('options_no_stats')}</p>
        )}
      </section>

      {stats?.topHosts && stats.topHosts.length > 0 && (
        <section className="options-section">
          <h2>{i18n('options_stats_top_hosts')}</h2>
          <table className="stats-table">
            <thead>
              <tr>
                <th>{i18n('options_stats_host')}</th>
                <th>{i18n('options_stats_ads')}</th>
                <th>{i18n('options_stats_ad_duration')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.topHosts.map((h, i) => (
                <tr key={i}>
                  <td>{h.host}</td>
                  <td>{h.ads}</td>
                  <td>{h.adDuration.toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {stats?.topRules && stats.topRules.length > 0 && (
        <section className="options-section">
          <h2>{i18n('options_stats_top_rules')}</h2>
          <table className="stats-table">
            <thead>
              <tr>
                <th>{i18n('options_stats_rule')}</th>
                <th>{i18n('options_stats_hits')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.topRules.map((r, i) => (
                <tr key={i}>
                  <td>{r.ruleId}</td>
                  <td>{r.hits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {stats?.recentReports && stats.recentReports.length > 0 && (
        <section className="options-section">
          <h2>{i18n('options_stats_recent_reports')}</h2>
          <table className="stats-table">
            <thead>
              <tr>
                <th>{i18n('options_stats_time')}</th>
                <th>{i18n('options_stats_host')}</th>
                <th>{i18n('options_stats_ad_total')}</th>
                <th>{i18n('options_stats_rule')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.recentReports.map((r, i) => (
                <tr key={i}>
                  <td>{new Date(r.timestamp).toLocaleString()}</td>
                  <td>{r.host}</td>
                  <td>{r.adSegments}/{r.totalSegments}</td>
                  <td>{r.ruleId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="hls-actions">
        <button className="btn-secondary" onClick={() => void loadStats()}>
          {i18n('options_refresh')}
        </button>
        <button className="btn-danger" onClick={async () => {
          if (!confirm(i18n('options_confirm_clear_stats'))) return
          try {
            await chrome.runtime.sendMessage({ type: 'clearHlsStats' })
            setStats(null)
          } catch (e) { alert(String(e)) }
        }}>
          {i18n('options_clear_stats')}
        </button>
      </div>
    </PageLayout>
  )
}

createRoot(document.getElementById('root')!).render(<StatsPage />)