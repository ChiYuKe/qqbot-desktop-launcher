import { useEffect, useState } from 'react'
import { Boxes, ChevronDown, ExternalLink, FileText, Folder, GitBranch, Power, Puzzle, RefreshCw, Settings, Star, X } from 'lucide-react'
import { StatusPill } from '../components.jsx'
import { api } from '../lib/api.js'
import { PLUGIN_FRAMEWORK_FAVORITE_KEYS } from '../constants.js'
import { EMPTY_PLUGIN_FRAMEWORKS, openExternal } from '../lib/bot.js'
import { MarkdownDocument } from '../lib/markdown.jsx'
import { getPluginSettingsComponent, getPluginSettingsSchema } from '../lib/console-plugins.js'
import { AutoSettingsForm } from '../settings/auto-plugin-settings.jsx'

// 插件管理页：NoneBot 插件、AstrBot 插件、控制台插件三个 tab 切换。
export function PluginPage({ framework = 'nonebot', onFrameworkChange, frameworks = EMPTY_PLUGIN_FRAMEWORKS, consolePlugins = [], refreshing, onRefresh, busy, onToggle, onToggleConsolePlugin, onInstallConsolePlugin, onOpenPluginPage, favorites = {}, onToggleFavorite }) {
  const [expanded, setExpanded] = useState({ framework: 'nonebot', id: '' })
  const [gitInstallOpen, setGitInstallOpen] = useState(false)
  const [detailPlugin, setDetailPlugin] = useState(null)
  const [settingsPlugin, setSettingsPlugin] = useState(null)
  const [documentation, setDocumentation] = useState({ loading: false, error: '', filename: 'README.md', exists: false, markdown: '' })

  useEffect(() => {
    if (!detailPlugin) return undefined
    let active = true
    api(`/api/console-plugins/${encodeURIComponent(detailPlugin.id)}/readme`)
      .then((data) => {
        if (!active) return
        setDocumentation({
          loading: false,
          error: '',
          filename: data.filename || 'README.md',
          exists: Boolean(data.exists),
          markdown: data.markdown || '',
        })
      })
      .catch((error) => {
        if (active) setDocumentation({ loading: false, error: error.message || '无法读取插件说明文件', filename: 'README.md', exists: false, markdown: '' })
      })
    return () => { active = false }
  }, [detailPlugin])

  useEffect(() => {
    if (!detailPlugin) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setDetailPlugin(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [detailPlugin])
  const openConsolePluginDetail = (plugin) => {
    setDocumentation({ loading: true, error: '', filename: 'README.md', exists: false, markdown: '' })
    setDetailPlugin(plugin)
  }

  const isConsole = framework === 'console'
  const isAstrBot = framework === 'astrbot'
  const current = isConsole ? null : frameworks[framework] || EMPTY_PLUGIN_FRAMEWORKS[framework]
  const plugins = current?.plugins || []
  const project = current?.project || null
  const projects = current?.projects || []
  const enabledCount = plugins.filter((plugin) => plugin.enabled).length
  const metadataCount = plugins.filter((plugin) => plugin.metadata_available).length
  const directoryManaged = !isConsole && project?.configuration === 'directory'
  const projectPath = isConsole
    ? `已安装 ${consolePlugins.length} 个控制台插件`
    : isAstrBot
      ? (projects.length ? projects.map((item) => `${item.bot_name || item.bot_id}：${item.path}`).join(' · ') : '暂无 AstrBot 实例')
      : (project?.path || 'NoneBot 项目尚未配置')
  const pluginDirectories = isConsole
    ? 'plugins/ 目录'
    : isAstrBot
      ? (projects.length ? projects.map((item) => `${item.bot_name || item.bot_id}：${item.path}/plugins`).join('、') : '来自 AstrBot 实例的 data/plugins')
      : (project?.plugin_dirs?.length ? `插件目录：${project.plugin_dirs.join('、')}` : '来自 NoneBot 项目配置与本地插件目录')

  const expandedId = expanded.framework === framework ? expanded.id : ''
  const discoveredSummary = isConsole
    ? `${consolePlugins.length} 个已安装`
    : isAstrBot ? `${plugins.length} 个已发现` : `${enabledCount} 个启用`

  const tabs = [
    ['nonebot', 'NoneBot 插件'],
    ['astrbot', 'AstrBot 插件'],
    ['console', '控制台插件'],
  ]

  return <><section className="plugin-page">
    <header className="plugin-page-header">
      <div>
        <div className="eyebrow">
          {isConsole ? '控制台插件' : isAstrBot ? 'AstrBot 插件' : 'NoneBot 插件'}
        </div>
        <h1>插件管理</h1>
        <p data-tooltip={projectPath}>{projectPath}</p>
      </div>
      <button className="plain-icon plugin-refresh" onClick={onRefresh} disabled={refreshing} aria-label="刷新插件列表" data-tooltip="刷新插件列表"><RefreshCw size={17} /></button>
    </header>

    <div className="plugin-framework-tabs" role="tablist" aria-label="插件框架">
      {tabs.map(([key, label]) => {
        const favoriteKey = PLUGIN_FRAMEWORK_FAVORITE_KEYS[key]
        const favorite = Boolean(favorites[key])
        return <div key={key} className={`plugin-framework-tab-group ${framework === key ? 'active' : ''}`}>
          <button type="button" role="tab" aria-selected={framework === key} className={`plugin-framework-tab ${framework === key ? 'active' : ''}`} onClick={() => { onFrameworkChange?.(key); setDetailPlugin(null) }}>{label}<span>{key === 'console' ? consolePlugins.length : frameworks[key]?.plugins?.length || 0}</span></button>
          <button type="button" className={`plugin-framework-favorite ${favorite ? 'active' : ''}`} onClick={() => onToggleFavorite?.(favoriteKey)} aria-pressed={favorite} aria-label={favorite ? `取消收藏${label}` : `收藏${label}`} data-tooltip={favorite ? `取消收藏${label}` : `收藏${label}`}><Star size={15} fill={favorite ? 'currentColor' : 'none'} /></button>
        </div>
      })}
    </div>

    {isConsole ? <>
      <div className="plugin-summary">
        <div><span>插件总数</span><strong>{consolePlugins.length}</strong></div>
        <div><span>前端页面</span><strong>{consolePlugins.filter((p) => p.frontend).length}</strong></div>
        <div><span>后端接口</span><strong>{consolePlugins.filter((p) => p.backend).length}</strong></div>
        <div><span>加载方式</span><strong>运行期</strong></div>
      </div>

      <div className="plugin-list-heading">
        <div><h2>已安装控制台插件</h2><span>插件目录：{pluginDirectories}</span></div>
        <div className="plugin-list-heading-actions">
          <span>{discoveredSummary}</span>
          <button type="button" className="action-button plugin-git-install-trigger" onClick={() => setGitInstallOpen(true)}><GitBranch size={15} />从 Git 安装</button>
        </div>
      </div>

      <div className="console-plugin-grid">
        {consolePlugins.length ? consolePlugins.map((plugin) => {
          const pluginEnabled = plugin.enabled !== false
          const hasPage = pluginEnabled && Boolean(plugin.frontend && plugin.nav?.key)
          const isBusy = busy === `console-plugin:${plugin.id}`
          return <article className={`console-plugin-card ${pluginEnabled ? '' : 'disabled'}`} key={plugin.id}>
            <div className="console-plugin-card-main" role="button" tabIndex={0} onClick={() => openConsolePluginDetail(plugin)} onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openConsolePluginDetail(plugin)
              }
            }} aria-label={`查看插件详情：${plugin.name || plugin.id}`}>
              <div className="console-plugin-card-head">
                <div className="plugin-icon console-plugin-card-icon"><Boxes size={20} /></div>
                <StatusPill label={pluginEnabled ? '控制台插件' : '已停用'} state={pluginEnabled ? 'green' : 'muted'} />
              </div>
              <div className="console-plugin-card-title"><strong>{plugin.name || plugin.id}</strong></div>
              <span className="plugin-module">{plugin.id}{plugin.version ? ` · v${plugin.version}` : ''}{plugin.author ? ` · ${plugin.author}` : ''}</span>
              <p className="console-plugin-card-desc">{plugin.description || '未提供描述'}</p>
            </div>
            <div className="console-plugin-card-foot">
              <div className="console-plugin-card-foot-left">
                {hasPage ? <button type="button" className="action-button console-plugin-open" onClick={() => onOpenPluginPage?.(plugin.id)}>打开页面</button> : null}
                {plugin.backend ? <span className="plugin-managed">后端接口</span> : null}
                {!plugin.frontend && !plugin.backend ? <span className="plugin-managed">仅声明</span> : null}
                {plugin.frontend && !hasPage ? <span className="plugin-managed">前端页面</span> : null}
              </div>
              <button type="button" role="switch" aria-checked={pluginEnabled} className={`plugin-toggle ${pluginEnabled ? 'enabled' : ''}`} onClick={() => onToggleConsolePlugin?.(plugin, !pluginEnabled)} disabled={isBusy} aria-label={pluginEnabled ? '停用插件' : '启用插件'}><Power size={14} />{isBusy ? '保存中' : pluginEnabled ? '停用' : '启用'}</button>
            </div>
          </article>
        }) : <div className="plugin-empty"><Boxes size={22} /><strong>没有安装控制台插件</strong><span>将插件目录放入项目根目录的 plugins/ 文件夹后刷新本页即可。</span></div>}
      </div>
    </> : <>
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
                {plugin.toggle_supported ? <button type="button" role="switch" aria-checked={plugin.enabled} className={`plugin-toggle ${plugin.enabled ? 'enabled' : ''}`} onClick={() => onToggle(plugin, !plugin.enabled)} disabled={isBusy} data-tooltip={plugin.enabled ? '停用插件' : '启用插件'}><Power size={14} />{isBusy ? '保存中' : plugin.enabled ? '停用' : '启用'}</button> : <span className="plugin-managed">{isAstrBot ? 'AstrBot 管理' : '自动加载'}</span>}
                <button type="button" className="plain-icon plugin-expand" onClick={() => setExpanded({ framework, id: isExpanded ? '' : plugin.plugin_id })} aria-expanded={isExpanded} aria-label={isExpanded ? '收起插件详情' : '展开插件详情'} data-tooltip={isExpanded ? '收起详情' : '查看详情'}><ChevronDown size={16} /></button>
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
    </>}
  </section>{detailPlugin ? <ConsolePluginDetailModal plugin={detailPlugin} documentation={documentation} canConfigure={pluginCanConfigure(detailPlugin)} onConfigure={() => setSettingsPlugin(detailPlugin)} onClose={() => setDetailPlugin(null)} /> : null}{settingsPlugin ? <ConsolePluginSettingsModal plugin={settingsPlugin} SettingsComponent={getPluginSettingsComponent(settingsPlugin.id)} useAutoForm={!getPluginSettingsComponent(settingsPlugin.id) && Boolean(getPluginSettingsSchema(settingsPlugin))} onClose={() => setSettingsPlugin(null)} /> : null}{gitInstallOpen ? <GitPluginInstallModal busy={busy === 'console-plugin-install'} onClose={() => setGitInstallOpen(false)} onInstall={onInstallConsolePlugin} /> : null}</>
}

// 插件是否有「配置」入口：注册了自定义 settings 组件，或声明了 settings.json 配置模式。
function pluginCanConfigure(plugin) {
  return Boolean(getPluginSettingsComponent(plugin.id) || getPluginSettingsSchema(plugin))
}

function ConsolePluginDetailModal({ plugin, documentation, canConfigure, onConfigure, onClose }) {
  return <div className="modal-backdrop plugin-detail-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="plugin-detail-modal" role="dialog" aria-modal="true" aria-labelledby="plugin-detail-title">
      <div className="modal-header plugin-detail-header">
        <div>
          <div className="eyebrow">控制台插件详情</div>
          <h2 id="plugin-detail-title">{plugin.name || plugin.id}</h2>
          <p>{plugin.description || '未提供描述'}</p>
        </div>
        <div className="plugin-detail-header-actions">
          {canConfigure ? <button type="button" className="secondary" onClick={onConfigure}><Settings size={14} />配置</button> : null}
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭插件详情"><X size={18} /></button>
        </div>
      </div>

      <dl className="plugin-detail-meta">
        <div><dt>插件名字</dt><dd>{plugin.name || plugin.id}</dd></div>
        <div><dt>版本</dt><dd>{plugin.version || '未声明'}</dd></div>
        <div><dt>作者</dt><dd>{plugin.author || '未声明'}</dd></div>
        <div><dt><Folder size={13} />文件夹名</dt><dd>{plugin.folder || plugin.id}</dd></div>
      </dl>

      <section className="plugin-documentation" aria-labelledby="plugin-documentation-title">
        <div className="plugin-documentation-header">
          <div><FileText size={16} /><h3 id="plugin-documentation-title">{documentation.filename}</h3></div>
          <span>{documentation.exists ? '插件说明' : '未提供文档'}</span>
        </div>
        {documentation.loading ? <div className="plugin-documentation-state">正在读取插件说明文件…</div> : null}
        {!documentation.loading && documentation.error ? <div className="plugin-documentation-state error">{documentation.error}</div> : null}
        {!documentation.loading && !documentation.error && !documentation.exists ? <div className="plugin-documentation-state">此插件目录中未找到 {documentation.filename}。</div> : null}
        {!documentation.loading && !documentation.error && documentation.exists ? <MarkdownDocument markdown={documentation.markdown} /> : null}
      </section>
    </section>
  </div>
}

function ConsolePluginSettingsModal({ plugin, SettingsComponent, useAutoForm, onClose }) {
  // 回退逻辑：有自定义 settings 组件优先用自定义；否则声明了 settings.json 则自动渲染。
  if (typeof SettingsComponent !== 'function' && !useAutoForm) return null
  return <div className="modal-backdrop plugin-settings-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="plugin-settings-modal" role="dialog" aria-modal="true" aria-labelledby="plugin-settings-title">
      <div className="modal-header plugin-settings-header">
        <div>
          <div className="eyebrow">控制台插件配置</div>
          <h2 id="plugin-settings-title">{plugin.name || plugin.id}</h2>
          <p>配置会保存在本机，仅供这个控制台使用。</p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="关闭插件配置"><X size={18} /></button>
      </div>
      <div className="plugin-settings-body">
        {useAutoForm
          ? <AutoSettingsForm api={api} plugin={plugin} onClose={onClose} />
          : <SettingsComponent api={api} plugin={plugin} onClose={onClose} />}
      </div>
    </section>
  </div>
}


function GitPluginInstallModal({ busy, onClose, onInstall }) {
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [replace, setReplace] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    if (!url.trim()) {
      setError('请输入 Git 仓库地址')
      return
    }
    setError('')
    try {
      await onInstall?.({ url: url.trim(), ref: ref.trim() || null, replace })
      onClose()
    } catch (reason) {
      setError(reason.message || 'Git 插件安装失败')
    }
  }

  return <div className="modal-backdrop git-install-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <form className="git-install-modal" onSubmit={submit}>
      <div className="modal-header">
        <div>
          <div className="eyebrow">控制台插件</div>
          <h2>从 Git 安装</h2>
          <p>克隆仓库并校验其中的 plugin.json</p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} disabled={busy} aria-label="关闭 Git 安装"><X size={18} /></button>
      </div>
      <label>Git 仓库地址
        <input required autoFocus type="text" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/plugin.git" disabled={busy} />
        <small>支持 HTTPS、SSH URL 和 git@host:path 格式；不支持本地路径。</small>
      </label>
      <label>分支或 Tag（可选）
        <input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="留空使用默认分支" disabled={busy} />
      </label>
      <label className="git-install-replace-choice">
        <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} disabled={busy} />
        <span>覆盖同 ID 的已安装插件</span>
      </label>
      <div className="git-install-warning">插件代码会在管理服务进程内运行，拥有与控制台相同的本机权限。请只安装你信任的仓库。</div>
      {error ? <div className="git-install-error" role="alert">{error}</div> : null}
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button>
        <button type="submit" className="action-button" disabled={busy}>{busy ? '安装中…' : '开始安装'}</button>
      </div>
    </form>
  </div>
}