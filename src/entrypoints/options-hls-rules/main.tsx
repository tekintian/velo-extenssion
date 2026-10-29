import { mountReact } from '@/lib/mount'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import { request, requestArray } from '@/lib/messaging'
import '@/assets/options.css'

interface RuleItem {
  id: string
  name: string
  hostPattern: string
  scoreThreshold?: number
  mode?: string
  adUrlPatterns: string[]
  forceKeep: string[]
  source: 'builtin' | 'remote' | 'user'
}

interface SuggestionItem {
  id: string
  hostPattern: string
  adUrlPatterns: string[]
  scoreThreshold: number
  createdAt: number
}

function RulesPage() {
  const [rules, setRules] = useState<RuleItem[]>([])
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [loading, setLoading] = useState(true)

  // 自定义规则编辑状态
  const [urlPatterns, setUrlPatterns] = useState('')
  const [remoteRulesUrl, setRemoteRulesUrl] = useState('')
  const [saved, setSaved] = useState(false)

  const loadData = async () => {
    setLoading(true)
    const r = await request<{ rules?: unknown }>('listHlsRules')
    if (Array.isArray(r?.rules)) setRules(r.rules as RuleItem[])
    const s = await requestArray<SuggestionItem>('listSuggestions')
    if (s) setSuggestions(s)
    setLoading(false)
  }

  async function loadCustomRules() {
    const full = await request<{ urlPatterns?: unknown; remoteRulesUrl?: string }>('getHlsFullConfig')
    if (!full) return
    setUrlPatterns(Array.isArray(full.urlPatterns) ? full.urlPatterns.join('\n') : '')
    setRemoteRulesUrl(full.remoteRulesUrl ?? '')
  }

  useEffect(() => {
    void loadData()
    void loadCustomRules()
  }, [])

  const handleApprove = async (id: string) => {
    const r = await request('approveSuggestion', { id })
    if (!r) return
    void loadData()
  }

  const handleDismiss = async (id: string) => {
    const r = await request('dismissSuggestion', { id })
    if (!r) return
    void loadData()
  }

  async function handleSaveCustomRules() {
    const r = await request('setHlsFullConfig', {
      urlPatterns: urlPatterns.split('\n').filter(Boolean),
      remoteRulesUrl,
    })
    if (!r) {
      alert(i18n('options_save_failed'))
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleRefreshRemote() {
    if (!remoteRulesUrl.trim()) {
      alert(i18n('options_remote_rules_url') + ' ' + i18n('options_is_empty'))
      return
    }
    const r = await request<{ rules?: number }>('refreshHlsRemoteRules', { url: remoteRulesUrl.trim() })
    if (!r) {
      alert(i18n('options_refresh_failed'))
      return
    }
    alert(i18n('options_refresh_ok') + ': ' + (r.rules ?? 0) + ' ' + i18n('options_rules_count'))
    void loadData()
  }

  const sourceLabel = (src: string) => {
    if (src === 'builtin') return i18n('options_rule_source_builtin')
    if (src === 'remote') return i18n('options_rule_source_remote')
    return i18n('options_rule_source_user')
  }

  return (
    <PageLayout title={i18n('options_nav_rules')}>
      {/* 自定义规则 */}
      <section className="options-section">
        <h2>{i18n('options_custom_rules_title')}</h2>
        <label>
          {i18n('options_url_patterns')}
          <textarea
            className="textarea-mono"
            value={urlPatterns}
            onChange={(e) => setUrlPatterns(e.target.value)}
            placeholder={'/ads?/\ndoubleclick\\.com'}
          />
        </label>
        <label>
          {i18n('options_remote_rules_url')}
          <input
            type="url"
            value={remoteRulesUrl}
            onChange={(e) => setRemoteRulesUrl(e.target.value)}
            placeholder="https://example.com/velo-rules.json"
          />
        </label>
        <div className="btn-row">
          <button className="btn-primary" onClick={() => void handleSaveCustomRules()}>
            {saved ? `✅ ${i18n('options_saved')}` : i18n('options_save_config')}
          </button>
          <button className="btn-secondary" onClick={() => void handleRefreshRemote()}>
            {i18n('options_refresh_remote_rules')}
          </button>
        </div>
      </section>

      {suggestions.length > 0 && (
        <section className="options-section">
          <h2>{i18n('options_suggestions_title')} ({suggestions.length})</h2>
          <div className="suggestion-list">
            {suggestions.map((s) => (
              <div key={s.id} className="suggestion-item">
                <div className="suggestion-info">
                  <span className="suggestion-host">{s.hostPattern}</span>
                  <span className="suggestion-patterns">{s.adUrlPatterns.join(', ')}</span>
                </div>
                <div className="suggestion-actions">
                  <button className="btn-sm btn-primary" onClick={() => void handleApprove(s.id)}>
                    {i18n('options_suggestion_approve')}
                  </button>
                  <button className="btn-sm btn-secondary" onClick={() => void handleDismiss(s.id)}>
                    {i18n('options_suggestion_dismiss')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="options-section">
        <h2>{i18n('options_rules_list_title')}</h2>
        {loading ? (
          <p>{i18n('options_loading')}</p>
        ) : rules.length === 0 ? (
          <p>{i18n('options_no_rules')}</p>
        ) : (
          <div className="rule-list">
            {rules.map((rule) => (
              <div key={rule.id} className="rule-item">
                <div className="rule-header">
                  <span className="rule-name">{rule.name || rule.id}</span>
                  <span className={`rule-source source-${rule.source}`}>{sourceLabel(rule.source)}</span>
                </div>
                <div className="rule-detail">
                  <span>{i18n('options_rule_host')}: {rule.hostPattern || i18n('options_rule_all')}</span>
                  <span>{i18n('options_rule_threshold')}: {rule.scoreThreshold ?? '-'}</span>
                  <span>{i18n('options_rule_mode')}: {rule.mode || i18n('options_rule_default')}</span>
                </div>
                {rule.adUrlPatterns && rule.adUrlPatterns.length > 0 && (
                  <div className="rule-patterns">
                    {i18n('options_ad_patterns')}: {rule.adUrlPatterns.join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </PageLayout>
  )
}

mountReact('root', <RulesPage />)