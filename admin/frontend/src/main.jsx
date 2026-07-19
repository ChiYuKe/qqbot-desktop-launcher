import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, ArrowLeft, Bell, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, CircleUserRound, Cpu,
  Copy, Database, Download, Eye, EyeOff, ExternalLink, FileText, FolderOpen, Gauge, Image as ImageIcon, Keyboard, LayoutDashboard, MessageSquare, Monitor, Moon, MoreHorizontal, Palette, Pause, Play,
  Maximize2, Minimize2, Plus, Power, Puzzle, RefreshCw, RotateCcw, Search, Server,
  Paintbrush, Settings, ShieldCheck, SlidersHorizontal, Square, SquareTerminal, Star, Sun, Trash2, UserRound, Users, Volume2, X,
} from 'lucide-react'
import './styles.css'
import './layout.css'
import './theme-packages/blue.css'
import { api, dashboardApi, DASHBOARD_POLL_INTERVAL_MS, downloadAuthenticatedFile, fetchAuthenticatedBlob } from './lib/api.js'
import {
  astrbotDashboardPort,
  botStatusLabel,
  botStatusState,
  EMPTY_PLUGIN_FRAMEWORKS,
  isBotRunning,
  isBotTransitioning,
  normalizePluginFrameworks,
  openExternal,
  webUiTarget,
} from './lib/bot.js'
import {
  findLoginVerification,
  isCurrentSessionLog,
  mergeCurrentSessionLogs,
  normalizeLogLevel,
  orderCurrentSessionLogs,
  parseLogSegments,
  prepareLogItems,
  resolveQuickLoginCommand,
} from './lib/logs.js'
import { deriveStatsFromLogs } from './lib/stats.js'
import { DEFAULT_THEME_PACKAGE, getThemePackage, THEME_PACKAGES } from './theme-packages/index.js'

const fallbackBots = []
const fallbackLogs = []
const fallbackStats = { periods: {}, bots: {}, series: [], intraday: [], intraday_by_day: {}, updated_at: null }
const FAVORITES_STORAGE_KEY = 'qq-console-favorites'
const NOTIFICATION_STORAGE_KEY = 'qq-console-github-notifications'
const PREFERENCES_STORAGE_KEY = 'qq-console-preferences'
const FONT_STORAGE_KEY = 'qq-console-font'
const THEME_PACKAGE_STORAGE_KEY = 'qq-console-theme-package'
const NOTIFICATION_POLL_INTERVAL_MS = 60_000
const NOTIFICATION_MAX_ITEMS = 50
const NOTIFICATION_LEVELS = new Set(['info', 'success', 'warning', 'error'])
const NOTIFICATION_FEED_URL = String(import.meta.env.VITE_GITHUB_NOTIFICATION_URL || 'https://raw.githubusercontent.com/ChiYuKe/qqbot-desktop-launcher/master/notifications.json').trim()
const NOTIFICATION_SOURCE = 'GitHub'
const OFFICIAL_RESOURCE_URLS = {
  napcat: 'https://github.com/NapNeko/NapCatQQ/releases',
  nonebot: 'https://nonebot.dev/docs/quick-start',
  astrbot: 'https://docs.astrbot.app/deploy/astrbot/cli.html',
}
const RESOURCE_SETUP_POLL_INTERVAL_MS = 750
const favoritePageDefinitions = [
  { key: 'page:概览', label: '概览', icon: LayoutDashboard },
  { key: 'page:QQ 账号', label: 'QQ 账号', icon: UserRound },
  { key: 'page:运行状态', label: '运行状态', icon: Activity },
  { key: 'page:插件管理', label: '插件管理', icon: Puzzle },
  { key: 'page:群组管理', label: '群组管理', icon: Users },
  { key: 'page:NapCat', label: 'NapCat', icon: Server },
  { key: 'page:NoneBot', label: 'NoneBot', icon: SquareTerminal },
  { key: 'page:AstrBot', label: 'AstrBot', icon: Bot },
]
const SECONDARY_PAGE_NAMES = new Set(['系统设置', 'NapCat', 'NoneBot', 'AstrBot'])
const FONT_OPTIONS = [
  { value: 'system', label: '系统默认', description: 'HarmonyOS Sans SC', family: '"HarmonyOS Sans SC", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif' },
  { value: 'microsoft', label: '微软雅黑', description: 'Windows 中文默认风格', family: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif' },
  { value: 'segoe', label: 'Segoe UI', description: '偏英文和数字阅读', family: '"Segoe UI Variable Text", "Segoe UI", sans-serif' },
]
const SETTINGS_SECTIONS = [
  { title: '个人', items: [{ label: '常规', icon: SlidersHorizontal }, { label: '个人资料', icon: CircleUserRound }, { label: '外观', icon: Palette }, { label: '快捷键', icon: Keyboard }] },
  { title: '应用', items: [{ label: '通知', icon: Volume2 }, { label: '服务', icon: ShieldCheck }, { label: '主题插件包', icon: Paintbrush }] },
]
const DEFAULT_PREFERENCES = {
  autoRefresh: true,
  notificationsEnabled: true,
  reduceMotion: false,
  density: 'comfortable',
  profileName: '管理员',
  notificationSound: false,
}

function readPreferences() {
  try {
    const saved = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
    const parsed = saved ? JSON.parse(saved) : {}
    return { ...DEFAULT_PREFERENCES, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

function normalizeNotification(item) {
  if (!item || !String(item.id || '').trim() || !String(item.title || '').trim() || !String(item.body || '').trim()) return null
  const level = String(item.level || 'info').toLowerCase()
  return {
    id: String(item.id).trim(),
    title: String(item.title).trim(),
    body: String(item.body).trim(),
    level: NOTIFICATION_LEVELS.has(level) ? level : 'info',
    created_at: String(item.created_at || ''),
    expires_at: item.expires_at ? String(item.expires_at) : '',
    link: item.link ? String(item.link).trim() : '',
    read: Boolean(item.read),
  }
}

function isNotificationActive(item) {
  if (!item?.expires_at) return true
  const expiresAt = Date.parse(item.expires_at)
  return !Number.isFinite(expiresAt) || expiresAt > Date.now()
}

function readNotificationState() {
  const fallback = { version: 1, initialized: false, cursor: '', items: [] }
  try {
    const saved = window.localStorage.getItem(NOTIFICATION_STORAGE_KEY)
    if (!saved) return fallback
    const parsed = JSON.parse(saved)
    const items = Array.isArray(parsed?.items)
      ? parsed.items.map(normalizeNotification).filter(Boolean).filter(isNotificationActive).slice(0, NOTIFICATION_MAX_ITEMS)
      : []
    return {
      version: 1,
      initialized: Boolean(parsed?.initialized),
      cursor: String(parsed?.cursor || ''),
      items,
    }
  } catch {
    return fallback
  }
}

function formatNotificationTime(value) {
  const timestamp = Date.parse(String(value || ''))
  if (!Number.isFinite(timestamp)) return '刚刚'
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatUptime(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0))
  const displaySeconds = totalSeconds % 60
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes} 分 ${String(displaySeconds).padStart(2, '0')} 秒`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return `${hours} 小时${remainingMinutes ? ` ${remainingMinutes} 分` : ''} ${String(displaySeconds).padStart(2, '0')} 秒`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return `${days} 天${remainingHours ? ` ${remainingHours} 小时` : ''}${remainingMinutes ? ` ${remainingMinutes} 分` : ''} ${String(displaySeconds).padStart(2, '0')} 秒`
}

function App() {
  const [bots, setBots] = useState(fallbackBots)
  const [system, setSystem] = useState({ cpu: 0, memory: 0, running_bots: 0 })
  const [stats, setStats] = useState(fallbackStats)
  const [napcat, setNapcat] = useState({ available: false, running: 0 })
  const [resources, setResources] = useState(null)
  const [pluginFrameworks, setPluginFrameworks] = useState(EMPTY_PLUGIN_FRAMEWORKS)
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
  const [newAccount, setNewAccount] = useState({ name: '', qq: '', port: '', framework: 'nonebot', napcatPort: '', password: '' })
  const [online, setOnline] = useState(false)
  const [webUiMenuOpen, setWebUiMenuOpen] = useState(false)
  const [embeddedWebUi, setEmbeddedWebUi] = useState(null)
  const [notificationState, setNotificationState] = useState(readNotificationState)
  const [notificationOpen, setNotificationOpen] = useState(false)
  const returnPageRef = useRef('QQ 账号')
  const dashboardLoadingRef = useRef(false)
  const webUiMenuRef = useRef(null)
  const notificationStateRef = useRef(notificationState)
  const resourceSetupAutoOpenedRef = useRef(false)
  const [theme, setTheme] = useState(() => window.localStorage.getItem('qq-console-theme') || 'system')
  const [themePackage, setThemePackage] = useState(() => {
    const saved = window.localStorage.getItem(THEME_PACKAGE_STORAGE_KEY)
    return THEME_PACKAGES.some((item) => item.id === saved) ? saved : DEFAULT_THEME_PACKAGE.id
  })
  const [font, setFont] = useState(() => {
    const saved = window.localStorage.getItem(FONT_STORAGE_KEY)
    return saved === 'harmony' || !FONT_OPTIONS.some((option) => option.value === saved) ? 'system' : saved
  })
  const [preferences, setPreferences] = useState(readPreferences)
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
    const selectedPackage = getThemePackage(themePackage)
    document.documentElement.dataset.themePackage = selectedPackage.id
    window.localStorage.setItem(THEME_PACKAGE_STORAGE_KEY, selectedPackage.id)
  }, [themePackage])

  useEffect(() => {
    const selectedFont = FONT_OPTIONS.find((option) => option.value === font) || FONT_OPTIONS[0]
    document.documentElement.dataset.font = selectedFont.value
    document.documentElement.style.setProperty('--app-font-family', selectedFont.family)
    window.localStorage.setItem(FONT_STORAGE_KEY, selectedFont.value)
  }, [font])

  useEffect(() => {
    document.documentElement.dataset.density = preferences.density
    document.documentElement.dataset.reducedMotion = preferences.reduceMotion ? 'true' : 'false'
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  }, [preferences])

  useEffect(() => {
    if (favoriteKeys !== null) window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favoriteKeys))
  }, [favoriteKeys])

  useEffect(() => {
    notificationStateRef.current = notificationState
    try {
      window.localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(notificationState))
    } catch {
      // Notification history is optional; a full local storage must not break the console.
    }
  }, [notificationState])

  useEffect(() => {
    if (!webUiMenuOpen) return undefined
    const closeMenu = (event) => {
      if (!webUiMenuRef.current?.contains(event.target)) setWebUiMenuOpen(false)
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setWebUiMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [webUiMenuOpen])

  useEffect(() => {
    let disposed = false
    let timer = null
    let inFlight = false

    if (!preferences.notificationsEnabled) return undefined

    const syncNotifications = async () => {
      if (disposed || inFlight) return
      inFlight = true
      try {
        const current = notificationStateRef.current
        const endpoint = new URL(NOTIFICATION_FEED_URL)
        // Keep the one-minute polling interval from serving a stale branch file
        // from an intermediate cache while preserving normal CDN caching.
        endpoint.searchParams.set('v', String(Math.floor(Date.now() / NOTIFICATION_POLL_INTERVAL_MS)))
        const response = await fetch(endpoint, { headers: { Accept: 'application/json' } })
        if (response.ok) {
          const payload = await response.json()
          const remoteItems = Array.isArray(payload) ? payload : payload?.items
          const incoming = Array.isArray(remoteItems)
            ? remoteItems.map(normalizeNotification).filter(Boolean).filter(isNotificationActive)
            : []
          const nextCursor = String(payload?.cursor || current.cursor)
          // GitHub exposes a complete snapshot rather than an append-only
          // cursor. Treat the remote file as authoritative so deleted notices
          // disappear locally, while the local read flag survives polling.
          const remoteById = new Map()
          incoming.forEach((item) => remoteById.set(item.id, item))
          const remoteSnapshot = [...remoteById.values()].sort((left, right) => {
            const leftTime = Date.parse(left.created_at)
            const rightTime = Date.parse(right.created_at)
            if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime
            return 0
          })
          const cachedById = new Map(current.items.map((item) => [item.id, item]))
          const nextState = {
            version: 1,
            initialized: true,
            cursor: nextCursor,
            items: remoteSnapshot.map((item) => ({
              ...item,
              read: current.initialized ? Boolean(cachedById.get(item.id)?.read) : true,
            })).slice(0, NOTIFICATION_MAX_ITEMS),
          }
          if (current.initialized) {
            const newItems = remoteSnapshot.filter((item) => !cachedById.has(item.id))
            newItems.forEach((item) => {
              const nextItem = nextState.items.find((candidate) => candidate.id === item.id)
              if (nextItem) nextItem.read = false
            })
          }
          notificationStateRef.current = nextState
          setNotificationState(nextState)
        }
      } catch {
        // Remote notices are optional. Keep the last local snapshot on network errors.
      } finally {
        inFlight = false
        if (!disposed) timer = window.setTimeout(syncNotifications, NOTIFICATION_POLL_INTERVAL_MS)
      }
    }

    void syncNotifications()
    return () => {
      disposed = true
      if (timer) window.clearTimeout(timer)
    }
  }, [preferences.notificationsEnabled])

  useEffect(() => {
    if (!notificationOpen) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setNotificationOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [notificationOpen])

  const notify = useCallback((message) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2400)
  }, [])

  const updatePreference = useCallback((key, value) => {
    setPreferences((current) => ({ ...current, [key]: value }))
  }, [])

  const loadDashboard = useCallback(async (showToast = false) => {
    if (dashboardLoadingRef.current) return
    dashboardLoadingRef.current = true
    try {
      const results = await Promise.allSettled([
        dashboardApi('/api/bots'), dashboardApi('/api/system'), dashboardApi('/api/logs'), dashboardApi('/api/napcat'), dashboardApi('/api/runtime/resources'),
        dashboardApi('/api/plugins'),
      ])
      const [botResult, systemResult, logResult, napcatResult, resourceResult, pluginResult] = results
      const botData = botResult.status === 'fulfilled' ? botResult.value : null
      const systemData = systemResult.status === 'fulfilled' ? systemResult.value : null
      const logData = logResult.status === 'fulfilled' ? logResult.value : null
      const napcatData = napcatResult.status === 'fulfilled' ? napcatResult.value : null
      const resourceData = resourceResult.status === 'fulfilled' ? resourceResult.value : null
      const pluginData = pluginResult.status === 'fulfilled' ? pluginResult.value : null

      if (botData) setBots(botData)
      if (systemData) setSystem(systemData)
      if (logData && !logsPaused) {
        setLogs((current) => logData.length
          ? mergeCurrentSessionLogs(current, orderCurrentSessionLogs(logData))
          : fallbackLogs)
      }
      if (napcatData) setNapcat(napcatData)
      if (resourceData) {
        setResources(resourceData)
        if (!resourceSetupAutoOpenedRef.current && !resourceData.initialized) {
          resourceSetupAutoOpenedRef.current = true
          setResourceSetupOpen(true)
        }
      }
      if (pluginData) {
        const normalizedPlugins = normalizePluginFrameworks(pluginData)
        setPluginFrameworks(normalizedPlugins)
      }

      const reachable = results.slice(0, 5).some((result) => result.status === 'fulfilled')
      setOnline(reachable)
      if (logData && botData) {
        try {
          setStats(await dashboardApi('/api/stats'))
        } catch {
          setStats(deriveStatsFromLogs(logData, botData))
        }
      }
      if (showToast) notify(reachable ? '状态已刷新' : '管理 API 不可用')
    } finally {
      dashboardLoadingRef.current = false
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
    if (!preferences.autoRefresh) return undefined
    const timer = window.setInterval(() => loadDashboard(), DASHBOARD_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [loadDashboard, preferences.autoRefresh])

  useEffect(() => {
    const host = window.location.hostname || '127.0.0.1'
    let socket
    let retryTimer
    let connecting = false
    let disposed = false

    const scheduleReconnect = () => {
      if (disposed || retryTimer) return
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        void connect()
      }, 3000)
    }

    const connect = async () => {
      if (disposed || connecting) return
      connecting = true
      try {
        const { ticket } = await api('/api/ws/ticket', { method: 'POST' })
        if (disposed || !ticket) return
        socket = new WebSocket(`ws://${host}:6700/ws/events?ticket=${encodeURIComponent(ticket)}`)
        socket.onopen = () => setOnline(true)
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
          setOnline(false)
          scheduleReconnect()
        }
        socket.onerror = () => socket.close()
      } catch {
        setOnline(false)
        scheduleReconnect()
      } finally {
        connecting = false
      }
    }

    void connect()
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

  const openWebUi = async (kind, botOverride = selectedBot) => {
    const target = webUiTarget(botOverride, kind)
    if (!target) return
    setWebUiMenuOpen(false)
    let resolvedTarget = target
    if (kind === 'napcat' && botOverride) {
      try {
        const credentials = await api(`/api/bots/${botOverride.id}/napcat/webui`)
        if (credentials.url) resolvedTarget = { ...target, url: credentials.url }
        if (!credentials.available) notify('暂时没有找到 NapCat Token，请先启动一次 NapCat')
      } catch (error) {
        notify(`NapCat 登录信息读取失败：${error.message}`)
      }
    }
    setEmbeddedWebUi({ ...resolvedTarget, kind, botId: botOverride?.id || '' })
  }

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
        body: JSON.stringify({ name: newAccount.name, qq: newAccount.qq, port: Number(newAccount.port), framework: newAccount.framework, napcat_port: newAccount.napcatPort ? Number(newAccount.napcatPort) : null, password: newAccount.password || null }),
      })
      setNewAccount({ name: '', qq: '', port: '', framework: 'nonebot', napcatPort: '', password: '' })
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
    setNewAccount({ name: '', qq: '', port: '', framework: 'nonebot', napcatPort: '', password: '' })
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

  const saveFramework = async (bot, framework) => {
    await api(`/api/bots/${bot.id}/framework`, {
      method: 'PUT',
      body: JSON.stringify({ framework }),
    })
    await loadDashboard()
    notify(`机器人框架已切换为 ${framework === 'astrbot' ? 'AstrBot' : 'NoneBot'}，重启 Bot 后生效`)
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
    const labels = { napcat: 'NapCat', nonebot: 'NoneBot', astrbot: 'AstrBot' }
    const path = selectedPath || window.prompt(`请输入 ${labels[kind] || kind} 目录路径`)
    if (!path) return
    try {
      await api(`/api/runtime/resources/${kind}`, { method: 'PUT', body: JSON.stringify({ path }) })
      await loadDashboard()
      notify(`${labels[kind] || kind} 目录已保存`)
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
      const normalizedPlugins = normalizePluginFrameworks(result)
      setPluginFrameworks(normalizedPlugins)
      notify(`${enabled ? '已启用' : '已停用'}插件「${plugin.name}」，重启 Bot 后生效`)
    } catch (error) {
      notify(`插件设置失败：${error.message}`)
    } finally {
      setBusy('')
    }
  }

  const unreadNotificationCount = preferences.notificationsEnabled
    ? notificationState.items.filter((item) => !item.read && isNotificationActive(item)).length
    : 0
  const openNotificationCenter = () => {
    if (!preferences.notificationsEnabled) {
      notify('通知已关闭，可在设置中重新开启')
      return
    }
    setNotificationOpen(true)
    setNotificationState((current) => {
      const next = { ...current, items: current.items.map((item) => ({ ...item, read: true })) }
      notificationStateRef.current = next
      return next
    })
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
        await new Promise((resolve) => window.setTimeout(resolve, RESOURCE_SETUP_POLL_INTERVAL_MS))
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
      ? ['nonebot', 'astrbot', 'napcat']
      : Array.isArray(selectedKinds) ? selectedKinds : [selectedKinds]
    const requestedKinds = [...new Set(kinds)]
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
        if (result.status === 'succeeded') {
          notify(String(result.message || '').includes('缺少 QQ.exe')
            ? '配置完成，但当前缺少 QQ.exe，安装 QQ 后才能启动 Bot'
            : '一键配置完成，可以启动 Bot 了')
        }
      }
    } catch (error) {
      notify(`一键配置失败：${error.message}`)
    }
  }, [notify, resourceSetup?.status, trackResourceSetup])

  const navigate = useCallback((nextPage) => {
    setActive((currentPage) => {
      if (SECONDARY_PAGE_NAMES.has(nextPage) && nextPage !== currentPage) returnPageRef.current = currentPage
      return nextPage
    })
  }, [])

  const returnToPreviousPage = useCallback(() => {
    setActive(returnPageRef.current || 'QQ 账号')
  }, [])

  const isAccountPage = active === 'QQ 账号'

  return <div className="app-shell">
    <header className="app-topbar">
      <div className="topbar-brand-wrap" ref={webUiMenuRef}><button type="button" className={`topbar-brand ${webUiMenuOpen ? 'open' : ''}`} onClick={() => setWebUiMenuOpen(value => !value)} aria-haspopup="menu" aria-expanded={webUiMenuOpen}><span>QQ 控制台</span><ChevronDown size={14} /></button>{webUiMenuOpen && <div className="webui-switcher" role="menu"><div className="webui-switcher-heading">切换 WebUI{selectedBot && <small>{selectedBot.name}</small>}</div>{selectedBot ? <><WebUiMenuItem icon={Server} label="NapCat WebUI" port={selectedBot.napcat_port || 6099} onClick={() => openWebUi('napcat')} /><WebUiMenuItem icon={Bot} label="AstrBot WebUI" port={astrbotDashboardPort(selectedBot.napcat_port || 6099)} disabled={selectedBot.framework !== 'astrbot'} disabledText="当前账号未使用 AstrBot" onClick={() => openWebUi('astrbot')} /></> : <div className="webui-switcher-empty">请先创建或选择一个 QQ 账号</div>}</div>}</div>
      <div className="topbar-actions"><button className={`topbar-action ${unreadNotificationCount ? 'has-unread' : ''}`} onClick={openNotificationCenter} aria-label={unreadNotificationCount ? `通知，有${unreadNotificationCount}条未读` : '通知'} title={unreadNotificationCount ? `${unreadNotificationCount} 条未读通知` : '通知'}><Bell size={16} />{unreadNotificationCount > 0 && <i className="notification-dot" aria-hidden="true" />}</button><span className={`service-pill ${online ? 'online' : ''}`}><i />{online ? '本机服务正常' : '等待连接'}</span><WindowControls /></div>
    </header>

    <div className={`app-body ${active === '系统设置' ? 'settings-mode' : ''} ${embeddedWebUi ? 'webui-embedded-mode' : ''}`}>
      {embeddedWebUi ? <EmbeddedWebUiPage target={embeddedWebUi} onClose={() => setEmbeddedWebUi(null)} /> : <>
      <aside className="sidebar">
        <nav className="sidebar-nav">
          <NavItem icon={LayoutDashboard} label="概览" active={active} onClick={navigate} favoriteKey="page:概览" favorite={isFavorite('page:概览')} onToggleFavorite={toggleFavorite} />
          <NavItem icon={Puzzle} label="插件管理" active={active} onClick={navigate} favoriteKey="page:插件管理" favorite={isFavorite('page:插件管理')} onToggleFavorite={toggleFavorite} />
          <NavItem icon={UserRound} label="QQ 账号" active={active} onClick={navigate} favoriteKey="page:QQ 账号" favorite={isFavorite('page:QQ 账号')} onToggleFavorite={toggleFavorite} />
          <NavItem icon={Activity} label="运行状态" active={active} onClick={navigate} favoriteKey="page:运行状态" favorite={isFavorite('page:运行状态')} onToggleFavorite={toggleFavorite} />
          <div className="nav-section-label">收藏</div>
          {favoriteBots.length || favoritePages.length ? <>
            {favoriteBots.map((bot) => <NavItem key={bot.id} icon={Bot} label={bot.name} active={active === 'QQ 账号' && selectedBot?.id === bot.id} onClick={() => { navigate('QQ 账号'); setSelectedBotId(bot.id) }} favoriteKey={`bot:${bot.id}`} favorite onToggleFavorite={toggleFavorite} />)}
            {favoritePages.map(({ key, label, icon: Icon }) => <NavItem key={key} icon={Icon} label={label} active={active} onClick={navigate} favoriteKey={key} favorite onToggleFavorite={toggleFavorite} />)}
          </> : <div className="nav-empty">点击菜单右侧的星标添加快捷入口</div>}
          <div className="nav-section-label">服务</div>
          <NavItem icon={Server} label="NapCat" active={active} onClick={navigate} favoriteKey="page:NapCat" favorite={isFavorite('page:NapCat')} onToggleFavorite={toggleFavorite} />
          <NavItem icon={SquareTerminal} label="NoneBot" active={active} onClick={navigate} favoriteKey="page:NoneBot" favorite={isFavorite('page:NoneBot')} onToggleFavorite={toggleFavorite} />
          <NavItem icon={Bot} label="AstrBot" active={active} onClick={navigate} favoriteKey="page:AstrBot" favorite={isFavorite('page:AstrBot')} onToggleFavorite={toggleFavorite} />
        </nav>
        <div className="sidebar-bottom">
          <button className="bottom-item" onClick={() => navigate('系统设置')}><Settings size={16} />设置</button>
          <button className="bottom-item" onClick={() => notify('桌面控制台正在运行')}><CircleHelp size={16} />帮助</button>
        </div>
      </aside>

      <main className={`main-content ${active === '运行状态' ? 'runtime-mode' : ''}`}>
        {active === '系统设置' ? <SettingsPage theme={theme} themePackage={themePackage} font={font} preferences={preferences} online={online} onThemeChange={setTheme} onThemePackageChange={setThemePackage} onFontChange={setFont} onPreferenceChange={updatePreference} onBack={returnToPreviousPage} onNavigate={navigate} onRefresh={refresh} onNotice={notify} /> : active === '概览' ? <OverviewPage bots={bots} stats={stats} napcat={napcat} online={online} logs={logs} refreshing={refreshing} refresh={refresh} onNavigate={navigate} onSelectBot={(botId) => { setSelectedBotId(botId); navigate('QQ 账号') }} /> : active === '运行状态' ? <RuntimeStatusPage bots={bots} system={system} stats={stats} napcat={napcat} online={online} refreshing={refreshing} refresh={refresh} busy={busy} action={action} onSelectBot={(botId) => { setSelectedBotId(botId); navigate('QQ 账号') }} /> : active === '插件管理' ? <PluginPage frameworks={pluginFrameworks} refreshing={refreshing} onRefresh={refresh} busy={busy} onToggle={togglePlugin} /> : ['NapCat', 'NoneBot', 'AstrBot'].includes(active) ? <ResourcePage key={active} kind={active === 'NapCat' ? 'napcat' : active === 'NoneBot' ? 'nonebot' : 'astrbot'} resource={resources?.[active === 'NapCat' ? 'napcat' : active === 'NoneBot' ? 'nonebot' : 'astrbot']} officialUrl={OFFICIAL_RESOURCE_URLS[active === 'NapCat' ? 'napcat' : active === 'NoneBot' ? 'nonebot' : 'astrbot']} setup={resourceSetup} onOpenSetup={() => setResourceSetupOpen(true)} onSelect={selectResource} onRefresh={() => loadDashboard(true)} onBack={returnToPreviousPage} /> : isAccountPage ? <AccountWorkspace bots={bots} selectedBot={selectedBot} selectedBotId={selectedBotId} setSelectedBotId={setSelectedBotId} napcat={napcat} online={online} refreshing={refreshing} refresh={refresh} busy={busy} action={action} onSelectBot={(botId) => { setSelectedBotId(botId); navigate('QQ 账号') }} onCreate={() => setCreateOpen(true)} onDelete={() => setDeleteTarget(selectedBot)} logs={logs} logsPaused={logsPaused} onTogglePause={() => { setLogsPaused(value => !value); notify(logsPaused ? '日志同步已恢复' : '日志同步已暂停') }} onClear={clearLogs} onCommand={sendCommand} onSavePassword={savePassword} onSavePort={savePort} onSaveNapcatPort={saveNapcatPort} onSaveFramework={saveFramework} onOpenWebUi={openWebUi} onNotice={notify} /> : <PlaceholderPage active={active} onBack={() => navigate('QQ 账号')} />}
      </main>
      </>}
    </div>

    {notificationOpen && <NotificationCenterModal items={notificationState.items.filter(isNotificationActive)} onClose={() => setNotificationOpen(false)} />}
    {createOpen && <CreateAccountModal account={newAccount} creating={creating} onChange={setNewAccount} onClose={closeCreateModal} onSubmit={createAccount} />}
    {deleteTarget && <DeleteAccountModal bot={deleteTarget} deleting={deleting} onClose={() => !deleting && setDeleteTarget(null)} onConfirm={deleteAccount} />}
    {resources && resourceSetupOpen && <ResourceSetupModal key={resourceSetup?.id || 'new'} resources={resources} setup={resourceSetup} onSetup={startResourceSetup} onSelect={selectResource} onRefresh={() => loadDashboard(true)} onClose={() => setResourceSetupOpen(false)} />}
    {toast && <div className="toast"><span className="live-dot" />{toast}</div>}
  </div>
}

function WebUiMenuItem({ icon: Icon, label, port, disabled = false, disabledText = '', onClick }) {
  return <button type="button" className="webui-switcher-item" role="menuitem" disabled={disabled} onClick={onClick}><span className="webui-switcher-icon"><Icon size={15} /></span><span><strong>{label}</strong><small>{disabled ? disabledText : `本机端口 ${port}`}</small></span><ExternalLink size={13} /></button>
}

function OverviewPage({ bots, stats, napcat, online, logs, refreshing, refresh, onNavigate, onSelectBot }) {
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

function NotificationCenterModal({ items, onClose }) {
  return <div className="modal-backdrop notification-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="notification-modal" role="dialog" aria-modal="true" aria-labelledby="notification-center-title"><div className="modal-header notification-modal-header"><div><div className="eyebrow">{NOTIFICATION_SOURCE}</div><h2 id="notification-center-title">通知中心</h2><p>来自远程通知服务的系统消息</p></div><button type="button" className="modal-close" onClick={onClose} aria-label="关闭通知中心"><X size={18} /></button></div>{items.length ? <div className="notification-list">{items.map((item) => <article className={`notification-item ${item.level}`} key={item.id}><div className="notification-item-heading"><span className="notification-level-dot" /><strong>{item.title}</strong><time>{formatNotificationTime(item.created_at)}</time></div><p>{item.body}</p>{item.link && <a href={item.link} onClick={(event) => { event.preventDefault(); openExternal(item.link) }}><ExternalLink size={13} />打开相关链接</a>}<small className="notification-source">{NOTIFICATION_SOURCE}</small></article>)}</div> : <div className="notification-empty"><Bell size={20} /><strong>暂无通知</strong><span>新的系统消息会显示在这里</span></div>}</section></div>
}

function EmbeddedWebUiPage({ target, onClose }) {
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

function WindowControls() {
  if (!window.desktopInfo?.isDesktop) return null
  return <div className="window-controls"><button onClick={() => window.windowControls?.minimize()} aria-label="最小化" title="最小化"><Minimize2 size={14} /></button><button onClick={() => window.windowControls?.toggleMaximize()} aria-label="最大化" title="最大化"><Maximize2 size={14} /></button><button className="window-close" onClick={() => window.windowControls?.close()} aria-label="关闭" title="关闭"><X size={15} /></button></div>
}

function useAuthenticatedMedia(path, enabled) {
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

function NavItem({ icon: Icon, label, active, onClick, favoriteKey, favorite, onToggleFavorite }) {
  const selected = typeof active === 'boolean' ? active : active === label
  return <div className={`nav-item-wrap ${selected ? 'active-wrap' : ''}`}><button className={`nav-item ${selected ? 'active' : ''}`} onClick={() => onClick(label)}><Icon size={16} /><span>{label}</span></button>{favoriteKey && <button type="button" className={`favorite-toggle ${favorite ? 'active' : ''}`} onClick={(event) => { event.stopPropagation(); onToggleFavorite(favoriteKey) }} aria-label={favorite ? `取消收藏${label}` : `收藏${label}`} title={favorite ? '取消收藏' : '添加到收藏'}><Star size={13} fill={favorite ? 'currentColor' : 'none'} /></button>}</div>
}

function PluginPage({ frameworks = EMPTY_PLUGIN_FRAMEWORKS, refreshing, onRefresh, busy, onToggle }) {
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

function AccountWorkspace({ bots, selectedBot, selectedBotId, setSelectedBotId, napcat, online, refreshing, refresh, busy, action, onCreate, onDelete, logs, logsPaused, onTogglePause, onClear, onCommand, onSavePassword, onSavePort, onSaveNapcatPort, onSaveFramework, onOpenWebUi, onNotice }) {
  const [command, setCommand] = useState('')
  const [detailView, setDetailView] = useState('overview')
  const [visibleQrKey, setVisibleQrKey] = useState('')
  const autoOpenedQrKey = useRef('')
  const feedRef = useRef(null)
  const followLogsRef = useRef(true)
  const running = isBotRunning(selectedBot)
  const transitioning = isBotTransitioning(selectedBot)
  const botLogs = useMemo(() => selectedBot ? logs.filter((log) => log.source === selectedBot.name) : [], [logs, selectedBot?.name])
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
          <div className="account-summary"><div className="summary-row"><span>状态</span><StatusPill label={botStatusLabel(selectedBot)} state={botStatusState(selectedBot)} /></div><div className="summary-row"><span>持续运行</span><BotUptime bot={selectedBot} /></div><div className="summary-row"><span>QQ 号</span><b className="summary-value mono">{selectedBot.qq}</b></div><div className="summary-row"><span>协议端</span><StatusPill label="NapCat" state={!napcat.available ? 'red' : selectedBot.runtime?.napcat?.running ? 'green' : 'muted'} /></div><div className="summary-row"><span>机器人框架</span><StatusPill label={selectedBot.framework_label || (selectedBot.framework === 'astrbot' ? 'AstrBot' : 'NoneBot')} state={selectedBot.runtime?.framework?.running ? 'green' : 'muted'} /></div><div className="summary-row"><span>OneBot 端口</span><b className="summary-value mono">{selectedBot.port || '—'}</b></div><div className="summary-row"><span>NapCat WebUI</span><b className="summary-value mono">{selectedBot.napcat_port || '—'}</b></div></div>
          <div className="conversation"><div className="conversation-header"><div><h3>实时活动</h3><span>{logsPaused ? '日志同步已暂停' : '来自本机服务的最新状态'}</span></div><div className="conversation-tools"><button className="plain-icon" onClick={onTogglePause} aria-label={logsPaused ? '恢复日志' : '暂停日志'} title={logsPaused ? '恢复日志更新' : '暂停日志更新'}>{logsPaused ? <Play size={15} /> : <Pause size={15} />}</button><button className="plain-icon" onClick={onClear} aria-label="清空日志" title="清空日志"><Trash2 size={15} /></button></div></div>{verification && <LoginVerificationCard verification={verification} onRetry={async () => { try { await onCommand(selectedBot, `-q ${selectedBot.qq}`, botLogs); onNotice('已重新尝试登录，请等待二维码或登录结果') } catch (error) { onNotice(`重新登录失败：${error.message}`) } }} onNotice={onNotice} />}<div className="activity-feed" ref={feedRef} onScroll={() => { const feed = feedRef.current; if (feed) followLogsRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24 }}>{visibleLogs.length ? visibleLogs.map((log, index) => { const qrKey = `${log.time}-${log.source}-${index}`; return <LogItem key={qrKey} log={log} qrVisible={visibleQrKey === qrKey} onToggleQr={() => setVisibleQrKey(visibleQrKey === qrKey ? '' : qrKey)} /> }) : <div className="activity-empty">暂无日志</div>}</div><div className="command-box"><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="输入 -q 2 快速登录…" onKeyDown={(event) => { if (event.key === 'Enter') submitCommand() }} /><button onClick={submitCommand} aria-label="发送"><Play size={14} /></button></div></div>
           </> : <AccountConfig key={`${selectedBot.id}-${selectedBot.port}-${selectedBot.napcat_port}-${selectedBot.framework}`} bot={selectedBot} onSavePassword={onSavePassword} onSavePort={onSavePort} onSaveNapcatPort={onSaveNapcatPort} onSaveFramework={onSaveFramework} onOpenWebUi={onOpenWebUi} onNotice={onNotice} />}
        </div>
      </> : <EmptyDetail onCreate={onCreate} />}
    </div>
  </section>
}

function WebUiCredentials({ bot, onOpenWebUi, onNotice }) {
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
      await navigator.clipboard.writeText(value)
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
      onNotice('AstrBot WebUI 密码已重置，重启 Bot 后生效')
    } catch (error) {
      onNotice(`密码重置失败：${error.message}`)
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
      {napcatToken && <div className="credential-secret"><input readOnly value={napcatToken} aria-label="NapCat Token" /><button type="button" className="plain-icon" onClick={() => copy(napcatToken, 'NapCat Token')} aria-label="复制 NapCat Token" title="复制 NapCat Token"><Copy size={15} /></button></div>}
      {astrbot && <div className="credential-row"><div><strong>AstrBot WebUI</strong><small>用户名：<span className="mono">{astrbot.username}</span>{astrbot.password_change_required ? ' · 当前密码需要修改' : ''}</small></div><div className="credential-actions"><button type="button" className="secondary" onClick={() => onOpenWebUi('astrbot', bot)}>打开 WebUI</button><button type="button" className="secondary" disabled={busy === 'astrbot'} onClick={resetAstrbotPassword}>{busy === 'astrbot' ? '重置中…' : '重置密码'}</button></div></div>}
      {resetCredentials && <div className="credential-secret generated-credential"><div><span>新用户名</span><b className="mono">{resetCredentials.username}</b></div><div className="generated-password"><span>新密码</span><input readOnly value={resetCredentials.password} aria-label="AstrBot 新密码" /><button type="button" className="plain-icon" onClick={() => copy(resetCredentials.password, 'AstrBot 新密码')} aria-label="复制 AstrBot 新密码" title="复制 AstrBot 新密码"><Copy size={15} /></button></div><small>密码只在本次页面中显示，不会写入日志；请立即保存。重启 Bot 后登录。</small></div>}
      <small className="credential-note">管理控制台不会读取或恢复旧密码；找不到 NapCat Token 时，启动一次 NapCat 后再重试。</small>
    </section>
  </>
}

const frameworkOptions = [
  { value: 'nonebot', label: 'NoneBot', description: 'Python 机器人框架', icon: SquareTerminal },
  { value: 'astrbot', label: 'AstrBot', description: 'Agent 与插件框架', icon: Bot },
]

function FrameworkSelect({ value, onChange, disabled = false }) {
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

function AccountConfig({ bot, onSavePassword, onSavePort, onSaveNapcatPort, onSaveFramework, onOpenWebUi, onNotice }) {
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

function AccountListItem({ bot, selected, onClick }) {
  const running = isBotRunning(bot)
  const transitioning = isBotTransitioning(bot)
  const framework = bot.framework_label || (bot.framework === 'astrbot' ? 'AstrBot' : 'NoneBot')
  return <button className={`account-list-item ${selected ? 'selected' : ''}`} onClick={onClick}><BotAvatar bot={bot} className="list-avatar" /><div className="list-item-copy"><strong>{bot.name}</strong><span>{bot.qq} · {framework}</span><BotUptime bot={bot} /></div><div className={`list-status ${running ? 'green' : transitioning ? 'blue' : ''}`}><i />{botStatusLabel(bot)}</div></button>
}

function BotUptime({ bot, className = '' }) {
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

function BotAvatar({ bot, className = '' }) {
  const qq = String(bot?.qq || '').trim()
  const avatarUrl = qq ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qq)}&s=640` : ''
  const [failedUrl, setFailedUrl] = useState('')
  const failed = failedUrl === avatarUrl

  return <div className={`bot-avatar ${className}`} title={`${bot?.name || 'Bot'} 头像`} aria-label={`${bot?.name || 'Bot'} 头像`}>
    {avatarUrl && !failed ? <img className="bot-avatar-image" src={avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(avatarUrl)} /> : <Bot size={15} />}
  </div>
}

function EmptyDetail({ onCreate }) {
  return <div className="empty-detail"><div className="empty-detail-icon"><Bot size={23} /></div><h2>还没有 QQ 账号</h2><p>添加你的真实 QQ 账号，开始管理 NapCat 和机器人框架。</p><button className="action-button" onClick={onCreate}><Plus size={15} />新建账号</button></div>
}

function StatusPill({ label, state }) {
  return <span className={`status-pill ${state}`}><i />{label}</span>
}

function LoginVerificationCard({ verification, onRetry, onNotice }) {
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

function renderLogText(message, prefix = '') {
  const parts = String(message || '').split(/(https?:\/\/[^\s<>"']+)/gi)
  return parts.map((part, index) => /^https?:\/\//i.test(part)
    ? <a key={`${prefix}-${part}-${index}`} className="log-link" href={part} onClick={(event) => { event.preventDefault(); openExternal(part) }} title="打开链接">{part}</a>
    : <React.Fragment key={`${prefix}-${index}`}>{part}</React.Fragment>)
}

function ImageMessage({ image }) {
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

function renderLogMessage(message) {
  return parseLogSegments(message).map((segment, index) => segment.type === 'image'
    ? <ImageMessage key={`image-${index}`} image={segment.value} />
    : <React.Fragment key={`text-${index}`}>{renderLogText(segment.value, `text-${index}`)}</React.Fragment>)
}

function LogItem({ log, qrVisible, onToggleQr }) {
  const level = normalizeLogLevel(log.level, log.message)
  const multiline = String(log.message || '').includes('\n')
  return <div className={`log-item ${log.kind === 'qr' ? 'qr-log-item' : ''}`}><div className={`log-dot ${level}`} /><div className="log-copy">{log.kind === 'qr' ? <><div className="log-meta"><time>{log.time}</time><strong>[{log.source}]</strong></div>{qrVisible ? <div className="qr-card"><AuthenticatedQr time={log.time} /><span>使用手机 QQ 扫描此二维码登录</span><button type="button" className="qr-reveal" onClick={onToggleQr}>隐藏二维码</button></div> : <button type="button" className="qr-reveal" onClick={onToggleQr}>登录二维码已就绪 · 点击显示</button>}</> : <div className="log-line"><time>{log.time}</time><strong>[{log.source}]</strong><span className={`log-level-${level}${multiline ? ' log-multiline' : ''}`}>{renderLogMessage(log.message)}</span></div>}</div></div>
}

function AuthenticatedQr({ time }) {
  const media = useAuthenticatedMedia(`/api/napcat/qrcode?time=${encodeURIComponent(time)}`, true)
  if (media.error) return <span className="image-message-error">二维码加载失败</span>
  return media.url ? <img src={media.url} alt="NapCat 登录二维码" /> : <span className="image-message-error">二维码加载中…</span>
}

function ResourcePage({ kind, resource, setup, onOpenSetup, onSelect, onRefresh, onBack, officialUrl }) {
  const isNapCat = kind === 'napcat'
  const labels = { nonebot: 'NoneBot', astrbot: 'AstrBot', napcat: 'NapCat' }
  const descriptions = { nonebot: 'NoneBot2 机器人运行环境与插件项目', astrbot: 'AstrBot Agent 机器人运行环境与插件项目', napcat: 'QQ 协议端与 WebUI 运行资源' }
  const title = labels[kind] || kind
  const description = descriptions[kind] || '机器人运行资源'
  const unavailable = !resource
  const valid = Boolean(resource?.valid)
  const missing = resource?.missing
  const installerReady = Boolean(resource?.installer_exists)
  const statusTitle = unavailable ? '等待管理 API' : valid ? `${title} 已就绪` : installerReady && isNapCat ? '等待 NapCatInstaller' : missing === 'qq' ? '缺少 QQ 主程序' : `尚未配置 ${title}`
  const statusDescription = unavailable ? '暂时无法读取本机资源状态，请检查管理服务连接。' : valid ? '控制台可以使用该资源启动 Bot。' : installerReady && isNapCat ? '已找到 NapCatInstaller.exe，一键配置会先执行 OneKey；QQ 下载失败时会切换官方 Shell 版。' : missing === 'qq' ? '已找到 NapCat 启动器，但暂未检测到 QQ.exe。官方 Shell 版会使用本机已安装的 QQ，请先安装 QQ 或选择完整目录。' : `请选择本机已有的 ${title} 目录，或打开官方页面下载。`
  const pathLabel = unavailable ? '等待管理 API' : resource.path || '尚未选择目录'
  const pathState = unavailable ? '状态未知' : valid ? '路径有效' : installerReady ? '等待安装器部署' : missing === 'qq' ? '缺少 QQ.exe' : '路径无效或不存在'
  return <section className="resource-page"><div className="resource-page-header"><div><button className="resource-back" onClick={onBack}><RotateCcw size={14} />返回上一页</button><div className="eyebrow">运行资源</div><h1>{title}</h1><p>{description}</p></div><div className="resource-page-actions"><button className="action-button" onClick={onOpenSetup} disabled={unavailable}><Download size={15} />{setup?.status === 'running' ? '查看配置进度' : '一键配置'}</button><button className="plain-icon" onClick={onRefresh} aria-label="刷新资源状态"><RefreshCw size={16} /></button></div></div><div className={`resource-status-card ${valid ? 'ready' : unavailable ? 'unavailable' : 'missing'}`}><div className="resource-status-icon">{valid ? <Check size={22} /> : <FolderOpen size={22} />}</div><div><strong>{statusTitle}</strong><span>{statusDescription}</span></div><span className="resource-status-pill">{unavailable ? '状态未知' : valid ? '已就绪' : '待设置'}</span></div><section className="resource-card"><div className="resource-card-heading"><div><h2>资源目录</h2><p>控制台会从此目录读取并启动 {title}。</p></div><span className="resource-path-state">{pathState}</span></div><div className="resource-path"><FolderOpen size={16} /><span title={pathLabel}>{pathLabel}</span></div><div className="resource-actions"><button className="secondary" onClick={() => onSelect(kind)} disabled={unavailable}><FolderOpen size={15} />选择本地目录</button><button className="secondary" onClick={() => officialUrl && openExternal(officialUrl)}><Download size={15} />打开官方获取页<ExternalLink size={13} /></button></div></section><section className="resource-help"><strong>首次使用建议</strong><p>{isNapCat ? 'NapCat 会连接已选择的机器人框架；OneBot 反向 WS 地址会根据框架自动配置。' : '一键配置会安装并校验该机器人框架。选择 AstrBot 时，每个 QQ 账号会使用独立的数据和配置目录。'}</p></section></section>
}

function ResourceSetupModal({ resources, setup, onSetup, onSelect, onRefresh, onClose }) {
  const items = [
    { kind: 'nonebot', label: 'NoneBot', resource: resources.nonebot, file: 'bot.py + pyproject.toml', description: '可选机器人框架，负责运行机器人和插件。' },
    { kind: 'astrbot', label: 'AstrBot', resource: resources.astrbot, file: 'main.py + pyproject.toml', description: '可选机器人框架，使用官方源码和 OneBot 反向 WS。' },
    { kind: 'napcat', label: 'NapCat', resource: resources.napcat, file: 'NapCatWinBootMain.exe', description: '可选协议端，优先执行官方 OneKey；失败时切换 Shell 并使用本机 QQ。' },
  ]
  const [selectedKinds, setSelectedKinds] = useState(() => {
    if (Array.isArray(setup?.kinds) && setup.kinds.length) return setup.kinds.filter((kind) => items.some((item) => item.kind === kind))
    return ['nonebot', 'napcat']
  })
  const setupRunning = setup?.status === 'running'
  const [logDownloading, setLogDownloading] = useState(false)
  const downloadInstallerLog = async () => {
    if (!setup?.installer_log_url || logDownloading) return
    setLogDownloading(true)
    try {
      await downloadAuthenticatedFile(setup.installer_log_url, 'napcat-installer.log')
    } catch (error) {
      window.alert(error.message || '安装器日志下载失败')
    } finally {
      setLogDownloading(false)
    }
  }
  const toggleKind = (kind) => {
    if (setupRunning) return
    setSelectedKinds((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind])
  }

  const taskMap = new Map((Array.isArray(setup?.tasks) ? setup.tasks : []).map((task) => [task.kind, task]))
  const workflowTasks = Array.isArray(setup?.tasks) && setup.tasks.length
    ? setup.tasks
    : items.filter((item) => selectedKinds.includes(item.kind)).map((item) => ({ kind: item.kind, label: item.label, status: 'queued', progress: 0, message: '等待执行' }))
  const statusLabels = { queued: '等待执行', running: '执行中', succeeded: '已完成', failed: '失败' }
  const stepStatusLabels = { queued: '等待', running: '执行中', succeeded: '完成', failed: '失败' }
  const setupStarted = Boolean(setup?.status && setup.status !== 'idle')
  const currentTask = items.find((item) => item.kind === setup?.current_task)?.label || taskMap.get(setup?.current_task)?.label
  const workflowTitle = setup?.status === 'succeeded' ? '配置流程已完成' : setup?.status === 'failed' ? '配置流程未完成' : '正在执行配置流程'

  return <div className="modal-backdrop resource-setup-backdrop"><section className="resource-setup-modal" role="dialog" aria-modal="true" aria-labelledby="resource-setup-title"><div className="modal-header"><div><div className="eyebrow">首次启动设置</div><h2 id="resource-setup-title">准备运行资源</h2><p>按官方流程完成下载、安装、环境配置、协议配置和校验。</p></div><div className="resource-setup-header-actions"><button className="action-button" onClick={() => onSetup(selectedKinds)} disabled={setupRunning || !selectedKinds.length}><Download size={15} />{setupRunning ? '配置中…' : setupStarted ? '重新配置' : '一键配置'}</button><button className="plain-icon resource-setup-refresh" onClick={onRefresh} aria-label="刷新资源状态" title="刷新资源状态"><RefreshCw size={18} /></button><button className="plain-icon resource-setup-close" onClick={onClose} aria-label="收起弹窗" title="收起"><X size={17} /></button></div></div><div className="resource-setup-list">{items.map(({ kind, label, resource, file, required, unavailable, description }) => { const selected = selectedKinds.includes(kind); return <div className={`resource-setup-item setup-option ${selected ? 'selected' : ''} ${unavailable ? 'unavailable' : ''}`} key={kind}><label className="resource-setup-choice"><input type="checkbox" checked={selected} disabled={required || unavailable || setupRunning} onChange={() => toggleKind(kind)} /><span className="resource-setup-check" aria-hidden="true">{selected && <Check size={13} />}</span></label><div className={`resource-setup-icon ${resource?.valid ? 'ready' : ''}`}><FolderOpen size={18} /></div><div className="resource-setup-copy"><strong>{label}<em>{required ? '默认' : unavailable ? '暂未接入' : '可选'}</em></strong><span>{resource?.valid ? '已检测到有效目录，执行时会跳过下载并重新校验配置' : resource?.installer_exists ? '已找到 NapCatInstaller.exe，配置会先下载并部署内置 QQ' : resource?.missing === 'qq' ? '已找到启动器，但缺少 QQ.exe，配置会重新执行官方安装器' : unavailable ? description : `${description} 需要包含 ${file}`}</span><small>{resource?.path || (unavailable ? '暂不参与本次配置' : '尚未配置')}</small></div>{!unavailable && <div className="resource-setup-actions"><button className="secondary" onClick={() => onSelect(kind)} disabled={setupRunning}>选择目录</button></div>}</div> })}</div>{setupStarted && <div className={`resource-setup-progress workflow-panel ${setup.status}`}><div className="resource-setup-progress-heading"><strong>{workflowTitle}</strong><span>{Math.round(setup.progress || 0)}%</span></div>{setup.status === 'running' && <p className="resource-current-task">当前任务：{currentTask || setup.step || '准备中'}</p>}<div className="resource-progress-track"><i style={{ width: `${Math.max(0, Math.min(100, setup.progress || 0))}%` }} /></div><div className="resource-task-list">{workflowTasks.map((task) => <div className={`resource-task-item ${task.status}`} key={task.kind}><div className="resource-task-status" aria-hidden="true">{task.status === 'succeeded' ? <Check size={14} /> : task.status === 'failed' ? <X size={14} /> : task.status === 'running' ? <RefreshCw size={14} /> : <MoreHorizontal size={14} />}</div><div className="resource-task-copy"><strong>{task.label}</strong><span>{task.message || statusLabels[task.status] || '等待执行'}</span>{Array.isArray(task.steps) && <div className="resource-task-steps">{task.steps.map((step) => <span className={step.status} key={step.id}><i />{step.label}<small>{stepStatusLabels[step.status] || step.status}</small></span>)}</div>}</div><span className="resource-task-state">{statusLabels[task.status] || task.status} · {Math.round(task.progress || 0)}%</span></div>)}</div>{setup.message && setup.status !== 'running' && <p className="resource-setup-summary">{setup.message}</p>}{setup.error && <div className="resource-setup-error"><p>{setup.error}</p>{setup.installer_log_url && <button className="resource-log-download" onClick={downloadInstallerLog} disabled={logDownloading}><FileText size={13} />{logDownloading ? '日志下载中…' : '下载安装器日志'}</button>}</div>}</div>}<div className="resource-setup-note">NoneBot、AstrBot 和 NapCat 可分别选择；AstrBot 会为每个账号生成独立的 data/cmd_config.json，NapCat 会按框架写入反向 WS 地址。安装器输出会保存为 napcat-installer.log。</div></section></div>
}

function SettingsPage({ theme, themePackage, font, preferences, online, onThemeChange, onThemePackageChange, onFontChange, onPreferenceChange, onBack, onNavigate, onRefresh, onNotice }) {
  const [section, setSection] = useState('外观')
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const filteredSections = query
    ? SETTINGS_SECTIONS.map((group) => ({ ...group, items: group.items.filter((item) => item.label.toLowerCase().includes(query)) })).filter((group) => group.items.length)
    : SETTINGS_SECTIONS

  const chooseSection = (label) => setSection(label)
  const renderContent = () => {
    if (section === '外观') return <AppearanceSettings theme={theme} font={font} preferences={preferences} onThemeChange={onThemeChange} onFontChange={onFontChange} onPreferenceChange={onPreferenceChange} onNotice={onNotice} />
    if (section === '常规') return <GeneralSettings preferences={preferences} onPreferenceChange={onPreferenceChange} onNotice={onNotice} />
    if (section === '个人资料') return <ProfileSettings profileName={preferences.profileName} onProfileNameChange={(value) => onPreferenceChange('profileName', value)} onNotice={onNotice} />
    if (section === '快捷键') return <ShortcutSettings onNotice={onNotice} />
    if (section === '通知') return <NotificationSettings preferences={preferences} onPreferenceChange={onPreferenceChange} onNotice={onNotice} />
    if (section === '主题插件包') return <ThemePackageSettings themePackage={themePackage} onThemePackageChange={onThemePackageChange} onNotice={onNotice} />
    return <ServiceSettings online={online} onNavigate={onNavigate} onRefresh={onRefresh} />
  }

  return <section className="settings-shell"><aside className="settings-sidebar"><button className="settings-back" onClick={onBack}><ArrowLeft size={15} />返回上一页</button><div className="settings-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索设置…" aria-label="搜索设置" /></div><div className="settings-nav-list">{filteredSections.length ? filteredSections.map((group) => <div className="settings-group" key={group.title}><div className="settings-group-title">{group.title}</div>{group.items.map(({ label, icon: Icon }) => <button key={label} className={`settings-nav-item ${section === label ? 'active' : ''}`} onClick={() => chooseSection(label)}><Icon size={15} /><span>{label}</span></button>)}</div>) : <div className="settings-search-empty">没有匹配的设置</div>}</div></aside><main className="settings-main">{renderContent()}</main></section>
}

function SettingsRow({ title, description, action }) {
  return <div className="settings-row"><div className="settings-row-copy"><strong>{title}</strong><span>{description}</span></div>{action}</div>
}

function SettingsToggle({ checked, onChange, label }) {
  return <button type="button" className={`settings-toggle ${checked ? 'checked' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>
}

function SettingsPanel({ title, description, children }) {
  return <section className="settings-panel"><div className="settings-panel-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div></div>{children}</section>
}

function FontSelect({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const selected = FONT_OPTIONS.find((option) => option.value === value) || FONT_OPTIONS[0]

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

  return <div className={`settings-font-select ${open ? 'open' : ''}`} ref={rootRef}><button type="button" className="settings-font-select-trigger" onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open} aria-label="界面字体选择"><span className="settings-font-select-copy"><strong>{selected.label}</strong><small>{selected.description}</small></span><ChevronDown size={15} className="settings-font-select-chevron" /></button>{open && <div className="settings-font-select-menu" role="listbox" aria-label="界面字体选项">{FONT_OPTIONS.map((option) => { const isSelected = option.value === selected.value; return <button type="button" className={`settings-font-select-option ${isSelected ? 'selected' : ''}`} role="option" aria-selected={isSelected} key={option.value} onClick={() => choose(option.value)}><span><strong>{option.label}</strong><small>{option.description}</small></span>{isSelected && <Check size={14} />}</button> })}</div>}</div>
}

function AppearanceSettings({ theme, font, preferences, onThemeChange, onFontChange, onPreferenceChange, onNotice }) {
  const themeOptions = [
    { value: 'system', label: '系统', icon: Monitor },
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
  ]
  const currentTheme = themeOptions.find((option) => option.value === theme) || themeOptions[0]
  const currentFont = FONT_OPTIONS.find((option) => option.value === font) || FONT_OPTIONS[0]
  const resetAppearance = () => {
    onThemeChange('system')
    onFontChange('system')
    onPreferenceChange('density', 'comfortable')
    onPreferenceChange('reduceMotion', false)
    onNotice('外观设置已恢复默认')
  }

  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">系统设置</div><h1>外观</h1><p>主题、字体和布局偏好会立即应用，并保存到本机。</p></div><section className="settings-section"><h2>主题</h2><div className="theme-options">{themeOptions.map(({ value, label, icon: Icon }) => <button type="button" key={value} className={`theme-option ${theme === value ? 'selected' : ''}`} onClick={() => onThemeChange(value)}><div className={`theme-preview theme-preview-${value}`}><div className="theme-preview-top" /><div className="theme-preview-body"><div /><div /><div /></div><Icon size={15} /></div><span>{label}</span>{theme === value && <Check className="theme-option-check" size={14} />}</button>)}</div></section><SettingsPanel title="界面字体" description="选择控制台使用的字体，中文和数字会同步更新。"><SettingsRow title="字体" description={currentFont.description} action={<FontSelect value={font} onChange={onFontChange} />} /></SettingsPanel><SettingsPanel title="显示偏好" description="调整信息密度和交互动画。"><SettingsRow title="布局密度" description="紧凑布局可以在同一屏显示更多内容。" action={<div className="settings-segmented"><button type="button" className={preferences.density === 'comfortable' ? 'selected' : ''} onClick={() => onPreferenceChange('density', 'comfortable')}>舒适</button><button type="button" className={preferences.density === 'compact' ? 'selected' : ''} onClick={() => onPreferenceChange('density', 'compact')}>紧凑</button></div>} /><SettingsRow title="减少动效" description="关闭按钮和面板的过渡动画。" action={<SettingsToggle checked={preferences.reduceMotion} onChange={(value) => onPreferenceChange('reduceMotion', value)} label="减少动效" />} /></SettingsPanel><div className="settings-actions"><span><strong>{currentTheme.label} · {currentFont.label}</strong><small>当前外观配置</small></span><button type="button" className="secondary" onClick={resetAppearance}>恢复默认</button></div></div>
}

function ThemePackageSettings({ themePackage, onThemePackageChange, onNotice }) {
  const currentPackage = getThemePackage(themePackage)
  const choosePackage = (id) => {
    const nextPackage = getThemePackage(id)
    onThemePackageChange(nextPackage.id)
    onNotice(`${nextPackage.label}已启用`)
  }
  const resetPackage = () => choosePackage(DEFAULT_THEME_PACKAGE.id)

  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">外观扩展</div><h1>主题插件包</h1><p>安装并切换控制台的配色插件包，选择后会立即应用并保存到本机。</p></div><SettingsPanel title="已安装主题包" description="主题插件包只改变颜色和强调色，不会影响账号或服务配置。"><div className="theme-package-grid">{THEME_PACKAGES.map((item) => { const selected = item.id === currentPackage.id; return <button type="button" className={`theme-package-card ${selected ? 'selected' : ''}`} key={item.id} onClick={() => choosePackage(item.id)} aria-pressed={selected}><div className={`theme-package-preview theme-package-preview-${item.id}`}><div className="theme-package-preview-top"><i /><i /><i /></div><div className="theme-package-preview-body"><div className="theme-package-preview-nav" /><div className="theme-package-preview-content"><i /><i /><i /></div></div></div><div className="theme-package-card-copy"><span><strong>{item.label}</strong><small>{item.description}</small></span>{selected && <span className="theme-package-check" aria-label="当前已启用"><Check size={13} /></span>}</div><div className="theme-package-card-meta"><span>{item.version}</span><strong>{selected ? '已启用' : '启用'}</strong></div></button> })}</div></SettingsPanel><div className="settings-note"><Paintbrush size={18} /><span>蓝色主题插件包使用海洋蓝强调色，并兼容系统、浅色和深色模式。</span></div><div className="settings-actions"><span><strong>{currentPackage.label}</strong><small>当前主题插件包</small></span><button type="button" className="secondary" onClick={resetPackage}>恢复默认</button></div></div>
}

function GeneralSettings({ preferences, onPreferenceChange, onNotice }) {
  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">系统设置</div><h1>常规</h1><p>控制控制台的启动和数据刷新方式。</p></div><SettingsPanel title="运行方式" description="这些选项只影响本地控制台，不会修改 Bot 配置。"><SettingsRow title="自动刷新状态" description="按固定间隔同步账号、日志和运行资源状态。" action={<SettingsToggle checked={preferences.autoRefresh} onChange={(value) => { onPreferenceChange('autoRefresh', value); onNotice(value ? '已开启自动刷新' : '已关闭自动刷新') }} label="自动刷新状态" />} /><SettingsRow title="本地数据" description="主题、字体和设置偏好保存在当前设备的浏览器存储中。" action={<span className="settings-status-badge"><Check size={13} />已启用</span>} /></SettingsPanel><SettingsPanel title="安全提示" description="管理服务仍通过本机 API 访问，账号密码不会写入这里。"><div className="settings-note"><ShieldCheck size={18} /><span>建议仅在可信设备上使用 QQ 控制台，并定期检查 Bot 的登录状态。</span></div></SettingsPanel><div className="settings-actions"><span><strong>设置已自动保存</strong><small>修改后无需额外点击保存</small></span><button type="button" className="secondary" onClick={() => onNotice('当前设置已保存')}>确认</button></div></div>
}

function ProfileSettings({ profileName, onProfileNameChange, onNotice }) {
  const [draftName, setDraftName] = useState(profileName || '管理员')
  const saveName = () => {
    const value = draftName.trim() || '管理员'
    onProfileNameChange(value)
    setDraftName(value)
    onNotice('个人资料已保存')
  }

  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">个人设置</div><h1>个人资料</h1><p>设置本机控制台中显示的称呼。</p></div><SettingsPanel title="显示信息" description="该名称只用于本机界面，不会同步到 QQ 或机器人平台。"><label className="settings-form-field"><span>显示名称</span><input value={draftName} maxLength={32} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveName() }} placeholder="例如：管理员" /><small>最多 32 个字符。</small></label><div className="settings-actions inline"><span><strong>{draftName.trim() || '管理员'}</strong><small>预览名称</small></span><button type="button" className="action-button" onClick={saveName}>保存资料</button></div></SettingsPanel></div>
}

function ShortcutSettings({ onNotice }) {
  const shortcuts = [
    ['打开设置', 'Ctrl / ⌘ + ,'],
    ['刷新状态', 'Ctrl / ⌘ + R'],
    ['关闭弹窗', 'Esc'],
    ['切换账号搜索', 'Ctrl / ⌘ + K'],
  ]
  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">个人设置</div><h1>快捷键</h1><p>常用操作的默认快捷键，桌面端会优先响应这些组合键。</p></div><SettingsPanel title="默认快捷键" description="快捷键展示与桌面壳保持一致。"><div className="shortcut-list">{shortcuts.map(([label, key]) => <div className="shortcut-row" key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div></SettingsPanel><div className="settings-actions"><span><strong>默认快捷键</strong><small>当前版本暂不支持自定义组合键</small></span><button type="button" className="secondary" onClick={() => onNotice('快捷键已是默认配置')}>恢复默认</button></div></div>
}

function NotificationSettings({ preferences, onPreferenceChange, onNotice }) {
  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">应用设置</div><h1>通知</h1><p>管理 GitHub 更新通知和控制台提醒。</p></div><SettingsPanel title="通知中心" description="关闭后将暂停远程通知同步，并隐藏顶部未读提示。"><SettingsRow title="显示更新通知" description="在顶部通知按钮中显示新的控制台更新。" action={<SettingsToggle checked={preferences.notificationsEnabled} onChange={(value) => { onPreferenceChange('notificationsEnabled', value); onNotice(value ? '已开启更新通知' : '已关闭更新通知') }} label="显示更新通知" />} /><SettingsRow title="通知提示音" description="桌面壳支持时播放提示音，浏览器预览不会自动播放声音。" action={<SettingsToggle checked={preferences.notificationSound} onChange={(value) => onPreferenceChange('notificationSound', value)} label="通知提示音" />} /></SettingsPanel><div className="settings-note"><Volume2 size={18} /><span>通知内容只保存最近 50 条，并会随本机设置一起保存在浏览器存储中。</span></div></div>
}

function ServiceSettings({ online, onNavigate, onRefresh }) {
  const resources = [['NapCat', Server], ['NoneBot', SquareTerminal], ['AstrBot', Bot]]
  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">应用设置</div><h1>服务</h1><p>查看管理服务连接状态，并快速打开运行资源配置。</p></div><SettingsPanel title="管理服务" description="控制台会从本机管理 API 读取状态。"><SettingsRow title="管理 API" description="本机 6700 端口的后台服务。" action={<span className={`settings-status-badge ${online ? 'online' : ''}`}><i />{online ? '连接正常' : '等待连接'}</span>} /><div className="settings-actions inline"><span><strong>{online ? '服务在线' : '服务离线'}</strong><small>重新读取账号与资源状态</small></span><button type="button" className="secondary" onClick={onRefresh}><RefreshCw size={14} />刷新状态</button></div></SettingsPanel><SettingsPanel title="运行资源" description="进入对应资源页面可以选择目录或执行一键配置。"><div className="service-entry-list">{resources.map(([label, Icon]) => <button type="button" className="service-entry" key={label} onClick={() => onNavigate(label)}><span className="service-entry-icon"><Icon size={16} /></span><span><strong>{label}</strong><small>打开资源配置</small></span><ChevronRight size={15} /></button>)}</div></SettingsPanel></div>
}

function RuntimeStatusPage({ bots, system, stats, napcat, online, busy, action, onSelectBot }) {
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
  const periodBots = stats?.bots?.[period] || []
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
  const dashboardTotal = Number(periodStats.total || 0)
  const overviewStats = showIntraday
    ? dailySeries.find((item) => item.day === selectedIntradayDay) || periodStats
    : periodStats
  const overviewPeriodLabel = showIntraday && selectedIntradayDay ? chartLabel({ day: selectedIntradayDay }) : periodLabel
  const total = Number(overviewStats.total || 0)
  const received = Number(overviewStats.received || 0)
  const sent = Number(overviewStats.sent || 0)
  const receivedShare = total ? Math.round(received / total * 100) : 0
  const sentShare = total ? Math.round(sent / total * 100) : 0
  const media = Number(periodStats.media || 0)
  const mediaShare = total ? Math.round(media / total * 100) : 0
  const yesterdaySeries = dailySeries.length > 1 ? dailySeries[dailySeries.length - 2] : null
  const yesterdayTotal = yesterdaySeries ? Number(yesterdaySeries.received || 0) + Number(yesterdaySeries.sent || 0) : 0
  const dailyChange = yesterdayTotal ? Math.round((dashboardTotal - yesterdayTotal) / yesterdayTotal * 100) : null
  const botStats = new Map(periodBots.map((item) => [String(item.id), item]))
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

function PlaceholderPage({ active, onBack }) {
  return <section className="placeholder"><div className="placeholder-icon"><Gauge size={21} /></div><h2>{active}</h2><p>这个模块已经预留好入口，下一步可以接入真实配置。</p><button className="secondary" onClick={onBack}>返回 QQ 账号</button></section>
}

function CreateAccountModal({ account, creating, onChange, onClose, onSubmit }) {
  const [showPassword, setShowPassword] = useState(false)
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="create-modal" onSubmit={onSubmit}><div className="modal-header"><div><div className="eyebrow">QQ 控制台</div><h2>新建账号</h2><p>添加你的真实 QQ 账号</p></div><button type="button" className="modal-close" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><label>账号名称<input required maxLength="40" placeholder="例如：群管助手" value={account.name} onChange={event => onChange({ ...account, name: event.target.value })} /></label><label>QQ 号<input required pattern="[0-9]{5,20}" placeholder="请输入 5-20 位 QQ 号" value={account.qq} onChange={event => onChange({ ...account, qq: event.target.value })} /></label><label>机器人框架<FrameworkSelect value={account.framework} onChange={(framework) => onChange({ ...account, framework })} /><small>选择消息处理和插件运行框架，NapCat 负责 QQ 协议连接。</small></label><label>OneBot 连接端口<input required type="number" min="1024" max="65535" placeholder="例如：8080" value={account.port} onChange={event => onChange({ ...account, port: event.target.value })} /><small>每个账号必须使用不同端口，创建后会按所选框架配置 NapCat。</small></label><label>NapCat WebUI 端口（可选）<input type="number" min="1024" max="65535" placeholder="留空自动分配（默认 6099）" value={account.napcatPort} onChange={event => onChange({ ...account, napcatPort: event.target.value })} /><small>用于 NapCat 登录面板；留空会自动选择未占用端口。</small></label><label>登录密码（可选）<span className="password-input-wrap"><input type={showPassword ? 'text' : 'password'} maxLength="256" autoComplete="new-password" placeholder="留空则使用二维码登录" value={account.password} onChange={event => onChange({ ...account, password: event.target.value })} /><button type="button" className="password-toggle" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? '隐藏密码' : '显示密码'} title={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></span><small>密码只保存在本机配置中，不会显示在日志中。</small></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="action-button" disabled={creating}>{creating ? '创建中…' : '创建账号'}</button></div></form></div>
}

function DeleteAccountModal({ bot, deleting, onClose, onConfirm }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="delete-modal" role="alertdialog" aria-labelledby="delete-account-title"><div className="modal-header"><div><div className="eyebrow">QQ 控制台</div><h2 id="delete-account-title">删除账号</h2><p>确认删除「{bot.name}」？</p></div><button type="button" className="modal-close" onClick={onClose} aria-label="关闭" disabled={deleting}><X size={18} /></button></div><div className="delete-warning">删除后会移除账号记录和专属启动脚本；不会删除 NapCat 安装文件。</div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={deleting}>取消</button><button type="button" className="action-button danger" onClick={onConfirm} disabled={deleting}>{deleting ? '删除中…' : '确认删除'}</button></div></div></div>
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[QQ 控制台] React 渲染异常', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    const message = this.state.error?.message || String(this.state.error)
    return <main className="app-runtime-error" role="alert">
      <div className="app-runtime-error-card">
        <h1>控制台渲染异常</h1>
        <p>页面运行过程中遇到错误，管理服务仍可能在后台运行。</p>
        <code>{message}</code>
        <button type="button" onClick={() => window.location.reload()}>重新加载控制台</button>
      </div>
    </main>
  }
}

window.addEventListener('error', (event) => {
  console.error('[QQ 控制台] 未捕获前端异常', event.error || event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  console.error('[QQ 控制台] 未处理 Promise 异常', event.reason)
})

createRoot(document.getElementById('root')).render(<AppErrorBoundary><App /></AppErrorBoundary>)
