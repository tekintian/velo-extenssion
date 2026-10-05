export interface Segment {
  readonly index: number
  readonly url: string
  readonly duration: number
  readonly title: string
  readonly byterange: string | null
  readonly discontinuity: boolean
  readonly cueState: 'out' | null
  readonly scte35: string | null
  readonly dateRangeAd: string | null
  readonly seqNum: number | null
}

export interface ParsedPlaylist {
  readonly headerTags: string[]
  readonly segments: Segment[]
  readonly mediaSeqStart: number
}

export interface DetectionResult {
  adSegments: Set<number>
  reasons: Map<number, string[]>
  report: DetectionReport
}

export interface DetectionReport {
  readonly total: number
  readonly ads: number
  readonly adDuration: number
  readonly contentDuration: number
  readonly appliedRule?: SiteRule | null
}

export interface SiteRule {
  readonly id: string
  readonly name: string
  readonly hostPattern: string
  readonly adUrlPatterns: readonly string[]
  readonly scoreThreshold?: number
  readonly mode?: AdDeliveryMode
  readonly forceKeep: readonly string[]
}

export type AdDeliveryMode = 'data-url' | 'enumerate' | 'passthrough' | 'm3u8-file' | 'disabled'

export type FingerprintMode = 'off' | 'suspicious-only' | 'all'

export interface AdFilterConfig {
  readonly enabled: boolean
  readonly mode: AdDeliveryMode
  readonly scoreThreshold: number
  readonly urlPatterns: readonly string[]
  readonly logToConsole: boolean
  readonly minSegmentsForStats: number
  readonly keepDiscontinuityOnGap: boolean
  readonly remoteRulesUrl: string
  readonly enableFingerprint: boolean
  readonly fingerprintMode: FingerprintMode
  readonly autoLearnFingerprints: boolean
  readonly remoteFingerprintsUrl: string
  readonly maxFingerprintPerPlaylist: number
  readonly _patterns?: readonly RegExp[]
  readonly _forceKeep?: readonly RegExp[]
  readonly _appliedRule?: SiteRule | null
}

export interface FingerprintEntry {
  readonly hash: string
  readonly adName: string
  readonly source: string
  readonly firstSeen: number
}

export interface FingerprintLookupResult {
  readonly isAd: boolean
  readonly adName?: string
  readonly source?: string
}

export interface AdRange {
  readonly start: number
  readonly end: number
  readonly duration: number
}

export type ProcessResult =
  | { readonly mode: 'disabled'; readonly url: string; readonly report: null }
  | { readonly mode: 'master'; readonly url: string; readonly report: { readonly master: true; readonly variants: number; readonly appliedRule: SiteRule | null } }
  | { readonly mode: 'no-ads'; readonly url: string; readonly report: DetectionReport; readonly segments: readonly Segment[] }
  | { readonly mode: 'passthrough'; readonly url: string; readonly report: DetectionReport; readonly reasons: Record<number, string[]>; readonly adSegmentUrls: string[]; readonly segments: readonly Segment[]; readonly adRanges: AdRange[] }
  | { readonly mode: 'enumerate'; readonly segments: readonly Segment[]; readonly report: DetectionReport; readonly reasons: Record<number, string[]>; readonly adSegmentUrls: string[]; readonly adRanges: AdRange[] }
  | { readonly mode: 'm3u8-file'; readonly cleaned: string; readonly report: DetectionReport; readonly reasons: Record<number, string[]>; readonly adSegmentUrls: string[]; readonly segments: readonly Segment[]; readonly adRanges: AdRange[] }
  | { readonly mode: 'data-url'; readonly url: string; readonly cleaned: string; readonly report: DetectionReport; readonly reasons: Record<number, string[]>; readonly adSegmentUrls: string[]; readonly segments: readonly Segment[]; readonly adRanges: AdRange[] }
