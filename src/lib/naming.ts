/**
 * 文件名提取与"无意义段"识别工具
 *
 * 抽取自 sniffer.ts 与 hls/handler.ts 中重复的命名规则。
 * 用于从 m3u8/页面 URL 中提取对用户友好的文件名。
 *
 * 规则：剔除 URL 路径中的"技术段"（index/home/player/cdn/static 等），
 * 保留有意义的内容段，拼接为 baseName。
 */

/**
 * 无意义 URL 路径段（技术/通用名，对用户无信息量）
 *
 * 三处原重复定义（sniffer.ts:507 / handler.ts:491 / handler.ts:575）已统一抽取到此。
 * 修改时只需改这一处。
 */
const BAD_SEG_RE =
  /^(?:index|home|homepage|main|default|start|top|bottom|left|right|middle|center|content|body|page|p|menu|header|footer|sidebar|aside|section|wrapper|container|app|root|layout|component|video|player|online|play|h5|web|mixed|playlist|master|vod|hls|dash|audio|segment|segments|ts|m3u8|mp4|flv|3gp|img|images|image|photo|pic|thumb|thumbnail|cdn|static|public|assets|resource|resources|file|files|stream|streams|media|live|origin|backup|temp|tmp|cache|downloads|download|upload|uploads|api|admin|user|login|register|auth|profile|search|list|all|new|create|edit|delete|update|view|show|add|remove)$/i

/**
 * 无意义文件名（含无标题/未知/test/纯数字/纯符号等，比 BAD_SEG_RE 更宽）
 *
 * 仅 hls/handler.ts:385 使用，用于识别"无信息量文件名"并回退到 baseName。
 * 在 BAD_SEG_RE 基础上扩展：无标题/untitled/unknown/test/demo/sample/example +
 * 4~6 位纯数字 + 纯符号串。
 */
const BAD_NAME_RE =
  /^(?:index|home|homepage|main|default|start|top|bottom|left|right|middle|center|content|body|page|p|menu|header|footer|sidebar|aside|section|wrapper|container|app|root|layout|component|video|player|online|play|h5|web|new\s*tab|无标题|untitled|unknown|test|demo|sample|example|mixed|playlist|master|vod|hls|dash|audio|segment|segments|ts|m3u8|mp4|flv|3gp|img|images|image|photo|pic|thumb|thumbnail|cdn|static|public|assets|resource|resources|file|files|stream|streams|media|live|origin|backup|temp|tmp|cache|tempfile|downloads|download|upload|uploads|api|admin|user|login|register|auth|profile|search|list|all|new|create|edit|delete|update|view|show|add|remove|[0-9]{4,6}|\/?[\s*_\-|·]+\/?)$/i

/**
 * 从 m3u8 URL 提取 baseName（剔除技术段，拼接所有有意义路径段）
 *
 * 算法：
 *   1. 取 URL pathname，按 `/` 分段
 *   2. 剔除扩展名 + 长度 < 2 + 命中 BAD_SEG_RE 的段
 *   3. 剩余段用 `_` 拼接
 *   4. 全部被剔除时回退到 hostname（去 www. 前缀）
 *   5. 清理非法文件名字符，限长 50 字符
 *
 * @example
 *   extractBaseName('https://cdn.example.com/static/video/我的视频/index.m3u8') → '我的视频'
 *   extractBaseName('https://example.com/index.m3u8') → 'example.com'
 */
export function extractBaseName(url: string): string {
  try {
    const u = new URL(url)
    const segs = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
    let name = segs
      .map((s) => s.replace(/\.[^.]+$/, ''))
      .filter((s) => s.length >= 2 && !BAD_SEG_RE.test(s))
      .join('_')
    if (!name) name = u.hostname.replace(/^www\./, '')
    name = name.replace(/[\\/:*?"<>|\s]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
    if (name.length > 50) name = name.slice(-50)
    return name || 'video'
  } catch {
    return 'video'
  }
}

/**
 * 判断文件名是否为"无信息量"（应回退到 baseName）
 *
 * 用于 hls/handler.ts 中识别 pageTitle / og:title / payloadFileName 是否
 * 值得作为最终文件名。命中以下任一条件视为无效：
 *   - 空或长度 < 3
 *   - 命中 BAD_NAME_RE（无标题/unknown/test/纯数字/纯符号等）
 *   - 不含任何字母或中文字符（纯符号/纯数字已在上一步覆盖，这里防御性）
 */
export function isBadName(s: string | undefined): boolean {
  if (!s) return true
  const t = s.trim()
  if (t.length < 3) return true
  if (BAD_NAME_RE.test(t)) return true
  if (/^[^a-z\u4e00-\u9fa5]*$/i.test(t)) return true
  return false
}
