/**
 * 控制台插件宿主：加载、注册和管理前端页面插件。
 *
 * 每个插件在 ``plugins/<id>/`` 目录下有一个 ``plugin.json`` 声明和
 * 一个 ``frontend.js`` 脚本。该脚本是一个 IIFE，通过
 * ``window.__DSH_PLUGINS__.register()`` 向宿主注册页面组件。
 *
 * 宿主提供：
 * - ``window.React``     React 全局（在 main.jsx 入口处挂载）
 * - ``window.__DSH_PLUGINS__`` 插件注册 API
 *
 * 加载流程：
 * 1. 控制台启动时调用 ``fetchPlugins()`` 从后端获取清单
 * 2. 对有 ``frontend`` 入口的插件，注入 ``<script src>`` 标签加载
 * 3. 插件脚本执行后调用 ``window.__DSH_PLUGINS__.register()``
 * 4. 宿主将插件信息合并到状态中供导航和页面渲染使用
 */

import {
  Activity, AlertCircle, AlertTriangle, Bell, Bot, Calendar, Check, ChevronDown, ChevronLeft, ChevronRight,
  ChevronUp, CircleHelp, Clock, Cloud, CloudOff, Code, Copy, Database, Download, Edit, ExternalLink, Eye, EyeOff,
  FileText, Filter, Globe, Heart, Home, Image, Info, Keyboard, LayoutDashboard, Link, Loader, Loader2, Lock,
  LogIn, LogOut, Laptop, Maximize, Menu, MessageSquare, Minimize, Minus, Monitor, Moon, MoreHorizontal,
  MoreVertical, Music, Palette, Paintbrush, Plus, Power, Puzzle, RefreshCw, Save, Search, Send, Server,
  Settings, Share, ShieldCheck, SlidersHorizontal, Smartphone, SortAsc, SortDesc, SquareTerminal,
  Star, Sun, Tablet, Terminal, ThumbsUp, Trash, Trash2, Unlock, Upload, UserRound, Users, Video, Volume2,
  Wifi, WifiOff, X,
} from 'lucide-react'

// 支持的图标名称到 lucide 组件的映射。插件 manifest 中的 icon 字段使用
// 驼峰或 kebab-case 名称，这里解析为对应的 lucide-react 组件。
const ICON_MAP = {
  Activity, AlertCircle, AlertTriangle, Bell, Bot, Calendar, Check, ChevronDown, ChevronLeft, ChevronRight,
  ChevronUp, CircleHelp, Clock, Cloud, CloudOff, Code, Copy, Database, Download, Edit, ExternalLink, Eye, EyeOff,
  FileText, Filter, Globe, Heart, Home, Image, Info, Keyboard, LayoutDashboard, Link, Loader, Loader2, Lock,
  LogIn, LogOut, Laptop, Maximize, Menu, MessageSquare, Minimize, Minus, Monitor, Moon, MoreHorizontal,
  MoreVertical, Music, Palette, Paintbrush, Plus, Power, Puzzle, RefreshCw, Save, Search, Send, Server,
  Settings, Share, ShieldCheck, SlidersHorizontal, Smartphone, SortAsc, SortDesc, SquareTerminal,
  Star, Sun, Tablet, Terminal, ThumbsUp, Trash, Trash2, Unlock, Upload, UserRound, Users, Video, Volume2,
  Wifi, WifiOff, X,
}

// kebab-case 与 camelCase 都接受：kebab -> camel
function normalizeIconName(name) {
  const camel = String(name || '')
    .replace(/-([a-z])/g, (_, char) => char.toUpperCase())
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

export function resolvePluginIcon(name) {
  return ICON_MAP[normalizeIconName(name)] || Puzzle
}

// 缓存注册的插件页面组件和设置组件。
const _registeredPlugins = new Map()
const _loadedScripts = new Set()
// 注册事件监听器：插件脚本加载并调用 register() 后触发，宿主据此重新渲染。
const _listeners = new Set()

function _emitChange() {
  for (const listener of _listeners) {
    try {
      listener()
    } catch {
      // 单个监听器异常不能影响插件宿主。
    }
  }
}

/**
 * 订阅插件注册变化。
 * @param {() => void} listener
 * @returns {() => void} 取消订阅函数
 */
export function subscribePlugins(listener) {
  _listeners.add(listener)
  return () => _listeners.delete(listener)
}

/**
 * 插件注册 API（暴露在 window.__DSH_PLUGINS__ 上）。
 */
const pluginApi = {
  /**
   * 由插件 frontend.js 调用，注册页面组件。
   * @param {object} plugin - 插件注册对象
   * @param {string} plugin.id - 插件 id，必须与 manifest 一致
   * @param {object} plugin.pages - 导航 key 到 React 组件函数的映射
   *   pages['page:example-plugin'] = function(props) { return React.createElement(...) }
   * @param {object} [plugin.settings] - 可选，设置页面组件映射
   */
  register({ id, pages = {}, settings = {} }) {
    if (!id) {
      console.error('[控制台插件] 注册失败：缺少 id')
      return
    }
    const existing = _registeredPlugins.get(id) || {}
    _registeredPlugins.set(id, {
      ...existing,
      pages: { ...existing.pages, ...pages },
      settings: { ...existing.settings, ...settings },
    })
    _emitChange()
  },
}

/**
 * 从后端获取插件清单。
 */
export async function fetchPlugins(api) {
  try {
    const data = await api('/api/console-plugins')
    return Array.isArray(data?.plugins) ? data.plugins : []
  } catch {
    return []
  }
}

/**
 * 切换插件启用状态。
 * @param {Function} api - 带鉴权的 API 请求函数
 * @param {string} pluginId
 * @param {boolean} enabled
 * @returns {Promise<Array<object>>} 更新后的插件清单
 */
export async function setPluginEnabled(api, pluginId, enabled) {
  const data = await api(`/api/console-plugins/${encodeURIComponent(pluginId)}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
  return Array.isArray(data?.plugins) ? data.plugins : []
}

/**
 * 卸载单个插件：注销其页面组件并清除脚本缓存，使重新启用时可以再次加载。
 * @param {string} pluginId
 */
export function unloadPlugin(pluginId) {
  _registeredPlugins.delete(pluginId)
  for (const key of [..._loadedScripts]) {
    if (key.startsWith(`${pluginId}:`)) _loadedScripts.delete(key)
  }
  document.querySelectorAll(`script[src*="/plugin-assets/${pluginId}/"]`).forEach((script) => script.remove())
  _emitChange()
}

/**
 * 加载插件的前端脚本。
 * 注入 <script> 标签，脚本会在加载后立即执行并调用 window.__DSH_PLUGINS__.register()。
 * @param {string} pluginId
 * @param {string} frontendFile - 相对于 plugin 目录的入口文件名
 */
export function loadPluginScript(pluginId, frontendFile) {
  const scriptKey = `${pluginId}:${frontendFile}`
  if (_loadedScripts.has(scriptKey)) return
  const script = document.createElement('script')
  script.src = `http://127.0.0.1:6700/plugin-assets/${pluginId}/${frontendFile}`
  script.onload = () => {
    _loadedScripts.add(scriptKey)
  }
  script.onerror = () => {
    console.error(`[控制台插件] 加载 ${pluginId}/${frontendFile} 失败`)
  }
  document.head.appendChild(script)
}

/**
 * 获取已注册的插件页面组件。
 * @param {string} pageKey - 导航 key（如 'page:example-plugin'）
 * @returns {function|null} React 组件函数
 */
export function getPluginPageComponent(pageKey) {
  for (const [, plugin] of _registeredPlugins) {
    if (plugin.pages[pageKey]) return plugin.pages[pageKey]
  }
  return null
}

/**
 * 获取所有已加载的插件导航条目。
 * 调用前需先加载所有插件脚本；已停用的插件不产生导航项。
 * @param {Array<object>} manifests - 从后端获取的插件清单
 * @returns {Array<object>} 导航条目 { key, label, icon, pluginId }
 */
export function collectPluginNavItems(manifests) {
  const items = []
  for (const manifest of manifests) {
    if (manifest.enabled === false) continue
    const nav = manifest.nav
    if (!nav || !nav.key || !nav.label) continue
    items.push({
      key: nav.key,
      label: nav.label,
      icon: resolvePluginIcon(nav.icon),
      pluginId: manifest.id,
    })
  }
  return items
}

/**
 * 初始化插件宿主：暴露全局 API，加载启用插件的脚本。
 * 在控制台启动时调用。
 * @param {Array<object>} manifests - 插件清单
 */
export function initPluginHost(manifests) {
  // 暴露全局注册 API
  window.__DSH_PLUGINS__ = pluginApi

  // 加载每个启用插件的 frontend.js
  for (const manifest of manifests) {
    if (manifest.enabled === false) continue
    const frontendFile = manifest.frontend
    if (!frontendFile) continue
    loadPluginScript(manifest.id, frontendFile)
  }
}