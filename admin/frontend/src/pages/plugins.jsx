import {  useState  } from 'react'
import { ChevronDown, ExternalLink, Power, Puzzle, RefreshCw } from 'lucide-react'
import { EMPTY_PLUGIN_FRAMEWORKS, openExternal } from '../lib/bot.js'
import { StatusPill } from '../components.jsx'

// 插件管理页：NoneBot / AstrBot 插件列表、启停与详情。
export function PluginPage({ frameworks = EMPTY_PLUGIN_FRAMEWORKS, refreshing, onRefresh, busy, onToggle }) {
  const [framework, setFramework] = useState('nonebot')
  const [expanded, setExpanded] = useState({ framework: 'nonebot', id: '' })
  const current = frameworks[framework] || EMPTY_PLUGIN_FRAMEWORKS[framework]
  const plugins = current?.plugins || []
  const project = current?.project || null
  const projects = current?.projects || []
  const enabledCount = plugins.filter((plugin) => plugin.enabled).length
  const metadataCount = plugins.filter((plugin) => plugin.metadata_available).length
  const directoryManaged = project?.configuration === 'directory'
  const isAstrBot = framework === 'astrbot'
  const projectPath = isAstrBot
    ? (projects.length ? projects.map((item) => `${item.bot_name || item.bot_id}：${item.path}`).join(' · ') : '暂无 AstrBot 实例')
    : (project?.path || 'NoneBot 项目尚未配置')
  const pluginDirectories = isAstrBot
    ? (projects.length ? projects.map((item) => `${item.bot_name || item.bot_id}：${item.path}/plugins`).join('、') : '来自 AstrBot 实例的 data/plugins')
    : (project?.plugin_dirs?.length ? `插件目录：${project.plugin_dirs.join('、')}` : '来自 NoneBot 项目配置与本地插件目录')

  const expandedId = expanded.framework === framework ? expanded.id : ''
  const discoveredSummary = isAstrBot ? `${plugins.length} 个已发现` : `${enabledCount} 个启用`

  return <section className="plugin-page">
    <header className="plugin-page-header">
      <div>
        <div className="eyebrow">{isAstrBot ? 'AstrBot 插件' : 'NoneBot 插件'}</div>
        <h1>插件管理</h1>
        <p title={projectPath}>{projectPath}</p>
      </div>
      <button className="plain-icon plugin-refresh" onClick={onRefresh} disabled={refreshing} aria-label="刷新插件列表" title="刷新插件列表"><RefreshCw size={17} /></button>
    </header>

    <div className="plugin-framework-tabs" role="tablist" aria-label="插件框架">
      {[
        ['nonebot', 'NoneBot 插件'],
        ['astrbot', 'AstrBot 插件'],
      ].map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={framework === key} className={`plugin-framework-tab ${framework === key ? 'active' : ''}`} onClick={() => setFramework(key)}>{label}<span>{frameworks[key]?.plugins?.length || 0}</span></button>)}
    </div>

    <div className="plugin-summary">
      <div><span>插件总数</span><strong>{plugins.length}</strong></div>
      <div><span>{isAstrBot ? '已读取元信息' : '已启用'}</span><strong>{isAstrBot ? metadataCount : enabledCount}</strong></div>
      <div><span>{isAstrBot ? '实例数' : '已读取元信息'}</span><strong>{isAstrBot ? projects.length : metadataCount}</strong></div>
      <div><span>{isAstrBot ? '管理方式' : '配置格式'}</span><strong>{isAstrBot ? 'AstrBot' : project?.configuration === 'table' ? '新版' : project?.configuration === 'list' ? '兼容' : '目录'}</strong></div>
    </div>

    {directoryManaged && <div className="plugin-notice">当前项目按插件目录自动加载，不能单独停用其中一个插件。</div>}
    {isAstrBot && <div className="plugin-notice plugin-notice-info">AstrBot 插件按账号实例分别扫描；启停和配置请在对应的 AstrBot WebUI 中管理。</div>}

    <div className="plugin-list-heading">
      <div><h2>已发现插件</h2><span>{pluginDirectories}</span></div>
      <span>{plugins.length ? discoveredSummary : '暂无插件'}</span>
    </div>

    <div className="plugin-list">
      {plugins.length ? plugins.map((plugin) => {
        const isExpanded = expandedId === plugin.plugin_id
        const isBusy = busy === `plugin:${plugin.plugin_id}`
        return <article className={`plugin-row ${plugin.enabled ? 'enabled' : 'disabled'}`} key={plugin.plugin_id}>
          <div className="plugin-row-main">
            <div className="plugin-icon"><Puzzle size={18} /></div>
            <div className="plugin-row-copy">
              <div className="plugin-row-title"><strong>{plugin.name}</strong><StatusPill label={isAstrBot ? '已发现' : plugin.enabled ? '已启用' : '已停用'} state={isAstrBot || plugin.enabled ? 'green' : 'muted'} /></div>
              <span className="plugin-module">{plugin.module_name}</span>
              {isAstrBot && <span className="plugin-account">账号：{plugin.bot_name || plugin.bot_id || '未关联账号'}</span>}
              <p>{plugin.description}</p>
            </div>
            <div className="plugin-row-actions">
              {plugin.toggle_supported ? <button type="button" role="switch" aria-checked={plugin.enabled} className={`plugin-toggle ${plugin.enabled ? 'enabled' : ''}`} onClick={() => onToggle(plugin, !plugin.enabled)} disabled={isBusy} title={plugin.enabled ? '停用插件' : '启用插件'}><Power size={14} />{isBusy ? '保存中' : plugin.enabled ? '停用' : '启用'}</button> : <span className="plugin-managed">{isAstrBot ? 'AstrBot 管理' : '自动加载'}</span>}
              <button type="button" className="plain-icon plugin-expand" onClick={() => setExpanded({ framework, id: isExpanded ? '' : plugin.plugin_id })} aria-expanded={isExpanded} aria-label={isExpanded ? '收起插件详情' : '展开插件详情'} title={isExpanded ? '收起详情' : '查看详情'}><ChevronDown size={16} /></button>
            </div>
          </div>
          {isExpanded && <div className="plugin-details">
            <div><span>加载来源</span><strong>{plugin.source === 'installed' ? '已安装依赖' : plugin.load_mode === 'directory' ? '插件目录' : '项目配置'}</strong></div>
            {isAstrBot && <div><span>所属账号</span><strong>{plugin.bot_name || plugin.bot_id || '未关联账号'}</strong></div>}
            <div><span>插件路径</span><strong>{plugin.path || '未找到本地源码'}</strong></div>
            {isAstrBot && <div><span>作者 / 版本</span><strong>{[plugin.author, plugin.version].filter(Boolean).join(' / ') || '未声明'}</strong></div>}
            <div><span>类型</span><strong>{plugin.type || '未声明'}</strong></div>
            <div><span>支持适配器</span><strong>{plugin.supported_adapters?.length ? plugin.supported_adapters.join('、') : '未声明'}</strong></div>
            <div className="plugin-usage"><span>使用方法</span><p>{plugin.usage}</p></div>
            {plugin.homepage && <a href={plugin.homepage} onClick={(event) => { event.preventDefault(); openExternal(plugin.homepage) }}><ExternalLink size={13} />打开插件主页</a>}
            {plugin.error && <div className="plugin-error">{plugin.error}</div>}
          </div>}
        </article>
      }) : <div className="plugin-empty"><Puzzle size={22} /><strong>没有发现 {isAstrBot ? 'AstrBot' : 'NoneBot'} 插件</strong><span>{isAstrBot ? '请先创建 AstrBot 账号实例，或检查对应实例的 data/plugins 目录。' : '检查项目目录或 pyproject.toml 中的插件配置。'}</span></div>}
    </div>
  </section>
}
