import { defineContentScript } from 'wxt/sandbox'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    const HLS_NS = (window as unknown as Record<string, unknown>).__HLS_HOOK_NAMESPACE__ ??= {} as Record<string, unknown>
    ;(window as unknown as Record<string, unknown>).__HLS_HOOK_NAMESPACE__ = HLS_NS

    if ((HLS_NS as Record<string, unknown>).mseHooked) {
      return
    }
    ;(HLS_NS as Record<string, unknown>).mseHooked = 'sdown'

    const origCreateObjectURL = URL.createObjectURL
    URL.createObjectURL = function (blob: Blob | MediaSource) {
      if (blob instanceof MediaSource) {
        hookMediaSource(blob)
      }
      return origCreateObjectURL.call(URL, blob)
    }

    function hookMediaSource(ms: MediaSource): void {
      const origAddSourceBuffer = ms.addSourceBuffer.bind(ms)
      ms.addSourceBuffer = function (mimeType: string) {
        const sb = origAddSourceBuffer(mimeType)

        if (mimeType.includes('mpegurl') || mimeType.includes('mpegURL')) {
          window.postMessage({
            source: 'sdown-mse',
            type: 'mse-source-added',
            payload: { mimeType, url: location.href },
          }, '*')

          const origAppend = sb.appendBuffer.bind(sb)
          sb.appendBuffer = function (data: BufferSource) {
            window.postMessage({
              source: 'sdown-mse',
              type: 'mse-segment-appended',
              payload: { mimeType, byteLength: data.byteLength, url: location.href },
            }, '*')
            return origAppend(data)
          }
        }

        return sb
      }
    }
  },
})
