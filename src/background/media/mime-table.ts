/**
 * MIME → 扩展名映射表 + 反向查找
 *
 * 100% 移植自 NDM bg.js 的 `I` 对象（101 项）。
 *
 * 用途：
 *   - 嗅探到响应但 Content-Disposition 缺失时，从 Content-Type 反查扩展名
 *   - 与 NDM 行为对齐：所有 NDM 能识别的 MIME 类型，velo 也能识别
 *
 * 反向查找：给定一个扩展名（大写），返回首个匹配的 MIME 类型。
 * 对应 NDM bg.js 的 `ea()` 函数。
 *
 * NDM 原始结构：键为 MIME 类型（小写），值为 `|` 分隔的扩展名列表（大写）。
 */

/**
 * MIME → 扩展名映射表（101 项，移植自 NDM bg.js `I`）
 *
 * 键：MIME 类型（小写，已 trim）
 * 值：扩展名列表，多个用 `|` 分隔（大写，无点）
 */
export const MIME_TO_EXTS: Readonly<Record<string, string>> = {
  'application/x-apple-diskimage': 'DMG',
  'application/cert-chain+cbor': 'MSG',
  'application/epub+zip': 'EPUB',
  'application/java-archive': 'JAR',
  'video/x-matroska': 'MKV',
  'text/html': 'HTML|HTM',
  'text/css': 'CSS',
  'text/javascript': 'JS|JSON',
  'text/mspg-legacyinfo': 'MSI|MSP',
  'text/plain': 'TXT|SRT',
  'text/srt': 'SRT',
  'text/vtt': 'VTT|SRT',
  'text/xml': 'XML|F4M|TTML',
  'text/x-javascript': 'JS|JSON',
  'text/x-json': 'JSON',
  'application/f4m+xml': 'F4M',
  'application/gzip': 'GZ',
  'application/javascript': 'JS',
  'application/json': 'JSON',
  'application/msword': 'DOC|DOCX|DOT|DOTX',
  'application/pdf': 'PDF',
  'application/ttaf+xml': 'DFXP',
  'application/vnd.apple.mpegurl': 'M3U8',
  'application/zip': 'ZIP',
  'application/x-7z-compressed': '7Z',
  'application/x-aim': 'PLJ',
  'application/x-compress': 'Z',
  'application/x-compress-7z': '7Z',
  'application/x-compressed': 'ARJ',
  'application/x-gtar': 'TAR',
  'application/x-msi': 'MSI',
  'application/x-msp': 'MSP',
  'application/x-gzip': 'GZ',
  'application/x-gzip-compressed': 'GZ',
  'application/x-javascript': 'JS',
  'application/x-mpegurl': 'M3U8',
  'application/x-msdos-program': 'EXE|DLL',
  'application/vnd.apple.installer+xml': 'MPKG',
  'application/x-ole-storage': 'MSI|MSP',
  'application/x-rar': 'RAR',
  'application/x-rar-compressed': 'RAR',
  'application/x-sdlc': 'EXE|SDLC',
  'application/x-shockwave-flash': 'SWF',
  'application/x-silverlight-app': 'XAP',
  'application/x-subrip': 'SRT',
  'application/x-tar': 'TAR',
  'application/x-zip': 'ZIP',
  'application/x-zip-compressed': 'ZIP',
  'video/3gpp': '3GP|3GPP',
  'video/3gpp2': '3GP|3GPP',
  'video/avi': 'AVI',
  'video/f4f': 'F4F',
  'video/f4m': 'F4M',
  'video/flv': 'FLV',
  'video/mp2t': 'TS|M3U8',
  'video/mp4': 'MP4|M4V',
  'video/mpeg': 'MPG|MPEG|MPE',
  'video/mpegurl': 'M3U8|M3U',
  'video/mpg4': 'MP4|M4V',
  'video/msvideo': 'AVI',
  'video/quicktime': 'MOV|QT',
  'video/webm': 'WEBM',
  'video/x-flash-video': 'FLV',
  'video/x-flv': 'FLV',
  'video/x-mp4': 'MP4|M4V',
  'video/x-mpegurl': 'M3U8|M3U',
  'video/x-mpg4': 'MP4|M4V',
  'video/x-ms-asf': 'ASF',
  'video/x-ms-wmv': 'WMV',
  'video/x-msvideo': 'AVI',
  'audio/3gpp': '3GP|3GPP',
  'audio/3gpp2': '3GP|3GPP',
  'audio/mp3': 'MP3',
  'audio/mp4': 'M4A|MP4',
  'audio/mp4a-latm': 'M4A|MP4',
  'audio/mpeg': 'MP3',
  'audio/mpeg4-generic': 'M4A|MP4',
  'audio/mpegurl': 'M3U8|M3U',
  'image/svg+xml': 'SVG|SVGZ',
  'audio/webm': 'WEBM',
  'audio/wav': 'WAV',
  'audio/x-mpeg': 'MP3',
  'audio/x-mpegurl': 'M3U8|M3U',
  'audio/x-ms-wma': 'WMA',
  'audio/x-wav': 'WAV',
  'ilm/tm': 'MP3',
  'image/gif': 'GIF|GFA',
  'image/icon': 'ICO|CUR',
  'image/jpg': 'JPG|JPEG',
  'image/jpeg': 'JPG|JPEG',
  'image/png': 'PNG|APNG',
  'image/tiff': 'TIF|TIFF',
  'image/vnd.microsoft.icon': 'ICO|CUR',
  'image/webp': 'WEBP',
  'image/x-icon': 'ICO|CUR',
  'flv-application/octet-stream': 'FLV',
  'image/x-xbitmap': 'XBM',
  'audio/x-mp3': 'MP3',
  'audio/x-hx-aac-adts': 'AAC',
  'audio/aac': 'AAC',
  'audio/x-aac': 'AAC',
  'application/vnd.rn-realmedia-vbr': 'RMVB',
}

/**
 * 给定 Content-Type（小写），返回首个匹配的扩展名（小写，无点）
 *
 * 对应 NDM bg.js `M(s,"Content-Type")` 后 `I[u]` 取 `split("|").shift()` 的逻辑：
 *   - 从 MIME 表查询扩展名列表，取第一个
 *   - 例：'video/mp4' → 'MP4'（取第一个，丢弃 'M4V'）
 *   - 例：'application/x-mpegurl' → 'M3U8'
 *
 * @param contentType 响应头 Content-Type（可含 charset 等参数，会先 trim 取首段）
 * @returns 扩展名（小写，无点）或空字符串
 */
export function extFromContentType(contentType: string): string {
  if (!contentType) return ''
  // 取首段（去掉 "; charset=..." 等参数）
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!mime) return ''
  const list = MIME_TO_EXTS[mime]
  if (!list) return ''
  const first = list.split('|', 1)[0]
  return first ? first.toLowerCase() : ''
}

/**
 * 给定扩展名，反查 MIME 类型（移植自 NDM bg.js `ea()` 函数）
 *
 * 用途：嗅探到 .ext 文件但没有 Content-Type 时，从扩展名反查 MIME。
 *
 * @param ext 扩展名（带或不带前导点，大小写不敏感）
 * @returns MIME 类型（小写）或空字符串
 */
export function mimeFromExt(ext: string): string {
  if (!ext) return ''
  const upper = ext.replace(/^\./, '').toUpperCase()
  if (!upper) return ''
  for (const [mime, list] of Object.entries(MIME_TO_EXTS)) {
    if (list.split('|').indexOf(upper) >= 0) {
      return mime
    }
  }
  return ''
}