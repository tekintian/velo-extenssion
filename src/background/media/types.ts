export type { MediaDescriptor } from '@/types'
export type { PushMessage } from '@/types'
export type { PushOptions } from '@/types'
export type { AdRange } from '@/types'

import type { MediaDescriptor } from '@/types'

export interface SniffResult {
  descriptor: MediaDescriptor
  details: chrome.webRequest.WebRequestDetails
}

export interface DownloadTask {
  url: string
  headers: Record<string, string>
  options: Record<string, unknown>
  createdAt: number
}
