import { useState, useEffect, useCallback } from 'react'
import '@/assets/popup.css'

export default function Popup() {
  const [paired, setPaired] = useState(false)
  const [port, setPort] = useState(16888)
  const [token, setToken] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    void loadStatus()
  }, [])

  async function loadStatus() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'sdown-get-status' })
      if (resp) {
        setPaired(resp.paired ?? false)
        if (resp.config?.port) setPort(resp.config.port)
      }
    } catch {
      setStatus('通信失败')
    }
  }

  const handlePair = useCallback(async () => {
    if (!token.trim()) {
      setStatus('请输入 Token')
      return
    }
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'sdown-validate-pairing',
        token: token.trim(),
        port,
      })
      if (resp?.ok) {
        await chrome.runtime.sendMessage({
          type: 'sdown-save-pairing',
          token: token.trim(),
          port,
        })
        setPaired(true)
        setStatus('配对成功！')
      } else {
        setStatus('配对失败，请检查 Token 和端口')
      }
    } catch (e) {
      setStatus(`配对出错: ${(e as Error).message}`)
    }
  }, [token, port])

  const handleClearPairing = useCallback(async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'sdown-clear-pairing' })
      setPaired(false)
      setToken('')
      setStatus('已清除配对')
    } catch (e) {
      setStatus(`清除出错: ${(e as Error).message}`)
    }
  }, [])

  const openOptions = useCallback(() => {
    void chrome.runtime.openOptionsPage()
  }, [])

  return (
    <div className="popup-container">
      <header className="popup-header">
        <img src="/icons/icon48.png" alt="sdown" className="popup-logo" />
        <h1>sdown</h1>
      </header>

      <div className="popup-status">
        {paired ? (
          <span className="status-paired">
            ✅ {chrome.i18n.getMessage('popup_paired', [String(port)])}
          </span>
        ) : (
          <span className="status-unpaired">
            ❌ {chrome.i18n.getMessage('popup_not_paired')}
          </span>
        )}
      </div>

      {!paired && (
        <div className="popup-pair-form">
          <label>
            端口
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              min={1024}
              max={65535}
            />
          </label>
          <label>
            Token
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="输入配对 Token"
            />
          </label>
          <button className="btn-primary" onClick={handlePair}>
            {chrome.i18n.getMessage('popup_pair_button')}
          </button>
        </div>
      )}

      {paired && (
        <button className="btn-secondary" onClick={handleClearPairing}>
          {chrome.i18n.getMessage('popup_repair_button')}
        </button>
      )}

      {status && <p className="popup-message">{status}</p>}

      <div className="popup-actions">
        <button className="btn-link" onClick={openOptions}>
          ⚙️ {chrome.i18n.getMessage('popup_settings_button')}
        </button>
      </div>
    </div>
  )
}
