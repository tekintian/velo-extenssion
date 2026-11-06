import { mountReact } from '@/lib/mount'
import { useState, useEffect, useCallback } from 'react'
import { i18n } from '@/lib/i18n'
import { request, requestArray } from '@/lib/messaging'
import { queryPlayback } from '@/lib/playback'
import '@/assets/popup.css'

type DlClient = 'ndm' | 'aria2' | 'velo' | 'native'

const DL_CLIENT_LABELS: Record<DlClient, string> = {
  native: 'Chrome',
  aria2: 'Motrix/aria2',
  ndm: 'NDM',
  velo: 'Velo',
}

const DL_CLIENT_HOMEPAGES: Record<DlClient, string> = {
  native: 'https://www.google.com/chrome/',
  aria2: 'https://motrix.app/download/',
  ndm: 'https://neatdownloadmanager.com/',
  velo: 'https://velo.tekin.cn',
}

function Popup() {
  const [paired, setPaired] = useState(false)
  const [probing, setProbing] = useState(false)
  const [port, setPort] = useState(16888)
  const [status, setStatus] = useState('')

  const [filterEnabled, setFilterEnabled] = useState(true)
  const [detectInfo, setDetectInfo] = useState<{
    report: { ads: number; total: number; adDuration: number }
    baseUrl: string
    playback: 'cleaned' | 'original'
  } | null>(null)
  const [dlClient, setDlClient] = useState<DlClient>('native')
  const [siteAds, setSiteAds] = useState(0)
  const [runMode, setRunMode] = useState<'smart' | 'manual'>('smart')
  const [siteDomain, setSiteDomain] = useState('')
  const [siteActive, setSiteActive] = useState(false)
  const [siteBlocked, setSiteBlocked] = useState(false)
  const [siteEnabled, setSiteEnabled] = useState(false)
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
      setStatus(i18n('popup_client_not_found', [DL_CLIENT_LABELS.velo]))
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

    const full = await request<{ enableHlsAdFilter?: boolean }>('getHlsFullConfig')
    if (full) setFilterEnabled(full.enableHlsAdFilter ?? true)

    const dl = await request<{ client?: string }>('getDownloadConfig')
    if (dl?.client) setDlClient(dl.client as DlClient)
    let activePageUrl = ''
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tabId = tabs[0]?.id ?? 0
      activePageUrl = tabs[0]?.url ?? ''
      if (tabId > 0) {
        const r = await request<{
          report: { ads: number; total: number; adDuration: number }
          baseUrl: string
          playback?: 'cleaned' | 'original'
        }>('getLastDetect', { tabId })
        if (r?.report?.ads && r.report.ads > 0) {
          setDetectInfo({
            report: r.report,
            baseUrl: r.baseUrl,
            playback: r.playback === 'cleaned' ? 'cleaned' : 'original',
          })
        }
      }
    } catch { /* ignore */ }

    const siteSt = await request<{
      runMode: 'smart' | 'manual'
      domain: string
      isActive: boolean
      isDisabled: boolean
      extensionEnabled?: boolean
      filterEnabled?: boolean
      siteEnabled?: boolean
      siteAds?: number
    }>(
      'hlsGetSiteStatus',
      { pageUrl: activePageUrl },
    )
    if (siteSt) {
      setRunMode(siteSt.runMode)
      setSiteDomain(siteSt.domain)
      setSiteActive(siteSt.isActive)
      setSiteBlocked(siteSt.isDisabled)
      setSiteEnabled(siteSt.siteEnabled ?? false)
      setSiteAds(siteSt.siteAds ?? 0)
      if (typeof siteSt.filterEnabled === 'boolean') setFilterEnabled(siteSt.filterEnabled)
    }
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

  const openHlsFilterOptions = useCallback(() => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options-hls-filter.html') })
  }, [])

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
    const pb = await queryPlayback(tab.id)
    if (!pb.ok) {
      alert(i18n('popup_playback_read_fail') + ': ' + (pb.error || i18n('popup_play_video_first')))
      return
    }
    const r = await request<{ ok?: boolean; error?: string; learned?: number; total?: number }>('captureSample', {
      tabId: tab.id,
      currentTime: pb.currentTime,
    })
    if (r?.ok) {
      alert(
        i18n('popup_sample_saved', [
          String(Math.round(pb.currentTime)),
          String(r.learned ?? 0),
          String(r.total ?? 0),
        ]),
      )
    } else {
      const err = r?.error
      const msg =
        err === 'site-inactive' ? i18n('popup_error_site_inactive')
        : err === 'no-m3u8-context' ? i18n('popup_error_no_m3u8_context')
        : err === 'sample-out-of-range' ? i18n('popup_error_sample_out_of_range')
        : i18n('popup_capture_fail', [err ?? i18n('popup_unknown_error')])
      alert(msg)
    }
  }

  async function handleTempEnableHls() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id || !tab.url) {
      alert(i18n('popup_no_active_tab'))
      return
    }
    const r = await request<{ ok?: boolean; domain?: string; error?: string }>(
      'hlsTempEnableCurrentSite',
      { pageUrl: tab.url },
    )
    if (!r?.ok) {
      const err = r?.error
      const msg =
        err === 'site-blocked' ? i18n('popup_hls_site_blocked')
        : err === 'no-page-domain' ? i18n('popup_no_active_tab')
        : i18n('popup_temp_enable_fail', [err ?? i18n('popup_unknown_error')])
      alert(msg)
      return
    }
    setStatus(i18n('popup_temp_enable_success', [r.domain ?? '']))

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'hlsDelegationChanged',
        mode: 'active',
        reason: 'temp-enable',
      })
    } catch {
      // content script 尚未注入（如扩展刚安装），刷新页面后自动生效
    }

    setSiteEnabled(true)
    setSiteActive(true)
  }

  const openOptions = useCallback(() => {
    void chrome.runtime.openOptionsPage()
  }, [])

  const clientConnected = dlClient !== 'velo' || paired

  const clientValue = dlClient === 'velo'
    ? paired ? `✅ ${i18n('popup_connected')}` : `❌ ${i18n('popup_not_paired')}`
    : dlClient === 'native'
      ? `🌐 ${i18n('popup_client_browser_download')}`
      : `⚪ ${i18n('popup_client_direct_mode')}`

  const clientDetail = dlClient === 'velo' ? `${DL_CLIENT_LABELS[dlClient]} · port ${port}`
    : dlClient === 'aria2' ? DL_CLIENT_LABELS[dlClient]
    : dlClient === 'ndm' ? `${DL_CLIENT_LABELS[dlClient]} · port ${port}`
    : i18n('popup_client_browser_download')

  const hlsActive = siteActive && !siteBlocked

  const filterCardDetail = !filterEnabled ? i18n('popup_hls_filter_disabled_desc')
    : siteAds > 0 ? i18n('popup_filtered_count', [String(siteAds)])
    : i18n('popup_hls_filter_no_record')

  const siteCardValue = siteBlocked ? `🚫 ${i18n('popup_hls_site_blocked')}`
    : siteActive ? `🟢 ${i18n('popup_hls_site_probe_on')}`
    : `⚪ ${i18n('popup_hls_site_inactive')}`

  const canTempEnable = !siteEnabled && !siteBlocked

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

      <div className={`popup-client-bar ${clientConnected ? 'status-ok' : paired ? 'status-err' : 'status-warn'}`}>
        <span className="status-card-label">{i18n('popup_desktop_client')}</span>
        <span className="status-card-value">{clientValue}</span>
        <span className="status-card-detail">{clientDetail}</span>
      </div>

      {hlsActive && (
        <div className="popup-group">
          <div className="popup-group-title">
            {runMode === 'smart'
              ? `${i18n('popup_hls_smart_mode')}（${i18n('popup_hls_mode_auto_detect')}）`
              : `${i18n('popup_hls_manual_mode')}（${i18n('popup_hls_mode_only_enabled_sites')}）`}
          </div>
          <div className="popup-group-grid">
            <div className={`popup-status-card ${filterEnabled ? 'status-ok' : 'status-warn'}`}>
              <span className="status-card-label">{i18n('popup_ad_filter')}</span>
              <span className="status-card-value">
                {filterEnabled ? `🟢 ${i18n('popup_enabled')}` : `⚪ ${i18n('popup_hls_filter_disabled')}`}
              </span>
              <span className="status-card-detail">{filterCardDetail}</span>
            </div>
            <div className="popup-status-card status-ok">
              <span className="status-card-label">{i18n('popup_hls_site_detect')}</span>
              <span className="status-card-value">{siteCardValue}</span>
              <span className="status-card-detail ellipsis">{siteDomain}</span>
            </div>
          </div>
        </div>
      )}

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
          <div className="popup-detect-hint">
            {detectInfo.playback === 'cleaned'
              ? i18n('popup_playback_cleaned')
              : i18n('popup_playback_original')}
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

      <div className="popup-actions">
        {dlClient === 'velo' && !paired && (
          <button className="btn-secondary" onClick={() => void handleAutoConnect()} disabled={probing}>
            {probing ? i18n('popup_probing') : i18n('popup_auto_connect_button')}
          </button>
        )}
        {dlClient === 'velo' && paired && (
          <button className="btn-ghost" onClick={handleClearPairing}>
            {i18n('popup_repair_button')}
          </button>
        )}
        {canTempEnable && siteDomain && (
          <button className="btn-secondary" onClick={() => void handleTempEnableHls()}>
            🎯 {i18n('popup_enable_site_detect')}
          </button>
        )}
        {siteActive && (
          <button className="btn-sample" onClick={() => void handleSampleSave()}>
            📋 {i18n('popup_hls_sample_save')}
          </button>
        )}
      </div>

      {status && <p className="popup-message">{status}</p>}

      <div className="popup-footer">
        <div className="popup-footer-tools">
          <span className="popup-dl-client">
            {i18n('popup_download_client')}:{' '}
            <a
              className="popup-dl-link"
              href={DL_CLIENT_HOMEPAGES[dlClient]}
              target="_blank"
              rel="noreferrer"
            >
              {DL_CLIENT_LABELS[dlClient]}
            </a>
          </span>
          <button className="popup-tool-icon" onClick={openHlsFilterOptions} title={i18n('popup_hls_settings_short')}>
            🛡️
          </button>
          <button className="popup-tool-icon" onClick={openOptions} title={i18n('popup_open_settings_short')}>
            ⚙️
          </button>
        </div>
      </div>
    </div>
  )
}

mountReact('root', <Popup />)