import { createRoot } from 'react-dom/client'
import { useState, useEffect, useCallback } from 'react'
import { i18n } from '@/lib/i18n'
import '@/assets/popup.css'

function Popup() {
  const [paired, setPaired] = useState(false)
  const [port, setPort] = useState(16888)
  const [token, setToken] = useState('')
  const [status, setStatus] = useState('')

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
    } catch {
      setStatus(i18n('popup_comm_error'))
    }
  }

  const handlePair = useCallback(async () => {
    if (!token.trim()) {
      setStatus(i18n('popup_token_required'))
      return
    }
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
      setStatus(i18n('popup_clear_success'))
    } catch (e) {
      setStatus(i18n('popup_clear_error', [(e as Error).message]))
    }
  }, [])

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
          <button className="btn-primary" onClick={handlePair}>
            {i18n('popup_pair_button')}
          </button>
        </div>
      )}

      {paired && (
        <button className="btn-secondary" onClick={handleClearPairing}>
          {i18n('popup_repair_button')}
        </button>
      )}

      {status && <p className="popup-message">{status}</p>}

      <div className="popup-actions">
        <button className="btn-link" onClick={openOptions}>
          ⚙️ {i18n('popup_settings_button')}
        </button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Popup />)