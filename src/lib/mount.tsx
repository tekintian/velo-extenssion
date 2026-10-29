/**
 * React 挂载工具
 *
 * 所有 options/popup 入口共用，避免各入口重复写 `(rootEl as any)._reactRoot`。
 * HMR 场景下页面脚本可能被重复执行，必须复用已存在的 root，否则 React 会警告
 * "createRoot() on a container that has already been passed to createRoot()"。
 */

import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'

interface MountableElement extends HTMLElement {
  _reactRoot?: Root
}

export function mountReact(containerId: string, node: ReactNode): void {
  const el = document.getElementById(containerId) as MountableElement | null
  if (!el) throw new Error(`mountReact: #${containerId} not found`)

  if (!el._reactRoot) {
    el._reactRoot = createRoot(el)
  }
  el._reactRoot.render(node)
}