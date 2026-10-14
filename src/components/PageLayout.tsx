import type { ReactNode } from 'react'
import { i18n } from '@/lib/i18n'

interface PageLayoutProps {
  title: string
  backHref?: string
  children: ReactNode
}

export function PageLayout({ title, backHref = '/options.html', children }: PageLayoutProps) {
  return (
    <div className="options-container">
      <header className="page-header">
        <a href={backHref} className="back-link">← {i18n('options_back_to_index')}</a>
        <h1>{title}</h1>
      </header>
      {children}
    </div>
  )
}