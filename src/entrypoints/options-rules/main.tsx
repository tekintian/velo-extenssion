import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

interface RuleItem {
  id: string
  name: string
  hostPattern: string
  threshold: number
  mode: string
  adPatterns: string[]
  forceKeep: string[]
  source: 'builtin' | 'remote' | 'user'
}

interface SuggestionItem {
  id: string
  hostPattern: string
  adPatterns: string[]
  timestamp: number
}

function RulesPage() {
  const [rules, setRules] = useState<RuleItem[]>([])
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [loading, setLoading] = useState(true)

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

  useEffect(() => { void loadData() }, [])

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

  const sourceLabel = (src: string) => {
    if (src === 'builtin') return i18n('options_rule_source_builtin')
    if (src === 'remote') return i18n('options_rule_source_remote')
    return i18n('options_rule_source_user')
  }

  return (
    <PageLayout title={i18n('options_nav_rules')}>
      {suggestions.length > 0 && (
        <section className="options-section">
          <h2>{i18n('options_suggestions_title')} ({suggestions.length})</h2>
          <div className="suggestion-list">
            {suggestions.map((s) => (
              <div key={s.id} className="suggestion-item">
                <div className="suggestion-info">
                  <span className="suggestion-host">{s.hostPattern}</span>
                  <span className="suggestion-patterns">{s.adPatterns.join(', ')}</span>
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
                  <span>host: {rule.hostPattern}</span>
                  <span>threshold: {rule.threshold}</span>
                  <span>mode: {rule.mode}</span>
                </div>
                {rule.adPatterns.length > 0 && (
                  <div className="rule-patterns">
                    {i18n('options_ad_patterns')}: {rule.adPatterns.join(', ')}
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

createRoot(document.getElementById('root')!).render(<RulesPage />)