import { createRoot } from 'react-dom/client'
import { useState, useEffect, useCallback } from 'react'
import { i18n } from '@/lib/i18n'
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

  useEffect(() => {
    void loadStatus()
  }, [])

  async function loadStatus() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'velo-get-status' })
      if (resp) {
        setPaired(resp.paired ?? false)
        if (resp.config?.port) setPort(resp.config.port)
      }
      if (!resp?.paired) {
        void handleAutoConnect()
      }
    } catch {
      setStatus(i18n('popup_comm_error'))
    }

    try {
      const full = await chrome.runtime.sendMessage({ type: 'getHlsFullConfig' })
      if (full) {
        setHlsEnabled(full.enableAdSkip ?? true)
      }
    } catch { /* ignore */ }

    try {
      const dl = await chrome.runtime.sendMessage({ type: 'getDownloadConfig' }) as {
        client: string
      }
      if (dl?.client) setDlClient(dl.client as DlClient)
    } catch { /* ignore */ }

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tabId = tabs[0]?.id ?? 0
      if (tabId > 0) {
        const r = await chrome.runtime.sendMessage({
          type: 'getLastDetect',
          payload: { tabId },
        }) as { report: { ads: number; total: number; adDuration: number }; baseUrl: string } | null
        if (r?.report?.ads && r.report.ads > 0) {
          setDetectInfo(r)
        }
      }
    } catch { /* ignore */ }

    try {
      const stats = await chrome.runtime.sendMessage({ type: 'getHlsStats' })
      if (stats?.total?.ads) setTotalFiltered(stats.total.ads)
    } catch { /* ignore */ }
  }

  const handleAutoConnect = useCallback(async () => {
    setProbing(true)
    setStatus(i18n('popup_probing'))
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'velo-auto-connect' })
      if (resp?.connected) {
        setPaired(true)
        if (resp.port) setPort(resp.port)
        setStatus('')
      } else {
        setStatus(i18n('popup_client_not_found'))
      }
    } catch {
      setStatus(i18n('popup_client_not_found'))
    } finally {
      setProbing(false)
    }
  }, [])

  const handleClearPairing = useCallback(async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'velo-clear-pairing' })
      setPaired(false)
      setStatus('')
    } catch (e) {
      setStatus(i18n('popup_clear_error', [(e as Error).message]))
    }
  }, [])

  async function handleHlsToggle(v: boolean) {
    setHlsEnabled(v)
    try {
      await chrome.runtime.sendMessage({
        type: 'setHlsFullConfig',
        payload: { enableAdSkip: v },
      })
    } catch {
      setHlsEnabled(!v)
    }
  }

  async function handleDownloadCleanM3u8() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tabId = tabs[0]?.id ?? 0
      if (tabId <= 0) return
      await chrome.runtime.sendMessage({
        type: 'sendToDownload',
        payload: { tabId, action: 'download-clean-m3u8' },
      })
    } catch (e) {
      alert(i18n('popup_download_fail', [(e as Error).message]))
    }
  }

  async function handleCopyMediaUrl() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tabId = tabs[0]?.id ?? 0
      if (tabId <= 0) return
      const items = await chrome.runtime.sendMessage({
        type: 'getMediaItems',
        payload: { tabId },
      }) as Array<{ url: string }>
      if (items && items.length > 0 && items[0]) {
        await navigator.clipboard.writeText(items[0].url)
        setStatus(i18n('popup_url_copied'))
      } else {
        setStatus(i18n('popup_no_media'))
      }
    } catch {
      setStatus(i18n('popup_no_media'))
    }
  }

  async function handleSampleSave() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) {
        alert(i18n('popup_no_active_tab'))
        return
      }
      let pb: { ok?: boolean; currentTime?: number; error?: string } | undefined
      try {
        pb = await chrome.tabs.sendMessage(tab.id!, { type: 'getPlayback' })
      } catch {
        pb = { ok: false, error: 'content script not available' }
      }
      if (!pb?.ok) {
        alert(i18n('popup_playback_read_fail') + ': ' + (pb?.error || i18n('popup_play_video_first')))
        return
      }
      const r = await chrome.runtime.sendMessage({
        type: 'captureSample',
        payload: { tabId: tab.id, currentTime: pb?.currentTime ?? 0 },
      }) as { success?: boolean; error?: string }
      if (r?.success) {
        alert(i18n('popup_sample_saved', [String(Math.round(pb?.currentTime ?? 0))]))
      } else {
        alert(i18n('popup_capture_fail', [r?.error ?? i18n('popup_unknown_error')]))
      }
    } catch (e) {
      alert(i18n('popup_capture_fail', [(e as Error).message]))
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

const rootEl = document.getElementById('root')!
if (!(rootEl as any)._reactRoot) {
  ;(rootEl as any)._reactRoot = createRoot(rootEl)
}
;(rootEl as any)._reactRoot.render(<Popup />)