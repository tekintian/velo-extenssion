import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

type DlClient = 'ndm' | 'aria2' | 'velo' | 'native'
type HeaderLevel = 'full' | 'partial' | 'none'

function DownloadPage() {
  const [dlClient, setDlClient] = useState<DlClient>('velo')
  const [rpcUrl, setRpcUrl] = useState('http://127.0.0.1:16816/jsonrpc')
  const [rpcSecret, setRpcSecret] = useState('')
  const [veloUrl, setVeloUrl] = useState('ws://127.0.0.1:16888/ws')
  const [veloToken, setVeloToken] = useState('')
  const [showVeloToken, setShowVeloToken] = useState(false)
  const [deliveryMode, setDeliveryMode] = useState('m3u8-file')
  const [headerLevel, setHeaderLevel] = useState<HeaderLevel>('full')
  const [mergeFormat, setMergeFormat] = useState<'ts' | 'mp4' | 'mkv' | 'keep'>('ts')
  const [autoPush, setAutoPush] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testUrl, setTestUrl] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void loadConfig()
  }, [])

  async function loadConfig() {
    try {
      const dl = await chrome.runtime.sendMessage({ type: 'getDownloadConfig' }) as {
        client: string; rpcUrl: string; rpcSecret: string
        veloUrl: string; veloToken: string
        headerLevel?: string
        mergeFormat?: string
        autoPush?: boolean
      }
      if (dl) {
        setDlClient((dl.client as DlClient) ?? 'velo')
        setRpcUrl(dl.rpcUrl ?? 'http://127.0.0.1:16816/jsonrpc')
        setRpcSecret(dl.rpcSecret ?? '')
        setVeloUrl(dl.veloUrl ?? 'ws://127.0.0.1:16888/ws')
        setVeloToken(dl.veloToken ?? '')
        setHeaderLevel((dl.headerLevel as HeaderLevel) ?? 'full')
        setMergeFormat((dl.mergeFormat as 'ts' | 'mp4' | 'mkv' | 'keep') ?? 'ts')
        setAutoPush(dl.autoPush ?? false)
      }
    } catch { /* ignore */ }
    try {
      const full = await chrome.runtime.sendMessage({ type: 'getHlsFullConfig' })
      if (full?.mode) setDeliveryMode(full.mode)
    } catch { /* ignore */ }
  }

  async function handleSave() {
    try {
      await chrome.runtime.sendMessage({
        type: 'setDownloadConfig',
        payload: { client: dlClient, rpcUrl, rpcSecret, veloUrl, veloToken, headerLevel, mergeFormat, autoPush },
      })
      await chrome.runtime.sendMessage({
        type: 'setHlsFullConfig',
        payload: { mode: deliveryMode },
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
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
      setTestResult(r.success ? i18n('options_download_sent') : `✗ ${r.message ?? i18n('options_test_failed')}`)
    } catch (e) {
      setTestResult(`✗ ${(e as Error).message}`)
    } finally {
      setTesting(false)
    }
  }

  const CLIENTS: { id: DlClient; icon: string; nameKey: string; descKey: string; defaultUrl: string }[] = [
    { id: 'native', icon: '🌐', nameKey: 'options_browser_native', descKey: 'options_use_chrome_download', defaultUrl: '' },
    { id: 'aria2', icon: '⚡', nameKey: 'options_aria2_client', descKey: 'options_http_json_rpc', defaultUrl: 'http://127.0.0.1:16816/jsonrpc' },
    { id: 'ndm', icon: '📥', nameKey: 'options_ndm_desktop', descKey: 'options_ws_protocol', defaultUrl: 'ws://127.0.0.1:10007/download' },
    { id: 'velo', icon: '🚀', nameKey: 'options_velo_client', descKey: 'options_velo_protocol', defaultUrl: 'ws://127.0.0.1:16888/ws' },
  ]

  const DELIVERY_MODES: { id: string; labelKey: string }[] = [
    { id: 'm3u8-file', labelKey: 'options_mode_m3u8_file' },
    { id: 'data-url', labelKey: 'options_mode_data_url' },
    { id: 'enumerate', labelKey: 'options_mode_enumerate' },
    { id: 'passthrough', labelKey: 'options_mode_passthrough' },
  ]

  const HEADER_LEVELS: { id: HeaderLevel; labelKey: string; descKey: string }[] = [
    { id: 'full', labelKey: 'options_header_full', descKey: 'options_header_full_desc' },
    { id: 'partial', labelKey: 'options_header_partial', descKey: 'options_header_partial_desc' },
    { id: 'none', labelKey: 'options_header_none', descKey: 'options_header_none_desc' },
  ]

  return (
    <PageLayout title={i18n('options_nav_download')}>
      <section className="options-section">
        <h2>{i18n('options_download_client_title')}</h2>
        <p className="section-desc">{i18n('options_download_client_desc')}</p>

        <div className="client-grid">
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              className={`client-btn ${dlClient === c.id ? 'client-btn-active' : ''}`}
              onClick={() => setDlClient(c.id)}
            >
              <span className="client-btn-name">{c.icon} {i18n(c.nameKey)}</span>
              <span className="client-btn-desc">{i18n(c.descKey)}</span>
            </button>
          ))}
        </div>

        {dlClient === 'aria2' && (
          <div className="sub-fields">
            <label>
              <span className="field-label">{i18n('options_rpc_url') ?? 'RPC 地址'}</span>
              <input
                value={rpcUrl}
                onChange={(e) => setRpcUrl(e.target.value)}
                placeholder="http://127.0.0.1:16816/jsonrpc"
              />
            </label>
            <label>
              <span className="field-label">{i18n('options_rpc_secret')}</span>
              <input type="password" value={rpcSecret} onChange={(e) => setRpcSecret(e.target.value)} placeholder={i18n('options_rpc_secret_placeholder')} />
            </label>
          </div>
        )}

        {dlClient === 'ndm' && (
          <div className="sub-fields">
            <div className="hint-box hint-box-url">
              <span className="url-label">{i18n('options_default_url')}:</span>
              <code className="url-code">ws://127.0.0.1:10007/download</code>
            </div>
            <div className="hint-box">{i18n('options_ndm_hint')}</div>
          </div>
        )}

        {dlClient === 'velo' && (
          <div className="sub-fields">
            <div className="hint-box hint-box-url">
              <span className="url-label">{i18n('options_default_url')}:</span>
              <code className="url-code">ws://127.0.0.1:16888/ws</code>
            </div>
            <label>
              <span className="field-label">{i18n('options_velo_url')}</span>
              <input
                value={veloUrl}
                onChange={(e) => setVeloUrl(e.target.value)}
                placeholder="ws://127.0.0.1:16888/ws"
              />
            </label>
            <label>
              <span className="field-label">{i18n('options_velo_token')}</span>
              <div className="input-with-toggle">
                <input
                  type={showVeloToken ? 'text' : 'password'}
                  value={veloToken}
                  onChange={(e) => setVeloToken(e.target.value)}
                  placeholder={i18n('options_velo_token_placeholder')}
                />
                <button
                  type="button"
                  className="btn-toggle-visibility"
                  onClick={() => setShowVeloToken(!showVeloToken)}
                  title={showVeloToken ? (i18n('options_hide') ?? '隐藏') : (i18n('options_show') ?? '显示')}
                >
                  {showVeloToken ? '🙈' : '👁️'}
                </button>
              </div>
            </label>
            <div className="hint-box">{i18n('options_velo_hint')}</div>
          </div>
        )}

        {dlClient === 'native' && (
          <div className="hint-box">{i18n('options_native_hint')}</div>
        )}
      </section>

      <section className="options-section">
        <h2>{i18n('options_hls_delivery_mode')}</h2>
        <div className="mode-grid">
          {DELIVERY_MODES.map((m) => (
            <button
              key={m.id}
              className={`mode-btn ${deliveryMode === m.id ? 'mode-btn-active' : ''}`}
              onClick={() => setDeliveryMode(m.id)}
            >
              {i18n(m.labelKey)}
            </button>
          ))}
        </div>
      </section>

      <section className="options-section">
        <h2>{i18n('options_header_forward_title')}</h2>
        <p className="section-desc">{i18n('options_header_forward_desc')}</p>
        <div className="mode-grid">
          {HEADER_LEVELS.map((h) => (
            <button
              key={h.id}
              className={`mode-btn ${headerLevel === h.id ? 'mode-btn-active' : ''}`}
              onClick={() => setHeaderLevel(h.id)}
            >
              <span className="mode-btn-label">{i18n(h.labelKey)}</span>
              <span className="mode-btn-desc">{i18n(h.descKey)}</span>
            </button>
          ))}
        </div>
        {headerLevel !== 'full' && (
          <div className="hint-box">{i18n('options_header_forward_hint')}</div>
        )}
      </section>

      <section className="options-section">
        <h2>{i18n('options_push_title')}</h2>
        <label>
          {i18n('options_merge_format_label')}
          <select value={mergeFormat} onChange={(e) => setMergeFormat(e.target.value as 'ts' | 'mp4' | 'mkv' | 'keep')}>
            <option value="ts">TS</option>
            <option value="mp4">MP4</option>
            <option value="mkv">MKV</option>
            <option value="keep">Keep Original</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={autoPush}
            onChange={(e) => setAutoPush(e.target.checked)}
          />
          {i18n('options_auto_push_label')}
        </label>
      </section>

      <section className="options-section">
        <h2>{i18n('options_test_download')}</h2>
        <p className="section-desc">{i18n('options_test_download_desc')}</p>
        <div className="test-row">
          <input
            value={testUrl}
            onChange={(e) => setTestUrl(e.target.value)}
            placeholder="https://example.com/file.zip"
            className="test-input"
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
          <div className={`test-result ${testResult.startsWith('✓') ? 'test-ok' : 'test-err'}`}>
            {testResult}
          </div>
        )}
      </section>

      <div className="options-actions">
        <button className="btn-primary" onClick={() => void handleSave()}>
          {saved ? `✅ ${i18n('options_saved')}` : i18n('options_save_config')}
        </button>
      </div>
    </PageLayout>
  )
}

const rootEl = document.getElementById('root')!
if (!(rootEl as any)._reactRoot) {
  ;(rootEl as any)._reactRoot = createRoot(rootEl)
}
;(rootEl as any)._reactRoot.render(<DownloadPage />)