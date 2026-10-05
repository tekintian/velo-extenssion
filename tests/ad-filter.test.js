/**
 * ad-filter.test.js — 广告过滤算法测试
 *
 * 对应 extension-integration-design §8 / T73。
 * 使用 Node.js 内置 test runner。
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载 ad-filter（IIFE 注入到全局）
const code = readFileSync(join(__dirname, '../src/ad-filter/ad-filter.js'), 'utf-8');
const sandbox = {};
const fn = new Function('self', 'window', code + '; return self.SDOWN_AdFilter;');
const AdFilter = fn(sandbox, sandbox);

test('parsePlaylist — master playlist', () => {
  const master = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
variant_1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
variant_720p.m3u8
`;
  const result = AdFilter.parsePlaylist(master, 'https://example.com/video.m3u8');
  assert.equal(result.isMaster, true);
  assert.equal(result.variants.length, 2);
  assert.equal(result.variants[0].bandwidth, 5000000);
  assert.equal(result.variants[0].uri, 'https://example.com/variant_1080p.m3u8');
});

test('parsePlaylist — media playlist', () => {
  const media = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10.0,
seg1.ts
#EXTINF:10.0,
seg2.ts
#EXTINF:10.0,
seg3.ts
#EXT-X-ENDLIST
`;
  const result = AdFilter.parsePlaylist(media, 'https://example.com/video.m3u8');
  assert.equal(result.isMaster, false);
  assert.equal(result.segments.length, 3);
  assert.equal(result.segments[0].uri, 'https://example.com/seg1.ts');
  assert.equal(result.hasEndlist, true);
});

test('parsePlaylist — AES-128 加密', () => {
  const media = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key.bin",IV=0x00000000000000000000000000000001
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
seg1.ts
#EXT-X-ENDLIST
`;
  const result = AdFilter.parsePlaylist(media, 'https://example.com/video.m3u8');
  assert.equal(result.segments[0].key.method, 'AES-128');
  assert.equal(result.segments[0].key.uri, 'https://example.com/key.bin');
});

test('processPlaylist — master 返回 master 模式', () => {
  const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000
variant.m3u8
`;
  const result = AdFilter.processPlaylist(master, 'https://example.com/video.m3u8', 'https://example.com/');
  assert.equal(result.mode, 'master');
  assert.equal(result.variants.length, 1);
});

test('processPlaylist — live playlist 拒绝', () => {
  const live = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
seg1.ts
`;
  const result = AdFilter.processPlaylist(live, 'https://example.com/video.m3u8', 'https://example.com/');
  assert.equal(result.mode, 'unsupported-live');
});

test('detectAds — url-pattern 识别广告', () => {
  const segments = [
    { sequence: 0, uri: 'https://cdn.example.com/seg1.ts', duration: 10, isAd: false, signals: [], score: 0 },
    { sequence: 1, uri: 'https://cdn.example.com/seg2.ts', duration: 10, isAd: false, signals: [], score: 0 },
    { sequence: 2, uri: 'https://ads.example.com/ad1.ts', duration: 5, isAd: false, signals: [], score: 0 },
    { sequence: 3, uri: 'https://cdn.example.com/seg3.ts', duration: 10, isAd: false, signals: [], score: 0 },
  ];
  AdFilter.detectAds(segments);
  assert.equal(segments[2].signals.includes('url-pattern'), true);
  assert.equal(segments[2].score >= 2, true);
  assert.equal(segments[2].isAd, true);
});

test('rebuildPlaylist — 移除广告分片', () => {
  const segments = [
    { sequence: 0, uri: 'https://cdn.example.com/seg1.ts', duration: 10, isAd: false, signals: [], score: 0 },
    { sequence: 1, uri: 'https://ads.example.com/ad1.ts', duration: 5, isAd: true, signals: ['url-pattern'], score: 2 },
    { sequence: 2, uri: 'https://cdn.example.com/seg2.ts', duration: 10, isAd: false, signals: [], score: 0 },
  ];
  const result = AdFilter.rebuildPlaylist(segments, 10);
  assert.equal(result.includes('#EXTM3U'), true);
  assert.equal(result.includes('seg1.ts'), true);
  assert.equal(result.includes('ad1.ts'), false);
  assert.equal(result.includes('seg2.ts'), true);
  assert.equal(result.includes('#EXT-X-DISCONTINUITY'), true);
  assert.equal(result.includes('#EXT-X-ENDLIST'), true);
});

test('processPlaylist — 完整流程', () => {
  const media = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10.0,
https://cdn.example.com/seg1.ts
#EXTINF:5.0,
https://ads.example.com/ad1.ts
#EXTINF:10.0,
https://cdn.example.com/seg2.ts
#EXT-X-ENDLIST
`;
  const result = AdFilter.processPlaylist(media, 'https://example.com/video.m3u8', 'https://example.com/');
  assert.equal(result.mode, 'media');
  assert.equal(result.report.total, 3);
  assert.equal(result.report.ads >= 1, true);
  assert.equal(result.cleaned.includes('ad1.ts'), false);
  assert.equal(result.cleaned.includes('seg1.ts'), true);
  assert.equal(result.cleaned.includes('seg2.ts'), true);
});

console.log('ad-filter 测试完成');
