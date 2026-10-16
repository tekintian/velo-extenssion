import { defineConfig } from 'wxt'
import tailwindcss from '@tailwindcss/vite'
import { version } from './package.json'
import { resolve } from 'path'
import { cpSync, existsSync, mkdirSync } from 'fs'
import type { Plugin } from 'vite'

function localesSyncPlugin(): Plugin {
  const localesSrc = resolve(__dirname, 'src/locales')
  const localesDest = resolve(__dirname, 'public/_locales')
  const localeDirs = ['zh_CN', 'en_US']

  function syncLocales() {
    for (const dir of localeDirs) {
      const src = resolve(localesSrc, `${dir}.json`)
      const destDir = resolve(localesDest, dir)
      if (!existsSync(src)) continue
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
      cpSync(src, resolve(destDir, 'messages.json'))
    }
  }

  return {
    name: 'vite-plugin-locales-sync',
    buildStart() {
      syncLocales()
    },
    configureServer(server) {
      server.watcher.add(localesSrc)
      server.watcher.on('change', (file) => {
        if (file.startsWith(localesSrc)) {
          syncLocales()
        }
      })
      server.watcher.on('add', (file) => {
        if (file.startsWith(localesSrc)) {
          syncLocales()
        }
      })
    },
  }
}

export default defineConfig({
  srcDir: 'src',

  modules: ['@wxt-dev/module-react'],

  webExt: {
    binaries: {
      chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
    chromiumArgs: ['--test-type'],
  },

  vite: ({ mode }) => ({
    plugins: [tailwindcss() as never, localesSyncPlugin() as never],
    define: {
      __DEV__: mode === 'development',
    },
    resolve: {
      alias: {
        '@': './src',
        '@engine': './src/engine',
        '@background': './src/background',
        '@lib': './src/lib',
        '@types': './src/types',
      },
    },
    build: {
      target: 'chrome116',
      // 禁用 Vite modulepreload polyfill。
      // 该 polyfill 生成 __vitePreload 辅助函数，内部引用 document.querySelector /
      // document.createElement / document.head.appendChild 等 DOM API。
      // Service Worker 无 DOM 全局对象，V8 解析阶段即抛出
      // "Uncaught ReferenceError: document is not defined"，
      // 导致 Service Worker 注册失败（Status code: 15）。
      // 设为 false 后 Vite 不注入此 polyfill，background.js 不再包含 DOM 引用。
      modulePreload: false,
    },
  }) as never,

  manifest: ({ mode }) => ({
    name: 'Velo Extension',
    description: '__MSG_ext_description__',
    version,
    default_locale: 'zh_CN',
    minimum_chrome_version: '116',

    permissions: [
      'webRequest',
      'webNavigation',
      'cookies',
      'contextMenus',
      'storage',
      'scripting',
      'notifications',
      'activeTab',
      'downloads',
      'tabs',
    ],

    host_permissions: [
      'http://*/*',
      'https://*/*',
      // FTP / 本地文件嗅探（移植自 NDM bg.js：onBeforeRequest 匹配 ftp:// + file:///）
      'ftp://*/*',
      'file:///*',
    ],

    content_security_policy: {
      extension_pages:
        mode === 'development'
          ? "script-src 'self'; object-src 'self'; connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:* https: http:"
          : "script-src 'self'; object-src 'self'; connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:* https: http:",
    },

    icons: {
      '16': 'icons/icon16.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
  }),
})