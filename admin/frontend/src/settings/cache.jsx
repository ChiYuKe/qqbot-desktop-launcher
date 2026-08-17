import {  useEffect, useState  } from 'react'
import { Check, Database, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../lib/api.js'
import { formatCacheBytes } from '../constants.js'
import { SettingsPanel } from './controls.jsx'

// 缓存清理设置：动态扫描可清理缓存并按类别清理。
export function CacheSettings({ onNotice }) {
  const [cache, setCache] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')

  const loadCache = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      setCache(await api('/api/cache'))
    } catch (error) {
      onNotice(error.message || '读取缓存失败')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    void loadCache()
  }, [])

  const clearCache = async (item) => {
    if (!item?.clearable || busy) return
    if (!window.confirm(`确定清理“${item.label}”吗？\n这只会删除该项目中的缓存数据。`)) return
    setBusy(item.id)
    try {
      const result = await api(`/api/cache/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      setCache(result.cache || result)
      onNotice(`已清理 ${item.label}，释放 ${formatCacheBytes(result.cleared_bytes)}`)
    } catch (error) {
      onNotice(error.message || '清理缓存失败')
    } finally {
      setBusy('')
    }
  }

  const clearAll = async () => {
    if (busy || !Number(cache?.total_bytes || 0)) return
    if (!window.confirm('确定清理全部可清理缓存吗？\n配置、数据库、日志、备份和运行中的服务不会受到影响。')) return
    setBusy('all')
    try {
      const result = await api('/api/cache/clear', { method: 'POST' })
      setCache(result.cache || result)
      const blocked = Array.isArray(result.blocked) && result.blocked.length ? `，${result.blocked.length} 项因正在使用而保留` : ''
      onNotice(`已清理缓存，释放 ${formatCacheBytes(result.cleared_bytes)}${blocked}`)
    } catch (error) {
      onNotice(error.message || '清理缓存失败')
    } finally {
      setBusy('')
    }
  }

  const items = Array.isArray(cache?.items) ? cache.items : []
  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">应用设置</div><h1>缓存清理</h1><p>每次打开或刷新时动态扫描本机插件和运行组件产生的缓存，并按类别清理。</p></div><section className="cache-summary"><div><span>可清理缓存</span><strong>{loading ? '读取中…' : formatCacheBytes(cache?.total_bytes)}</strong><small>{Number(cache?.total_files || 0).toLocaleString()} 个缓存{Number(cache?.total_files || 0) === 1 ? '文件' : '文件或记录'}</small></div><div className="cache-summary-actions"><button type="button" className="plain-icon" onClick={() => loadCache()} disabled={loading || Boolean(busy)} title="刷新缓存统计" aria-label="刷新缓存统计"><RefreshCw size={15} /></button><button type="button" className="secondary" onClick={clearAll} disabled={loading || Boolean(busy) || !Number(cache?.total_bytes || 0)}><Trash2 size={14} />{busy === 'all' ? '清理中…' : '全部清理'}</button></div></section><SettingsPanel title="动态发现的缓存项目" description="会识别实际存在的 cache、temp、tmp 目录和缓存文件，以及 SQLite 中的缓存表；配置、日志、备份和插件主体不会被列入。"><div className="cache-list">{loading && !cache ? <div className="cache-empty"><RefreshCw size={16} />正在扫描缓存…</div> : items.length ? items.map((item) => <div className="cache-item" key={item.id}><div className="cache-item-icon"><Database size={16} /></div><div className="cache-item-copy"><strong>{item.label}</strong><span>{item.description}</span><small>{item.files ? `${Number(item.files).toLocaleString()} ${item.unit || '个文件'} · ` : ''}{formatCacheBytes(item.bytes)}{item.size_note ? `（${item.size_note}）` : ''}{item.path ? ` · ${item.path}` : ''}</small>{item.blocked_reason && <em>{item.blocked_reason}</em>}</div><div className="cache-item-actions"><strong>{formatCacheBytes(item.bytes)}</strong><button type="button" className="secondary" onClick={() => clearCache(item)} disabled={!item.clearable || Boolean(busy)}>{busy === item.id ? '清理中…' : item.clearable ? '清理' : '暂不可用'}</button></div></div>) : <div className="cache-empty"><Check size={16} />当前没有可清理的缓存</div>}</div></SettingsPanel><div className="settings-actions"><span><strong>设置已自动保存</strong><small>修改后无需额外点击保存</small></span><button type="button" className="secondary" onClick={() => onNotice('当前设置已保存')}>确认</button></div></div>
}