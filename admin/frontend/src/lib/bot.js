export const EMPTY_PLUGIN_FRAMEWORKS = {
  nonebot: { project: null, plugins: [] },
  astrbot: { projects: [], plugins: [] },
}

const BOT_RUNNING_STATES = new Set(['running', 'login_required'])
const BOT_TRANSITION_STATES = new Set(['starting', 'stopping', 'restarting', 'logging_in'])

export function normalizePluginFrameworks(data) {
  const frameworks = data?.frameworks || {}
  const nonebot = frameworks.nonebot || { project: data?.project || null, plugins: data?.plugins || [] }
  const astrbot = frameworks.astrbot || { projects: [], plugins: [] }
  return {
    nonebot: { project: nonebot.project || null, plugins: Array.isArray(nonebot.plugins) ? nonebot.plugins : [] },
    astrbot: {
      projects: Array.isArray(astrbot.projects) ? astrbot.projects : [],
      plugins: Array.isArray(astrbot.plugins) ? astrbot.plugins : [],
    },
  }
}

export function isBotRunning(bot) {
  return BOT_RUNNING_STATES.has(bot?.status)
}

export function isBotTransitioning(bot) {
  return BOT_TRANSITION_STATES.has(bot?.status)
}

export function botStatusLabel(bot) {
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

export function botStatusState(bot) {
  if (bot?.status === 'error' || bot?.status === 'login_required') return 'red'
  if (isBotRunning(bot)) return 'green'
  if (isBotTransitioning(bot)) return 'blue'
  return 'muted'
}

export function normalizeLocalUrl(value) {
  if (!value) return value
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' && ['[::]', '[::1]', '0.0.0.0'].includes(url.hostname)) {
      url.hostname = '127.0.0.1'
    }
    return url.toString()
  } catch {
    return value
  }
}

export function astrbotDashboardPort(napcatPort) {
  const port = Number(napcatPort)
  const candidate = port + 10000
  return candidate <= 65535 ? candidate : Math.max(1024, port - 1000)
}

export function webUiTarget(bot, kind) {
  if (!bot) return null
  if (kind === 'napcat') {
    return { url: `http://127.0.0.1:${bot.napcat_port || 6099}`, title: `NapCat WebUI · ${bot.name}` }
  }
  if (kind === 'astrbot' && bot.framework === 'astrbot') {
    return { url: `http://127.0.0.1:${astrbotDashboardPort(bot.napcat_port || 6099)}`, title: `AstrBot WebUI · ${bot.name}` }
  }
  return null
}

export function openExternal(url) {
  const normalizedUrl = normalizeLocalUrl(url)
  if (!normalizedUrl) return
  if (window.externalLinks?.open) {
    window.externalLinks.open(normalizedUrl)
    return
  }
  window.open(normalizedUrl, '_blank', 'noopener,noreferrer')
}
