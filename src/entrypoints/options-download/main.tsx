import { mountReact } from '@/lib/mount'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import { request } from '@/lib/messaging'
import '@/assets/options.css'

type DlClient = 'ndm' | 'aria2' | 'velo' | 'native'
type HeaderLevel = 'full' | 'partial' | 'none'

function DownloadPage() {
  const [dlClient, setDlClient] = useState<DlClient>('velo')
  const [rpcUrl, setRpcUrl] = useState('http://127.0.0.1:16816/jsonrpc')
  const [rpcSecret, setRpcSecret] = useState('')
  const [veloPort, setVeloPort] = useState('16888')
  const [veloToken, setVeloToken] = useState('')
  const [ndmUrl, setNdmUrl] = useState('ws://127.0.0.1:10007/download')
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
    const dl = await request<{
      client?: string
      rpcUrl?: string
      rpcSecret?: string
      ndmUrl?: string
      headerLevel?: string
      mergeFormat?: string
      autoPush?: boolean
    }>('getDownloadConfig')
    if (dl) {
      setDlClient((dl.client as DlClient) ?? 'velo')
      setRpcUrl(dl.rpcUrl ?? 'http://127.0.0.1:16816/jsonrpc')
      setRpcSecret(dl.rpcSecret ?? '')
      setNdmUrl(dl.ndmUrl ?? 'ws://127.0.0.1:10007/download')
      setHeaderLevel((dl.headerLevel as HeaderLevel) ?? 'full')
      setMergeFormat((dl.mergeFormat as 'ts' | 'mp4' | 'mkv' | 'keep') ?? 'ts')
      setAutoPush(dl.autoPush ?? false)
    }

    // 端口与 Token 的唯一来源是配对存储，不再从下载配置读取
    const pairing = await request<{ pairing?: { port?: number; token?: string } }>('velo-get-pairing')
    if (pairing?.pairing) {
      setVeloPort(String(pairing.pairing.port ?? 16888))
      setVeloToken(pairing.pairing.token ?? '')
    }

    const full = await request<{ mode?: string }>('getHlsFullConfig')
    if (full?.mode) setDeliveryMode(full.mode)
  }

  async function handleSave() {
    const a = await request('setDownloadConfig', {
      client: dlClient,
      rpcUrl,
      rpcSecret,
      ndmUrl,
      headerLevel,
      mergeFormat,
      autoPush,
    })
    const b = await request('setHlsFullConfig', { mode: deliveryMode })
    if (!a || !b) {
      alert(i18n('options_save_failed'))
      return
    }
    if (dlClient === 'velo') {
      const port = Number.parseInt(veloPort, 10)
      const saved = await request('velo-save-pairing', {
        token: veloToken,
        port: Number.isFinite(port) && port > 0 ? port : 16888,
      })
      if (!saved) {
        alert(i18n('options_save_failed'))
        return
      }
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleTest() {
    if (!testUrl) return
    setTesting(true)
    setTestResult(null)
    const r = await request<{ success?: boolean; message?: string; queued?: boolean; pending?: boolean; unconfirmed?: boolean }>('sendToDownload', {
      url: testUrl,
      pageUrl: testUrl,
    })
    if (!r) {
      setTestResult(`✗ ${i18n('options_test_failed')}`)
    } else if (r.queued) {
      setTestResult(`⏳ ${i18n('download_queued')}`)
    } else if (r.pending) {
      setTestResult(`⏳ ${i18n('push_pending_confirm')}`)
    } else if (r.unconfirmed) {
      setTestResult(`? ${i18n('push_unconfirmed')}`)
    } else {
      setTestResult(r.success ? i18n('options_download_sent') : `✗ ${r.message ?? i18n('options_test_failed')}`)
    }
    setTesting(false)
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
            <label>
              <span className="field-label">{i18n('options_ndm_url')}</span>
              <input
                value={ndmUrl}
                onChange={(e) => setNdmUrl(e.target.value)}
                placeholder="ws://127.0.0.1:10007/download"
              />
            </label>
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
              <span className="field-label">{i18n('options_velo_port')}</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={veloPort}
                onChange={(e) => setVeloPort(e.target.value)}
                placeholder="16888"
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

mountReact('root', <DownloadPage />)