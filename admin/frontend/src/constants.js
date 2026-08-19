// 面板常量与纯函数：存储键、默认偏好、字体选项、通知规范化、时间/字节格式化。
// 不依赖 React（仅引用 lucide 图标组件用于收藏页/设置导航定义），被 main.jsx 与各功能模块共享。
import { Activity, Bot, Boxes, CircleUserRound, Keyboard, LayoutDashboard, Palette, Paintbrush, Puzzle, Server, ShieldCheck, SlidersHorizontal, SquareTerminal, Trash2, UserRound, Users, Volume2 } from 'lucide-react'
export const fallbackBots = []
export const fallbackLogs = []
export const fallbackStats = { periods: {}, bots: {}, series: [], intraday: [], intraday_by_day: {}, updated_at: null }
export const FAVORITES_STORAGE_KEY = 'qq-console-favorites'
export const NOTIFICATION_STORAGE_KEY = 'qq-console-github-notifications'
export const PREFERENCES_STORAGE_KEY = 'qq-console-preferences'
export const FONT_STORAGE_KEY = 'qq-console-font'
export const THEME_PACKAGE_STORAGE_KEY = 'qq-console-theme-package'
export const NOTIFICATION_POLL_INTERVAL_MS = 60_000
export const NOTIFICATION_MAX_ITEMS = 50
export const NOTIFICATION_LEVELS = new Set(['info', 'success', 'warning', 'error'])
export const NOTIFICATION_FEED_URL = String(import.meta.env.VITE_GITHUB_NOTIFICATION_URL || 'https://raw.githubusercontent.com/ChiYuKe/qqbot-desktop-launcher/master/notifications.json').trim()
export const NOTIFICATION_SOURCE = 'GitHub'
export const OFFICIAL_RESOURCE_URLS = {
  napcat: 'https://github.com/NapNeko/NapCatQQ/releases',
  nonebot: 'https://nonebot.dev/docs/quick-start',
  astrbot: 'https://docs.astrbot.app/deploy/astrbot/cli.html',
}
export const RESOURCE_SETUP_POLL_INTERVAL_MS = 750
export const PLUGIN_FRAMEWORK_FAVORITE_KEYS = {
  nonebot: 'tab:NoneBot插件',
  astrbot: 'tab:AstrBot插件',
  console: 'tab:控制台插件',
}
export const CONSOLE_PLUGIN_FAVORITE_KEY = PLUGIN_FRAMEWORK_FAVORITE_KEYS.console
export const favoritePageDefinitions = [
  { key: 'page:概览', label: '概览', icon: LayoutDashboard },
  { key: 'page:QQ 账号', label: 'QQ 账号', icon: UserRound },
  { key: 'page:运行状态', label: '运行状态', icon: Activity },
  { key: 'page:插件管理', label: '插件管理', icon: Puzzle },
  { key: PLUGIN_FRAMEWORK_FAVORITE_KEYS.nonebot, label: 'NoneBot 插件', icon: SquareTerminal },
  { key: PLUGIN_FRAMEWORK_FAVORITE_KEYS.astrbot, label: 'AstrBot 插件', icon: Bot },
  { key: PLUGIN_FRAMEWORK_FAVORITE_KEYS.console, label: '控制台插件', icon: Boxes },
  { key: 'page:群组管理', label: '群组管理', icon: Users },
  { key: 'page:NapCat', label: 'NapCat', icon: Server },
  { key: 'page:NoneBot', label: 'NoneBot', icon: SquareTerminal },
  { key: 'page:AstrBot', label: 'AstrBot', icon: Bot },
]
export const SECONDARY_PAGE_NAMES = new Set(['系统设置', 'NapCat', 'NoneBot', 'AstrBot'])
export const FONT_OPTIONS = [
  { value: 'system', label: '系统默认', description: 'HarmonyOS Sans SC', family: '"HarmonyOS Sans SC", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif' },
  { value: 'microsoft', label: '微软雅黑', description: 'Windows 中文默认风格', family: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif' },
  { value: 'segoe', label: 'Segoe UI', description: '偏英文和数字阅读', family: '"Segoe UI Variable Text", "Segoe UI", sans-serif' },
]
export const SETTINGS_SECTIONS = [
  { title: '个人', items: [{ label: '常规', icon: SlidersHorizontal }, { label: '个人资料', icon: CircleUserRound }, { label: '外观', icon: Palette }, { label: '快捷键', icon: Keyboard }] },
  { title: '应用', items: [{ label: '通知', icon: Volume2 }, { label: '服务', icon: ShieldCheck }, { label: '主题插件包', icon: Paintbrush }, { label: '缓存清理', icon: Trash2 }] },
]
export const DEFAULT_PREFERENCES = {
  autoRefresh: true,
  notificationsEnabled: true,
  reduceMotion: false,
  density: 'comfortable',
  profileName: '管理员',
  notificationSound: false,
}

export function readPreferences() {
  try {
    const saved = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
    const parsed = saved ? JSON.parse(saved) : {}
    return { ...DEFAULT_PREFERENCES, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function normalizeNotification(item) {
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

export function isNotificationActive(item) {
  if (!item?.expires_at) return true
  const expiresAt = Date.parse(item.expires_at)
  return !Number.isFinite(expiresAt) || expiresAt > Date.now()
}

export function readNotificationState() {
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

export function formatNotificationTime(value) {
  const timestamp = Date.parse(String(value || ''))
  if (!Number.isFinite(timestamp)) return '刚刚'
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatUptime(seconds) {
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
export function formatCacheBytes(bytes) {
  const value = Number(bytes || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}
