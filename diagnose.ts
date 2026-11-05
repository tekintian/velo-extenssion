const fs = require('fs')

function parse(file, base) {
  const t = fs.readFileSync(file, 'utf8')
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const segs = []
  let dis = false
  for (const l of lines) {
    if (l.startsWith('#EXT-X-DISCONTINUITY')) {
      dis = true
      continue
    }
    if (l.startsWith('#EXTINF:')) {
      segs.push({ dur: parseFloat(l.slice(8).split(',')[0]), dis, url: null })
      dis = false
      continue
    }
    if (!l.startsWith('#') && segs.length && segs[segs.length - 1].url === null) {
      segs[segs.length - 1].url = new URL(l, base).href
    }
  }
  return segs
}

const cases = [
  {
    name: 'old.m3u8 (dytt/qianbianse)',
    file: 'tmp/old.m3u8',
    base: 'https://vip.dytt-tvs.com/20260926/38688_18c968e3/3000k/hls/mixed.m3u8',
    truth: (segs) => {
      const windows = [
        [296.56, 316.09],
        [1517.7, 1534.0],
        [2753.6, 2760.0],
      ]
      let acc = 0
      const truth = new Set()
      for (const s of segs) {
        const mid = acc + s.dur / 2
        if (windows.some(([a, b]) => mid >= a && mid < b)) truth.add(s.idx)
        acc += s.dur
      }
      return truth
    },
  },
  {
    name: 'new.m3u8 (kkzy/mknypx)',
    file: 'tmp/new.m3u8',
    base: 'https://kkzycdn.com:65/20221216/tnoQ2Gnh/2000kb/hls/index.m3u8',
    truth: null,
  },
]

async function run() {
  const det = await import('./src/engine/hls/ad-detector.ts')
  const parser = await import('./src/engine/hls/playlist-parser.ts')
  const filter = await import('./src/engine/hls/hls-filter.ts')

  for (const c of cases) {
    const raw = parse(c.file, c.base)
    raw.forEach((s, i) => (s.idx = i))
    const parsed = parser.parsePlaylist(fs.readFileSync(c.file, 'utf-8'), c.base)
    const segs = parsed.segments

    let truth
    if (c.truth) {
      truth = c.truth(raw)
    } else {
      truth = new Set()
      const mainPrefix = new URL(c.base).origin + new URL(c.base).pathname.split('/').slice(0, -1).join('/')
      raw.forEach((s, i) => {
        if (!s.url.startsWith(mainPrefix)) truth.add(i)
      })
    }

    const cfg = await filter.buildConfig(
      { ...filter.DEFAULT_CONFIG, mode: 'passthrough', enabled: true, logToConsole: false },
      'www.test.com',
    )
    const res = det.detectAds(parsed, cfg)
    const adSet = res.adSegments

    const tp = [...adSet].filter((i) => truth.has(i)).length
    const fp = [...adSet].filter((i) => !truth.has(i)).length
    const fn = [...truth].filter((i) => !adSet.has(i)).length
    const prec = adSet.size ? (tp / adSet.size) * 100 : 0
    const rec = truth.size ? (tp / truth.size) * 100 : 0

    console.log(`\n===== ${c.name} =====`)
    console.log(`  真值广告片=${truth.size}  检测=${adSet.size}`)
    console.log(`  正确=${tp} 误判=${fp} 漏检=${fn}`)
    console.log(`  Precision=${prec.toFixed(1)}%  Recall=${rec.toFixed(1)}%`)
    if (fn > 0) {
      console.log(`  漏检位置: ${[...truth].filter((i) => !adSet.has(i)).map((i) => `${segs[i].duration}s`).join(' ')}`)
    }
    if (fp > 0) {
      console.log(`  误判位置: ${[...adSet].filter((i) => !truth.has(i)).map((i) => `${i}`).join(' ')}`)
    }
  }
}

run()