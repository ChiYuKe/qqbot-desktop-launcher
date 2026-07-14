import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, ArrowLeft, Bell, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, CircleUserRound, Cpu,
  Database, Download, Eye, EyeOff, ExternalLink, FileText, FolderOpen, Gauge, Image as ImageIcon, Keyboard, LayoutDashboard, MessageSquare, Monitor, Moon, MoreHorizontal, Palette, Pause, Play,
  Maximize2, Minimize2, Plus, Power, Puzzle, RefreshCw, RotateCcw, Search, Server,
  Settings, Square, SquareTerminal, Star, Sun, Trash2, UserRound, Users, Wifi, X,
} from 'lucide-react'
import './styles.css'
import './layout.css'

const API_BASE = `http://${window.location.hostname || '127.0.0.1'}:6700`

function apiToken() {
  return window.desktopInfo?.apiToken || import.meta.env.VITE_QQ_CONSOLE_TOKEN || ''
}
const fallbackBots = []
const fallbackLogs = []
const fallbackStats = { periods: {}, bots: {}, series: [], updated_at: null }
const FAVORITES_STORAGE_KEY = 'qq-console-favorites'
const OFFICIAL_RESOURCE_URLS = {
  napcat: 'https://github.com/NapNeko/NapCatQQ/releases',
  nonebot: 'https://nonebot.dev/docs/quick-start',
}
const BOT_RUNNING_STATES = new Set(['running', 'login_required'])
const BOT_TRANSITION_STATES = new Set(['starting', 'stopping', 'restarting', 'logging_in'])
const LOG_SESSION_STARTED_AT = Math.floor(Date.now() / 1000) * 1000
const favoritePageDefinitions = [
  { key: 'page:概览', label: '概览', icon: LayoutDashboard },
  { key: 'page:QQ 账号', label: 'QQ 账号', icon: UserRound },
  { key: 'page:运行状态', label: '运行状态', icon: Activity },
  { key: 'page:插件管理', label: '插件管理', icon: Puzzle },
  { key: 'page:群组管理', label: '群组管理', icon: Users },
  { key: 'page:NapCat', label: 'NapCat', icon: Server },
  { key: 'page:NoneBot', label: 'NoneBot', icon: SquareTerminal },
]

function isBotRunning(bot) {
  return BOT_RUNNING_STATES.has(bot?.status)
}

function isBotTransitioning(bot) {
  return BOT_TRANSITION_STATES.has(bot?.status)
}

function botStatusLabel(bot) {
  return {
    running: '运行中',
    login_required: '需要验证',
    starting: '启动中',
    stopping: '停止中',
    restarting: '重启中',
    logging_in: '登录中',
    error: '异常',
    stopped: '已停止',
  }[bot?.status] || '已停止'
}

function botStatusState(bot) {
  if (bot?.status === 'error' || bot?.status === 'login_required') return 'red'
  if (isBotRunning(bot)) return 'green'
  if (isBotTransitioning(bot)) return 'blue'
  return 'muted'
}

function openExternal(url) {
  if (!url) return
  if (window.externalLinks?.open) {
    window.externalLinks.open(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function orderLogs(logs) {
  return Array.isArray(logs) ? [...logs].reverse().slice(-500) : []
}

function logIdentity(log) {
  const id = String(log?.id || '').trim()
  if (id) return `id:${id}`
  return `legacy:${log?.timestamp || ''}|${log?.time || ''}|${log?.source || ''}|${log?.level || ''}|${log?.message || ''}`
}

function mergeCurrentSessionLogs(current, incoming) {
  const events = new Map()
  for (const log of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!isCurrentSessionLog(log)) continue
    events.set(logIdentity(log), log)
  }
  return [...events.values()].sort((left, right) => {
    const leftTime = Date.parse(String(left?.timestamp || ''))
    const rightTime = Date.parse(String(right?.timestamp || ''))
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime
    return 0
  }).slice(-500)
}

function isCurrentSessionLog(log) {
  const timestamp = Date.parse(String(log?.timestamp || ''))
  return Number.isFinite(timestamp) && timestamp >= LOG_SESSION_STARTED_AT
}

function orderCurrentSessionLogs(logs) {
  const sessionLogs = (Array.isArray(logs) ? logs : []).filter(isCurrentSessionLog)
  const unique = new Map()
  sessionLogs.forEach((log) => unique.set(logIdentity(log), log))
  return orderLogs([...unique.values()])
}

function statsLocalDay(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now())
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function statsShiftDay(day, offset) {
  const date = new Date(`${day}T00:00:00`)
  date.setDate(date.getDate() + offset)
  return statsLocalDay(date)
}

function classifyStatsLog(message) {
  return {
    group: /(群聊|群组|message\.group)/i.test(message),
    private: /(私聊|好友|message\.private)/i.test(message),
    media: /(图片|视频|文件|表情|\[image:|\[video:|\[file:)/i.test(message),
  }
}

// Fallback used only while the management API is unavailable. The database
// stats endpoint is authoritative once it responds; display logs are capped
// and therefore cannot be the source of truth for historical totals.
function deriveStatsFromLogs(logs, bots) {
  const botMap = new Map((Array.isArray(bots) ? bots : []).map((bot) => [String(bot.name), bot]))
  const rows = new Map()
  for (const log of Array.isArray(logs) ? logs : []) {
    const message = cleanLogMessage(log?.message || '')
    const direction = /接收\s*<-/.test(message) ? 'received' : /发送\s*->/.test(message) ? 'sent' : null
    if (!direction) continue
    const bot = botMap.get(String(log?.source || ''))
    if (!bot) continue
    const day = statsLocalDay(log?.timestamp || Date.now())
    const key = `${bot.id}|${day}`
    const row = rows.get(key) || { bot_id: bot.id, day, received: 0, sent: 0, groups: 0, private: 0, media: 0, commands: 0 }
    row[direction] += 1
    const type = classifyStatsLog(message)
    if (type.group) row.groups += 1
    if (type.private) row.private += 1
    if (type.media) row.media += 1
    if (/接收\s*<-\s*[^|]*\|\s*(?:[!/]|命令)/i.test(message)) row.commands += 1
    rows.set(key, row)
  }

  const today = statsLocalDay(new Date())
  const rowList = [...rows.values()]
  const sumRows = (items) => items.reduce((total, row) => ({
    received: total.received + row.received,
    sent: total.sent + row.sent,
    total: total.received + row.received + total.sent + row.sent,
    groups: total.groups + row.groups,
    private: total.private + row.private,
    media: total.media + row.media,
    commands: total.commands + row.commands,
  }), { received: 0, sent: 0, total: 0, groups: 0, private: 0, media: 0, commands: 0 })
  const period = (start) => {
    const items = rowList.filter((row) => row.day >= start && row.day <= today)
    const summary = sumRows(items)
    return { ...summary, active_days: new Set(items.map((row) => row.day)).size }
  }
  const todayDate = new Date(`${today}T00:00:00`)
  const weekStart = statsLocalDay(new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() - todayDate.getDay() + (todayDate.getDay() === 0 ? -6 : 1)))
  const monthStart = `${today.slice(0, 8)}01`
  const periods = { day: period(today), week: period(weekStart), month: period(monthStart) }
  const botPeriods = Object.fromEntries(Object.entries({
    day: today,
    week: weekStart,
    month: monthStart,
  }).map(([name, start]) => [name, (Array.isArray(bots) ? bots : []).map((bot) => {
    const summary = sumRows(rowList.filter((row) => row.bot_id === bot.id && row.day >= start && row.day <= today))
    return { id: bot.id, name: bot.name, qq: bot.qq, ...summary }
  }).sort((a, b) => b.total - a.total)]))
  const series = Array.from({ length: 14 }, (_, index) => {
    const day = statsShiftDay(today, index - 13)
    return { day, ...sumRows(rowList.filter((row) => row.day === day)) }
  })
  return { periods, bots: botPeriods, series, updated_at: new Date().toISOString() }
}

function mergeStatsSnapshots(persisted, live) {
  if (!persisted) return live
  if (!live) return persisted
  const summaryKeys = ['received', 'sent', 'total', 'groups', 'private', 'media', 'commands', 'active_days']
  const mergeSummary = (left = {}, right = {}) => summaryKeys.reduce((result, key) => {
    result[key] = Math.max(Number(left[key] || 0), Number(right[key] || 0))
    return result
  }, {})
  const periods = Object.fromEntries(['day', 'week', 'month'].map((key) => [key, mergeSummary(persisted.periods?.[key], live.periods?.[key])]))
  const bots = Object.fromEntries(['day', 'week', 'month'].map((period) => {
    const persistedRows = persisted.bots?.[period] || []
    const liveRows = live.bots?.[period] || []
    const rows = new Map(persistedRows.map((row) => [String(row.id), row]))
    liveRows.forEach((row) => rows.set(String(row.id), { ...rows.get(String(row.id)), ...row, ...mergeSummary(rows.get(String(row.id)), row) }))
    return [period, [...rows.values()].sort((a, b) => Number(b.total || 0) - Number(a.total || 0))]
  }))
  const seriesRows = new Map((persisted.series || []).map((row) => [row.day, row]))
  ;(live.series || []).forEach((row) => seriesRows.set(row.day, { ...seriesRows.get(row.day), ...row, ...mergeSummary(seriesRows.get(row.day), row) }))
  return { periods, bots, series: [...seriesRows.values()].sort((a, b) => String(a.day).localeCompare(String(b.day))), updated_at: live.updated_at || persisted.updated_at }
}

function resolveQuickLoginCommand(command, logs) {
  const trimmed = command.trim()
  const match = trimmed.match(/^-q\s+(\d+)$/i)
  if (!match) return trimmed
  const index = Number(match[1])
  const accounts = logs.map((log) => cleanLogMessage(log.message).match(/(?:^|\s)(\d+)\.\s*(\d{5,20})\s+/)).filter(Boolean)
  const selected = accounts.find((item) => Number(item[1]) === index)
  return selected ? `-q ${selected[2]}` : trimmed
}

async function api(path, options) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15000)
  try {
    const token = apiToken()
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options?.headers || {}),
      },
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.detail || `请求失败 (${response.status})`)
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('管理服务响应超时，请重启控制台后重试')
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

function App() {
  const [bots, setBots] = useState(fallbackBots)
  const [system, setSystem] = useState({ cpu: 0, memory: 0, running_bots: 0 })
  const [stats, setStats] = useState(fallbackStats)
  const [napcat, setNapcat] = useState({ available: false, running: 0 })
  const [resources, setResources] = useState(null)
  const [plugins, setPlugins] = useState([])
  const [pluginProject, setPluginProject] = useState(null)
  const [resourceSetup, setResourceSetup] = useState(null)
  const [resourceSetupOpen, setResourceSetupOpen] = useState(false)
  const [logs, setLogs] = useState(fallbackLogs)
  const [active, setActive] = useState('QQ 账号')
  const [selectedBotId, setSelectedBotId] = useState('')
  const [toast, setToast] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [logsPaused, setLogsPaused] = useState(false)
  const [newAccount, setNewAccount] = useState({ name: '', qq: '', port: '', napcatPort: '', password: '' })
  const [online, setOnline] = useState(false)
  const [theme, setTheme] = useState(() => window.localStorage.getItem('qq-console-theme') || 'system')
  const [favoriteKeys, setFavoriteKeys] = useState(() => {
    try {
      const saved = window.localStorage.getItem(FAVORITES_STORAGE_KEY)
      const parsed = saved ? JSON.parse(saved) : null
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
    }
    applyTheme()
    media.addEventListener?.('change', applyTheme)
    window.localStorage.setItem('qq-console-theme', theme)
    return () => media.removeEventListener?.('change', applyTheme)
  }, [theme])

  useEffect(() => {
    if (favoriteKeys !== null) window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favoriteKeys))
  }, [favoriteKeys])

  useEffect(() => {
    if (!resources) return
    if (!resources.initialized) setResourceSetupOpen(true)
  }, [resources?.initialized])

  const notify = useCallback((message) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2400)
  }, [])

  const loadDashboard = useCallback(async (showToast = false) => {
    try {
      const [botData, systemData, logData, napcatData, resourceData, pluginData] = await Promise.all([
        api('/api/bots'), api('/api/system'), api('/api/logs'), api('/api/napcat'), api('/api/runtime/resources'),
        api('/api/plugins').catch(() => ({ plugins: [], project: null })),
      ])
      try {
        setStats(await api('/api/stats'))
      } catch {
        setStats(deriveStatsFromLogs(logData, botData))
      }
      setBots(botData)
      setSystem(systemData)
      if (!logsPaused) {
        setLogs((current) => logData.length
          ? mergeCurrentSessionLogs(current, orderCurrentSessionLogs(logData))
          : fallbackLogs)
      }
      setNapcat(napcatData)
      setResources(resourceData)
      setPlugins(Array.isArray(pluginData.plugins) ? pluginData.plugins : [])
      setPluginProject(pluginData.project || null)
      setOnline(true)
      if (showToast) notify('状态已刷新')
    } catch (error) {
      setOnline(false)
      if (showToast) notify(`管理 API 不可用：${error.message}`)
    }
  }, [logsPaused, notify])

  const clearLogs = async () => {
    try {
      await api('/api/logs/clear', { method: 'POST' })
      setLogs([])
      notify('历史日志已清空')
    } catch (error) {
      notify(`清空日志失败：${error.message}`)
    }
  }

  useEffect(() => {
    loadDashboard()
    const timer = window.setInterval(() => loadDashboard(), 5000)
    return () => window.clearInterval(timer)
  }, [loadDashboard])

  useEffect(() => {
    const host = window.location.hostname || '127.0.0.1'
    let socket
    let retryTimer
    let disposed = false

    const connect = () => {
      if (disposed) return
      const token = apiToken()
      socket = new WebSocket(`ws://${host}:6700/ws/events`, token ? [token] : [])
      socket.onmessage = (message) => {
        try {
          const payload = JSON.parse(message.data)
          if (logsPaused) return
          if (payload.type === 'snapshot') setLogs((current) => mergeCurrentSessionLogs(current, orderCurrentSessionLogs(payload.logs || [])))
          if (payload.type === 'event' && payload.data && isCurrentSessionLog(payload.data)) setLogs((current) => mergeCurrentSessionLogs(current, [payload.data]))
        } catch {
          // Ignore malformed events; the polling fallback remains active.
        }
      }
      socket.onclose = () => {
        if (!disposed) retryTimer = window.setTimeout(connect, 1500)
      }
      socket.onerror = () => socket.close()
    }

    connect()
    return () => {
      disposed = true
      window.clearTimeout(retryTimer)
      socket?.close()
    }
  }, [logsPaused])

  const selectedBot = useMemo(
    () => bots.find((bot) => bot.id === selectedBotId) || bots[0] || null,
    [bots, selectedBotId],
  )

  const action = async (bot, actionName, label) => {
    if (actionName === 'more') {
      notify(`已打开「${bot.name}」更多操作`)
      return
    }
    setBusy(`${bot.id}:${actionName}`)
    try {
      const result = await api(`/api/bots/${bot.id}/${actionName}`, { method: 'POST' })
      await loadDashboard()
      notify(result.operation_id ? `已提交${label}账号「${bot.name}」，后台处理中` : `${label}了账号「${bot.name}」`)
    } catch (error) {
      notify(`操作失败：${error.message}`)
    } finally {
      setBusy('')
    }
  }

  const createAccount = async (event) => {
    event.preventDefault()
    setCreating(true)
    try {
      await api('/api/bots', {
        method: 'POST',
        body: JSON.stringify({ name: newAccount.name, qq: newAccount.qq, port: Number(newAccount.port), napcat_port: newAccount.napcatPort ? Number(newAccount.napcatPort) : null, password: newAccount.password || null }),
      })
      setNewAccount({ name: '', qq: '', port: '', napcatPort: '', password: '' })
      setCreateOpen(false)
      await loadDashboard()
      notify('账号创建成功')
    } catch (error) {
      notify(`创建失败：${error.message}`)
    } finally {
      setCreating(false)
    }
  }

  const closeCreateModal = () => {
    if (creating) return
    setCreateOpen(false)
    setNewAccount({ name: '', qq: '', port: '', napcatPort: '', password: '' })
  }

  const deleteAccount = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api(`/api/bots/${deleteTarget.id}`, { method: 'DELETE' })
      setDeleteTarget(null)
      setSelectedBotId('')
      await loadDashboard()
      notify(`账号「${deleteTarget.name}」已删除`)
    } catch (error) {
      notify(`删除失败：${error.message}`)
    } finally {
      setDeleting(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    await loadDashboard(true)
    setRefreshing(false)
  }

  const sendCommand = async (bot, command, currentLogs) => {
    const resolvedCommand = resolveQuickLoginCommand(command, currentLogs)
    await api(`/api/bots/${bot.id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: resolvedCommand }),
    })
    await loadDashboard()
    notify(resolvedCommand === command ? `已发送指令：${command}` : `已发送快速登录：${command}`)
  }

  const savePassword = async (bot, password) => {
    await api(`/api/bots/${bot.id}/password`, {
      method: 'PUT',
      body: JSON.stringify({ password: password || null }),
    })
    await loadDashboard()
    notify(password ? '密码回退已保存，重启 Bot 后生效' : '密码回退已清除')
  }

  const savePort = async (bot, port) => {
    await api(`/api/bots/${bot.id}/port`, {
      method: 'PUT',
      body: JSON.stringify({ port }),
    })
    await loadDashboard()
    notify(`OneBot 端口已保存为 ${port}，重启 Bot 后生效`)
  }

  const saveNapcatPort = async (bot, port) => {
    await api(`/api/bots/${bot.id}/napcat-port`, {
      method: 'PUT',
      body: JSON.stringify({ port }),
    })
    await loadDashboard()
    notify(`NapCat WebUI 端口已保存为 ${port}，重启 Bot 后生效`)
  }

  const selectResource = async (kind) => {
    const selectedPath = await window.fileDialog?.selectDirectory(kind)
    const path = selectedPath || window.prompt(`请输入 ${kind === 'napcat' ? 'NapCat' : 'NoneBot'} 目录路径`)
    if (!path) return
    try {
      await api(`/api/runtime/resources/${kind}`, { method: 'PUT', body: JSON.stringify({ path }) })
      await loadDashboard()
      notify(`${kind === 'napcat' ? 'NapCat' : 'NoneBot'} 目录已保存`)
    } catch (error) {
      notify(`目录设置失败：${error.message}`)
    }
  }

  const togglePlugin = async (plugin, enabled) => {
    setBusy(`plugin:${plugin.plugin_id}`)
    try {
      const result = await api(`/api/plugins/${encodeURIComponent(plugin.plugin_id)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      })
      setPlugins(Array.isArray(result.plugins) ? result.plugins : [])
      setPluginProject(result.project || null)
      notify(`${enabled ? '已启用' : '已停用'}插件「${plugin.name}」，重启 Bot 后生效`)
    } catch (error) {
      notify(`插件设置失败：${error.message}`)
    } finally {
      setBusy('')
    }
  }

  const isFavorite = (key) => (favoriteKeys || []).includes(key)

  const toggleFavorite = (key) => {
    const currentlyFavorite = isFavorite(key)
    const label = key.startsWith('bot:') ? bots.find((bot) => `bot:${bot.id}` === key)?.name || '账号' : favoritePageDefinitions.find((item) => item.key === key)?.label || '页面'
    setFavoriteKeys((current) => {
      const favorites = current || []
      return currentlyFavorite ? favorites.filter((item) => item !== key) : [...favorites, key]
    })
    notify(currentlyFavorite ? `已取消收藏「${label}」` : `已收藏「${label}」`)
  }

  const favoriteBots = useMemo(() => bots.filter((bot) => (favoriteKeys || []).includes(`bot:${bot.id}`)), [bots, favoriteKeys])
  const favoritePages = useMemo(() => favoritePageDefinitions.filter((item) => (favoriteKeys || []).includes(item.key)), [favoriteKeys])

  const trackResourceSetup = useCallback(async (jobId) => {
    try {
      while (true) {
        await new Promise((resolve) => window.setTimeout(resolve, 250))
        const status = await api(`/api/runtime/setup/${jobId}`)
        setResourceSetup(status)
        if (['succeeded', 'failed', 'missing'].includes(status.status)) {
          await loadDashboard()
          return status
        }
      }
    } catch (error) {
      const failed = { id: jobId, status: 'failed', step: '连接中断', message: '无法读取配置进度。', progress: 0, error: error.message }
      setResourceSetup(failed)
      notify(`一键配置失败：${error.message}`)
      return failed
    }
  }, [loadDashboard, notify])

  const startResourceSetup = useCallback(async (selectedKinds = ['nonebot']) => {
    if (resourceSetup?.status === 'running') return
    const kinds = selectedKinds === 'all'
      ? ['nonebot', 'napcat']
      : Array.isArray(selectedKinds) ? selectedKinds : [selectedKinds]
    const requestedKinds = [...new Set(['nonebot', ...kinds])]
    try {
      const job = await api('/api/runtime/setup', { method: 'POST', body: JSON.stringify({ kinds: requestedKinds }) })
      if (!Array.isArray(job.kinds) || !requestedKinds.every((kind) => job.kinds.includes(kind))) {
        const failed = { ...job, status: 'failed', kinds: requestedKinds, step: '配置范围不可用', message: '管理服务未加载新的配置流程，请重启管理后端。', error: '后端版本过旧' }
        setResourceSetup(failed)
        notify('管理服务版本未更新，请重启管理后端后再试')
        return
      }
      setResourceSetup(job)
      if (job.id && job.status === 'running') {
        const result = await trackResourceSetup(job.id)
        if (result.status === 'succeeded') notify('一键配置完成，可以启动 Bot 了')
      }
    } catch (error) {
      notify(`一键配置失败：${error.message}`)
    }
  }, [notify, resourceSetup?.status, trackResourceSetup])

  const isAccountPage = active === '概览' || active === 'QQ 账号'

  return <div className="app-shell">
    <header className="app-topbar">
      <div className="topbar-brand"><span>QQ 控制台</span><ChevronDown size={14} /></div>
      <button className="global-search" onClick={() => document.querySelector('.account-search')?.focus()}><Search size={15} /><span>搜索账号、日志或设置</span><kbd>⌘ K</kbd></button>
      <div className="topbar-actions"><button className="topbar-action" onClick={() => notify('暂无新的系统通知')} aria-label="通知"><Bell size={16} /></button><span className={`service-pill ${online ? 'online' : ''}`}><i />{online ? '本机服务正常' : '等待连接'}</span><WindowControls /></div>
    </header>

    <div className={`app-body ${active === '系统设置' ? 'settings-mode' : ''}`}>
      <aside className="sidebar">
        <nav className="sidebar-nav">
          <NavItem icon={LayoutDashboard} label="概览" active={active} onClick={setActive} favoriteKey="page:概览" favorite={isFavorite('page:概览')} onToggleFavorite={toggleFavorite} />
          <NavItem icon={Puzzle} label="插件管理" active={active} onClick={setActive} favoriteKey="page:插件管理" favorite={isFavorite('page:插件管理')} onToggleFavorite={toggleFavorite} />
          <NavItem icon={UserRound} label="QQ 账号" active={active} onClick={setActive} favoriteKey="page:QQ 账号" favorite={isFavorite('page:QQ 账号')} onToggleFavorite={toggleFavorite} />
          <NavItem icon={Activity} label="运行状态" active={active} onClick={() => setActive('运行状态')} favoriteKey="page:运行状态" favorite={isFavorite('page:运行状态')} onToggleFavorite={toggleFavorite} />
          <div className="nav-section-label">收藏</div>
          {favoriteBots.length || favoritePages.length ? <>
            {favoriteBots.map((bot) => <NavItem key={bot.id} icon={Bot} label={bot.name} active={active === 'QQ 账号' && selectedBot?.id === bot.id} onClick={() => { setActive('QQ 账号'); setSelectedBotId(bot.id) }} favoriteKey={`bot:${bot.id}`} favorite onToggleFavorite={toggleFavorite} />)}
            {favoritePages.map(({ key, label, icon: Icon }) => <NavItem key={key} icon={Icon} label={label} active={active} onClick={setActive} favoriteKey={key} favorite onToggleFavorite={toggleFavorite} />)}
          </> : <div className="nav-empty">点击菜单右侧的星标添加快捷入口</div>}
          <div className="nav-section-label">服务</div>
          <NavItem icon={Server} label="NapCat" active={active} onClick={setActive} favoriteKey="page:NapCat" favorite={isFavorite('page:NapCat')} onToggleFavorite={toggleFavorite} />
          <NavItem icon={SquareTerminal} label="NoneBot" active={active} onClick={setActive} favoriteKey="page:NoneBot" favorite={isFavorite('page:NoneBot')} onToggleFavorite={toggleFavorite} />
        </nav>
        <div className="sidebar-bottom">
          <button className="bottom-item" onClick={() => setActive('系统设置')}><Settings size={16} />设置</button>
          <button className="bottom-item" onClick={() => notify('桌面控制台正在运行')}><CircleHelp size={16} />帮助</button>
        </div>
      </aside>

      <main className={`main-content ${active === '运行状态' ? 'runtime-mode' : ''}`}>
        {active === '系统设置' ? <SettingsPage theme={theme} onThemeChange={setTheme} onBack={() => setActive('QQ 账号')} onNotice={notify} /> : active === '运行状态' ? <RuntimeStatusPage bots={bots} system={system} stats={stats} napcat={napcat} online={online} refreshing={refreshing} refresh={refresh} busy={busy} action={action} onSelectBot={(botId) => { setSelectedBotId(botId); setActive('QQ 账号') }} /> : active === '插件管理' ? <PluginPage plugins={plugins} project={pluginProject} refreshing={refreshing} onRefresh={refresh} busy={busy} onToggle={togglePlugin} /> : active === 'NapCat' ? <ResourcePage key="napcat" kind="napcat" resource={resources?.napcat} officialUrl={OFFICIAL_RESOURCE_URLS.napcat} setup={resourceSetup} onOpenSetup={() => setResourceSetupOpen(true)} onSelect={selectResource} onRefresh={() => loadDashboard(true)} onBack={() => setActive('QQ 账号')} /> : active === 'NoneBot' ? <ResourcePage key="nonebot" kind="nonebot" resource={resources?.nonebot} officialUrl={OFFICIAL_RESOURCE_URLS.nonebot} setup={resourceSetup} onOpenSetup={() => setResourceSetupOpen(true)} onSelect={selectResource} onRefresh={() => loadDashboard(true)} onBack={() => setActive('QQ 账号')} /> : isAccountPage ? <AccountWorkspace bots={bots} selectedBot={selectedBot} selectedBotId={selectedBotId} setSelectedBotId={setSelectedBotId} napcat={napcat} online={online} refreshing={refreshing} refresh={refresh} busy={busy} action={action} onCreate={() => setCreateOpen(true)} onDelete={() => setDeleteTarget(selectedBot)} logs={logs} logsPaused={logsPaused} onTogglePause={() => { setLogsPaused(value => !value); notify(logsPaused ? '日志同步已恢复' : '日志同步已暂停') }} onClear={clearLogs} onCommand={sendCommand} onSavePassword={savePassword} onSavePort={savePort} onSaveNapcatPort={saveNapcatPort} onNotice={notify} /> : <PlaceholderPage active={active} onBack={() => setActive('QQ 账号')} />}
      </main>
    </div>

    {createOpen && <CreateAccountModal account={newAccount} creating={creating} onChange={setNewAccount} onClose={closeCreateModal} onSubmit={createAccount} />}
    {deleteTarget && <DeleteAccountModal bot={deleteTarget} deleting={deleting} onClose={() => !deleting && setDeleteTarget(null)} onConfirm={deleteAccount} />}
    {resources && resourceSetupOpen && <ResourceSetupModal resources={resources} setup={resourceSetup} onSetup={startResourceSetup} onSelect={selectResource} onRefresh={() => loadDashboard(true)} onClose={() => setResourceSetupOpen(false)} />}
    {toast && <div className="toast"><span className="live-dot" />{toast}</div>}
  </div>
}

function WindowControls() {
  if (!window.desktopInfo?.isDesktop) return null
  return <div className="window-controls"><button onClick={() => window.windowControls?.minimize()} aria-label="最小化" title="最小化"><Minimize2 size={14} /></button><button onClick={() => window.windowControls?.toggleMaximize()} aria-label="最大化" title="最大化"><Maximize2 size={14} /></button><button className="window-close" onClick={() => window.windowControls?.close()} aria-label="关闭" title="关闭"><X size={15} /></button></div>
}

async function fetchAuthenticatedBlob(path) {
  const token = apiToken()
  const response = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.detail || `资源请求失败 (${response.status})`)
  }
  return response.blob()
}

function useAuthenticatedMedia(path, enabled) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let objectUrl = ''
    setUrl('')
    setError('')
    if (!enabled) return () => {}
    fetchAuthenticatedBlob(path).then((blob) => {
      if (!active) return
      objectUrl = URL.createObjectURL(blob)
      setUrl(objectUrl)
    }).catch((reason) => {
      if (active) setError(reason.message || '资源加载失败')
    })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path, enabled])

  return { url, error }
}

function NavItem({ icon: Icon, label, active, onClick, favoriteKey, favorite, onToggleFavorite }) {
  const selected = typeof active === 'boolean' ? active : active === label
  return <div className={`nav-item-wrap ${selected ? 'active-wrap' : ''}`}><button className={`nav-item ${selected ? 'active' : ''}`} onClick={() => onClick(label)}><Icon size={16} /><span>{label}</span></button>{favoriteKey && <button type="button" className={`favorite-toggle ${favorite ? 'active' : ''}`} onClick={(event) => { event.stopPropagation(); onToggleFavorite(favoriteKey) }} aria-label={favorite ? `取消收藏${label}` : `收藏${label}`} title={favorite ? '取消收藏' : '添加到收藏'}><Star size={13} fill={favorite ? 'currentColor' : 'none'} /></button>}</div>
}

function PluginPage({ plugins, project, refreshing, onRefresh, busy, onToggle }) {
  const [expanded, setExpanded] = useState('')
  const enabledCount = plugins.filter((plugin) => plugin.enabled).length
  const metadataCount = plugins.filter((plugin) => plugin.metadata_available).length
  const directoryManaged = project?.configuration === 'directory'

  return <section className="plugin-page">
    <header className="plugin-page-header">
      <div>
        <div className="eyebrow">NoneBot 插件</div>
        <h1>插件管理</h1>
        <p title={project?.path || ''}>{project?.path || 'NoneBot 项目尚未配置'}</p>
      </div>
      <button className="plain-icon plugin-refresh" onClick={onRefresh} disabled={refreshing} aria-label="刷新插件列表" title="刷新插件列表"><RefreshCw size={17} /></button>
    </header>

    <div className="plugin-summary">
      <div><span>插件总数</span><strong>{plugins.length}</strong></div>
      <div><span>已启用</span><strong>{enabledCount}</strong></div>
      <div><span>已读取元信息</span><strong>{metadataCount}</strong></div>
      <div><span>配置格式</span><strong>{project?.configuration === 'table' ? '新版' : project?.configuration === 'list' ? '兼容' : '目录'}</strong></div>
    </div>

    {directoryManaged && <div className="plugin-notice">当前项目按插件目录自动加载，不能单独停用其中一个插件。</div>}

    <div className="plugin-list-heading">
      <div><h2>已发现插件</h2><span>{project?.plugin_dirs?.length ? `插件目录：${project.plugin_dirs.join('、')}` : '来自 NoneBot 项目配置与本地插件目录'}</span></div>
      <span>{plugins.length ? `${enabledCount} 个启用` : '暂无插件'}</span>
    </div>

    <div className="plugin-list">
      {plugins.length ? plugins.map((plugin) => {
        const isExpanded = expanded === plugin.plugin_id
        const isBusy = busy === `plugin:${plugin.plugin_id}`
        return <article className={`plugin-row ${plugin.enabled ? 'enabled' : 'disabled'}`} key={plugin.plugin_id}>
          <div className="plugin-row-main">
            <div className="plugin-icon"><Puzzle size={18} /></div>
            <div className="plugin-row-copy">
              <div className="plugin-row-title"><strong>{plugin.name}</strong><StatusPill label={plugin.enabled ? '已启用' : '已停用'} state={plugin.enabled ? 'green' : 'muted'} /></div>
              <span className="plugin-module">{plugin.module_name}</span>
              <p>{plugin.description}</p>
            </div>
            <div className="plugin-row-actions">
              {plugin.toggle_supported ? <button type="button" role="switch" aria-checked={plugin.enabled} className={`plugin-toggle ${plugin.enabled ? 'enabled' : ''}`} onClick={() => onToggle(plugin, !plugin.enabled)} disabled={isBusy} title={plugin.enabled ? '停用插件' : '启用插件'}><Power size={14} />{isBusy ? '保存中' : plugin.enabled ? '停用' : '启用'}</button> : <span className="plugin-managed">自动加载</span>}
              <button type="button" className="plain-icon plugin-expand" onClick={() => setExpanded(isExpanded ? '' : plugin.plugin_id)} aria-expanded={isExpanded} aria-label={isExpanded ? '收起插件详情' : '展开插件详情'} title={isExpanded ? '收起详情' : '查看详情'}><ChevronDown size={16} /></button>
            </div>
          </div>
          {isExpanded && <div className="plugin-details">
            <div><span>加载来源</span><strong>{plugin.source === 'installed' ? '已安装依赖' : plugin.load_mode === 'directory' ? '插件目录' : '项目配置'}</strong></div>
            <div><span>插件路径</span><strong>{plugin.path || '未找到本地源码'}</strong></div>
            <div><span>类型</span><strong>{plugin.type || '未声明'}</strong></div>
            <div><span>支持适配器</span><strong>{plugin.supported_adapters?.length ? plugin.supported_adapters.join('、') : '未声明'}</strong></div>
            <div className="plugin-usage"><span>使用方法</span><p>{plugin.usage}</p></div>
            {plugin.homepage && <a href={plugin.homepage} onClick={(event) => { event.preventDefault(); openExternal(plugin.homepage) }}><ExternalLink size={13} />打开插件主页</a>}
            {plugin.error && <div className="plugin-error">{plugin.error}</div>}
          </div>}
        </article>
      }) : <div className="plugin-empty"><Puzzle size={22} /><strong>没有发现 NoneBot 插件</strong><span>检查项目目录或 pyproject.toml 中的插件配置。</span></div>}
    </div>
  </section>
}

function AccountWorkspace({ bots, selectedBot, selectedBotId, setSelectedBotId, napcat, online, refreshing, refresh, busy, action, onCreate, onDelete, logs, logsPaused, onTogglePause, onClear, onCommand, onSavePassword, onSavePort, onSaveNapcatPort, onNotice }) {
  const [command, setCommand] = useState('')
  const [detailView, setDetailView] = useState('overview')
  const [visibleQrKey, setVisibleQrKey] = useState('')
  const feedRef = useRef(null)
  const followLogsRef = useRef(true)
  const running = isBotRunning(selectedBot)
  const transitioning = isBotTransitioning(selectedBot)
  const botLogs = useMemo(() => selectedBot ? logs.filter((log) => log.source === selectedBot.name) : [], [logs, selectedBot?.name])
  const visibleLogs = useMemo(() => prepareLogItems(botLogs), [botLogs])
  const verification = useMemo(() => findLoginVerification(botLogs), [botLogs])

  useEffect(() => {
    setDetailView('overview')
    setVisibleQrKey('')
  }, [selectedBot?.id])

  useEffect(() => {
    if (feedRef.current && visibleLogs.length && followLogsRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
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
          <div className="account-summary"><div className="summary-row"><span>状态</span><StatusPill label={botStatusLabel(selectedBot)} state={botStatusState(selectedBot)} /></div><div className="summary-row"><span>QQ 号</span><b className="summary-value mono">{selectedBot.qq}</b></div><div className="summary-row"><span>NapCat</span><StatusPill label={!napcat.available ? '未找到' : selectedBot.runtime?.napcat?.running ? '运行中' : '待启动'} state={!napcat.available ? 'red' : selectedBot.runtime?.napcat?.running ? 'green' : 'muted'} /></div><div className="summary-row"><span>NoneBot</span><StatusPill label={selectedBot.runtime?.onebot?.running ? '运行中' : '待启动'} state={selectedBot.runtime?.onebot?.running ? 'green' : 'muted'} /></div><div className="summary-row"><span>OneBot 端口</span><b className="summary-value mono">{selectedBot.port || '—'}</b></div><div className="summary-row"><span>NapCat WebUI</span><b className="summary-value mono">{selectedBot.napcat_port || '—'}</b></div></div>
          <div className="conversation"><div className="conversation-header"><div><h3>实时活动</h3><span>{logsPaused ? '日志同步已暂停' : '来自本机服务的最新状态'}</span></div><div className="conversation-tools"><button className="plain-icon" onClick={onTogglePause} aria-label={logsPaused ? '恢复日志' : '暂停日志'} title={logsPaused ? '恢复日志更新' : '暂停日志更新'}>{logsPaused ? <Play size={15} /> : <Pause size={15} />}</button><button className="plain-icon" onClick={onClear} aria-label="清空日志" title="清空日志"><Trash2 size={15} /></button></div></div>{verification && <LoginVerificationCard verification={verification} onRetry={async () => { try { await onCommand(selectedBot, `-q ${selectedBot.qq}`, botLogs); onNotice('已重新尝试登录，请等待二维码或登录结果') } catch (error) { onNotice(`重新登录失败：${error.message}`) } }} onNotice={onNotice} />}<div className="activity-feed" ref={feedRef} onScroll={() => { const feed = feedRef.current; if (feed) followLogsRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24 }}>{visibleLogs.length ? visibleLogs.map((log, index) => { const qrKey = `${log.time}-${log.source}-${index}`; return <LogItem key={qrKey} log={log} qrVisible={visibleQrKey === qrKey} onToggleQr={() => setVisibleQrKey(visibleQrKey === qrKey ? '' : qrKey)} /> }) : <div className="activity-empty">暂无日志</div>}</div><div className="command-box"><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="输入 -q 2 快速登录…" onKeyDown={(event) => { if (event.key === 'Enter') submitCommand() }} /><button onClick={submitCommand} aria-label="发送"><Play size={14} /></button></div></div>
           </> : <AccountConfig bot={selectedBot} onSavePassword={onSavePassword} onSavePort={onSavePort} onSaveNapcatPort={onSaveNapcatPort} onNotice={onNotice} />}
        </div>
      </> : <EmptyDetail onCreate={onCreate} />}
    </div>
  </section>
}

function AccountConfig({ bot, onSavePassword, onSavePort, onSaveNapcatPort, onNotice }) {
  const [password, setPassword] = useState('')
  const [passwordEditing, setPasswordEditing] = useState(false)
  const [port, setPort] = useState(String(bot.port || ''))
  const [napcatPort, setNapcatPort] = useState(String(bot.napcat_port || ''))
  const [savingPassword, setSavingPassword] = useState(false)
  const [savingPort, setSavingPort] = useState(false)
  const [savingNapcatPort, setSavingNapcatPort] = useState(false)

  useEffect(() => {
    setPort(String(bot.port || ''))
    setNapcatPort(String(bot.napcat_port || ''))
    setPassword('')
    setPasswordEditing(false)
  }, [bot.id, bot.port, bot.napcat_port])

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

  return <div className="config-panel"><div className="config-heading"><div><div className="eyebrow">账号配置</div><h3>连接与登录</h3><p>为「{bot.name}」管理 OneBot、NapCat WebUI 端口和密码回退。</p></div><StatusPill label={bot.password_configured ? '已设置密码' : '未设置密码'} state={bot.password_configured ? 'green' : 'muted'} /></div><form className="config-card" onSubmit={save}><div className="config-card-title"><div><strong>密码回退</strong><span>可选配置</span></div><span className="config-status">{bot.password_configured ? '当前已配置' : '当前未配置'}</span></div><label className="config-field">登录密码<span className="password-input-wrap"><input type="password" maxLength="256" autoComplete="new-password" placeholder={bot.password_configured && !passwordEditing ? '已设置，输入新密码可覆盖' : '留空则使用二维码登录'} value={password} readOnly={bot.password_configured && !passwordEditing} onFocus={() => { if (!passwordEditing) { setPasswordEditing(true); setPassword('') } }} onChange={event => setPassword(event.target.value)} /></span><small>密码只支持覆盖或清除，不提供读取原密码功能。</small></label><div className="config-actions"><button type="submit" className="action-button" disabled={savingPassword}>{savingPassword ? '保存中…' : '保存密码'}</button></div></form><form className="config-card" onSubmit={savePort}><div className="config-card-title"><div><strong>OneBot 连接端口</strong><span>NoneBot 服务</span></div><span className="config-status">当前 {bot.port}</span></div><label className="config-field">本地端口<input required type="number" min="1024" max="65535" value={port} onChange={event => setPort(event.target.value)} /><small>保存后会同步 NapCat 的 OneBot WebSocket 地址，重启 Bot 后生效。</small></label><div className="config-actions"><button type="submit" className="action-button" disabled={savingPort || !port}>{savingPort ? '保存中…' : '保存端口'}</button></div></form><form className="config-card" onSubmit={saveNapcatPort}><div className="config-card-title"><div><strong>NapCat WebUI 端口</strong><span>登录面板</span></div><span className="config-status">当前 {bot.napcat_port}</span></div><label className="config-field">本地端口<input required type="number" min="1024" max="65535" value={napcatPort} onChange={event => setNapcatPort(event.target.value)} /><small>用于打开 NapCat WebUI 登录面板；保存后需重启 Bot。</small></label><div className="config-actions"><button type="submit" className="action-button" disabled={savingNapcatPort || !napcatPort}>{savingNapcatPort ? '保存中…' : '保存端口'}</button></div></form></div>
}

function AccountListItem({ bot, selected, onClick }) {
  const running = isBotRunning(bot)
  const transitioning = isBotTransitioning(bot)
  return <button className={`account-list-item ${selected ? 'selected' : ''}`} onClick={onClick}><BotAvatar bot={bot} className="list-avatar" /><div className="list-item-copy"><strong>{bot.name}</strong><span>{bot.qq}</span></div><div className={`list-status ${running ? 'green' : transitioning ? 'blue' : ''}`}><i />{botStatusLabel(bot)}</div></button>
}

function BotAvatar({ bot, className = '' }) {
  const qq = String(bot?.qq || '').trim()
  const avatarUrl = qq ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qq)}&s=640` : ''
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [avatarUrl])

  return <div className={`bot-avatar ${className}`} title={`${bot?.name || 'Bot'} 头像`} aria-label={`${bot?.name || 'Bot'} 头像`}>
    {avatarUrl && !failed ? <img className="bot-avatar-image" src={avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <Bot size={15} />}
  </div>
}

function EmptyDetail({ onCreate }) {
  return <div className="empty-detail"><div className="empty-detail-icon"><Bot size={23} /></div><h2>还没有 QQ 账号</h2><p>添加你的真实 QQ 账号，开始管理 NapCat 和 NoneBot。</p><button className="action-button" onClick={onCreate}><Plus size={15} />新建账号</button></div>
}

function StatusPill({ label, state }) {
  return <span className={`status-pill ${state}`}><i />{label}</span>
}

function cleanLogMessage(message) {
  return String(message || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\[\d+(?:;\d+)*m/g, '')
}

function isQrArt(message) {
  const cleaned = cleanLogMessage(message)
  return cleaned.length >= 12 && /[█▀▄]/.test(cleaned) && cleaned.replace(/[█▀▄\s]/g, '') === ''
}

function compactLogMessage(message, source) {
  const prefixRemoved = message.replace(/^\s*(?:\d{2}-\d{2}\s+)?\d{2}:\d{2}:\d{2}\s+\[[^\]]+\]\s*/, '')
  const sourcePrefix = source ? new RegExp(`^${String(source).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|\\s*`, 'i') : null
  return prefixRemoved.replace(sourcePrefix || /^$/, '').trim()
}

function findImageTokenEnd(message, start) {
  let depth = 0
  for (let index = start; index < message.length; index += 1) {
    if (message[index] === '[') depth += 1
    if (message[index] !== ']') continue
    depth -= 1
    if (depth === 0) return index + 1
  }
  return -1
}

function parseImageToken(token) {
  const fields = {}
  const body = token.slice('[image:'.length, -1)
  const matcher = /(?:^|,)\s*([a-z_]+)=([\s\S]*?)(?=,\s*[a-z_]+=|$)/gi
  let match
  while ((match = matcher.exec(body))) fields[match[1].toLowerCase()] = match[2].trim()
  if (!/^https?:\/\//i.test(fields.url || '')) return null
  return {
    url: fields.url,
    file: fields.file || 'qq-image',
    summary: fields.summary || '图片消息',
    size: fields.file_size || '',
    truncated: /\.\.\.$/.test(fields.url),
  }
}

function parseLogSegments(message) {
  const text = String(message || '')
  const segments = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('[image:', cursor)
    if (start < 0) break
    const end = findImageTokenEnd(text, start)
    if (end < 0) break
    if (start > cursor) segments.push({ type: 'text', value: text.slice(cursor, start) })
    const image = parseImageToken(text.slice(start, end))
    if (image) segments.push({ type: 'image', value: image })
    else segments.push({ type: 'text', value: text.slice(start, end) })
    cursor = end
  }
  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) })
  return segments.length ? segments : [{ type: 'text', value: text }]
}

function isRedundantLog(message) {
  const normalized = message.replace(/\s+/g, ' ').trim()
  return !normalized
    || /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\[(?:trace|debug|info|notice|success|warn|warning|error|critical|fatal)\]\s*$/i.test(normalized)
    || /二维码已保存到|二维码解码URL|如果控制台二维码无法扫码|请扫描下面的二维码/.test(normalized)
    || /^\d+\.\d+\s+\S+$/.test(normalized)
}

function isNapcatMessageLog(log) {
  const message = compactLogMessage(cleanLogMessage(log?.message), log?.source)
  return /(?:接收\s*<-|发送\s*->)\s*/.test(message)
}

function prepareLogItems(logs) {
  const prepared = []
  const seen = new Set()
  for (let index = 0; index < logs.length; index += 1) {
    if (isNapcatMessageLog(logs[index])) continue
    const rawMessage = cleanLogMessage(logs[index].message)
    const message = compactLogMessage(rawMessage, logs[index].source)
    if (!isQrArt(message)) {
      if (isRedundantLog(rawMessage)) continue
      const key = `${logs[index].time}|${logs[index].source}|${rawMessage}`
      if (seen.has(key)) continue
      seen.add(key)
      const detectedLevel = rawMessage.match(/\[(trace|debug|info|notice|success|warn|warning|error|critical|fatal)\]/i)?.[1]
      prepared.push({ ...logs[index], level: detectedLevel || logs[index].level, message })
      continue
    }

    const qrLines = [message]
    while (index + 1 < logs.length && isQrArt(logs[index + 1].message)) {
      index += 1
      qrLines.push(cleanLogMessage(logs[index].message))
    }
    prepared.push({ ...logs[index], kind: 'qr', message: qrLines.join('\n') })
  }
  return prepared
}

function normalizeLogLevel(level, message) {
  const rawLevel = String(level || '').toLowerCase()
  const detectedLevel = String(message || '').match(/\[(trace|debug|info|notice|success|warn|warning|error|critical|fatal)\]/i)?.[1]
  const normalized = (rawLevel && rawLevel !== 'info' ? rawLevel : detectedLevel || rawLevel || 'info').toLowerCase()
  if (normalized === 'warning') return 'warn'
  if (normalized === 'critical' || normalized === 'fatal') return 'error'
  if (normalized === 'success' || normalized === 'debug' || normalized === 'warn' || normalized === 'error') return normalized
  return 'info'
}

function findLoginVerification(logs, source) {
  const candidates = [...logs].reverse().filter((log) => !source || log.source === source)
  const challengeIndex = candidates.findIndex((log) => /proofWaterUrl|需要验证码|密码回退需要验证码|安全验证/.test(cleanLogMessage(log.message)))
  if (challengeIndex < 0) return null

  // The array is newest-first here. A later login-success event means the
  // challenge has already been handled, so do not keep showing a stale card.
  const recoveredIndex = candidates.findIndex((log) => /登录成功|登录完成|安全验证成功|二维码登录成功|登录状态.*(?:在线|成功)|账号.*(?:上线|登录成功)|(?:OneBot|NapCat).*连接成功/i.test(cleanLogMessage(log.message)))
  if (recoveredIndex >= 0 && recoveredIndex < challengeIndex) return null

  const challenge = candidates[challengeIndex]
  if (!challenge) return null
  const text = cleanLogMessage(challenge.message)
  const proofUrl = text.match(/(?:proofWaterUrl|验证[:：])\s*(https?:\/\/[^\s]+)/i)?.[1]?.replace(/[),.;]+$/, '') || ''
  const webuiLog = candidates.find((log) => /WebUI User Panel Url:\s*https?:\/\//i.test(cleanLogMessage(log.message)))
  const webuiUrl = cleanLogMessage(webuiLog?.message || '').match(/https?:\/\/[^\s]+\/webui\?token=[^\s]+/i)?.[0]?.replace(/[),.;]+$/, '') || ''
  return { proofUrl, webuiUrl, challengeTime: challenge.time }
}

function LoginVerificationCard({ verification, onRetry, onNotice }) {
  const [webuiOpen, setWebuiOpen] = useState(false)
  const [frameKey, setFrameKey] = useState(0)

  const open = (url, label) => {
    if (!url) {
      onNotice(`${label}地址尚未从日志中获取，请稍后重试`)
      return
    }
    openExternal(url)
  }
  return <div className={`login-verification-card ${webuiOpen ? 'is-expanded' : ''}`}>
    <div className="login-verification-copy"><strong>需要 QQ 安全验证</strong><span>可直接在这里打开 NapCat WebUI 完成验证；验证完成后点击“重新登录”，面板会继续显示二维码或登录结果。</span></div>
    <div className="login-verification-actions">
      <button type="button" className="soft-button" onClick={() => setWebuiOpen((openState) => !openState)} disabled={!verification.webuiUrl}>{webuiOpen ? '收起 WebUI' : '在面板中打开 WebUI'}</button>
      <button type="button" className="soft-button" onClick={() => open(verification.proofUrl, '安全验证')} disabled={!verification.proofUrl}>打开安全验证</button>
      <button type="button" className="action-button" onClick={onRetry}>重新登录</button>
    </div>
    {webuiOpen && verification.webuiUrl && <div className="login-verification-embed">
      <iframe key={frameKey} title="NapCat WebUI 安全验证" src={verification.webuiUrl} />
      <div className="login-verification-embed-tools"><span>如果窗口空白，请使用外部窗口打开。</span><button type="button" className="soft-button" onClick={() => setFrameKey((key) => key + 1)}><RefreshCw size={13} />刷新</button><button type="button" className="soft-button" onClick={() => open(verification.webuiUrl, 'NapCat WebUI')}><ExternalLink size={13} />外部打开</button></div>
    </div>}
  </div>
}

function renderLogText(message, prefix = '') {
  const parts = String(message || '').split(/(https?:\/\/[^\s<>"']+)/gi)
  return parts.map((part, index) => /^https?:\/\//i.test(part)
    ? <a key={`${prefix}-${part}-${index}`} className="log-link" href={part} onClick={(event) => { event.preventDefault(); openExternal(part) }} title="打开链接">{part}</a>
    : <React.Fragment key={`${prefix}-${index}`}>{part}</React.Fragment>)
}

function ImageMessage({ image }) {
  const [open, setOpen] = useState(false)
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
    } catch (error) {
      setFailed(true)
    }
  }

  return <span className="log-image-message"><button type="button" className="image-message-button" onClick={() => setOpen(value => !value)} aria-expanded={open}><ImageIcon size={14} /><span>{image.summary}</span><small>{open ? '收起' : '查看图片'}</small></button>{open && <span className="image-message-panel"><span className="image-message-preview">{failed || cache.error ? <span className="image-message-error">{image.truncated ? '日志里的图片链接已被 NoneBot 截断，且本地没有可用缓存' : '图片加载失败，请打开原链接查看'}</span> : image.truncated && !cache.url ? <span className="image-message-error">正在加载图片…</span> : <img src={image.truncated ? cache.url : image.url} alt={image.summary} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}</span><span className="image-message-meta">{image.file}{image.size ? ` · ${image.size} bytes` : ''}</span><span className="image-message-url"><a href={image.url} onClick={(event) => { event.preventDefault(); openExternal(image.url) }} title="打开原链接">{image.url}</a></span><span className="image-message-actions"><a className="image-message-action" href={image.url} onClick={(event) => { event.preventDefault(); openExternal(image.url) }}><ExternalLink size={13} />原链接</a><a className="image-message-action" href={image.url} onClick={saveImage}><Download size={13} />保存图片</a></span></span>}</span>
}

function renderLogMessage(message) {
  return parseLogSegments(message).map((segment, index) => segment.type === 'image'
    ? <ImageMessage key={`image-${index}`} image={segment.value} />
    : <React.Fragment key={`text-${index}`}>{renderLogText(segment.value, `text-${index}`)}</React.Fragment>)
}

function LogItem({ log, qrVisible, onToggleQr }) {
  const level = normalizeLogLevel(log.level, log.message)
  return <div className={`log-item ${log.kind === 'qr' ? 'qr-log-item' : ''}`}><div className={`log-dot ${level}`} /><div className="log-copy">{log.kind === 'qr' ? <><div className="log-meta"><time>{log.time}</time><strong>[{log.source}]</strong></div>{qrVisible ? <div className="qr-card"><AuthenticatedQr time={log.time} /><span>使用手机 QQ 扫描此二维码登录</span><button type="button" className="qr-reveal" onClick={onToggleQr}>隐藏二维码</button></div> : <button type="button" className="qr-reveal" onClick={onToggleQr}>登录二维码已就绪 · 点击显示</button>}</> : <div className="log-line"><time>{log.time}</time><strong>[{log.source}]</strong><span className={`log-level-${level}`}>{renderLogMessage(log.message)}</span></div>}</div></div>
}

function AuthenticatedQr({ time }) {
  const media = useAuthenticatedMedia(`/api/napcat/qrcode?time=${encodeURIComponent(time)}`, true)
  if (media.error) return <span className="image-message-error">二维码加载失败</span>
  return media.url ? <img src={media.url} alt="NapCat 登录二维码" /> : <span className="image-message-error">二维码加载中…</span>
}

function ResourcePage({ kind, resource, setup, onOpenSetup, onSelect, onRefresh, onBack, officialUrl }) {
  const isNapCat = kind === 'napcat'
  const title = isNapCat ? 'NapCat' : 'NoneBot'
  const description = isNapCat ? 'QQ 协议端与 WebUI 运行资源' : 'NoneBot2 机器人运行环境与插件项目'
  const unavailable = !resource
  const valid = Boolean(resource?.valid)
  const missing = resource?.missing
  const statusTitle = unavailable ? '等待管理 API' : valid ? `${title} 已就绪` : missing === 'qq' ? '缺少 QQ 主程序' : `尚未配置 ${title}`
  const statusDescription = unavailable ? '暂时无法读取本机资源状态，请检查管理服务连接。' : valid ? '控制台可以使用该资源启动 Bot。' : missing === 'qq' ? 'NapCat 启动器已找到，但同一目录缺少 QQ.exe。请先安装 QQ，或选择已有 QQ/NapCat 目录。' : `请选择本机已有的 ${title} 目录，或打开官方页面下载。`
  const pathLabel = unavailable ? '等待管理 API' : resource.path || '尚未选择目录'
  const pathState = unavailable ? '状态未知' : valid ? '路径有效' : missing === 'qq' ? '缺少 QQ.exe' : '路径无效或不存在'
  return <section className="resource-page"><div className="resource-page-header"><div><button className="resource-back" onClick={onBack}><RotateCcw size={14} />返回 QQ 账号</button><div className="eyebrow">运行资源</div><h1>{title}</h1><p>{description}</p></div><div className="resource-page-actions"><button className="action-button" onClick={onOpenSetup} disabled={unavailable}><Download size={15} />{setup?.status === 'running' ? '查看配置进度' : '一键配置'}</button><button className="plain-icon" onClick={onRefresh} aria-label="刷新资源状态"><RefreshCw size={16} /></button></div></div><div className={`resource-status-card ${valid ? 'ready' : unavailable ? 'unavailable' : 'missing'}`}><div className="resource-status-icon">{valid ? <Check size={22} /> : <FolderOpen size={22} />}</div><div><strong>{statusTitle}</strong><span>{statusDescription}</span></div><span className="resource-status-pill">{unavailable ? '状态未知' : valid ? '已就绪' : '待设置'}</span></div><section className="resource-card"><div className="resource-card-heading"><div><h2>资源目录</h2><p>控制台会从此目录读取并启动 {title}。</p></div><span className="resource-path-state">{pathState}</span></div><div className="resource-path"><FolderOpen size={16} /><span title={pathLabel}>{pathLabel}</span></div><div className="resource-actions"><button className="secondary" onClick={() => onSelect(kind)} disabled={unavailable}><FolderOpen size={15} />选择本地目录</button><button className="secondary" onClick={() => officialUrl && openExternal(officialUrl)}><Download size={15} />打开官方获取页<ExternalLink size={13} /></button></div></section><section className="resource-help"><strong>首次使用建议</strong><p>一键配置会打开完整流程：NoneBot 固定执行，NapCat 等协议端按需选择。也可以先手动下载，再选择已有目录。</p></section></section>
}

function ResourceSetupModal({ resources, setup, onSetup, onSelect, onRefresh, onClose }) {
  const items = [
    { kind: 'nonebot', label: 'NoneBot', resource: resources.nonebot, file: 'bot.py + pyproject.toml', required: true, description: '固定配置，负责运行机器人和插件。' },
    { kind: 'napcat', label: 'NapCat', resource: resources.napcat, file: 'NapCatWinBootMain.exe + QQ.exe', description: '可选协议端，需要本机已安装 QQ。' },
    { kind: 'lagrange', label: 'Lagrange.Core', resource: null, unavailable: true, description: '协议端接入正在开发，暂时不会执行。' },
  ]
  const [selectedKinds, setSelectedKinds] = useState(['nonebot'])
  const setupRunning = setup?.status === 'running'
  useEffect(() => {
    if (Array.isArray(setup?.kinds) && setup.kinds.length) setSelectedKinds(setup.kinds)
  }, [setup?.id])

  const toggleKind = (kind) => {
    if (setupRunning || kind === 'nonebot') return
    setSelectedKinds((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind])
  }

  const taskMap = new Map((Array.isArray(setup?.tasks) ? setup.tasks : []).map((task) => [task.kind, task]))
  const workflowTasks = Array.isArray(setup?.tasks) && setup.tasks.length
    ? setup.tasks
    : items.filter((item) => selectedKinds.includes(item.kind)).map((item) => ({ kind: item.kind, label: item.label, status: 'queued', progress: 0, message: '等待执行' }))
  const statusLabels = { queued: '等待执行', running: '执行中', succeeded: '已完成', failed: '失败' }
  const setupStarted = Boolean(setup?.status && setup.status !== 'idle')
  const currentTask = items.find((item) => item.kind === setup?.current_task)?.label || taskMap.get(setup?.current_task)?.label
  const workflowTitle = setup?.status === 'succeeded' ? '配置流程已完成' : setup?.status === 'failed' ? '配置流程未完成' : '正在执行配置流程'

  return <div className="modal-backdrop resource-setup-backdrop"><section className="resource-setup-modal" role="dialog" aria-modal="true" aria-labelledby="resource-setup-title"><div className="modal-header"><div><div className="eyebrow">首次启动设置</div><h2 id="resource-setup-title">准备运行资源</h2><p>NoneBot 固定执行，协议端按需选择；开始后会按顺序自动处理。</p></div><div className="resource-setup-header-actions"><button className="action-button" onClick={() => onSetup(selectedKinds)} disabled={setupRunning || !selectedKinds.length}><Download size={15} />{setupRunning ? '配置中…' : setupStarted ? '重新配置' : '一键配置'}</button><button className="plain-icon resource-setup-refresh" onClick={onRefresh} aria-label="刷新资源状态" title="刷新资源状态"><RefreshCw size={18} /></button><button className="plain-icon resource-setup-close" onClick={onClose} aria-label="收起弹窗" title="收起"><X size={17} /></button></div></div><div className="resource-setup-list">{items.map(({ kind, label, resource, file, required, unavailable, description }) => { const selected = selectedKinds.includes(kind); return <div className={`resource-setup-item setup-option ${selected ? 'selected' : ''} ${unavailable ? 'unavailable' : ''}`} key={kind}><label className="resource-setup-choice"><input type="checkbox" checked={selected} disabled={required || unavailable || setupRunning} onChange={() => toggleKind(kind)} /><span className="resource-setup-check" aria-hidden="true">{selected && <Check size={13} />}</span></label><div className={`resource-setup-icon ${resource?.valid ? 'ready' : ''}`}><FolderOpen size={18} /></div><div className="resource-setup-copy"><strong>{label}<em>{required ? '固定' : unavailable ? '暂未接入' : '可选'}</em></strong><span>{resource?.valid ? '已检测到有效目录，执行时会跳过安装' : resource?.missing === 'qq' ? '缺少 QQ.exe，请先安装 QQ' : unavailable ? description : `${description} 需要包含 ${file}`}</span><small>{resource?.path || (unavailable ? '暂不参与本次配置' : '尚未配置')}</small></div>{!unavailable && <div className="resource-setup-actions"><button className="secondary" onClick={() => onSelect(kind)} disabled={setupRunning}>选择目录</button></div>}</div> })}</div>{setupStarted && <div className={`resource-setup-progress workflow-panel ${setup.status}`}><div className="resource-setup-progress-heading"><strong>{workflowTitle}</strong><span>{Math.round(setup.progress || 0)}%</span></div>{setup.status === 'running' && <p className="resource-current-task">当前任务：{currentTask || setup.step || '准备中'}</p>}<div className="resource-progress-track"><i style={{ width: `${Math.max(0, Math.min(100, setup.progress || 0))}%` }} /></div><div className="resource-task-list">{workflowTasks.map((task) => <div className={`resource-task-item ${task.status}`} key={task.kind}><div className="resource-task-status" aria-hidden="true">{task.status === 'succeeded' ? <Check size={14} /> : task.status === 'failed' ? <X size={14} /> : task.status === 'running' ? <RefreshCw size={14} /> : <MoreHorizontal size={14} />}</div><div className="resource-task-copy"><strong>{task.label}</strong><span>{task.message || statusLabels[task.status] || '等待执行'}</span></div><span className="resource-task-state">{statusLabels[task.status] || task.status} · {Math.round(task.progress || 0)}%</span></div>)}</div>{setup.error && <p className="resource-setup-error">{setup.error}</p>}</div>}<div className="resource-setup-note">NapCat 还需要本机安装 QQ；官方 NapCat 下载包只提供启动组件。目录配置保存在本机，不会把账号密码写入资源目录。</div></section></div>
}

function SettingsPage({ theme, onThemeChange, onBack, onNotice }) {
  const [section, setSection] = useState('外观')
  const sections = [
    { title: '个人', items: [{ label: '常规', icon: Settings }, { label: '个人资料', icon: CircleUserRound }, { label: '外观', icon: Palette }, { label: '快捷键', icon: Keyboard }] },
    { title: '应用', items: [{ label: '通知', icon: Bell }, { label: '服务', icon: Server }] },
  ]

  const chooseSection = (label) => {
    setSection(label)
    if (label !== '外观') onNotice(`${label}设置即将开放`)
  }

  return <section className="settings-shell"><aside className="settings-sidebar"><button className="settings-back" onClick={onBack}><ArrowLeft size={15} />返回应用</button><div className="settings-search"><Search size={14} /><input placeholder="搜索设置…" /></div><div className="settings-nav-list">{sections.map((group) => <div className="settings-group" key={group.title}><div className="settings-group-title">{group.title}</div>{group.items.map(({ label, icon: Icon }) => <button key={label} className={`settings-nav-item ${section === label ? 'active' : ''}`} onClick={() => chooseSection(label)}><Icon size={15} /><span>{label}</span></button>)}</div>)}</div></aside><main className="settings-main">{section === '外观' ? <AppearanceSettings theme={theme} onThemeChange={onThemeChange} /> : <div className="settings-empty"><div className="placeholder-icon"><Settings size={21} /></div><h2>{section}</h2><p>这个设置模块已经预留好入口。</p></div>}</main></section>
}

function AppearanceSettings({ theme, onThemeChange }) {
  const options = [
    { value: 'system', label: '系统', icon: Monitor },
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
  ]
  const currentLabel = options.find((option) => option.value === theme)?.label || '系统'
  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">系统设置</div><h1>外观</h1><p>调整 QQ 控制台的主题和界面显示方式。</p></div><section className="settings-section"><h2>主题</h2><div className="theme-options">{options.map(({ value, label, icon: Icon }) => <button key={value} className={`theme-option ${theme === value ? 'selected' : ''}`} onClick={() => onThemeChange(value)}><div className={`theme-preview theme-preview-${value}`}><div className="theme-preview-top" /><div className="theme-preview-body"><div /><div /><div /></div><Icon size={15} /></div><span>{label}</span>{theme === value && <Check className="theme-option-check" size={14} />}</button>)}</div></section><section className="appearance-card"><div className="appearance-card-heading"><div><h2>{currentLabel}主题</h2><p>当前主题会立即应用，并保存到本机。</p></div><span className="theme-badge"><Palette size={14} />{currentLabel}</span></div><div className="appearance-row"><div><strong>界面字体</strong><span>中文优先使用 HarmonyOS Sans SC</span></div><b>HarmonyOS Sans SC</b></div><div className="appearance-row"><div><strong>布局密度</strong><span>保持当前舒适的桌面布局</span></div><b>舒适</b></div></section></div>
}

function RuntimeStatusPage({ bots, system, stats, napcat, online, refreshing, refresh, busy, action, onSelectBot }) {
  const [period, setPeriod] = useState('day')
  const [botPage, setBotPage] = useState(1)
  const runningBots = bots.filter((bot) => isBotRunning(bot))
  const periodStats = stats?.periods?.[period] || { received: 0, sent: 0, total: 0, groups: 0, private: 0, media: 0, commands: 0, active_days: 0 }
  const periodBots = stats?.bots?.[period] || []
  const series = stats?.series || []
  const chartSeries = series.length ? series : Array.from({ length: 14 }, (_, index) => ({ day: `empty-${index}`, received: 0, sent: 0 }))
  const maxDaily = Math.max(1, ...chartSeries.map((item) => Math.max(Number(item.received || 0), Number(item.sent || 0))))
  const hasSeriesData = chartSeries.some((item) => Number(item.received || 0) > 0 || Number(item.sent || 0) > 0)
  const chartScale = hasSeriesData ? Math.max(100, Math.ceil(maxDaily / 100) * 100) : 80
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
  const periodLabel = period === 'day' ? '今日' : period === 'week' ? '本周' : '本月'
  const total = Number(periodStats.total || 0)
  const received = Number(periodStats.received || 0)
  const sent = Number(periodStats.sent || 0)
  const receivedShare = total ? Math.round(received / total * 100) : 0
  const sentShare = total ? Math.round(sent / total * 100) : 0
  const media = Number(periodStats.media || 0)
  const mediaShare = total ? Math.round(media / total * 100) : 0
  const yesterdaySeries = chartSeries.length > 1 ? chartSeries[chartSeries.length - 2] : null
  const yesterdayTotal = yesterdaySeries ? Number(yesterdaySeries.received || 0) + Number(yesterdaySeries.sent || 0) : 0
  const dailyChange = yesterdayTotal ? Math.round((total - yesterdayTotal) / yesterdayTotal * 100) : null
  const botStats = new Map(periodBots.map((item) => [String(item.id), item]))
  const firstBot = bots[0]
  const memoryTotal = Number(system.memory_total || 0)
  const memoryText = online && memoryTotal
    ? `${((memoryTotal * Number(system.memory || 0) / 100) / (1024 ** 3)).toFixed(1)} GB / ${(memoryTotal / (1024 ** 3)).toFixed(1)} GB`
    : '本机资源占用'
  const pageSize = 3
  const pageCount = Math.max(1, Math.ceil(bots.length / pageSize))
  const visibleBots = bots.slice((botPage - 1) * pageSize, botPage * pageSize)
  const uptime = (seconds) => {
    const totalSeconds = Math.max(0, Number(seconds || 0))
    if (!totalSeconds) return '—'
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    return hours ? `${hours}小时 ${minutes}分` : `${Math.max(1, minutes)}分钟`
  }
  useEffect(() => {
    setBotPage((page) => Math.min(page, pageCount))
  }, [pageCount])
  return <section className="runtime-page">
    <div className="runtime-metrics">
      <div className="runtime-metric"><div className="runtime-metric-icon purple"><Bot size={19} /></div><div><span>在线 Bot</span><strong>{runningBots.length}<small> / {bots.length}</small></strong><em>全部在线</em></div></div>
      <div className="runtime-metric"><div className="runtime-metric-icon green"><MessageSquare size={19} /></div><div><span>今日消息</span><strong>{total.toLocaleString()} <small>条</small></strong><em className={dailyChange !== null && dailyChange >= 0 ? 'positive' : ''}>{dailyChange === null ? '较昨日暂无数据' : `较昨日 ${dailyChange >= 0 ? '↑' : '↓'} ${Math.abs(dailyChange)}%`}</em></div></div>
      <div className="runtime-metric"><div className="runtime-metric-icon blue"><Cpu size={17} /></div><div><span>CPU 使用率</span><strong>{online ? `${Math.round(system.cpu ?? 0)}%` : '—'}</strong><em>负载良好</em></div></div>
      <div className="runtime-metric"><div className="runtime-metric-icon orange"><Database size={17} /></div><div><span>内存使用率</span><strong>{online ? `${Math.round(system.memory ?? 0)}%` : '—'}</strong><em>{memoryText}</em></div></div>
    </div>

    <section className="runtime-section runtime-stats-section">
      <div className="runtime-section-heading runtime-stats-heading"><div><h2>消息趋势 <button className="runtime-info" type="button" title="查看消息统计说明" aria-label="查看消息统计说明"><CircleHelp size={14} /></button></h2><p>最近 14 天的收发消息统计</p></div><div className="runtime-period-tabs">{[['day', '今日'], ['week', '本周'], ['month', '本月']].map(([value, label]) => <button key={value} className={period === value ? 'selected' : ''} onClick={() => setPeriod(value)}>{label}</button>)}</div></div>
      <div className="runtime-analytics-grid">
        <div className="runtime-chart-panel">
          <div className="runtime-chart-head"><div className="runtime-chart-legend"><span><i className="received" />收到</span><span><i className="sent" />发出</span></div></div>
          <div className="runtime-chart-area" aria-label="近 14 天收到和发出消息趋势">
            <div className="runtime-chart-y-axis">{chartLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>
            <div className="runtime-chart-plot"><div className="runtime-chart-grid-lines"><i /><i /><i /><i /><i /></div><svg className="runtime-line-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline className="received" points={chartPoints('received')} /><polyline className="sent" points={chartPoints('sent')} /></svg>{hasSeriesData && <div className="runtime-chart-points" aria-hidden="true">{chartSeries.flatMap((item, index) => ['received', 'sent'].map((key) => { const { x, y } = chartPointPosition(item, index, key); return <i key={`${item.day}-${key}`} className={`runtime-chart-point ${key}`} style={{ left: `${x}%`, top: `${y}%` }} /> }))}</div>}<div className="runtime-chart-x-axis">{(hasSeriesData ? chartSeries : [{ day: '00:00' }, { day: '06:00' }, { day: '12:00' }, { day: '18:00' }, { day: '24:00' }]).map((item, index, items) => <span key={`${item.day}-${index}`}>{hasSeriesData ? (index === 0 || index === items.length - 1 || index % 2 === 0 ? item.day.slice(5) : '') : item.day}</span>)}</div></div>
          </div>
        </div>
        <div className="runtime-overview-panel"><h3>{periodLabel}统计</h3><div className="runtime-share-list"><div><span><i className="received" />收到消息</span><b>{received.toLocaleString()}</b><small>{receivedShare}%</small></div><div><span><i className="sent" />发出消息</span><b>{sent.toLocaleString()}</b><small>{sentShare}%</small></div><div><span><i className="media" />含媒体消息</span><b>{media.toLocaleString()}</b><small>{mediaShare}%</small></div></div><div className="runtime-overview-foot"><span>群聊 {Number(periodStats.groups || 0).toLocaleString()}</span><span>私聊 {Number(periodStats.private || 0).toLocaleString()}</span><span>命令 {Number(periodStats.commands || 0).toLocaleString()}</span></div></div>
      </div>
    </section>

    <div className="runtime-columns">
      <section className="runtime-section runtime-bots-section"><div className="runtime-section-heading"><div><h2>Bot 运行概况 <small>共 {bots.length} 个账号</small></h2></div></div>{bots.length ? <><div className="runtime-bot-table"><div className="runtime-bot-table-head"><span>Bot</span><span>QQ 号</span><span>状态</span><span>今日消息</span><span>OneBot 端口</span><span>NapCat WebUI</span><span>操作</span></div>{visibleBots.map((bot) => { const running = isBotRunning(bot); const transitioning = isBotTransitioning(bot); const botTotal = Number(botStats.get(String(bot.id))?.total || 0); return <div className="runtime-bot-row" key={bot.id}><div className="runtime-bot-identity"><BotAvatar bot={bot} className="runtime-bot-avatar" /><div><strong>{bot.name}</strong></div></div><span className="runtime-bot-qq">{bot.qq}</span><StatusPill label={botStatusLabel(bot)} state={botStatusState(bot)} /><span className="runtime-table-value">{botTotal.toLocaleString()}</span><span className="runtime-table-value">{bot.port || '—'}</span><span className="runtime-table-value">{bot.napcat_port || '—'}</span><div className="runtime-bot-row-actions"><button className="secondary runtime-view-button" onClick={() => onSelectBot(bot.id)}>查看账号</button><button className={`runtime-action ${running ? 'danger' : ''}`} onClick={() => action(bot, running ? 'stop' : 'start', running ? '停止' : '启动')} disabled={busy.startsWith(`${bot.id}:`) || transitioning}>{running ? <Square size={12} /> : <Play size={12} />}{transitioning ? botStatusLabel(bot) : running ? '停止' : '启动'}</button></div></div>})}</div>{pageCount > 1 && <div className="runtime-table-footer"><div className="runtime-pagination"><button className="plain-icon" onClick={() => setBotPage((page) => Math.max(1, page - 1))} disabled={botPage === 1} aria-label="上一页" title="上一页"><ChevronLeft size={15} /></button><span className="selected">{botPage}</span><button className="plain-icon" onClick={() => setBotPage((page) => Math.min(pageCount, page + 1))} disabled={botPage === pageCount} aria-label="下一页" title="下一页"><ChevronRight size={15} /></button></div><span>共 {bots.length} 条</span></div>}</> : <div className="runtime-empty"><Bot size={18} /><span>还没有可监控的 Bot</span></div>}</section>
    </div>

    <section className="runtime-section runtime-services-section"><div className="runtime-section-heading"><div><h2>服务状态</h2></div></div><div className="runtime-service-cards"><div className="runtime-service-card"><div className="runtime-service-icon"><Server size={18} /></div><div><strong>NapCat</strong><span>{napcat.available ? '可选服务，未启动' : '尚未配置资源'}</span></div><StatusPill label={napcat.running > 0 ? '运行中' : '未启用'} state={napcat.running > 0 ? 'green' : 'muted'} /></div><div className="runtime-service-card"><div className="runtime-service-icon nonebot"><SquareTerminal size={18} /></div><div><strong>NoneBot</strong><span>{runningBots.length ? `${runningBots.length} 个插件已加载` : '等待 Bot 启动'}</span></div><StatusPill label={runningBots.length ? '运行中' : '未启动'} state={runningBots.length ? 'green' : 'muted'} /></div><div className="runtime-service-card"><div className="runtime-service-icon onebot"><FileText size={18} /></div><div><strong>OneBot 端口</strong><span>{firstBot?.port ? `端口 ${firstBot.port} 可用` : '尚未配置端口'}</span></div><StatusPill label={firstBot?.port ? '正常' : '未配置'} state={firstBot?.port ? 'green' : 'muted'} /></div></div></section>
  </section>
}

function PlaceholderPage({ active, onBack }) {
  return <section className="placeholder"><div className="placeholder-icon"><Gauge size={21} /></div><h2>{active}</h2><p>这个模块已经预留好入口，下一步可以接入真实配置。</p><button className="secondary" onClick={onBack}>返回 QQ 账号</button></section>
}

function CreateAccountModal({ account, creating, onChange, onClose, onSubmit }) {
  const [showPassword, setShowPassword] = useState(false)
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="create-modal" onSubmit={onSubmit}><div className="modal-header"><div><div className="eyebrow">QQ 控制台</div><h2>新建账号</h2><p>添加你的真实 QQ 账号</p></div><button type="button" className="modal-close" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><label>账号名称<input required maxLength="40" placeholder="例如：群管助手" value={account.name} onChange={event => onChange({ ...account, name: event.target.value })} /></label><label>QQ 号<input required pattern="[0-9]{5,20}" placeholder="请输入 5-20 位 QQ 号" value={account.qq} onChange={event => onChange({ ...account, qq: event.target.value })} /></label><label>NoneBot / OneBot 端口<input required type="number" min="1024" max="65535" placeholder="例如：8080" value={account.port} onChange={event => onChange({ ...account, port: event.target.value })} /><small>每个账号必须使用不同端口，创建后会同步到 NapCat。</small></label><label>NapCat WebUI 端口（可选）<input type="number" min="1024" max="65535" placeholder="留空自动分配（默认 6099）" value={account.napcatPort} onChange={event => onChange({ ...account, napcatPort: event.target.value })} /><small>用于 NapCat 登录面板；留空会自动选择未占用端口。</small></label><label>登录密码（可选）<span className="password-input-wrap"><input type={showPassword ? 'text' : 'password'} maxLength="256" autoComplete="new-password" placeholder="留空则使用二维码登录" value={account.password} onChange={event => onChange({ ...account, password: event.target.value })} /><button type="button" className="password-toggle" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? '隐藏密码' : '显示密码'} title={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></span><small>仅作为 NapCat 登录失败后的密码回退，不会显示在日志中。</small></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="action-button" disabled={creating}>{creating ? '创建中…' : '创建账号'}</button></div></form></div>
}

function DeleteAccountModal({ bot, deleting, onClose, onConfirm }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="delete-modal" role="alertdialog" aria-labelledby="delete-account-title"><div className="modal-header"><div><div className="eyebrow">QQ 控制台</div><h2 id="delete-account-title">删除账号</h2><p>确认删除「{bot.name}」？</p></div><button type="button" className="modal-close" onClick={onClose} aria-label="关闭" disabled={deleting}><X size={18} /></button></div><div className="delete-warning">删除后会移除账号记录和专属启动脚本；不会删除 NapCat 安装文件。</div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={deleting}>取消</button><button type="button" className="action-button danger" onClick={onConfirm} disabled={deleting}>{deleting ? '删除中…' : '确认删除'}</button></div></div></div>
}

createRoot(document.getElementById('root')).render(<App />)
