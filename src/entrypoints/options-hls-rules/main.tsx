import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
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
    try {
      const r = await chrome.runtime.sendMessage({ type: 'listHlsRules' })
      if (r?.rules) setRules(r.rules)
      const s = await chrome.runtime.sendMessage({ type: 'listSuggestions' })
      if (s?.suggestions) setSuggestions(s.suggestions)
    } catch { /* ignore */ }
    setLoading(false)
  }

  async function loadCustomRules() {
    try {
      const full = await chrome.runtime.sendMessage({ type: 'getHlsFullConfig' })
      if (full) {
        setUrlPatterns(Array.isArray(full.urlPatterns) ? full.urlPatterns.join('\n') : '')
        setRemoteRulesUrl(full.remoteRulesUrl ?? '')
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    void loadData()
    void loadCustomRules()
  }, [])

  const handleApprove = async (id: string) => {
    try {
      await chrome.runtime.sendMessage({ type: 'approveSuggestion', payload: { id } })
      void loadData()
    } catch (e) { alert(String(e)) }
  }

  const handleDismiss = async (id: string) => {
    try {
      await chrome.runtime.sendMessage({ type: 'dismissSuggestion', payload: { id } })
      void loadData()
    } catch (e) { alert(String(e)) }
  }

  async function handleSaveCustomRules() {
    try {
      await chrome.runtime.sendMessage({
        type: 'setHlsFullConfig',
        payload: {
          urlPatterns: urlPatterns.split('\n').filter(Boolean),
          remoteRulesUrl,
        },
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      alert(i18n('options_save_failed') + ': ' + (e as Error).message)
    }
  }

  async function handleRefreshRemote() {
    if (!remoteRulesUrl.trim()) {
      alert(i18n('options_remote_rules_url') + ' ' + i18n('options_is_empty'))
      return
    }
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'refreshHlsRemoteRules',
        payload: { url: remoteRulesUrl.trim() },
      })
      alert(i18n('options_refresh_ok') + ': ' + (r?.rules ?? 0) + ' ' + i18n('options_rules_count'))
      void loadData()
    } catch (e) {
      alert(String(e))
    }
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

const rootEl = document.getElementById('root')!
if (!(rootEl as any)._reactRoot) {
  ;(rootEl as any)._reactRoot = createRoot(rootEl)
}
;(rootEl as any)._reactRoot.render(<RulesPage />)