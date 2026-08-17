import {  useCallback, useEffect, useRef, useState  } from 'react'
import { Bot, ChevronLeft, ChevronRight, CircleHelp, Cpu, Database, FileText, Gauge, MessageSquare, Play, Server, Square, SquareTerminal } from 'lucide-react'
import { botStatusLabel, botStatusState, isBotRunning, isBotTransitioning } from '../lib/bot.js'
import { BotAvatar, BotUptime, StatusPill } from '../components.jsx'

// 运行状态页：消息趋势图、Bot 运行概况与服务状态；以及预留页占位组件。
export function RuntimeStatusPage({ bots, system, stats, napcat, online, busy, action, onSelectBot }) {
  const [period, setPeriod] = useState('day')
  const [chartMode, setChartMode] = useState('daily')
  const [intradayDay, setIntradayDay] = useState('')
  const [botPage, setBotPage] = useState(1)
  const [hoveredChartIndex, setHoveredChartIndex] = useState(null)
  const chartAreaRef = useRef(null)
  const chartPlotRef = useRef(null)
  const chartHoverRatioRef = useRef(null)
  const runningBots = bots.filter((bot) => isBotRunning(bot))
  const frameworkNames = [...new Set(bots.map((bot) => bot.framework_label || (bot.framework === 'astrbot' ? 'AstrBot' : 'NoneBot')))]
  const periodStats = stats?.periods?.[period] || { received: 0, sent: 0, total: 0, groups: 0, private: 0, media: 0, commands: 0, active_days: 0 }
  const todayStats = stats?.periods?.day || { received: 0, sent: 0, total: 0, groups: 0, private: 0, media: 0, commands: 0, active_days: 0 }
  const todayBots = stats?.bots?.day || []
  const dailySeries = stats?.series || []
  const intradayByDay = stats?.intraday_by_day || {}
  const defaultIntradayDay = dailySeries[dailySeries.length - 1]?.day || ''
  const selectedIntradayDay = intradayDay || defaultIntradayDay
  const intradaySeries = intradayByDay[selectedIntradayDay] || (selectedIntradayDay === defaultIntradayDay ? stats?.intraday || [] : [])
  const showIntraday = period === 'day' && chartMode === 'intraday'
  const selectedSeries = showIntraday ? intradaySeries : dailySeries
  const emptySeries = showIntraday
    ? Array.from({ length: 24 }, (_, index) => ({ time: `${String(index).padStart(2, '0')}:00`, received: 0, sent: 0 }))
    : Array.from({ length: 14 }, (_, index) => ({ day: `empty-${index}`, received: 0, sent: 0 }))
  const chartSeries = selectedSeries.length ? selectedSeries : emptySeries
  const maxDaily = Math.max(1, ...chartSeries.map((item) => Math.max(Number(item.received || 0), Number(item.sent || 0))))
  const hasSeriesData = chartSeries.some((item) => Number(item.received || 0) > 0 || Number(item.sent || 0) > 0)
  const chartScaleStep = showIntraday ? 10 : 100
  const chartScale = hasSeriesData ? Math.max(chartScaleStep, Math.ceil(maxDaily / chartScaleStep) * chartScaleStep) : 80
  const chartLabels = hasSeriesData ? [chartScale, chartScale * .75, chartScale * .5, chartScale * .25, 0] : [80, 60, 40, 20, 0]
  const chartPointPosition = (item, index, key) => {
    const x = chartSeries.length === 1 ? 50 : index / (chartSeries.length - 1) * 100
    const value = Number(item[key] || 0)
    const y = 100 - (value / chartScale * 100)
    return { x, y }
  }
  const chartPoints = (key) => chartSeries.map((item, index) => {
    const { x, y } = chartPointPosition(item, index, key)
    return `${x},${y}`
  }).join(' ')
  const chartLabel = (item) => {
    const value = String(item?.time || item?.day || '')
    return item?.time || (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(5) : value)
  }
  const chartTooltipLabel = (item) => item?.last_at || chartLabel(item)
  const hoveredChartItem = hoveredChartIndex === null ? null : chartSeries[hoveredChartIndex]
  const hoveredChartPosition = hoveredChartItem
    ? chartPointPosition(hoveredChartItem, hoveredChartIndex, 'received')
    : null
  const hoveredSentPosition = hoveredChartItem
    ? chartPointPosition(hoveredChartItem, hoveredChartIndex, 'sent')
    : null
  const chartTooltipY = hoveredChartPosition && hoveredSentPosition
    ? Math.max(22, Math.min(hoveredChartPosition.y, hoveredSentPosition.y))
    : 0
  const setChartHoverPosition = (ratio) => {
    chartHoverRatioRef.current = ratio
    chartPlotRef.current?.style.setProperty('--chart-hover-x', `${ratio * 100}%`)
  }
  const handleChartMouseMove = (event) => {
    if (!hasSeriesData || !chartSeries.length) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = bounds.width ? Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)) : 0
    const nextIndex = chartSeries.length === 1 ? 0 : Math.round(ratio * (chartSeries.length - 1))
    setChartHoverPosition(ratio)
    setHoveredChartIndex((current) => current === nextIndex ? current : nextIndex)
  }
  const handleChartWheel = useCallback((event) => {
    if (period !== 'day') return
    if (!event.deltaY) return
    if (!showIntraday && event.deltaY < 0) return
    if (showIntraday && event.deltaY > 0) return
    const nextDay = hoveredChartItem?.day
    if (!showIntraday && !/^\d{4}-\d{2}-\d{2}$/.test(String(nextDay || ''))) return
    const scrollContainer = event.currentTarget.closest('.runtime-page')
    const previousScrollTop = scrollContainer?.scrollTop ?? 0
    event.preventDefault()
    if (showIntraday) {
      setChartMode('daily')
    } else {
      setIntradayDay(nextDay)
      setChartMode('intraday')
    }
    const restoreScrollPosition = () => {
      if (scrollContainer) scrollContainer.scrollTop = previousScrollTop
    }
    window.requestAnimationFrame(restoreScrollPosition)
    window.setTimeout(restoreScrollPosition, 0)
  }, [hoveredChartItem?.day, period, showIntraday])

  useEffect(() => {
    const chartArea = chartAreaRef.current
    if (!chartArea) return undefined
    chartArea.addEventListener('wheel', handleChartWheel, { passive: false })
    return () => chartArea.removeEventListener('wheel', handleChartWheel)
  }, [handleChartWheel])
  const periodLabel = period === 'day' ? '今日' : period === 'week' ? '本周' : '本月'
  // The KPI and account table are explicitly labelled "今日消息". They must
  // remain daily even when the trend panel is switched to week or month.
  const dashboardTotal = Number(todayStats.total || 0)
  const overviewStats = showIntraday
    ? dailySeries.find((item) => item.day === selectedIntradayDay) || periodStats
    : periodStats
  const overviewPeriodLabel = showIntraday && selectedIntradayDay ? chartLabel({ day: selectedIntradayDay }) : periodLabel
  const total = Number(overviewStats.total || 0)
  const received = Number(overviewStats.received || 0)
  const sent = Number(overviewStats.sent || 0)
  const receivedShare = total ? Math.round(received / total * 100) : 0
  const sentShare = total ? Math.round(sent / total * 100) : 0
  const media = Number(overviewStats.media || 0)
  const mediaShare = total ? Math.round(media / total * 100) : 0
  const yesterdaySeries = dailySeries.length > 1 ? dailySeries[dailySeries.length - 2] : null
  const yesterdayTotal = yesterdaySeries ? Number(yesterdaySeries.received || 0) + Number(yesterdaySeries.sent || 0) : 0
  const dailyChange = yesterdayTotal ? Math.round((dashboardTotal - yesterdayTotal) / yesterdayTotal * 100) : null
  const botStats = new Map(todayBots.map((item) => [String(item.id), item]))
  const firstBot = bots[0]
  const memoryTotal = Number(system.memory_total || 0)
  const memoryText = online && memoryTotal
    ? `${((memoryTotal * Number(system.memory || 0) / 100) / (1024 ** 3)).toFixed(1)} GB / ${(memoryTotal / (1024 ** 3)).toFixed(1)} GB`
    : '本机资源占用'
  const pageSize = 3
  const pageCount = Math.max(1, Math.ceil(bots.length / pageSize))
  const currentBotPage = Math.min(botPage, pageCount)
  const visibleBots = bots.slice((currentBotPage - 1) * pageSize, currentBotPage * pageSize)
  useEffect(() => {
    const ratio = chartHoverRatioRef.current
    if (!hasSeriesData || ratio === null || !chartSeries.length) {
      setHoveredChartIndex(null)
      return
    }
    setChartHoverPosition(ratio)
    const nextIndex = chartSeries.length === 1 ? 0 : Math.round(ratio * (chartSeries.length - 1))
    setHoveredChartIndex((current) => current === nextIndex ? current : nextIndex)
  }, [period, chartMode, intradayDay, chartSeries.length, hasSeriesData])
  return <section className="runtime-page">
    <div className="runtime-metrics">
      <div className="runtime-metric"><div className="runtime-metric-icon purple"><Bot size={19} /></div><div><span>在线 Bot</span><strong>{runningBots.length}<small> / {bots.length}</small></strong><em>全部在线</em></div></div>
      <div className="runtime-metric"><div className="runtime-metric-icon green"><MessageSquare size={19} /></div><div><span>今日消息</span><strong>{dashboardTotal.toLocaleString()} <small>条</small></strong><em className={dailyChange !== null && dailyChange >= 0 ? 'positive' : ''}>{dailyChange === null ? '较昨日暂无数据' : `较昨日 ${dailyChange >= 0 ? '↑' : '↓'} ${Math.abs(dailyChange)}%`}</em></div></div>
      <div className="runtime-metric"><div className="runtime-metric-icon blue"><Cpu size={17} /></div><div><span>CPU 使用率</span><strong>{online ? `${Math.round(system.cpu ?? 0)}%` : '—'}</strong><em>负载良好</em></div></div>
      <div className="runtime-metric"><div className="runtime-metric-icon orange"><Database size={17} /></div><div><span>内存使用率</span><strong>{online ? `${Math.round(system.memory ?? 0)}%` : '—'}</strong><em>{memoryText}</em></div></div>
    </div>

    <section className="runtime-section runtime-stats-section">
      <div className="runtime-section-heading runtime-stats-heading"><div><h2>消息趋势 <button className="runtime-info" type="button" title="查看消息统计说明" aria-label="查看消息统计说明"><CircleHelp size={14} /></button></h2><p>{showIntraday ? `${chartLabel({ day: selectedIntradayDay })} 按小时的收发消息统计` : '最近 14 天的收发消息统计 · 悬停日期后滚轮查看时分'}</p></div><div className="runtime-period-tabs">{[['day', '今日'], ['week', '本周'], ['month', '本月']].map(([value, label]) => <button key={value} className={period === value ? 'selected' : ''} onClick={() => { setPeriod(value); if (value !== 'day') { setChartMode('daily'); setIntradayDay('') } }}>{label}</button>)}</div></div>
      <div className="runtime-analytics-grid">
        <div className="runtime-chart-panel">
          <div className="runtime-chart-head"><div className="runtime-chart-legend"><span><i className="received" />收到</span><span><i className="sent" />发出</span></div></div>
          <div ref={chartAreaRef} className="runtime-chart-area" aria-label={showIntraday ? `${chartLabel({ day: selectedIntradayDay })} 按小时收到和发出消息趋势` : '近 14 天收到和发出消息趋势，悬停日期后滚轮查看时分'}>
            <div className="runtime-chart-y-axis">{chartLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>
            <div ref={chartPlotRef} className={`runtime-chart-plot ${hoveredChartIndex === null ? '' : 'has-hover'}`} onMouseMove={handleChartMouseMove} onMouseLeave={() => { setHoveredChartIndex(null); chartHoverRatioRef.current = null; chartPlotRef.current?.style.removeProperty('--chart-hover-x') }}><div className="runtime-chart-grid-lines"><i /><i /><i /><i /><i /></div><svg className="runtime-line-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline className="received" points={chartPoints('received')} /><polyline className="sent" points={chartPoints('sent')} /></svg>{hasSeriesData && <div className="runtime-chart-points">{chartSeries.flatMap((item, index) => ['received', 'sent'].map((key) => { const { x, y } = chartPointPosition(item, index, key); const seriesLabel = key === 'received' ? '收到' : '发出'; const canDrillDown = !showIntraday && /^\d{4}-\d{2}-\d{2}$/.test(String(item.day || '')); const pointRatio = chartSeries.length === 1 ? .5 : index / (chartSeries.length - 1); const setPointHover = () => { setChartHoverPosition(pointRatio); setHoveredChartIndex(index) }; return <button type="button" key={`${item.time || item.day}-${key}`} className={`runtime-chart-point ${key} ${canDrillDown ? 'drillable' : ''} ${hoveredChartIndex === index ? 'active' : ''}`} style={{ left: `${x}%`, top: `${y}%` }} aria-label={`${chartLabel(item)} ${seriesLabel} ${Number(item[key] || 0).toLocaleString()} 条`} title={canDrillDown ? `点击查看${chartLabel(item)}的时分` : undefined} onMouseEnter={setPointHover} onFocus={setPointHover} onBlur={() => { setHoveredChartIndex(null); chartHoverRatioRef.current = null; chartPlotRef.current?.style.removeProperty('--chart-hover-x') }} onClick={() => { if (canDrillDown) { setIntradayDay(item.day); setChartMode('intraday') } }}><span className="runtime-chart-point-dot" aria-hidden="true" /></button> }))}</div>}{hoveredChartItem && hoveredChartPosition && <><span className="runtime-chart-hover-line" style={{ left: 'var(--chart-hover-x, 50%)' }} aria-hidden="true" /><div className={`runtime-chart-tooltip ${hoveredChartPosition.x < 18 ? 'edge-left' : hoveredChartPosition.x > 82 ? 'edge-right' : ''}`} style={{ left: 'var(--chart-hover-x, 50%)', top: `${chartTooltipY}%` }} role="status"><strong>{chartTooltipLabel(hoveredChartItem)}</strong><span><i className="received" />收到 <b>{Number(hoveredChartItem.received || 0).toLocaleString()}</b></span><span><i className="sent" />发出 <b>{Number(hoveredChartItem.sent || 0).toLocaleString()}</b></span></div></>}<div className="runtime-chart-x-axis">{(hasSeriesData ? chartSeries : emptySeries).map((item, index, items) => { const step = showIntraday ? 4 : 2; const visible = index === 0 || index === items.length - 1 || index % step === 0; return <span className={hoveredChartIndex === index ? 'active' : ''} key={`${item.time || item.day}-${index}`}>{visible ? chartLabel(item) : ''}</span> })}</div></div>
          </div>
        </div>
        <div className="runtime-overview-panel"><h3>{overviewPeriodLabel}统计</h3><div className="runtime-share-list"><div><span><i className="received" />收到消息</span><b>{received.toLocaleString()}</b><small>{receivedShare}%</small></div><div><span><i className="sent" />发出消息</span><b>{sent.toLocaleString()}</b><small>{sentShare}%</small></div><div><span><i className="media" />含媒体消息</span><b>{media.toLocaleString()}</b><small>{mediaShare}%</small></div></div><div className="runtime-overview-foot"><span>群聊 {Number(overviewStats.groups || 0).toLocaleString()}</span><span>私聊 {Number(overviewStats.private || 0).toLocaleString()}</span><span>命令 {Number(overviewStats.commands || 0).toLocaleString()}</span></div></div>
      </div>
    </section>

    <div className="runtime-columns">
      <section className="runtime-section runtime-bots-section"><div className="runtime-section-heading"><div><h2>Bot 运行概况 <small>共 {bots.length} 个账号</small></h2></div></div>{bots.length ? <><div className="runtime-bot-table"><div className="runtime-bot-table-head"><span>Bot</span><span>QQ 号</span><span>状态</span><span>今日消息</span><span>OneBot 端口</span><span>机器人框架</span><span>操作</span></div>{visibleBots.map((bot) => { const running = isBotRunning(bot); const transitioning = isBotTransitioning(bot); const botTotal = Number(botStats.get(String(bot.id))?.total || 0); return <div className="runtime-bot-row" key={bot.id}><div className="runtime-bot-identity"><BotAvatar bot={bot} className="runtime-bot-avatar" /><div><strong>{bot.name}</strong><BotUptime bot={bot} /></div></div><span className="runtime-bot-qq">{bot.qq}</span><StatusPill label={botStatusLabel(bot)} state={botStatusState(bot)} /><span className="runtime-table-value">{botTotal.toLocaleString()}</span><span className="runtime-table-value">{bot.port || '—'}</span><span className="runtime-table-value">{bot.framework_label || (bot.framework === 'astrbot' ? 'AstrBot' : 'NoneBot')}</span><div className="runtime-bot-row-actions"><button className="secondary runtime-view-button" onClick={() => onSelectBot(bot.id)}>查看账号</button><button className={`runtime-action ${running ? 'danger' : ''}`} onClick={() => action(bot, running ? 'stop' : 'start', running ? '停止' : '启动')} disabled={busy.startsWith(`${bot.id}:`) || transitioning}>{running ? <Square size={12} /> : <Play size={12} />}{transitioning ? botStatusLabel(bot) : running ? '停止' : '启动'}</button></div></div>})}</div>{pageCount > 1 && <div className="runtime-table-footer"><div className="runtime-pagination"><button className="plain-icon" onClick={() => setBotPage((page) => Math.max(1, Math.min(pageCount, page) - 1))} disabled={currentBotPage === 1} aria-label="上一页" title="上一页"><ChevronLeft size={15} /></button><span className="selected">{currentBotPage}</span><button className="plain-icon" onClick={() => setBotPage((page) => Math.min(pageCount, Math.max(1, page) + 1))} disabled={currentBotPage === pageCount} aria-label="下一页" title="下一页"><ChevronRight size={15} /></button></div><span>共 {bots.length} 条</span></div>}</> : <div className="runtime-empty"><Bot size={18} /><span>还没有可监控的 Bot</span></div>}</section>
    </div>

    <section className="runtime-section runtime-services-section"><div className="runtime-section-heading"><div><h2>服务状态</h2></div></div><div className="runtime-service-cards"><div className="runtime-service-card"><div className="runtime-service-icon"><Server size={18} /></div><div><strong>NapCat</strong><span>{napcat.available ? 'QQ 协议端服务' : '尚未配置资源'}</span></div><StatusPill label={napcat.running > 0 ? '运行中' : '未启用'} state={napcat.running > 0 ? 'green' : 'muted'} /></div><div className="runtime-service-card"><div className="runtime-service-icon nonebot"><SquareTerminal size={18} /></div><div><strong>机器人框架</strong><span>{frameworkNames.length ? frameworkNames.join('、') : '等待账号配置'}</span></div><StatusPill label={runningBots.length ? '运行中' : '未启动'} state={runningBots.length ? 'green' : 'muted'} /></div><div className="runtime-service-card"><div className="runtime-service-icon onebot"><FileText size={18} /></div><div><strong>OneBot 端口</strong><span>{firstBot?.port ? `端口 ${firstBot.port} 可用` : '尚未配置端口'}</span></div><StatusPill label={firstBot?.port ? '正常' : '未配置'} state={firstBot?.port ? 'green' : 'muted'} /></div></div></section>
  </section>
}

export function PlaceholderPage({ active, onBack }) {
  return <section className="placeholder"><div className="placeholder-icon"><Gauge size={21} /></div><h2>{active}</h2><p>这个模块已经预留好入口，下一步可以接入真实配置。</p><button className="secondary" onClick={onBack}>返回 QQ 账号</button></section>
}
