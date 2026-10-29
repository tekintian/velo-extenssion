import { mountReact } from '@/lib/mount'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import { request } from '@/lib/messaging'
import '@/assets/options.css'

interface HlsStats {
  total: { ads: number; adDuration: number; contentDuration: number; reports: number }
  byHost: Record<string, { ads: number; adDuration: number; reports: number; lastSeen: number }>
  byRule: Record<string, { ads: number; reports: number }>
  recent: Array<{ host: string; ads: number; adDuration: number; rule: string | null; ts: number }>
}

function fmtDur(sec: number): string {
  const s = Math.round(sec || 0)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}m${r ? `${r}s` : ''}`
}

function StatsPage() {
  const [stats, setStats] = useState<HlsStats | null>(null)

  useEffect(() => {
    void loadStats()
  }, [])

  async function loadStats() {
    const r = await request<Partial<HlsStats>>('getHlsStats')
    if (!r?.total) return
    setStats({
      total: r.total,
      byHost: r.byHost ?? {},
      byRule: r.byRule ?? {},
      recent: Array.isArray(r.recent) ? r.recent : [],
    })
  }

  async function handleClearStats() {
    if (!confirm(i18n('options_confirm_clear_stats') ?? '确定清除所有统计数据？')) return
    const r = await request('clearHlsStats')
    if (r) setStats(null)
  }

  const topHosts = stats
    ? Object.entries(stats.byHost)
      .sort((a, b) => (b[1].ads - a[1].ads))
      .slice(0, 5)
    : []

  const topRules = stats
    ? Object.entries(stats.byRule)
      .sort((a, b) => (b[1].ads - a[1].ads))
      .slice(0, 5)
    : []

  return (
    <PageLayout title={i18n('options_nav_stats')}>
      {stats && stats.total.reports > 0 ? (
        <>
          {/* 累计统计 */}
          <section className="options-section">
            <div className="stat-block">
              <h3 className="stat-block-title">{i18n('options_stats_summary_title')}</h3>
              <div className="report-grid">
                <span className="report-label">{i18n('options_stats_total_ads')}</span>
                <span><b className="stat-num">{stats.total.ads}</b> {i18n('options_stats_unit_ads')}</span>
                <span className="report-label">{i18n('options_stats_total_ad_duration')}</span>
                <span><b className="stat-num">{fmtDur(stats.total.adDuration)}</b></span>
                <span className="report-label">{i18n('options_stats_total_content_duration')}</span>
                <span>{fmtDur(stats.total.contentDuration)}</span>
                <span className="report-label">{i18n('options_stats_total_detections')}</span>
                <span>{stats.total.reports}</span>
              </div>
            </div>
          </section>

          {/* Top 站点 */}
          {topHosts.length > 0 && (
            <section className="options-section">
              <div className="stat-block">
                <h3 className="stat-block-title">{i18n('options_stats_top_hosts')}</h3>
                {topHosts.map(([host, d]) => (
                  <div key={host} className="b-stat">
                    <span>{host}</span>
                    <span><b className="stat-num">{d.ads}</b> {i18n('options_stats_unit_ads')} · {fmtDur(d.adDuration)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 命中规则 */}
          {topRules.length > 0 && (
            <section className="options-section">
              <div className="stat-block">
                <h3 className="stat-block-title">{i18n('options_stats_top_rules')}</h3>
                {topRules.map(([rule, d]) => (
                  <div key={rule} className="b-stat">
                    <span>{rule}</span>
                    <span><b className="stat-num">{d.ads}</b> {i18n('options_stats_unit_ads')}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 最近报告 */}
          {stats.recent.length > 0 && (
            <section className="options-section">
              <div className="stat-block">
                <h3 className="stat-block-title">{i18n('options_stats_recent_reports')} ({stats.recent.length})</h3>
                <div className="recent-list">
                  {stats.recent.slice(0, 10).map((r, i) => {
                    const d = new Date(r.ts)
                    const t = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
                    return (
                      <div key={i} className="recent-item">
                        {t} · {r.host || '?'} · {r.ads} {i18n('options_stats_unit_ads')}{r.rule ? ` · ${r.rule}` : ''}
                      </div>
                    )
                  })}
                </div>
              </div>
            </section>
          )}

          {/* 操作按钮 */}
          <section className="options-section">
            <div className="btn-row stat-actions">
              <button className="btn-sm btn-secondary" onClick={() => void loadStats()}>
                {i18n('options_refresh')}
              </button>
              <button className="btn-sm btn-danger" onClick={() => void handleClearStats()}>
                {i18n('options_clear_stats')}
              </button>
            </div>
          </section>
        </>
      ) : (
        <section className="options-section">
          <div className="stat-block" style={{ textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.3 }}>📊</div>
            <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#333', marginBottom: '8px' }}>
              {i18n('options_stats_empty_title') ?? '暂无统计数据'}
            </h3>
            <p style={{ fontSize: '13px', color: '#999', marginBottom: '20px', lineHeight: 1.6 }}>
              {i18n('options_stats_empty_desc') ?? '当 HLS 广告过滤检测到广告分片时，数据将自动记录到这里'}
            </p>
            <button className="btn-sm btn-secondary" onClick={() => void loadStats()}>
              {i18n('options_refresh')}
            </button>
          </div>
        </section>
      )}
    </PageLayout>
  )
}

mountReact('root', <StatsPage />)