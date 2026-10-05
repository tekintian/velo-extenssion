import { logger } from '@/lib/logger'
import { M3U8_MIME_TYPES, MEDIA_EXTENSIONS, EXCLUDE_EXTENSIONS } from '@/types'
import type { MediaDescriptor } from '@/types'

type DetectedCallback = (descriptor: MediaDescriptor, details: chrome.webRequest.WebRequestDetails) => void | Promise<void>

const detectedCallbacks: DetectedCallback[] = []

export function registerWebRequestHandlers(onDetected: DetectedCallback): void {
  detectedCallbacks.push(onDetected)

  if (detectedCallbacks.length === 1) {
    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        handleHeadersReceived(details)
        return undefined
      },
      { urls: ['http://*/*', 'https://*/*'] },
      ['responseHeaders'],
    )

    chrome.webRequest.onBeforeSendHeaders.addListener(
      () => undefined,
      { urls: ['http://*/*', 'https://*/*'] },
      ['requestHeaders'],
    )

    logger.info('WebRequest handlers registered')
  }
}

function handleHeadersReceived(details: chrome.webRequest.WebRequestDetails): void {
  const responseHeaders = (details as { responseHeaders?: chrome.webRequest.HttpHeader[] }).responseHeaders
  const contentType = getHeader(responseHeaders, 'content-type') ?? ''
  const contentDisposition = getHeader(responseHeaders, 'content-disposition') ?? ''
  const contentLength = parseInt(getHeader(responseHeaders, 'content-length') ?? '0', 10)

  const url = details.url
  const ext = extractExtension(url)
  const mime = extractMime(contentType)

  if (isExcludedExtension(ext)) return

  const isM3u8 = M3U8_MIME_TYPES.some((m) => mime.includes(m)) || ext === '.m3u8' || ext === '.m3u'
  const isMedia = MEDIA_EXTENSIONS.includes(ext as (typeof MEDIA_EXTENSIONS)[number]) || isMediaMime(mime)

  if (!isM3u8 && !isMedia) return

  const descriptor: MediaDescriptor = {
    url,
    method: details.method,
    ext,
    mime,
    contentLength,
    contentType,
    contentDisposition,
    pageUrl: (details as { originUrl?: string }).originUrl ?? '',
    headers: headersToRecord(responseHeaders),
  }

  for (const cb of detectedCallbacks) {
    const result = cb(descriptor, details)
    if (result instanceof Promise) {
      void result.catch((e: unknown) => {
        logger.warn('Detected callback error:', (e as Error).message)
      })
    }
  }
}

export function isM3u8(descriptor: { ext: string; mime?: string }): boolean {
  return descriptor.ext === '.m3u8' || descriptor.ext === '.m3u' ||
    (descriptor.mime?.includes('mpegurl') ?? false)
}

export async function getCookieString(url: string): Promise<string> {
  try {
    const cookies = await chrome.cookies.getAll({ url })
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

function getHeader(headers: chrome.webRequest.HttpHeader[] | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return h?.value
}

function extractExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const dot = pathname.lastIndexOf('.')
    if (dot < 0) return ''
    return pathname.slice(dot).toLowerCase().split('?')[0]!
  } catch {
    return ''
  }
}

function extractMime(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase()
}

function isExcludedExtension(ext: string): boolean {
  return EXCLUDE_EXTENSIONS.includes(ext as (typeof EXCLUDE_EXTENSIONS)[number])
}

function isMediaMime(mime: string): boolean {
  return mime.startsWith('video/') || mime.startsWith('audio/')
}

function headersToRecord(headers: chrome.webRequest.HttpHeader[] | undefined): Record<string, string> {
  if (!headers) return {}
  const result: Record<string, string> = {}
  for (const h of headers) {
    result[h.name] = h.value ?? ''
  }
  return result
}
