import { mountReact } from '@/lib/mount'
import { useState, useEffect } from 'react'
import { PageLayout } from '@/components/PageLayout'
import { i18n } from '@/lib/i18n'
import { request, requestArray } from '@/lib/messaging'
import '@/assets/options.css'

interface SampleItem {
  id: string
  currentTime: number
  window: { length: number }
  pageHost: string
  ts: number
  baseUrl: string
}

function SamplesPage() {
  const [samples, setSamples] = useState<SampleItem[]>([])
  const [loading, setLoading] = useState(true)

  const loadSamples = async () => {
    setLoading(true)
    const list = await requestArray<SampleItem>('listSamples')
    if (list) setSamples(list)
    setLoading(false)
  }

  useEffect(() => { void loadSamples() }, [])

  const handleDelete = async (id: string) => {
    const r = await request<{ success?: boolean; revoked?: number }>('deleteSample', { id })
    if (!r?.success) return
    if (r.revoked && r.revoked > 0) {
      alert(i18n('options_sample_revoked', [String(r.revoked)]))
    }
    void loadSamples()
  }

  return (
    <PageLayout title={i18n('options_nav_samples')}>
      <section className="options-section">
        <h2>{i18n('options_samples_title')}</h2>
        <div className="hls-actions">
          <button className="btn-secondary" onClick={() => void loadSamples()}>
            {i18n('options_refresh')}
          </button>
        </div>
      </section>

      <section className="options-section">
        {loading ? (
          <p>{i18n('options_loading')}</p>
        ) : samples.length === 0 ? (
          <p>{i18n('options_no_samples')}</p>
        ) : (
          <table className="stats-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>{i18n('options_sample_host')}</th>
                <th>{i18n('options_sample_time')}</th>
                <th>{i18n('options_sample_window')}</th>
                <th>{i18n('options_sample_timestamp')}</th>
                <th>{i18n('options_sample_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {samples.map((s) => (
                <tr key={s.id}>
                  <td className="sample-id">{s.id.slice(0, 8)}</td>
                  <td>{s.pageHost}</td>
                  <td>{s.currentTime.toFixed(1)}s</td>
                  <td>{s.window?.length ?? 0}</td>
                  <td>{new Date(s.ts).toLocaleString()}</td>
                  <td>
                    <button className="btn-sm btn-danger" onClick={() => void handleDelete(s.id)}>
                      {i18n('options_delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="hls-actions">
        <button className="btn-danger" onClick={async () => {
          if (!confirm(i18n('options_confirm_clear_samples'))) return
          const r = await request('clearSamples')
          if (!r) return
          setSamples([])
        }}>
          {i18n('options_clear_all_samples')}
        </button>
      </div>
    </PageLayout>
  )
}

mountReact('root', <SamplesPage />)