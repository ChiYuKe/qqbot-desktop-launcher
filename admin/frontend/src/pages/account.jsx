import {  useEffect, useMemo, useRef, useState  } from 'react'
import { Copy, ExternalLink, MoreHorizontal, Pause, Play, Plus, RefreshCw, Search, Square, Trash2, UserRound } from 'lucide-react'
import { api, copyText } from '../lib/api.js'
import { botStatusLabel, botStatusState, isBotRunning, isBotTransitioning, openExternal } from '../lib/bot.js'
import { findLoginVerification, prepareLogItems } from '../lib/logs.js'
import { BotAvatar, BotUptime, EmptyDetail, FrameworkSelect, LogItem, RestartableStatus, StatusPill } from '../components.jsx'

const DSH_LOG_SOURCE = 'DeepSeek Harness'

// QQ 账号工作区：账号列表、实时活动日志、快速登录、WebUI 凭据与连接配置。
export function AccountWorkspace({ bots, selectedBot, selectedBotId, setSelectedBotId, napcat, online, refreshing, refresh, busy, action, onCreate, onDelete, logs, logsPaused, onTogglePause, onClear, onCommand, onSavePassword, onSavePort, onSaveNapcatPort, onSaveFramework, onOpenWebUi, onNotice }) {
  const [command, setCommand] = useState('')
  const [detailView, setDetailView] = useState('overview')
  const [visibleQrKey, setVisibleQrKey] = useState('')
  const autoOpenedQrKey = useRef('')
  const feedRef = useRef(null)
  const followLogsRef = useRef(true)
  const running = isBotRunning(selectedBot)
  const transitioning = isBotTransitioning(selectedBot)
  const botLogs = useMemo(() => selectedBot ? logs.filter((log) => log.source === selectedBot.name || log.source === DSH_LOG_SOURCE) : [], [logs, selectedBot?.name])
  const visibleLogs = useMemo(() => prepareLogItems(botLogs), [botLogs])
  const verification = useMemo(() => {
    if (selectedBot?.status === 'running' || selectedBot?.login_state === 'connected') return null
    return findLoginVerification(botLogs)
  }, [botLogs, selectedBot?.login_state, selectedBot?.status])

  useEffect(() => {
    if (feedRef.current && visibleLogs.length && followLogsRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [visibleLogs])

  useEffect(() => {
    let latestQrIndex = -1
    visibleLogs.forEach((log, index) => {
      if (log.kind === 'qr') latestQrIndex = index
    })
    if (latestQrIndex < 0) return
    const latestQr = visibleLogs[latestQrIndex]
    const qrKey = latestQr.time + '-' + latestQr.source + '-' + latestQrIndex
    if (autoOpenedQrKey.current === qrKey) return
    autoOpenedQrKey.current = qrKey
    setVisibleQrKey(qrKey)
  }, [visibleLogs])

  const submitCommand = async () => {
    const value = command.trim()
    if (!value || !selectedBot) return
    setCommand('')
    try {
      await onCommand(selectedBot, value, botLogs)
    } catch (error) {
      onNotice(`指令失败：${error.message}`)
    }
  }
  return <section className="workspace">
    <div className="workspace-list">
      <div className="list-header"><div><div className="eyebrow">工作区</div><h1>QQ 账号</h1></div><button className="plain-icon" onClick={() => onCreate()} aria-label="新建账号"><Plus size={17} /></button></div>
      <div className="list-toolbar"><div className="list-count">全部账号 <span>{bots.length}</span></div><button className="plain-icon" onClick={refresh} disabled={refreshing} aria-label="刷新"><RefreshCw size={15} className={refreshing ? 'spin' : ''} /></button></div>
      <div className="account-search-wrap"><Search size={15} /><input className="account-search" placeholder="筛选账号" /></div>
      <div className="account-list">
        {bots.length ? bots.map((bot) => <AccountListItem key={bot.id} bot={bot} selected={bot.id === selectedBotId || (!selectedBotId && bot.id === selectedBot?.id)} onClick={() => setSelectedBotId(bot.id)} />) : <div className="empty-list"><UserRound size={19} /><strong>还没有账号</strong><span>添加你自己的真实 QQ 账号。</span><button className="secondary" onClick={onCreate}><Plus size={14} />新建账号</button></div>}
      </div>
      <div className="list-footer"><span>{online ? '实时同步中' : '等待管理 API'}</span><span>{bots.length} 个账号</span></div>
    </div>

    <div className="workspace-detail">
      {selectedBot ? <>
        <div className="detail-topbar"><div className="detail-title"><BotAvatar bot={selectedBot} className="detail-avatar" /><div><div className="detail-kicker">QQ 账号 <span>/</span> {selectedBot.qq}</div><h2>{selectedBot.name}</h2></div></div><div className="detail-actions"><button className="soft-button" onClick={onDelete} aria-label="更多操作"><MoreHorizontal size={16} /></button><button className={`action-button ${running ? 'danger' : ''}`} onClick={() => action(selectedBot, running ? 'stop' : 'start', running ? '停止' : '启动')} disabled={busy.startsWith(`${selectedBot.id}:`) || transitioning}>{running ? <Square size={14} /> : <Play size={14} />}{transitioning ? botStatusLabel(selectedBot) : running ? '停止' : '启动'}</button></div></div>
        <div className="detail-tabs"><button className={`detail-tab ${detailView === 'overview' ? 'active' : ''}`} onClick={() => setDetailView('overview')}>概览</button><button className={`detail-tab ${detailView === 'config' ? 'active' : ''}`} onClick={() => setDetailView('config')}>配置</button></div>
        <div className={`detail-scroll ${detailView === 'config' ? 'config-detail' : ''}`}>
          {detailView === 'overview' ? <>
          <div className="account-summary"><div className="summary-row"><span>状态</span><StatusPill label={botStatusLabel(selectedBot)} state={botStatusState(selectedBot)} /></div><div className="summary-row"><span>持续运行</span><BotUptime bot={selectedBot} /></div><div className="summary-row"><span>QQ 号</span><b className="summary-value mono">{selectedBot.qq}</b></div><div className="summary-row"><span>协议端</span><RestartableStatus label="NapCat" state={!napcat.available ? 'red' : selectedBot.runtime?.napcat?.running ? 'green' : 'muted'} title="重启 NapCat 协议端" disabled={transitioning || busy.startsWith(`${selectedBot.id}:`)} onRestart={() => action(selectedBot, 'restart-napcat', '重启 NapCat 协议端')} /></div><div className="summary-row"><span>机器人框架</span><RestartableStatus label={selectedBot.framework_label || (selectedBot.framework === 'astrbot' ? 'AstrBot' : 'NoneBot')} state={selectedBot.runtime?.framework?.running ? 'green' : 'muted'} title="重启机器人框架" disabled={transitioning || busy.startsWith(`${selectedBot.id}:`)} onRestart={() => action(selectedBot, 'restart-framework', '重启机器人框架')} /></div><div className="summary-row"><span>OneBot 端口</span><b className="summary-value mono">{selectedBot.port || '—'}</b></div><div className="summary-row"><span>NapCat WebUI</span><b className="summary-value mono">{selectedBot.napcat_port || '—'}</b></div></div>
          <div className="conversation"><div className="conversation-header"><div><h3>实时活动</h3><span>{logsPaused ? '日志同步已暂停' : '来自本机服务的最新状态'}</span></div><div className="conversation-tools"><button className="plain-icon" onClick={onTogglePause} aria-label={logsPaused ? '恢复日志' : '暂停日志'} data-tooltip={logsPaused ? '恢复日志更新' : '暂停日志更新'}>{logsPaused ? <Play size={15} /> : <Pause size={15} />}</button><button className="plain-icon" onClick={onClear} aria-label="清空日志" data-tooltip="清空日志"><Trash2 size={15} /></button></div></div>{verification && <LoginVerificationCard verification={verification} onRetry={async () => { try { await onCommand(selectedBot, `-q ${selectedBot.qq}`, botLogs); onNotice('已重新尝试登录，请等待二维码或登录结果') } catch (error) { onNotice(`重新登录失败：${error.message}`) } }} onNotice={onNotice} />}<div className="activity-feed" ref={feedRef} onScroll={() => { const feed = feedRef.current; if (feed) followLogsRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24 }}>{visibleLogs.length ? visibleLogs.map((log, index) => { const qrKey = `${log.time}-${log.source}-${index}`; return <LogItem key={qrKey} log={log} qrVisible={visibleQrKey === qrKey} onToggleQr={() => setVisibleQrKey(visibleQrKey === qrKey ? '' : qrKey)} /> }) : <div className="activity-empty">暂无日志</div>}</div><div className="command-box"><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="输入 -q 2 快速登录…" onKeyDown={(event) => { if (event.key === 'Enter') submitCommand() }} /><button onClick={submitCommand} aria-label="发送"><Play size={14} /></button></div></div>
           </> : <AccountConfig key={`${selectedBot.id}-${selectedBot.port}-${selectedBot.napcat_port}-${selectedBot.framework}`} bot={selectedBot} onSavePassword={onSavePassword} onSavePort={onSavePort} onSaveNapcatPort={onSaveNapcatPort} onSaveFramework={onSaveFramework} onOpenWebUi={onOpenWebUi} onNotice={onNotice} />}
        </div>
      </> : <EmptyDetail onCreate={onCreate} />}
    </div>
  </section>
}

export function WebUiCredentials({ bot, onOpenWebUi, onNotice }) {
  const [status, setStatus] = useState(null)
  const [napcatToken, setNapcatToken] = useState('')
  const [resetCredentials, setResetCredentials] = useState(null)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    let active = true
    api(`/api/bots/${bot.id}/webui/status`).then((result) => {
      if (active) setStatus(result)
    }).catch((error) => {
      if (active) onNotice(`WebUI 登录信息读取失败：${error.message}`)
    })
    return () => { active = false }
  }, [bot.id, bot.napcat_port, bot.framework])

  const copy = async (value, label) => {
    if (!value) return
    try {
      const copied = await copyText(value)
      if (!copied) throw new Error('clipboard unavailable')
      onNotice(`${label}已复制`)
    } catch {
      onNotice(`无法复制${label}，请手动选择`)
    }
  }

  const revealNapcatToken = async () => {
    if (busy) return
    setBusy('napcat')
    try {
      const result = await api(`/api/bots/${bot.id}/napcat/webui`)
      setNapcatToken(result.token || '')
      if (!result.available) onNotice('没有找到 NapCat Token，请先启动一次 NapCat')
    } catch (error) {
      onNotice(`NapCat Token 读取失败：${error.message}`)
    } finally {
      setBusy('')
    }
  }

  const resetAstrbotPassword = async () => {
    if (busy || !window.confirm('确定重置 AstrBot WebUI 密码吗？旧密码会立即失效。')) return
    setBusy('astrbot')
    try {
      const result = await api(`/api/bots/${bot.id}/astrbot/password/reset`, { method: 'POST' })
      setResetCredentials(result)
      setStatus((current) => current?.astrbot ? { ...current, astrbot: { ...current.astrbot, password_saved: true } } : current)
      onNotice('AstrBot WebUI 密码已重置并加密保存，重启 Bot 后生效')
    } catch (error) {
      onNotice(`密码重置失败：${error.message}`)
    } finally {
      setBusy('')
    }
  }

  const revealAstrbotPassword = async () => {
    if (busy) return
    setBusy('astrbot-password')
    try {
      const result = await api(`/api/bots/${bot.id}/astrbot/password`)
      setResetCredentials({ ...result, password_saved: true, restart_required: false })
      onNotice('已读取本机保存的 AstrBot WebUI 密码')
    } catch (error) {
      onNotice(`密码读取失败：${error.message}`)
    } finally {
      setBusy('')
    }
  }

  const clearAstrbotPassword = async () => {
    if (busy || !window.confirm('确定清除本机保存的 AstrBot WebUI 密码吗？不会修改 AstrBot 当前密码。')) return
    setBusy('astrbot-clear-password')
    try {
      await api(`/api/bots/${bot.id}/astrbot/password`, { method: 'DELETE' })
      setResetCredentials(null)
      setStatus((current) => current?.astrbot ? { ...current, astrbot: { ...current.astrbot, password_saved: false } } : current)
      onNotice('本机保存的 AstrBot WebUI 密码已清除')
    } catch (error) {
      onNotice(`密码清除失败：${error.message}`)
    } finally {
      setBusy('')
    }
  }

  const napcat = status?.napcat
  const astrbot = status?.astrbot
  return <>
    <section className="config-card webui-credentials-card">
      <div className="config-card-title"><div><strong>WebUI 登录信息</strong><span>本机恢复</span></div><StatusPill label={status ? '可检查' : '读取中'} state={status ? 'green' : 'muted'} /></div>
      <div className="credential-row"><div><strong>NapCat Token</strong><small>{napcat?.available ? '已从本机进程日志找到最新 Token' : '暂未找到 Token，请先启动 NapCat'}</small></div><div className="credential-actions"><button type="button" className="secondary" onClick={() => onOpenWebUi('napcat', bot)}>打开 WebUI</button><button type="button" className="secondary" disabled={busy === 'napcat' || !napcat?.available} onClick={revealNapcatToken}>{busy === 'napcat' ? '读取中…' : '显示 Token'}</button></div></div>
      {napcatToken && <div className="credential-secret"><input readOnly value={napcatToken} aria-label="NapCat Token" /><button type="button" className="plain-icon" onClick={() => copy(napcatToken, 'NapCat Token')} aria-label="复制 NapCat Token" data-tooltip="复制 NapCat Token"><Copy size={15} /></button></div>}
      {astrbot && <div className="credential-row"><div><strong>AstrBot WebUI</strong><small>用户名：<span className="mono">{astrbot.username}</span>{astrbot.password_saved ? ' · 密码已加密保存' : ' · 尚未保存密码'}</small></div><div className="credential-actions"><button type="button" className="secondary" onClick={() => onOpenWebUi('astrbot', bot)}>打开 WebUI</button>{astrbot.password_saved ? <button type="button" className="secondary" disabled={Boolean(busy)} onClick={revealAstrbotPassword}>{busy === 'astrbot-password' ? '读取中…' : '显示密码'}</button> : null}<button type="button" className="secondary" disabled={Boolean(busy)} onClick={resetAstrbotPassword}>{busy === 'astrbot' ? '重置中…' : '重置密码'}</button>{astrbot.password_saved ? <button type="button" className="secondary" disabled={Boolean(busy)} onClick={clearAstrbotPassword}>{busy === 'astrbot-clear-password' ? '清除中…' : '清除保存'}</button> : null}</div></div>}
      {resetCredentials && <div className="credential-secret generated-credential"><div><span>{resetCredentials.password_saved ? 'WebUI 密码' : '新密码'}</span><input readOnly type="text" value={resetCredentials.password} aria-label="AstrBot WebUI 密码" /><button type="button" className="plain-icon" onClick={() => copy(resetCredentials.password, 'AstrBot WebUI 密码')} aria-label="复制 AstrBot WebUI 密码" data-tooltip="复制 AstrBot WebUI 密码"><Copy size={15} /></button></div><small>{resetCredentials.restart_required ? '密码已加密保存到本机；重启 Bot 后登录。' : '密码已从本机加密存储中读取。若在 AstrBot 内修改，请重新重置并保存。'}</small></div>}
      <small className="credential-note">AstrBot WebUI 密码只在你点击“显示密码”时读取；保存内容受当前 Windows 用户保护，换用户后无法恢复。</small>
    </section>
  </>
}
export function AccountConfig({ bot, onSavePassword, onSavePort, onSaveNapcatPort, onSaveFramework, onOpenWebUi, onNotice }) {
  const [password, setPassword] = useState('')
  const [passwordEditing, setPasswordEditing] = useState(false)
  const [port, setPort] = useState(String(bot.port || ''))
  const [napcatPort, setNapcatPort] = useState(String(bot.napcat_port || ''))
  const [framework, setFramework] = useState(bot.framework || 'nonebot')
  const [savingPassword, setSavingPassword] = useState(false)
  const [savingPort, setSavingPort] = useState(false)
  const [savingNapcatPort, setSavingNapcatPort] = useState(false)
  const [savingFramework, setSavingFramework] = useState(false)

  const save = async (event) => {
    event.preventDefault()
    if (bot.password_configured && !passwordEditing) {
      onNotice('密码未修改')
      return
    }
    setSavingPassword(true)
    try {
      await onSavePassword(bot, password)
      setPassword('')
      setPasswordEditing(false)
    } catch (error) {
      onNotice(`保存失败：${error.message}`)
    } finally {
      setSavingPassword(false)
    }
  }

  const savePort = async (event) => {
    event.preventDefault()
    const nextPort = Number(port)
    setSavingPort(true)
    try {
      await onSavePort(bot, nextPort)
    } catch (error) {
      onNotice(`保存失败：${error.message}`)
    } finally {
      setSavingPort(false)
    }
  }

  const saveNapcatPort = async (event) => {
    event.preventDefault()
    const nextPort = Number(napcatPort)
    setSavingNapcatPort(true)
    try {
      await onSaveNapcatPort(bot, nextPort)
    } catch (error) {
      onNotice(`保存失败：${error.message}`)
    } finally {
      setSavingNapcatPort(false)
    }
  }

  const saveFramework = async (event) => {
    event.preventDefault()
    setSavingFramework(true)
    try {
      await onSaveFramework(bot, framework)
    } catch (error) {
      onNotice(`保存失败：${error.message}`)
      setFramework(bot.framework || 'nonebot')
    } finally {
      setSavingFramework(false)
    }
  }

  return <div className="config-panel"><div className="config-heading"><div><div className="eyebrow">账号配置</div><h3>连接与登录</h3><p>为「{bot.name}」管理 NapCat、机器人框架、OneBot 端口和登录配置。</p></div><StatusPill label={bot.password_configured ? '已设置密码' : '未设置密码'} state={bot.password_configured ? 'green' : 'muted'} /></div><WebUiCredentials bot={bot} onOpenWebUi={onOpenWebUi} onNotice={onNotice} /><form className="config-card" onSubmit={saveFramework}><div className="config-card-title"><div><strong>机器人框架</strong><span>运行核心</span></div><span className="config-status">当前 {framework === 'astrbot' ? 'AstrBot' : 'NoneBot'}</span></div><label className="config-field">框架<FrameworkSelect value={framework} onChange={setFramework} disabled={savingFramework} /><small>NapCat 负责 QQ 协议连接，框架负责消息处理和插件运行。切换前必须先停止 Bot。</small></label><div className="config-actions"><button type="submit" className="action-button" disabled={savingFramework || framework === (bot.framework || 'nonebot')}>{savingFramework ? '保存中…' : '保存框架'}</button></div></form><form className="config-card" onSubmit={save}><div className="config-card-title"><div><strong>密码回退</strong><span>可选配置</span></div><span className="config-status">{bot.password_configured ? '当前已配置' : '当前未配置'}</span></div><label className="config-field">登录密码<span className="password-input-wrap"><input type="password" maxLength="256" autoComplete="new-password" placeholder={bot.password_configured && !passwordEditing ? '已设置，输入新密码可覆盖' : '留空则使用二维码登录'} value={password} readOnly={bot.password_configured && !passwordEditing} onFocus={() => { if (!passwordEditing) { setPasswordEditing(true); setPassword('') } }} onChange={event => setPassword(event.target.value)} /></span><small>密码只支持覆盖或清除，不提供读取原密码功能。</small></label><div className="config-actions"><button type="submit" className="action-button" disabled={savingPassword}>{savingPassword ? '保存中…' : '保存密码'}</button></div></form><form className="config-card" onSubmit={savePort}><div className="config-card-title"><div><strong>OneBot 连接端口</strong><span>{framework === 'astrbot' ? 'AstrBot 服务' : 'NoneBot 服务'}</span></div><span className="config-status">当前 {bot.port}</span></div><label className="config-field">本地端口<input required type="number" min="1024" max="65535" value={port} onChange={event => setPort(event.target.value)} /><small>NapCat 会连接到 {framework === 'astrbot' ? '/ws' : '/onebot/v11/ws'}，重启 Bot 后生效。</small></label><div className="config-actions"><button type="submit" className="action-button" disabled={savingPort || !port}>{savingPort ? '保存中…' : '保存端口'}</button></div></form><form className="config-card" onSubmit={saveNapcatPort}><div className="config-card-title"><div><strong>NapCat WebUI 端口</strong><span>登录面板</span></div><span className="config-status">当前 {bot.napcat_port}</span></div><label className="config-field">本地端口<input required type="number" min="1024" max="65535" value={napcatPort} onChange={event => setNapcatPort(event.target.value)} /><small>用于打开 NapCat WebUI 登录面板；留空会自动选择未占用端口。</small></label><div className="config-actions"><button type="submit" className="action-button" disabled={savingNapcatPort || !napcatPort}>{savingNapcatPort ? '保存中…' : '保存端口'}</button></div></form></div>
}
export function AccountListItem({ bot, selected, onClick }) {
  const running = isBotRunning(bot)
  const transitioning = isBotTransitioning(bot)
  const framework = bot.framework_label || (bot.framework === 'astrbot' ? 'AstrBot' : 'NoneBot')
  return <button className={`account-list-item ${selected ? 'selected' : ''}`} onClick={onClick}><BotAvatar bot={bot} className="list-avatar" /><div className="list-item-copy"><strong>{bot.name}</strong><span>{bot.qq} · {framework}</span><BotUptime bot={bot} /></div><div className={`list-status ${running ? 'green' : transitioning ? 'blue' : ''}`}><i />{botStatusLabel(bot)}</div></button>
}
export function LoginVerificationCard({ verification, onRetry, onNotice }) {
  const [embedTarget, setEmbedTarget] = useState('')
  const [frameKey, setFrameKey] = useState(0)
  const webuiOpen = embedTarget === 'webui'
  const proofOpen = embedTarget === 'proof'
  const embeddedUrl = webuiOpen ? verification.webuiUrl : proofOpen ? verification.proofUrl : ''
  const embeddedTitle = webuiOpen ? 'NapCat WebUI 安全验证' : 'QQ 安全验证'

  const open = (url, label) => {
    if (!url) {
      onNotice(`${label}地址尚未从日志中获取，请稍后重试`)
      return
    }
    openExternal(url)
  }
  return <div className={`login-verification-card ${webuiOpen ? 'is-expanded' : ''}`}>
    <div className="login-verification-copy"><strong>需要 QQ 安全验证</strong><span>密码回退失败后会自动切换到二维码登录，也可以在这里完成 QQ 安全验证；完成后点击“重新登录”即可。</span></div>
    <div className="login-verification-actions">
      <button type="button" className="soft-button" onClick={() => setEmbedTarget((target) => target === 'webui' ? '' : 'webui')} disabled={!verification.webuiUrl}>{webuiOpen ? '收起 WebUI' : '在面板中打开 WebUI'}</button>
      <button type="button" className="soft-button" onClick={() => setEmbedTarget((target) => target === 'proof' ? '' : 'proof')} disabled={!verification.proofUrl}>{proofOpen ? '收起安全验证' : '打开安全验证'}</button>
      <button type="button" className="action-button" onClick={onRetry}>重新登录</button>
    </div>
    {embeddedUrl && <div className="login-verification-embed">
      <iframe key={embedTarget + '-' + frameKey} title={embeddedTitle} src={embeddedUrl} />
      <div className="login-verification-embed-tools"><span>如果窗口空白，请使用外部窗口打开。</span><button type="button" className="soft-button" onClick={() => setFrameKey((key) => key + 1)}><RefreshCw size={13} />刷新</button><button type="button" className="soft-button" onClick={() => open(embeddedUrl, embeddedTitle)}><ExternalLink size={13} />外部打开</button></div>
    </div>}
  </div>
}
