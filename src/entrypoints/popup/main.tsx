import { mountReact } from '@/lib/mount'
import { useState, useEffect, useCallback } from 'react'
import { i18n } from '@/lib/i18n'
import { request, requestArray } from '@/lib/messaging'
import '@/assets/popup.css'

type DlClient = 'ndm' | 'aria2' | 'velo' | 'native'

const DL_CLIENT_LABELS: Record<DlClient, string> = {
  native: 'Chrome',
  aria2: 'Motrix/aria2',
  ndm: 'NDM',
  velo: 'Velo',
}

function Popup() {
  const [paired, setPaired] = useState(false)
  const [probing, setProbing] = useState(false)
  const [port, setPort] = useState(16888)
  const [status, setStatus] = useState('')

  const [hlsEnabled, setHlsEnabled] = useState(true)
  const [detectInfo, setDetectInfo] = useState<{
    report: { ads: number; total: number; adDuration: number }
    baseUrl: string
  } | null>(null)
  const [dlClient, setDlClient] = useState<DlClient>('native')
  const [totalFiltered, setTotalFiltered] = useState(0)
  const [version] = useState(() => chrome.runtime.getManifest().version)

  const handleAutoConnect = useCallback(async () => {
    setProbing(true)
    setStatus(i18n('popup_probing'))
    const resp = await request<{ connected?: boolean; port?: number }>('velo-auto-connect')
    if (resp?.connected) {
      setPaired(true)
      if (resp.port) setPort(resp.port)
      setStatus('')
    } else {
      setStatus(i18n('popup_client_not_found'))
    }
    setProbing(false)
  }, [])

  const loadStatus = useCallback(async () => {
    const st = await request<{
      paired?: boolean
      config?: { port?: number }
    }>('velo-get-status')
    if (!st) {
      setStatus(i18n('popup_comm_error'))
    } else {
      setPaired(st.paired ?? false)
      if (st.config?.port) setPort(st.config.port)
      if (!st.paired) void handleAutoConnect()
    }

    const full = await request<{ enableAdSkip?: boolean }>('getHlsFullConfig')
    if (full) setHlsEnabled(full.enableAdSkip ?? true)

    const dl = await request<{ client?: string }>('getDownloadConfig')
    if (dl?.client) setDlClient(dl.client as DlClient)

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tabId = tabs[0]?.id ?? 0
      if (tabId > 0) {
        const r = await request<{
          report: { ads: number; total: number; adDuration: number }
          baseUrl: string
        }>('getLastDetect', { tabId })
        if (r?.report?.ads && r.report.ads > 0) setDetectInfo(r)
      }
    } catch { /* ignore */ }

    const stats = await request<{ total?: { ads?: number } }>('getHlsStats')
    if (stats?.total?.ads) setTotalFiltered(stats.total.ads)
  }, [handleAutoConnect])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const handleClearPairing = useCallback(async () => {
    const r = await request('velo-clear-pairing')
    if (!r) {
      setStatus(i18n('popup_comm_error'))
      return
    }
    setPaired(false)
    setStatus('')
  }, [])

  async function handleHlsToggle(v: boolean) {
    setHlsEnabled(v)
    const r = await request('setHlsFullConfig', { enableAdSkip: v })
    if (!r) setHlsEnabled(!v)
  }

  async function handleDownloadCleanM3u8() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabId = tabs[0]?.id ?? 0
    if (tabId <= 0) {
      alert(i18n('popup_no_active_tab'))
      return
    }
    const r = await request<{ ok?: boolean; filename?: string; error?: string }>('downloadCleanedM3u8', {
      tabId,
    })
    if (!r) {
      alert(i18n('popup_download_fail', [i18n('popup_comm_error')]))
      return
    }
    if (r.ok) {
      setStatus(i18n('popup_clean_m3u8_sent'))
      return
    }
    alert(i18n('popup_download_fail', [r.error ?? i18n('popup_unknown_error')]))
  }

  async function handleCopyMediaUrl() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabId = tabs[0]?.id ?? 0
    if (tabId <= 0) return
    const items = await requestArray<{ url: string }>('getMediaItems', { tabId })
    if (items && items.length > 0 && items[0]) {
      try {
        await navigator.clipboard.writeText(items[0].url)
        setStatus(i18n('popup_url_copied'))
      } catch {
        setStatus(i18n('popup_copy_fail'))
      }
    } else {
      setStatus(i18n('popup_no_media'))
    }
  }

  async function handleSampleSave() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) {
      alert(i18n('popup_no_active_tab'))
      return
    }
    let pb: { ok?: boolean; currentTime?: number; error?: string } | undefined
    try {
      pb = await chrome.tabs.sendMessage(tab.id, { type: 'getPlayback' }) as
        { ok?: boolean; currentTime?: number; error?: string } | undefined
    } catch {
      pb = { ok: false, error: 'content script not available' }
    }
    if (!pb?.ok) {
      alert(i18n('popup_playback_read_fail') + ': ' + (pb?.error || i18n('popup_play_video_first')))
      return
    }
    const r = await request<{ success?: boolean; error?: string }>('captureSample', {
      tabId: tab.id,
      currentTime: pb.currentTime ?? 0,
    })
    if (r?.success) {
      alert(i18n('popup_sample_saved', [String(Math.round(pb.currentTime ?? 0))]))
    } else {
      alert(i18n('popup_capture_fail', [r?.error ?? i18n('popup_unknown_error')]))
    }
  }

  const openOptions = useCallback(() => {
    void chrome.runtime.openOptionsPage()
  }, [])

  return (
    <div className="popup-container">
      <header className="popup-header">
        <img src="/icons/icon48.png" alt="velo" className="popup-logo" />
        <div className="popup-header-text">
          <h1>velo</h1>
          <span className="popup-version">v{version}</span>
        </div>
        <button className="popup-settings-btn" onClick={openOptions} title={i18n('popup_settings_button')}>
          ⚙
        </button>
      </header>

      <div className="popup-status-row">
        <div className={`popup-status-card ${paired ? 'status-ok' : 'status-err'}`}>
          <span className="status-card-label">{i18n('popup_desktop_client')}</span>
          <span className="status-card-value">
            {paired ? `✅ ${i18n('popup_connected')}` : `❌ ${i18n('popup_not_paired')}`}
          </span>
          {paired && <span className="status-card-detail">port {port}</span>}
        </div>
        <div className={`popup-status-card ${hlsEnabled ? 'status-ok' : 'status-err'}`}>
          <span className="status-card-label">{i18n('popup_ad_filter')}</span>
          <span className="status-card-value">
            {hlsEnabled ? `🟢 ${i18n('popup_enabled')}` : `⚪ ${i18n('popup_disabled')}`}
          </span>
          {hlsEnabled && totalFiltered > 0 && (
            <span className="status-card-detail">{i18n('popup_filtered_count', [String(totalFiltered)])}</span>
          )}
        </div>
      </div>

      {detectInfo && (
        <div className="popup-detect-card">
          <div className="popup-detect-title">{i18n('popup_hls_detect')}</div>
          <div className="popup-detect-grid">
            <div>
              <span className="popup-detect-label">{i18n('popup_ad_segments')}</span>
              <span className="popup-detect-value">{detectInfo.report.ads}</span>
              <span className="popup-detect-label">/{detectInfo.report.total}</span>
            </div>
            <div>
              <span className="popup-detect-label">{i18n('popup_ad_duration')}</span>
              <span className="popup-detect-value">{detectInfo.report.adDuration}s</span>
            </div>
          </div>
          <div className="popup-quick-actions">
            <button className="btn-quick-primary" onClick={() => void handleDownloadCleanM3u8()}>
              📥 {i18n('popup_download_clean_m3u8')}
            </button>
            <button className="btn-quick-ghost" onClick={() => void handleCopyMediaUrl()}>
              🔗 {i18n('popup_copy_media_url')}
            </button>
          </div>
        </div>
      )}

      <div className="popup-section">
        <div className="popup-switch-row">
          <div className="popup-switch-info">
            <div className="popup-switch-label">{i18n('popup_hls_ad_filter')}</div>
            <div className="popup-switch-desc">{i18n('popup_hls_ad_filter_desc')}</div>
          </div>
          <label className="popup-toggle">
            <input
              type="checkbox"
              checked={hlsEnabled}
              onChange={(e) => void handleHlsToggle(e.target.checked)}
            />
            <span className="popup-toggle-slider" />
          </label>
        </div>
      </div>

      <div className="popup-actions">
        <button className="btn-sample" onClick={() => void handleSampleSave()}>
          📋 {i18n('popup_hls_sample_save')}
        </button>
        {!paired && (
          <button className="btn-secondary" onClick={() => void handleAutoConnect()} disabled={probing}>
            {probing ? i18n('popup_probing') : i18n('popup_auto_connect_button')}
          </button>
        )}
        {paired && (
          <button className="btn-ghost" onClick={handleClearPairing}>
            {i18n('popup_repair_button')}
          </button>
        )}
      </div>

      {status && <p className="popup-message">{status}</p>}

      <div className="popup-footer">
        <span className="popup-dl-client">
          {i18n('popup_download_client')}: {DL_CLIENT_LABELS[dlClient]}
        </span>
        <button className="popup-open-options" onClick={openOptions}>
          ↗ {i18n('popup_open_settings')}
        </button>
      </div>
    </div>
  )
}

mountReact('root', <Popup />)