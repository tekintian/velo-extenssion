import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import '@/assets/options.css'

interface SampleItem {
  id: string
  currentTime: number
  windowSegments: number
  host: string
  timestamp: number
  baseUrl: string
}

function SamplesPage() {
  const [samples, setSamples] = useState<SampleItem[]>([])
  const [loading, setLoading] = useState(true)

  const loadSamples = async () => {
    setLoading(true)
    try {
      const r = await chrome.runtime.sendMessage({ type: 'listSamples' })
      if (Array.isArray(r)) setSamples(r)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { void loadSamples() }, [])

  const handleCapture = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) throw new Error('未找到活动标签页')
      // 1. 从 content script 获取当前播放时间（对齐 NDM popup.js ndm-get-playback）
      const pb = await chrome.tabs.sendMessage(tab.id, { type: 'getPlayback' })
      if (!pb?.ok) throw new Error('读取播放状态失败: ' + (pb?.error || '?'))
      // 2. 发送给 background 捕获样本 + auto-learn（对齐 NDM popup.js ndm-capture-sample）
      const result = await chrome.runtime.sendMessage({
        type: 'captureSample',
        payload: { tabId: tab.id, currentTime: pb.currentTime },
      })
      if (!result?.success) throw new Error('捕获失败: ' + (result?.message || result?.error || '?'))
      alert(i18n('options_sample_captured') + ` (t=${Math.round(pb.currentTime)}s)`)
      void loadSamples()
    } catch (e) { alert(String(e)) }
  }

  const handleDelete = async (id: string) => {
    try {
      await chrome.runtime.sendMessage({ type: 'deleteSample', payload: { id } })
      void loadSamples()
    } catch (e) { alert(String(e)) }
  }

  return (
    <PageLayout title={i18n('options_nav_samples')}>
      <section className="options-section">
        <h2>{i18n('options_samples_title')}</h2>
        <div className="hls-actions">
          <button className="btn-primary" onClick={() => void handleCapture()}>
            📋 {i18n('options_capture_sample')}
          </button>
          <button className="btn-secondary" onClick={() => void loadSamples()}>
            {i18n('options_refresh')}
          </button>
        </div>
      </section>

      <section className="options-section">
        {loading ? (
          <p>{i18n('options_loading')}</p>
        ) : samples.length === 0 ? (
          <p>{i18n('options_no_samples')}</p>
        ) : (
          <table className="stats-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>{i18n('options_sample_host')}</th>
                <th>{i18n('options_sample_time')}</th>
                <th>{i18n('options_sample_window')}</th>
                <th>{i18n('options_sample_timestamp')}</th>
                <th>{i18n('options_sample_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {samples.map((s) => (
                <tr key={s.id}>
                  <td className="sample-id">{s.id.slice(0, 8)}</td>
                  <td>{s.host}</td>
                  <td>{s.currentTime.toFixed(1)}s</td>
                  <td>{s.windowSegments}</td>
                  <td>{new Date(s.timestamp).toLocaleString()}</td>
                  <td>
                    <button className="btn-danger" style={{ padding: '2px 8px', fontSize: '11px' }} onClick={() => void handleDelete(s.id)}>
                      {i18n('options_delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="hls-actions">
        <button className="btn-danger" onClick={async () => {
          if (!confirm(i18n('options_confirm_clear_samples'))) return
          try {
            await chrome.runtime.sendMessage({ type: 'clearSamples' })
            setSamples([])
          } catch (e) { alert(String(e)) }
        }}>
          {i18n('options_clear_all_samples')}
        </button>
      </div>
    </PageLayout>
  )
}

createRoot(document.getElementById('root')!).render(<SamplesPage />)