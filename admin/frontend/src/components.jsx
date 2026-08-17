import React, { useEffect, useRef, useState } from 'react'
import {
  Bell, Bot, Check, ChevronDown, Download, ExternalLink, Eye, EyeOff, Image as ImageIcon,
  Minimize2, Maximize2, Plus, SquareTerminal, Star, X,
} from 'lucide-react'
import { fetchAuthenticatedBlob } from './lib/api.js'
import { isBotRunning, isBotTransitioning, openExternal } from './lib/bot.js'
import { normalizeLogLevel, parseLogSegments } from './lib/logs.js'
import { formatNotificationTime, formatUptime, NOTIFICATION_SOURCE } from './constants.js'

// 通用组件与共享控件：窗口控制、导航、状态胶囊、头像/运行时长、日志渲染、
// 通知/新建/删除弹窗，以及框架下拉选择。
export function WebUiMenuItem({ icon: Icon, label, port, disabled = false, disabledText = '', onClick }) {
  return <button type="button" className="webui-switcher-item" role="menuitem" disabled={disabled} onClick={onClick}><span className="webui-switcher-icon"><Icon size={15} /></span><span><strong>{label}</strong><small>{disabled ? disabledText : `本机端口 ${port}`}</small></span><ExternalLink size={13} /></button>
}
export function NotificationCenterModal({ items, onClose }) {
  return <div className="modal-backdrop notification-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="notification-modal" role="dialog" aria-modal="true" aria-labelledby="notification-center-title"><div className="modal-header notification-modal-header"><div><div className="eyebrow">{NOTIFICATION_SOURCE}</div><h2 id="notification-center-title">通知中心</h2><p>来自远程通知服务的系统消息</p></div><button type="button" className="modal-close" onClick={onClose} aria-label="关闭通知中心"><X size={18} /></button></div>{items.length ? <div className="notification-list">{items.map((item) => <article className={`notification-item ${item.level}`} key={item.id}><div className="notification-item-heading"><span className="notification-level-dot" /><strong>{item.title}</strong><time>{formatNotificationTime(item.created_at)}</time></div><p>{item.body}</p>{item.link && <a href={item.link} onClick={(event) => { event.preventDefault(); openExternal(item.link) }}><ExternalLink size={13} />打开相关链接</a>}<small className="notification-source">{NOTIFICATION_SOURCE}</small></article>)}</div> : <div className="notification-empty"><Bell size={20} /><strong>暂无通知</strong><span>新的系统消息会显示在这里</span></div>}</section></div>
}
export function WindowControls() {
  if (!window.desktopInfo?.isDesktop) return null
  return <div className="window-controls"><button onClick={() => window.windowControls?.minimize()} aria-label="最小化" title="最小化"><Minimize2 size={14} /></button><button onClick={() => window.windowControls?.toggleMaximize()} aria-label="最大化" title="最大化"><Maximize2 size={14} /></button><button className="window-close" onClick={() => window.windowControls?.close()} aria-label="关闭" title="关闭"><X size={15} /></button></div>
}
export function useAuthenticatedMedia(path, enabled) {
  const [media, setMedia] = useState({ path: '', enabled: false, url: '', error: '' })

  useEffect(() => {
    let active = true
    let objectUrl = ''
    if (!enabled) return () => {}
    fetchAuthenticatedBlob(path).then((blob) => {
      if (!active) return
      objectUrl = URL.createObjectURL(blob)
      setMedia({ path, enabled, url: objectUrl, error: '' })
    }).catch((reason) => {
      if (active) setMedia({ path, enabled, url: '', error: reason.message || '资源加载失败' })
    })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path, enabled])

  if (media.path !== path || media.enabled !== enabled) return { url: '', error: '' }
  return { url: media.url, error: media.error }
}
export function NavItem({ icon: Icon, label, active, onClick, favoriteKey, favorite, onToggleFavorite }) {
  const selected = typeof active === 'boolean' ? active : active === label
  return <div className={`nav-item-wrap ${selected ? 'active-wrap' : ''}`}><button className={`nav-item ${selected ? 'active' : ''}`} onClick={() => onClick(label)}><Icon size={16} /><span>{label}</span></button>{favoriteKey && <button type="button" className={`favorite-toggle ${favorite ? 'active' : ''}`} onClick={(event) => { event.stopPropagation(); onToggleFavorite(favoriteKey) }} aria-label={favorite ? `取消收藏${label}` : `收藏${label}`} title={favorite ? '取消收藏' : '添加到收藏'}><Star size={13} fill={favorite ? 'currentColor' : 'none'} /></button>}</div>
}
export const frameworkOptions = [
  { value: 'nonebot', label: 'NoneBot', description: 'Python 机器人框架', icon: SquareTerminal },
  { value: 'astrbot', label: 'AstrBot', description: 'Agent 与插件框架', icon: Bot },
]

export function FrameworkSelect({ value, onChange, disabled = false }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const selected = frameworkOptions.find((option) => option.value === value) || frameworkOptions[0]
  const SelectedIcon = selected.icon

  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const choose = (nextValue) => {
    onChange(nextValue)
    setOpen(false)
  }

  return <div className={`framework-select ${open ? 'open' : ''}`} ref={rootRef}>
    <button type="button" className="framework-select-trigger" onClick={() => setOpen((current) => !current)} disabled={disabled} aria-haspopup="listbox" aria-expanded={open}>
      <span className={`framework-select-icon ${selected.value}`}><SelectedIcon size={16} /></span>
      <span className="framework-select-copy"><strong>{selected.label}</strong><small>{selected.description}</small></span>
      <ChevronDown size={15} className="framework-select-chevron" />
    </button>
    {open && <div className="framework-select-menu" role="listbox" aria-label="机器人框架">
      {frameworkOptions.map((option) => {
        const OptionIcon = option.icon
        const isSelected = option.value === selected.value
        return <button key={option.value} type="button" className={`framework-select-option ${isSelected ? 'selected' : ''}`} role="option" aria-selected={isSelected} onClick={() => choose(option.value)}>
          <span className={`framework-select-icon ${option.value}`}><OptionIcon size={15} /></span>
          <span className="framework-select-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
          {isSelected && <Check size={15} className="framework-select-check" />}
        </button>
      })}
    </div>}
  </div>
}
export function BotUptime({ bot, className = '' }) {
  const running = isBotRunning(bot)
  const transitioning = isBotTransitioning(bot)
  const [now, setNow] = useState(() => Date.now())
  const anchorRef = useRef({ seconds: Number(bot.uptime_seconds || 0), syncedAt: Date.now() })

  useEffect(() => {
    anchorRef.current = { seconds: Number(bot.uptime_seconds || 0), syncedAt: Date.now() }
  }, [bot.id, bot.status, bot.uptime_seconds])

  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const liveSeconds = running
    ? Math.max(0, anchorRef.current.seconds + Math.floor((now - anchorRef.current.syncedAt) / 1000))
    : 0
  const label = running ? `持续运行 ${formatUptime(liveSeconds)}` : transitioning ? '等待启动' : '未运行'
  return <small className={`bot-uptime ${running ? 'running' : ''} ${className}`.trim()}>{label}</small>
}

export function BotAvatar({ bot, className = '' }) {
  const qq = String(bot?.qq || '').trim()
  const avatarUrl = qq ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qq)}&s=640` : ''
  const [failedUrl, setFailedUrl] = useState('')
  const failed = failedUrl === avatarUrl

  return <div className={`bot-avatar ${className}`} title={`${bot?.name || 'Bot'} 头像`} aria-label={`${bot?.name || 'Bot'} 头像`}>
    {avatarUrl && !failed ? <img className="bot-avatar-image" src={avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(avatarUrl)} /> : <Bot size={15} />}
  </div>
}

export function EmptyDetail({ onCreate }) {
  return <div className="empty-detail"><div className="empty-detail-icon"><Bot size={23} /></div><h2>还没有 QQ 账号</h2><p>添加你的真实 QQ 账号，开始管理 NapCat 和机器人框架。</p><button className="action-button" onClick={onCreate}><Plus size={15} />新建账号</button></div>
}

export function StatusPill({ label, state }) {
  return <span className={`status-pill ${state}`}><i />{label}</span>
}

export function RestartableStatus({ label, state, title, disabled, onRestart }) {
  return <button type="button" className={`status-pill restartable-status ${state}`} onClick={onRestart} disabled={disabled} aria-label={title} title={title}><i /><span className="status-current">{label}</span><span className="restart-label">重启</span></button>
}
export function renderLogText(message, prefix = '') {
  const parts = String(message || '').split(/(https?:\/\/[^\s<>"']+)/gi)
  return parts.map((part, index) => /^https?:\/\//i.test(part)
    ? <a key={`${prefix}-${part}-${index}`} className="log-link" href={part} onClick={(event) => { event.preventDefault(); openExternal(part) }} title="打开链接">{part}</a>
    : <React.Fragment key={`${prefix}-${index}`}>{part}</React.Fragment>)
}

export function ImageMessage({ image }) {
  const [open, setOpen] = useState(true)
  const [failed, setFailed] = useState(false)
  const filename = image.file || 'qq-image'
  const cachePath = `/api/media/cache?file=${encodeURIComponent(filename)}`
  const downloadPath = `/api/media/download?url=${encodeURIComponent(image.url)}&filename=${encodeURIComponent(filename)}`
  const cache = useAuthenticatedMedia(cachePath, open && image.truncated)

  const saveImage = async (event) => {
    event.preventDefault()
    try {
      const blob = await fetchAuthenticatedBlob(image.truncated ? `${cachePath}&download=1` : downloadPath)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      setFailed(true)
    }
  }

  return <span className="log-image-message"><button type="button" className="image-message-button" onClick={() => setOpen(value => !value)} aria-expanded={open}><ImageIcon size={14} /><span>{image.summary}</span><small>{open ? '收起' : '查看图片'}</small></button>{open && <span className="image-message-panel"><span className="image-message-preview">{failed || cache.error ? <span className="image-message-error">{image.truncated ? '日志里的图片链接已被 NoneBot 截断，且本地没有可用缓存' : '图片加载失败，请打开原链接查看'}</span> : image.truncated && !cache.url ? <span className="image-message-error">正在加载图片…</span> : <img src={image.truncated ? cache.url : image.url} alt={image.summary} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}</span><span className="image-message-meta">{image.file}{image.size ? ` · ${image.size} bytes` : ''}</span><span className="image-message-url"><a href={image.url} onClick={(event) => { event.preventDefault(); openExternal(image.url) }} title="打开原链接">{image.url}</a></span><span className="image-message-actions"><a className="image-message-action" href={image.url} onClick={(event) => { event.preventDefault(); openExternal(image.url) }}><ExternalLink size={13} />原链接</a><a className="image-message-action" href={image.url} onClick={saveImage}><Download size={13} />保存图片</a></span></span>}</span>
}

export function renderLogMessage(message) {
  return parseLogSegments(message).map((segment, index) => segment.type === 'image'
    ? <ImageMessage key={`image-${index}`} image={segment.value} />
    : <React.Fragment key={`text-${index}`}>{renderLogText(segment.value, `text-${index}`)}</React.Fragment>)
}

export function LogItem({ log, qrVisible, onToggleQr }) {
  const level = normalizeLogLevel(log.level, log.message)
  const multiline = String(log.message || '').includes('\n')
  return <div className={`log-item ${log.kind === 'qr' ? 'qr-log-item' : ''}`}><div className={`log-dot ${level}`} /><div className="log-copy">{log.kind === 'qr' ? <><div className="log-meta"><time>{log.time}</time><strong>[{log.source}]</strong></div>{qrVisible ? <div className="qr-card"><AuthenticatedQr time={log.time} /><span>使用手机 QQ 扫描此二维码登录</span><button type="button" className="qr-reveal" onClick={onToggleQr}>隐藏二维码</button></div> : <button type="button" className="qr-reveal" onClick={onToggleQr}>登录二维码已就绪 · 点击显示</button>}</> : <div className="log-line"><time>{log.time}</time><strong>[{log.source}]</strong><span className={`log-level-${level}${multiline ? ' log-multiline' : ''}`}>{renderLogMessage(log.message)}</span></div>}</div></div>
}

export function AuthenticatedQr({ time }) {
  const media = useAuthenticatedMedia(`/api/napcat/qrcode?time=${encodeURIComponent(time)}`, true)
  if (media.error) return <span className="image-message-error">二维码加载失败</span>
  return media.url ? <img src={media.url} alt="NapCat 登录二维码" /> : <span className="image-message-error">二维码加载中…</span>
}
export function CreateAccountModal({ account, creating, onChange, onClose, onSubmit }) {
  const [showPassword, setShowPassword] = useState(false)
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="create-modal" onSubmit={onSubmit}><div className="modal-header"><div><div className="eyebrow">QQ 控制台</div><h2>新建账号</h2><p>添加你的真实 QQ 账号</p></div><button type="button" className="modal-close" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><label>账号名称<input required maxLength="40" placeholder="例如：群管助手" value={account.name} onChange={event => onChange({ ...account, name: event.target.value })} /></label><label>QQ 号<input required pattern="[0-9]{5,20}" placeholder="请输入 5-20 位 QQ 号" value={account.qq} onChange={event => onChange({ ...account, qq: event.target.value })} /></label><label>机器人框架<FrameworkSelect value={account.framework} onChange={(framework) => onChange({ ...account, framework })} /><small>选择消息处理和插件运行框架，NapCat 负责 QQ 协议连接。</small></label><label>OneBot 连接端口<input required type="number" min="1024" max="65535" placeholder="例如：8080" value={account.port} onChange={event => onChange({ ...account, port: event.target.value })} /><small>每个账号必须使用不同端口，创建后会按所选框架配置 NapCat。</small></label><label>NapCat WebUI 端口（可选）<input type="number" min="1024" max="65535" placeholder="留空自动分配（默认 6099）" value={account.napcatPort} onChange={event => onChange({ ...account, napcatPort: event.target.value })} /><small>用于 NapCat 登录面板；留空会自动选择未占用端口。</small></label><label>登录密码（可选）<span className="password-input-wrap"><input type={showPassword ? 'text' : 'password'} maxLength="256" autoComplete="new-password" placeholder="留空则使用二维码登录" value={account.password} onChange={event => onChange({ ...account, password: event.target.value })} /><button type="button" className="password-toggle" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? '隐藏密码' : '显示密码'} title={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></span><small>密码只保存在本机配置中，不会显示在日志中。</small></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="action-button" disabled={creating}>{creating ? '创建中…' : '创建账号'}</button></div></form></div>
}

export function DeleteAccountModal({ bot, deleting, onClose, onConfirm }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="delete-modal" role="alertdialog" aria-labelledby="delete-account-title"><div className="modal-header"><div><div className="eyebrow">QQ 控制台</div><h2 id="delete-account-title">删除账号</h2><p>确认删除「{bot.name}」？</p></div><button type="button" className="modal-close" onClick={onClose} aria-label="关闭" disabled={deleting}><X size={18} /></button></div><div className="delete-warning">删除后会移除账号记录和专属启动脚本；不会删除 NapCat 安装文件。</div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={deleting}>取消</button><button type="button" className="action-button danger" onClick={onConfirm} disabled={deleting}>{deleting ? '删除中…' : '确认删除'}</button></div></div></div>
}
