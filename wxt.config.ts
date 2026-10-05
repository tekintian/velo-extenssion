import { defineConfig } from 'wxt'
import tailwindcss from '@tailwindcss/vite'
import { version } from './package.json'

export default defineConfig({
  srcDir: 'src',

  modules: ['@wxt-dev/module-react'],

  vite: () => ({
    plugins: [tailwindcss() as never],
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
    },
  }) as never,

  manifest: ({ mode }) => ({
    name: 'sdown Extension',
    description: '__MSG_ext_description__',
    version,
    default_locale: 'zh_CN',
    minimum_chrome_version: '116',

    permissions: [
      'webRequest',
      'cookies',
      'contextMenus',
      'storage',
      'scripting',
      'notifications',
      'activeTab',
    ],

    host_permissions: [
      'http://*/*',
      'https://*/*',
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
