import { defineContentScript } from 'wxt/utils/define-content-script'
import { logger } from '@/lib/logger'

const ADCLEAR_BADGE_ID = '__adclear_hls_badge__'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  world: 'ISOLATED',

  main() {
    logger.info('Badge content script injected')

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'hlsFilterReport') {
        const report = message.report as { ads: number; total: number; adDuration: number; contentDuration: number } | undefined
        if (report && report.ads > 0) {
          updateBadge(report.ads)
        } else {
          clearBadge()
        }
        sendResponse({ ok: true })
        return false
      }

      if (message.type === 'sdown-m3u8-detected') {
        showPageAction()
        sendResponse({ ok: true })
        return false
      }

      return false
    })
  },
})

function updateBadge(ads: number): void {
  const text = ads > 99 ? '99+' : String(ads)
  void chrome.action.setBadgeText({ text })
  void chrome.action.setBadgeBackgroundColor({ color: '#ff4d4f' })
}

function clearBadge(): void {
  void chrome.action.setBadgeText({ text: '' })
}

function showPageAction(): void {
  void chrome.action.setBadgeText({ text: '▶' })
  void chrome.action.setBadgeBackgroundColor({ color: '#4a90d9' })
}
