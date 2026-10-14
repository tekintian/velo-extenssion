/**
 * 非媒体下载扩展名白名单（NDM bg.js `ca` 100% 移植）
 *
 * NDM bg.js `ca` 是 62 个非媒体扩展名（含 TAR/IMG 重复）的数组，
 * 当 URL 路径或 Content-Disposition 提取出的扩展名命中此列表时，
 * 视为"用户明确想要下载"，立即推送到下载客户端 + 返回 `{redirectUrl:"javascript:"}`
 * 取消浏览器的原生下载（不再走媒体嗅探的"加到 popup 列表等用户点击"路径）。
 *
 * 对应 NDM bg.js 行 219：
 * ```js
 * if (... && b.i && -1 < ca.indexOf(b.i.toUpperCase())) {
 *   if (b.isKeyDown) { delete this.j[c]; return }  // Delete 键按下：让浏览器处理
 *   ...push to NDM...
 *   delete this.j[c];
 *   return { redirectUrl: "javascript:" }
 * }
 * ```
 *
 * 注意：本列表的扩展名**不会**与 MEDIA_EXT_RE/H 正则重合，是补足非媒体下载场景。
 * 例：ZIP/EXE/DMG/ISO/DOC/XLS/PDF 等通用文件下载类型。
 */

/**
 * 非媒体下载扩展名白名单（62 项，与 NDM bg.js `ca` 严格一致，含 TAR/IMG 重复）
 *
 * 使用 Set 加速查找（O(1)），保持 NDM 原始数组的扩展名集合语义。
 */
export const NON_MEDIA_DOWNLOAD_EXTS: ReadonlySet<string> = new Set([
  '7Z', 'ARJ', 'BIN', 'BZ2', 'EXE', 'DLL', 'IMG', 'ISO', 'LZH', 'MSI', 'MSU',
  'PLJ', 'PPS', 'PPT', 'RA', 'RAR', 'SEA', 'SIT', 'SITX', 'TAR', 'TIF',
  'TIFF', 'Z', 'ZIP', 'ZIPX', 'TAR', 'GZ', 'XZ', 'BZ', 'CAB', 'ARC', 'PAK',
  'APK', 'NRG', 'NRI', 'OMG', 'IMG', 'SFX', 'DMG', 'DMGPART', 'XIP', 'TGZ',
  'ZZ', 'TXZ', 'PKG', 'HQX', 'GZIP', 'DOC', 'DOCX', 'XLS', 'XLSX', 'PPTX',
  'ODT', 'ODS', 'WPD', 'TEX', 'RTF', 'RTFD', 'EPUB', 'KEY', 'NUMBERS', 'PAGES',
])

/**
 * 判断扩展名是否在非媒体下载白名单中（大小写不敏感）
 *
 * @param ext 扩展名（带或不带前导点）
 * @returns true 表示在白名单中（应立即推送 + 取消浏览器下载）
 */
export function isNonMediaDownloadExt(ext: string): boolean {
  if (!ext) return false
  const upper = ext.replace(/^\./, '').toUpperCase()
  return NON_MEDIA_DOWNLOAD_EXTS.has(upper)
}
