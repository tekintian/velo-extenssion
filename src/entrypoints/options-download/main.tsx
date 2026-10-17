import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

type DlClient = 'ndm' | 'aria2' | 'velo' | 'native'

function DownloadPage() {
  const [dlClient, setDlClient] = useState<DlClient>('native')
  const [rpcHost, setRpcHost] = useState('localhost')
  const [rpcPort, setRpcPort] = useState(16816)
  const [rpcSecret, setRpcSecret] = useState('')
  const [veloHost, setVeloHost] = useState('127.0.0.1')
  const [veloPort, setVeloPort] = useState(16888)
  const [veloToken, setVeloToken] = useState('')
  const [deliveryMode, setDeliveryMode] = useState('m3u8-file')
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
    try {
      const full = await chrome.runtime.sendMessage({ type: 'getHlsFullConfig' })
      if (full?.mode) setDeliveryMode(full.mode)
    } catch { /* ignore */ }
  }

  async function handleSave() {
    try {
      await chrome.runtime.sendMessage({
        type: 'setDownloadConfig',
        payload: { client: dlClient, rpcHost, rpcPort, rpcSecret, veloHost, veloPort, veloToken },
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
            <div className="field-row-2">
              <label>
                <span className="field-label">{i18n('options_rpc_host')}</span>
                <input value={rpcHost} onChange={(e) => setRpcHost(e.target.value)} placeholder="localhost" />
              </label>
              <label>
                <span className="field-label">{i18n('options_rpc_port')}</span>
                <input type="number" value={rpcPort} onChange={(e) => setRpcPort(parseInt(e.target.value, 10) || 16816)} placeholder="16816" />
              </label>
            </div>
            <label>
              <span className="field-label">{i18n('options_rpc_secret')}</span>
              <input type="password" value={rpcSecret} onChange={(e) => setRpcSecret(e.target.value)} placeholder={i18n('options_rpc_secret_placeholder')} />
            </label>
          </div>
        )}

        {dlClient === 'ndm' && (
          <div className="hint-box">{i18n('options_ndm_hint')}</div>
        )}

        {dlClient === 'velo' && (
          <div className="sub-fields">
            <div className="field-row-2">
              <label>
                <span className="field-label">{i18n('options_velo_host')}</span>
                <input value={veloHost} onChange={(e) => setVeloHost(e.target.value)} placeholder="127.0.0.1" />
              </label>
              <label>
                <span className="field-label">{i18n('options_velo_port')}</span>
                <input type="number" value={veloPort} onChange={(e) => setVeloPort(parseInt(e.target.value, 10) || 16888)} placeholder="16888" />
              </label>
            </div>
            <label>
              <span className="field-label">{i18n('options_velo_token')}</span>
              <input type="password" value={veloToken} onChange={(e) => setVeloToken(e.target.value)} placeholder={i18n('options_velo_token_placeholder')} />
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

createRoot(document.getElementById('root')!).render(<DownloadPage />)