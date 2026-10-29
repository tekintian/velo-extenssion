import io

p = 'src/background/hls/handler.ts'
s = io.open(p, encoding='utf-8').read()

start_marker = "  registerHandler<{ tabId: number; fileName?: string }>('downloadCleanedM3u8', async (message, sender) => {\n"
i = s.index(start_marker)

payload_line = "    const { tabId, fileName: payloadFileName } = message.payload\n"
k = s.index(payload_line, i) + len(payload_line)
ctx_line_end = s.index("\n", s.index("const ctx = await loadCleanedContext(tabId)", k)) + 1
body_start = ctx_line_end

end_marker = "\n  })\n}\n"
j = s.index(end_marker, body_start)
body = s[body_start:j]

body = body.replace("sender.tab?.url || ''", "senderTabUrl || ''")
body = body.replace(
    "return { ok: false as const, error: '无待下载的 cleaned m3u8（先触发视频检测）' }",
    "return { ok: false as const, code: 'NO_CLEANED_M3U8' as const, error: '无待下载的 cleaned m3u8（先触发视频检测）' }",
)

dedented = "\n".join(l[4:] if l.startswith("    ") else l for l in body.split("\n"))

core = (
    "/**\n"
    " * 净化 m3u8 下载核心实现（唯一实现入口）\n"
    " *\n"
    " * 调用方共用，避免多处实现漂移：\n"
    " *   - downloadCleanedM3u8 消息（player-panel / badge / popup）\n"
    " *   - media sendToDownload 的 m3u8 净化分支\n"
    " */\n"
    "export async function downloadCleanedM3u8Core(\n"
    "  tabId: number,\n"
    "  payloadFileName?: string,\n"
    "  senderTabUrl?: string,\n"
    "): Promise<{ ok: boolean; error?: string | undefined; filename?: string | undefined; code?: string | undefined }> {\n"
    + dedented
    + "}\n\n"
)

new_handler = (
    "  registerHandler<{ tabId: number; fileName?: string }>('downloadCleanedM3u8', async (message, sender) => {\n"
    "    const { tabId, fileName: payloadFileName } = message.payload\n"
    "    return await downloadCleanedM3u8Core(tabId, payloadFileName, sender.tab?.url)\n"
    "  })\n"
    "}\n"
)

s = s[:i] + new_handler + s[j + len(end_marker):]

anchor = "export function registerHlsHandlers(): void {\n"
a = s.index(anchor)
s = s[:a] + core + s[a:]

io.open(p, 'w', encoding='utf-8').write(s)
print('done')