import { createRoot } from 'react-dom/client'
import { useState, useEffect, useCallback } from 'react'
import { i18n } from '@/lib/i18n'
import '@/assets/popup.css'

function Popup() {
  const [paired, setPaired] = useState(false)
  const [probing, setProbing] = useState(false)
  const [port, setPort] = useState(16888)
  const [token, setToken] = useState('')
  const [status, setStatus] = useState('')

  const [hlsEnabled, setHlsEnabled] = useState(true)
  const [detectInfo, setDetectInfo] = useState<{
    report: { ads: number; total: number; adDuration: number }
    baseUrl: string
  } | null>(null)

  useEffect(() => {
    void loadStatus()
  }, [])

  async function loadStatus() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'velo-get-status' })
      if (resp) {
        setPaired(resp.paired ?? false)
        if (resp.config?.port) setPort(resp.config.port)
        if (resp.config?.token) setToken(resp.config.token)
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
  }

  const handleAutoConnect = useCallback(async () => {
    setProbing(true)
    setStatus(i18n('popup_probing'))
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'velo-auto-connect' })
      if (resp?.connected) {
        setPaired(true)
        if (resp.port) setPort(resp.port)
        setStatus(i18n('popup_auto_connected', [String(resp.port)]))
      } else {
        setStatus(i18n('popup_client_not_found'))
      }
    } catch {
      setStatus(i18n('popup_client_not_found'))
    } finally {
      setProbing(false)
    }
  }, [])

  const handlePair = useCallback(async () => {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'velo-validate-pairing',
        token: token.trim(),
        port,
      })
      if (resp?.ok) {
        await chrome.runtime.sendMessage({
          type: 'velo-save-pairing',
          token: token.trim(),
          port,
        })
        setPaired(true)
        setStatus(i18n('popup_pair_success'))
      } else {
        setStatus(i18n('popup_pair_failed'))
      }
    } catch (e) {
      setStatus(i18n('popup_pair_error', [(e as Error).message]))
    }
  }, [token, port])

  const handleClearPairing = useCallback(async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'velo-clear-pairing' })
      setPaired(false)
      setToken('')
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

  async function handleSampleSave() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) {
        alert(i18n('popup_no_active_tab'))
        return
      }
      let pb: { ok?: boolean; currentTime?: number; error?: string } | undefined
      try {
        pb = await chrome.tabs.sendMessage(tab.id, { type: 'getPlayback' })
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
        <h1>velo</h1>
      </header>

      <div className="popup-status">
        {paired ? (
          <span className="status-paired">
            ✅ {i18n('popup_paired', [String(port)])}
          </span>
        ) : (
          <span className="status-unpaired">
            ❌ {i18n('popup_not_paired')}
          </span>
        )}
      </div>

      {!paired && (
        <div className="popup-pair-form">
          <label>
            {i18n('popup_port_label')}
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              min={1024}
              max={65535}
            />
          </label>
          <label>
            {i18n('popup_token_label')}
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={i18n('popup_token_placeholder')}
            />
          </label>
          <button className="btn-primary" onClick={handlePair} disabled={probing}>
            {i18n('popup_pair_button')}
          </button>
          <button className="btn-secondary" onClick={handleAutoConnect} disabled={probing}>
            {probing ? i18n('popup_probing') : i18n('popup_auto_connect_button')}
          </button>
        </div>
      )}

      {paired && (
        <button className="btn-secondary" onClick={handleClearPairing}>
          {i18n('popup_repair_button')}
        </button>
      )}

      {status && <p className="popup-message">{status}</p>}

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
        </div>
      )}

      <div className="popup-actions">
        <button
          className="btn-sample"
          onClick={() => void handleSampleSave()}
        >
          🐛 {i18n('popup_hls_sample_save')}
        </button>
        <button className="btn-link" onClick={openOptions}>
          ⚙️ {i18n('popup_settings_button')}
        </button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Popup />)