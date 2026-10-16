import { createRoot } from 'react-dom/client'
import { useState, useEffect, useCallback } from 'react'
import type { VeloConfig } from '@/types'
import { DEFAULT_CONFIG } from '@/types'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

type DlClient = 'ndm' | 'aria2' | 'velo' | 'native'

function ConfigPage() {
  const [config, setConfig] = useState<VeloConfig>({ ...DEFAULT_CONFIG })
  const [saved, setSaved] = useState(false)
  const [fpConfig, setFpConfig] = useState<{
    enableFingerprint: boolean
    fingerprintMode: string
    autoLearnFingerprints: boolean
    remoteFingerprintsUrl: string
  }>({ enableFingerprint: false, fingerprintMode: 'suspicious-only', autoLearnFingerprints: true, remoteFingerprintsUrl: '' })
  const [fullConfig, setFullConfig] = useState<{
    enableAdSkip: boolean
    showPageBadge: boolean
    keepDiscontinuityOnGap: boolean
    logToConsole: boolean
    mode: string
    urlPatterns: string
    remoteRulesUrl: string
  }>({ enableAdSkip: true, showPageBadge: true, keepDiscontinuityOnGap: true, logToConsole: false, mode: 'm3u8-file', urlPatterns: '', remoteRulesUrl: '' })
  const [advancedSaved, setAdvancedSaved] = useState(false)

  const [dlClient, setDlClient] = useState<DlClient>('native')
  const [rpcHost, setRpcHost] = useState('localhost')
  const [rpcPort, setRpcPort] = useState(16816)
  const [rpcSecret, setRpcSecret] = useState('')
  const [veloHost, setVeloHost] = useState('127.0.0.1')
  const [veloPort, setVeloPort] = useState(16888)
  const [veloToken, setVeloToken] = useState('')
  const [dlSaved, setDlSaved] = useState(false)
  const [testUrl, setTestUrl] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void loadConfig()
  }, [])

  async function loadConfig() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'velo-get-config' })
      if (resp) setConfig({ ...DEFAULT_CONFIG, ...resp })
    } catch { /* ignore */ }
    try {
      const fp = await chrome.runtime.sendMessage({ type: 'getHlsFingerprintConfig' })
      if (fp) setFpConfig({
        enableFingerprint: fp.enableFingerprint ?? false,
        fingerprintMode: fp.fingerprintMode ?? 'suspicious-only',
        autoLearnFingerprints: fp.autoLearnFingerprints ?? true,
        remoteFingerprintsUrl: fp.remoteFingerprintsUrl ?? '',
      })
    } catch { /* ignore */ }
    try {
      const full = await chrome.runtime.sendMessage({ type: 'getHlsFullConfig' })
      if (full) setFullConfig({
        enableAdSkip: full.enableAdSkip ?? true,
        showPageBadge: full.showPageBadge ?? true,
        keepDiscontinuityOnGap: full.keepDiscontinuityOnGap ?? true,
        logToConsole: full.logToConsole ?? false,
        mode: full.mode ?? 'm3u8-file',
        urlPatterns: Array.isArray(full.urlPatterns) ? full.urlPatterns.join('\n') : '',
        remoteRulesUrl: full.remoteRulesUrl ?? '',
      })
    } catch { /* ignore */ }
    try {
      const dl = await chrome.runtime.sendMessage({ type: 'getDownloadConfig' }) as {
        client: string; rpcHost: string; rpcPort: number; rpcSecret: string
        veloHost: string; veloPort: number; veloToken: string
      }
      if (dl) {
        setDlClient((dl.client as DlClient) ?? 'native')
        setRpcHost(dl.rpcHost ?? 'localhost')
        setRpcPort(dl.rpcPort ?? 16816)
        setRpcSecret(dl.rpcSecret ?? '')
        setVeloHost(dl.veloHost ?? '127.0.0.1')
        setVeloPort(dl.veloPort ?? 16888)
        setVeloToken(dl.veloToken ?? '')
      }
    } catch { /* ignore */ }
  }

  const handleSave = useCallback(async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'velo-save-config', config })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch { /* ignore */ }
  }, [config])

  const update = useCallback(<K extends keyof VeloConfig>(key: K, value: VeloConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }, [])

  async function handleDlSave() {
    try {
      await chrome.runtime.sendMessage({
        type: 'setDownloadConfig',
        payload: { client: dlClient, rpcHost, rpcPort, rpcSecret, veloHost, veloPort, veloToken },
      })
      await chrome.runtime.sendMessage({
        type: 'setHlsFullConfig',
        payload: { mode: fullConfig.mode },
      })
      setDlSaved(true)
      setTimeout(() => setDlSaved(false), 2000)
    } catch (e) {
      alert(i18n('options_save_failed') + ': ' + (e as Error).message)
    }
  }

  async function handleTest() {
    if (!testUrl) return
    setTesting(true)
    setTestResult(null)
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'sendToDownload',
        payload: { url: testUrl, pageUrl: testUrl },
      }) as { success: boolean; message?: string }
      setTestResult(r.success ? i18n('options_download_sent') : `✗ ${r.message ?? 'fail'}`)
    } catch (e) {
      setTestResult(`✗ ${(e as Error).message}`)
    } finally {
      setTesting(false)
    }
  }

  const CLIENTS: { id: DlClient; icon: string; nameKey: string; descKey: string }[] = [
    { id: 'native', icon: '🌐', nameKey: 'options_browser_native', descKey: 'options_use_chrome_download' },
    { id: 'aria2', icon: '⚡', nameKey: 'options_aria2_client', descKey: 'options_http_json_rpc' },
    { id: 'ndm', icon: '📥', nameKey: 'options_ndm_desktop', descKey: 'options_ws_protocol' },
    { id: 'velo', icon: '🚀', nameKey: 'options_velo_client', descKey: 'options_velo_protocol' },
  ]

  const DELIVERY_MODES: { id: string; labelKey: string }[] = [
    { id: 'm3u8-file', labelKey: 'options_mode_m3u8_file' },
    { id: 'data-url', labelKey: 'options_mode_data_url' },
    { id: 'enumerate', labelKey: 'options_mode_enumerate' },
    { id: 'passthrough', labelKey: 'options_mode_passthrough' },
  ]

  return (
    <PageLayout title={i18n('options_nav_config')}>
      <section className="options-section">
        <h2>{i18n('options_pairing_title')}</h2>
        <label>
          {i18n('options_port_label')}
          <input
            type="number"
            value={config.port}
            onChange={(e) => update('port', Number(e.target.value))}
            min={1024}
            max={65535}
          />
        </label>
        <label>
          {i18n('options_token_label')}
          <input
            type="text"
            value={config.token}
            onChange={(e) => update('token', e.target.value)}
            placeholder="Token"
          />
        </label>
      </section>

      <section className="options-section">
        <h2>{i18n('options_push_title')}</h2>
        <label>
          {i18n('options_merge_format_label')}
          <select value={config.mergeFormat} onChange={(e) => update('mergeFormat', e.target.value as VeloConfig['mergeFormat'])}>
            <option value="ts">TS</option>
            <option value="mp4">MP4</option>
            <option value="mkv">MKV</option>
            <option value="keep">Keep Original</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.autoPush}
            onChange={(e) => update('autoPush', e.target.checked)}
          />
          {i18n('options_auto_push_label')}
        </label>
      </section>

      <section className="options-section">
        <h2>{i18n('options_download_client_title')}</h2>
        <p className="text-xs text-muted-foreground" style={{ marginTop: 0, marginBottom: '12px' }}>
          {i18n('options_download_client_desc')}
        </p>

        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontSize: '12px', color: 'var(--muted-fg)' }}>
            {i18n('options_client_type')}
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            {CLIENTS.map((c) => (
              <button
                key={c.id}
                onClick={() => setDlClient(c.id)}
                style={{
                  padding: '10px',
                  borderRadius: '8px',
                  border: dlClient === c.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                  background: dlClient === c.id ? 'var(--accent-bg)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '13px',
                }}
              >
                <div style={{ fontWeight: 500 }}>{c.icon} {i18n(c.nameKey)}</div>
                <div style={{ fontSize: '10px', color: 'var(--muted-fg)', marginTop: '2px' }}>{i18n(c.descKey)}</div>
              </button>
            ))}
          </div>
        </div>

        {dlClient === 'aria2' && (
          <div style={{ marginBottom: '12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <label style={{ display: 'block' }}>
                <span style={{ fontSize: '12px', color: 'var(--muted-fg)' }}>{i18n('options_rpc_host')}</span>
                <input
                  value={rpcHost}
                  onChange={(e) => setRpcHost(e.target.value)}
                  placeholder="localhost"
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
              <label style={{ display: 'block' }}>
                <span style={{ fontSize: '12px', color: 'var(--muted-fg)' }}>{i18n('options_rpc_port')}</span>
                <input
                  type="number"
                  value={rpcPort}
                  onChange={(e) => setRpcPort(parseInt(e.target.value, 10) || 16816)}
                  placeholder="16816"
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
            </div>
            <label style={{ display: 'block', marginTop: '8px' }}>
              <span style={{ fontSize: '12px', color: 'var(--muted-fg)' }}>{i18n('options_rpc_secret')}</span>
              <input
                type="password"
                value={rpcSecret}
                onChange={(e) => setRpcSecret(e.target.value)}
                placeholder={i18n('options_rpc_secret_placeholder')}
                style={{ width: '100%', marginTop: '4px' }}
              />
            </label>
          </div>
        )}

        {dlClient === 'ndm' && (
          <div style={{ fontSize: '12px', color: 'var(--muted-fg)', padding: '10px', background: 'var(--muted-bg)', borderRadius: '6px', marginBottom: '12px' }}>
            {i18n('options_ndm_hint')}
          </div>
        )}

        {dlClient === 'velo' && (
          <div style={{ marginBottom: '12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <label style={{ display: 'block' }}>
                <span style={{ fontSize: '12px', color: 'var(--muted-fg)' }}>{i18n('options_velo_host')}</span>
                <input
                  value={veloHost}
                  onChange={(e) => setVeloHost(e.target.value)}
                  placeholder="127.0.0.1"
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
              <label style={{ display: 'block' }}>
                <span style={{ fontSize: '12px', color: 'var(--muted-fg)' }}>{i18n('options_velo_port')}</span>
                <input
                  type="number"
                  value={veloPort}
                  onChange={(e) => setVeloPort(parseInt(e.target.value, 10) || 16888)}
                  placeholder="16888"
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
            </div>
            <label style={{ display: 'block', marginTop: '8px' }}>
              <span style={{ fontSize: '12px', color: 'var(--muted-fg)' }}>{i18n('options_velo_token')}</span>
              <input
                type="password"
                value={veloToken}
                onChange={(e) => setVeloToken(e.target.value)}
                placeholder={i18n('options_velo_token_placeholder')}
                style={{ width: '100%', marginTop: '4px' }}
              />
            </label>
            <div style={{ fontSize: '12px', color: 'var(--muted-fg)', padding: '10px', background: 'var(--muted-bg)', borderRadius: '6px', marginTop: '8px' }}>
              {i18n('options_velo_hint')}
            </div>
          </div>
        )}

        {dlClient === 'native' && (
          <div style={{ fontSize: '12px', color: 'var(--muted-fg)', padding: '10px', background: 'var(--muted-bg)', borderRadius: '6px', marginBottom: '12px' }}>
            {i18n('options_native_hint')}
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '12px', marginBottom: '12px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontSize: '12px', color: 'var(--muted-fg)' }}>
            {i18n('options_hls_delivery_mode')}
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '6px' }}>
            {DELIVERY_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setFullConfig({ ...fullConfig, mode: m.id })}
                style={{
                  padding: '6px 4px',
                  borderRadius: '6px',
                  border: fullConfig.mode === m.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                  background: fullConfig.mode === m.id ? 'var(--accent-bg)' : 'transparent',
                  cursor: 'pointer',
                  fontSize: '11px',
                }}
              >
                {i18n(m.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <button className="btn-primary" onClick={() => void handleDlSave()}>
          {dlSaved ? `✅ ${i18n('options_saved')}` : i18n('options_save_config')}
        </button>
      </section>

      <section className="options-section">
        <h2>{i18n('options_test_download')}</h2>
        <p style={{ fontSize: '12px', color: 'var(--muted-fg)', marginTop: 0, marginBottom: '8px' }}>
          {i18n('options_test_download_desc')}
        </p>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input
            value={testUrl}
            onChange={(e) => setTestUrl(e.target.value)}
            placeholder="https://example.com/file.zip"
            style={{ flex: 1 }}
          />
          <button
            className="btn-secondary"
            onClick={() => void handleTest()}
            disabled={!testUrl.trim() || testing}
          >
            {testing ? i18n('options_testing') : i18n('options_test')}
          </button>
        </div>
        {testResult && (
          <div style={{
            fontSize: '12px',
            padding: '8px',
            borderRadius: '6px',
            marginTop: '8px',
            background: testResult.startsWith('✓') ? 'var(--accent-bg)' : 'var(--destructive-bg, #fee)',
            color: testResult.startsWith('✓') ? 'var(--accent)' : 'var(--destructive, red)',
          }}>
            {testResult}
          </div>
        )}
      </section>

      <section className="options-section">
        <h2>{i18n('options_filter_title')}</h2>
        <label>
          {i18n('options_threshold_label')}
          <input
            type="number"
            value={config.scoreThreshold}
            onChange={(e) => update('scoreThreshold', Number(e.target.value))}
            min={0}
            max={10}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.enableFilter}
            onChange={(e) => update('enableFilter', e.target.checked)}
          />
          {i18n('options_enable_filter_label')}
        </label>
      </section>

      <section className="options-section">
        <h2>{i18n('options_advanced_config_title')}</h2>

        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '13px', marginBottom: '8px' }}>{i18n('options_fingerprint_title')}</h3>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fpConfig.enableFingerprint}
              onChange={(e) => setFpConfig({ ...fpConfig, enableFingerprint: e.target.checked })}
            />
            {i18n('options_enable_fingerprint')}
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fpConfig.autoLearnFingerprints}
              onChange={(e) => setFpConfig({ ...fpConfig, autoLearnFingerprints: e.target.checked })}
            />
            {i18n('options_auto_learn_fingerprint')}
          </label>
          <label style={{ display: 'block', marginTop: '8px' }}>
            {i18n('options_fingerprint_mode')}
            <select
              value={fpConfig.fingerprintMode}
              onChange={(e) => setFpConfig({ ...fpConfig, fingerprintMode: e.target.value })}
              style={{ marginLeft: '8px' }}
            >
              <option value="off">{i18n('options_fp_mode_off')}</option>
              <option value="suspicious-only">{i18n('options_fp_mode_suspicious')}</option>
              <option value="all">{i18n('options_fp_mode_all')}</option>
            </select>
          </label>
          <label style={{ display: 'block', marginTop: '8px' }}>
            {i18n('options_remote_fp_url')}
            <input
              type="url"
              value={fpConfig.remoteFingerprintsUrl}
              onChange={(e) => setFpConfig({ ...fpConfig, remoteFingerprintsUrl: e.target.value })}
              placeholder="https://example.com/fingerprints.json"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
          <button
            className="btn-secondary"
            style={{ marginTop: '8px' }}
            onClick={async () => {
              try {
                await chrome.runtime.sendMessage({
                  type: 'setHlsFingerprintConfig',
                  payload: {
                    ...fpConfig,
                    enableFingerprint: true,
                    fingerprintMode: 'all',
                    autoLearnFingerprints: true,
                  },
                })
                setFpConfig({ ...fpConfig, enableFingerprint: true, fingerprintMode: 'all', autoLearnFingerprints: true })
                const r = await chrome.runtime.sendMessage({ type: 'getHlsFingerprintConfig' })
                alert(i18n('options_boost_result', [String(r?.learnedCount ?? 0)]))
              } catch (e) { alert(String(e)) }
            }}
          >
            🚀 {i18n('options_boost_detect')}
          </button>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '13px', marginBottom: '8px' }}>{i18n('options_filter_behavior_title')}</h3>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fullConfig.enableAdSkip}
              onChange={(e) => setFullConfig({ ...fullConfig, enableAdSkip: e.target.checked })}
            />
            {i18n('options_enable_ad_skip')}
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fullConfig.showPageBadge}
              onChange={(e) => setFullConfig({ ...fullConfig, showPageBadge: e.target.checked })}
            />
            {i18n('options_show_page_badge')}
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fullConfig.keepDiscontinuityOnGap}
              onChange={(e) => setFullConfig({ ...fullConfig, keepDiscontinuityOnGap: e.target.checked })}
            />
            {i18n('options_keep_discontinuity')}
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fullConfig.logToConsole}
              onChange={(e) => setFullConfig({ ...fullConfig, logToConsole: e.target.checked })}
            />
            {i18n('options_log_to_console')}
          </label>
          <label style={{ display: 'block', marginTop: '8px' }}>
            {i18n('options_output_mode')}
            <select
              value={fullConfig.mode}
              onChange={(e) => setFullConfig({ ...fullConfig, mode: e.target.value })}
              style={{ marginLeft: '8px' }}
            >
              <option value="m3u8-file">{i18n('options_mode_m3u8_file')}</option>
              <option value="data-url">{i18n('options_mode_data_url')}</option>
              <option value="enumerate">{i18n('options_mode_enumerate')}</option>
              <option value="passthrough">{i18n('options_mode_passthrough')}</option>
              <option value="disabled">{i18n('options_mode_disabled')}</option>
            </select>
          </label>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '13px', marginBottom: '8px' }}>{i18n('options_custom_rules_title')}</h3>
          <label style={{ display: 'block' }}>
            {i18n('options_url_patterns')}
            <textarea
              value={fullConfig.urlPatterns}
              onChange={(e) => setFullConfig({ ...fullConfig, urlPatterns: e.target.value })}
              placeholder={'/ads?/\ndoubleclick\\.com'}
              style={{ width: '100%', minHeight: '60px', marginTop: '4px', fontFamily: 'monospace', fontSize: '12px' }}
            />
          </label>
          <label style={{ display: 'block', marginTop: '8px' }}>
            {i18n('options_remote_rules_url')}
            <input
              type="url"
              value={fullConfig.remoteRulesUrl}
              onChange={(e) => setFullConfig({ ...fullConfig, remoteRulesUrl: e.target.value })}
              placeholder="https://example.com/velo-rules.json"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
        </div>

        <button
          className="btn-primary"
          style={{ marginTop: '8px' }}
          onClick={async () => {
            try {
              await chrome.runtime.sendMessage({ type: 'setHlsFingerprintConfig', payload: fpConfig })
              await chrome.runtime.sendMessage({
                type: 'setHlsFullConfig',
                payload: {
                  ...fullConfig,
                  urlPatterns: fullConfig.urlPatterns.split('\n').filter(Boolean),
                },
              })
              setAdvancedSaved(true)
              setTimeout(() => setAdvancedSaved(false), 2000)
            } catch (e) { alert(i18n('options_save_failed') + ': ' + (e as Error).message) }
          }}
        >
          {i18n('options_save_advanced_config')}
        </button>
        {advancedSaved && <span className="save-indicator">✅ {i18n('options_saved')}</span>}
      </section>

      <div className="options-actions">
        <button className="btn-primary" onClick={handleSave}>
          {i18n('options_save_config')}
        </button>
        {saved && <span className="save-indicator">✅ {i18n('options_saved')}</span>}
      </div>
    </PageLayout>
  )
}

createRoot(document.getElementById('root')!).render(<ConfigPage />)