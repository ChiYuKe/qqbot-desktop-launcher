import {  useState  } from 'react'
import { ChevronLeft, ExternalLink, RefreshCw } from 'lucide-react'
import { openExternal } from '../lib/bot.js'

// 嵌入式 WebUI 页：在控制台内嵌打开 NapCat / AstrBot WebUI。
export function EmbeddedWebUiPage({ target, onClose }) {
  const [frameKey, setFrameKey] = useState(0)
  const [loadedUrl, setLoadedUrl] = useState('')
  const loading = loadedUrl !== target.url

  const refresh = () => {
    setLoadedUrl('')
    setFrameKey((key) => key + 1)
  }

  return <section className="embedded-webui-page" aria-label={target.title}>
    <div className="embedded-webui-toolbar">
      <div className="embedded-webui-title"><button type="button" className="embedded-webui-back" onClick={onClose}><ChevronLeft size={15} />返回控制台</button><span>{target.title}</span></div>
      <div className="embedded-webui-actions"><button type="button" className="soft-button" onClick={refresh} aria-label="刷新 WebUI" title="刷新"><RefreshCw size={14} /></button><button type="button" className="soft-button embedded-webui-external" onClick={() => openExternal(target.url)}><ExternalLink size={13} />外部打开</button></div>
    </div>
    <div className="embedded-webui-frame-wrap">
      {loading && <div className="embedded-webui-loading">正在加载 {target.kind === 'napcat' ? 'NapCat' : 'AstrBot'} WebUI…</div>}
      <iframe key={`${target.url}-${frameKey}`} title={target.title} src={target.url} onLoad={() => setLoadedUrl(target.url)} />
    </div>
  </section>
}
