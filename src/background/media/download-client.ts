import { logger } from '@/lib/logger'
import { getCookieString } from '@/background/media/sniffer'
import type { MediaDescriptor } from '@/types'

interface PushClientLike {
  push(message: Record<string, unknown>): Promise<void>
}

let pushClient: PushClientLike | null = null

export function setPushClient(client: PushClientLike | null): void {
  pushClient = client
}

export async function pushHls(descriptor: MediaDescriptor, m3u8Text: string, options?: { mergeFormat?: string }): Promise<void> {
  await pushMessage({
    action: 'push_m3u8',
    m3u8_text: m3u8Text,
    base_url: descriptor.url,
    headers: await buildHeaders(descriptor),
    options: { merge_format: options?.mergeFormat ?? 'ts' },
  })
}

export async function pushUrl(url: string, descriptor: MediaDescriptor, options?: { mergeFormat?: string }): Promise<void> {
  await pushMessage({
    action: 'push_url',
    url,
    headers: await buildHeaders(descriptor),
    options: { merge_format: options?.mergeFormat ?? 'ts' },
  })
}

export async function pushNormal(descriptor: MediaDescriptor, options?: { filename?: string }): Promise<void> {
  await pushMessage({
    action: 'push_normal',
    url: descriptor.url,
    headers: await buildHeaders(descriptor),
    options: { filename: options?.filename ?? extractFilename(descriptor) },
  })
}

async function pushMessage(message: { action: string; [k: string]: unknown }): Promise<void> {
  if (!pushClient) {
    logger.warn('Not paired, push request dropped:', message.action)
    return
  }
  await pushClient.push(message)
}

async function buildHeaders(descriptor: { url: string; pageUrl: string; headers?: Record<string, string> }): Promise<Record<string, string>> {
  const cookies = await getCookieString(descriptor.url)
  const ua = await getPageUA()
  const result: Record<string, string> = {
    Cookie: cookies,
    Referer: descriptor.pageUrl,
    ...descriptor.headers,
  }
  if (ua) result['User-Agent'] = ua
  return result
}

async function getPageUA(): Promise<string> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabId = tabs[0]?.id
    if (tabId != null) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => navigator.userAgent,
        world: 'MAIN',
      })
      const r = results[0]?.result
      if (r) return r as string
    }
  } catch { /* ignore */ }
  return ''
}

function extractFilename(descriptor: { url: string; contentDisposition?: string }): string {
  if (descriptor.contentDisposition) {
    const match = descriptor.contentDisposition.match(/filename[^;=\n]*=(['"]?)([^'";\n]*)\1/i)
    if (match?.[2]) return match[2]
  }
  try {
    const u = new URL(descriptor.url)
    const parts = u.pathname.split('/')
    return parts[parts.length - 1] || 'download'
  } catch {
    return 'download'
  }
}
