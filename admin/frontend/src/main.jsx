import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, Bell, Bot, ChevronDown, CircleHelp, LayoutDashboard, Puzzle, Server, Settings, SquareTerminal, UserRound,
} from 'lucide-react'
import './styles.css'
import './layout.css'
import './theme-packages/blue.css'
import { api, dashboardApi, DASHBOARD_POLL_INTERVAL_MS } from './lib/api.js'
import { EMPTY_PLUGIN_FRAMEWORKS, astrbotDashboardPort, normalizePluginFrameworks, webUiTarget } from './lib/bot.js'
import { isCurrentSessionLog, mergeCurrentSessionLogs, orderCurrentSessionLogs, resolveQuickLoginCommand } from './lib/logs.js'
import { deriveStatsFromLogs } from './lib/stats.js'
import { DEFAULT_THEME_PACKAGE, getThemePackage, THEME_PACKAGES } from './theme-packages/index.js'
import {
  FAVORITES_STORAGE_KEY, FONT_OPTIONS, FONT_STORAGE_KEY, NOTIFICATION_FEED_URL,
  NOTIFICATION_MAX_ITEMS, NOTIFICATION_POLL_INTERVAL_MS,
  NOTIFICATION_STORAGE_KEY, OFFICIAL_RESOURCE_URLS, PREFERENCES_STORAGE_KEY, RESOURCE_SETUP_POLL_INTERVAL_MS,
  SECONDARY_PAGE_NAMES, THEME_PACKAGE_STORAGE_KEY, fallbackBots, fallbackLogs, fallbackStats,
  favoritePageDefinitions, isNotificationActive, normalizeNotification,
  readNotificationState, readPreferences,
} from './constants.js'
import { CreateAccountModal, DeleteAccountModal, NavItem, NotificationCenterModal, WebUiMenuItem, WindowControls } from './components.jsx'
import { AccountWorkspace } from './pages/account.jsx'
import { EmbeddedWebUiPage } from './pages/embedded.jsx'
import { OverviewPage } from './pages/overview.jsx'
import { PluginPage } from './pages/plugins.jsx'
import { ResourcePage, ResourceSetupModal } from './pages/resources.jsx'
import { PlaceholderPage, RuntimeStatusPage } from './pages/runtime.jsx'
import { SettingsPage } from './settings/index.jsx'
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

      if (botData) setBots(Array.isArray(botData) ? botData : [])
      if (systemData && typeof systemData === 'object' && !Array.isArray(systemData)) setSystem(systemData)
      if (logData && !logsPaused && Array.isArray(logData)) {
        setLogs((current) => logData.length
          ? mergeCurrentSessionLogs(current, orderCurrentSessionLogs(logData))
          : fallbackLogs)
      }
      if (napcatData && typeof napcatData === 'object' && !Array.isArray(napcatData)) setNapcat(napcatData)
      if (resourceData && typeof resourceData === 'object' && !Array.isArray(resourceData)) {
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
          const statsData = await dashboardApi('/api/stats')
          setStats(statsData && typeof statsData === 'object' && !Array.isArray(statsData) ? statsData : fallbackStats)
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
    if (kind === 'astrbot' && botOverride) {
      try {
        const credentials = await api(`/api/bots/${botOverride.id}/astrbot/webui`)
        if (credentials.url) resolvedTarget = { ...target, url: credentials.url }
        if (!credentials.available) notify('AstrBot WebUI 暂时不可用，请先启动一次 AstrBot')
      } catch (error) {
        notify(`AstrBot 登录信息读取失败：${error.message}`)
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


class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, stack: '' }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[QQ 控制台] React 渲染异常', error, info.componentStack)
    const record = {
      at: new Date().toISOString(),
      message: error?.message || String(error),
      stack: String(info.componentStack || '').slice(0, 2000),
    }
    try {
      const history = JSON.parse(window.localStorage.getItem('qq-console-last-errors') || '[]')
      if (!Array.isArray(history)) throw new Error('bad history')
      history.push(record)
      window.localStorage.setItem('qq-console-last-errors', JSON.stringify(history.slice(-3)))
    } catch {
      try {
        window.localStorage.setItem('qq-console-last-errors', JSON.stringify([record]))
      } catch {
        // localStorage 不可用时只保留在内存中
      }
    }
    this.setState({ stack: record.stack })
  }

  render() {
    if (!this.state.error) return this.props.children
    const message = this.state.error?.message || String(this.state.error)
    return <main className="app-runtime-error" role="alert">
      <div className="app-runtime-error-card">
        <h1>控制台渲染异常</h1>
        <p>页面运行过程中遇到错误，管理服务仍可能在后台运行。</p>
        <code>{message}</code>
        {this.state.stack && <details className="app-runtime-error-stack"><summary>组件调用栈（排查用）</summary><pre>{this.state.stack}</pre></details>}
        <p className="app-runtime-error-hint">错误已保存在本机（qq-console-last-errors），下次出现时点「复制错误信息」发给开发者即可定位。</p>
        <div className="app-runtime-error-actions">
          <button type="button" onClick={() => navigator.clipboard?.writeText(`${message}\n\n${this.state.stack || ''}`).catch(() => {})}>复制错误信息</button>
          <button type="button" onClick={() => this.setState({ error: null, stack: '' })}>重试</button>
          <button type="button" onClick={() => window.location.reload()}>重新加载控制台</button>
        </div>
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
