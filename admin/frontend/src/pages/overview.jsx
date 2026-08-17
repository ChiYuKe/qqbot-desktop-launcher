import {  useMemo  } from 'react'
import { Activity, Bot, ChevronRight, MessageSquare, Puzzle, RefreshCw, Server, UserRound } from 'lucide-react'
import { botStatusLabel, botStatusState, isBotRunning } from '../lib/bot.js'
import { normalizeLogLevel } from '../lib/logs.js'
import { BotAvatar, BotUptime, StatusPill } from '../components.jsx'

// 概览页：账号/服务指标、最近活动。
export function OverviewPage({ bots, stats, napcat, online, logs, refreshing, refresh, onNavigate, onSelectBot }) {
  const dayStats = stats?.periods?.day || {}
  const runningBots = bots.filter((bot) => isBotRunning(bot))
  const recentLogs = useMemo(() => (Array.isArray(logs) ? [...logs].reverse().slice(0, 5) : []), [logs])
  const todayMessages = Number(dayStats.total || 0)
  const serviceReady = Boolean(online && napcat?.available)

  return <section className="overview-page">
    <header className="overview-page-header">
      <div><div className="eyebrow">控制台</div><h1>概览</h1><p>快速了解 QQ Bot 的运行情况和最近活动。</p></div>
      <div className="overview-header-actions"><span className={`overview-sync ${online ? 'online' : ''}`}><i />{online ? '实时同步中' : '等待管理 API'}</span><button type="button" className="secondary overview-refresh" onClick={refresh} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : ''} />刷新</button></div>
    </header>

    <div className="overview-metrics">
      <div className="overview-metric"><div className="overview-metric-icon purple"><UserRound size={18} /></div><div><span>QQ 账号</span><strong>{bots.length}</strong><em>{runningBots.length} 个运行中</em></div></div>
      <div className="overview-metric"><div className="overview-metric-icon green"><Bot size={18} /></div><div><span>在线 Bot</span><strong>{runningBots.length}<small> / {bots.length}</small></strong><em>{bots.length ? '账号运行状态' : '尚未创建账号'}</em></div></div>
      <div className="overview-metric"><div className="overview-metric-icon blue"><MessageSquare size={18} /></div><div><span>今日消息</span><strong>{todayMessages.toLocaleString()}</strong><em>收到与发出的消息</em></div></div>
      <div className="overview-metric"><div className="overview-metric-icon orange"><Server size={18} /></div><div><span>管理服务</span><strong>{serviceReady ? '正常' : '待连接'}</strong><em>{napcat?.available ? 'NapCat 资源已就绪' : '请先配置运行资源'}</em></div></div>
    </div>

    <div className="overview-grid">
      <section className="overview-card overview-bots-card"><div className="overview-card-heading"><div><h2>账号运行概况</h2><p>查看账号状态并快速进入管理页。</p></div><button type="button" className="overview-link" onClick={() => onNavigate('QQ 账号')}>管理账号 <ChevronRight size={14} /></button></div>{bots.length ? <div className="overview-bot-list">{bots.slice(0, 5).map((bot) => <button type="button" className="overview-bot-row" key={bot.id} onClick={() => onSelectBot(bot.id)}><BotAvatar bot={bot} className="overview-bot-avatar" /><span className="overview-bot-copy"><strong>{bot.name}</strong><small>{bot.qq} · {bot.framework_label || (bot.framework === 'astrbot' ? 'AstrBot' : 'NoneBot')}</small><BotUptime bot={bot} /></span><StatusPill label={botStatusLabel(bot)} state={botStatusState(bot)} /><ChevronRight className="overview-row-arrow" size={15} /></button>)}</div> : <div className="overview-empty"><UserRound size={18} /><span>还没有 QQ 账号</span><button type="button" className="secondary" onClick={() => onNavigate('QQ 账号')}>新建账号</button></div>}</section>

      <div className="overview-side">
        <section className="overview-card"><div className="overview-card-heading"><div><h2>服务状态</h2><p>本机运行环境</p></div><button type="button" className="overview-link" onClick={() => onNavigate('运行状态')}>详细状态 <ChevronRight size={14} /></button></div><div className="overview-service-list"><div><span><i className={serviceReady ? 'green' : ''} />管理 API</span><StatusPill label={online ? '正常' : '等待连接'} state={online ? 'green' : 'muted'} /></div><div><span><i className={napcat?.available ? 'green' : ''} />NapCat</span><StatusPill label={napcat?.available ? `${napcat.running || 0} 个运行中` : '未配置'} state={napcat?.available ? 'green' : 'muted'} /></div><div><span><i className={runningBots.length ? 'green' : ''} />机器人框架</span><StatusPill label={runningBots.length ? '运行中' : '未启动'} state={runningBots.length ? 'green' : 'muted'} /></div></div></section>
        <section className="overview-card overview-actions-card"><div className="overview-card-heading"><div><h2>常用入口</h2><p>继续处理你的 Bot</p></div></div><div className="overview-actions"><button type="button" onClick={() => onNavigate('QQ 账号')}><UserRound size={15} />管理 QQ 账号</button><button type="button" onClick={() => onNavigate('运行状态')}><Activity size={15} />查看运行状态</button><button type="button" onClick={() => onNavigate('插件管理')}><Puzzle size={15} />管理插件</button></div></section>
      </div>
    </div>

    <section className="overview-card overview-activity-card"><div className="overview-card-heading"><div><h2>最近活动</h2><p>来自本机服务的最新日志</p></div><button type="button" className="overview-link" onClick={() => onNavigate('QQ 账号')}>查看账号日志 <ChevronRight size={14} /></button></div>{recentLogs.length ? <div className="overview-activity-list">{recentLogs.map((log, index) => { const level = normalizeLogLevel(log.level, log.message); return <div className="overview-activity-row" key={`${log.id || log.timestamp || log.time || index}`}><i className={level} /><time>{log.time || '—'}</time><strong>{log.source || '系统'}</strong><span>{String(log.message || '').replace(/\s+/g, ' ').slice(0, 110)}</span></div> })}</div> : <div className="overview-empty compact"><Activity size={18} /><span>暂无活动记录</span></div>}</section>
  </section>
}
