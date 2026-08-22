const API_BASE = `http://${window.location.hostname || '127.0.0.1'}:6700`

export const DASHBOARD_POLL_INTERVAL_MS = 10000
const DASHBOARD_REQUEST_TIMEOUT_MS = 8000

function apiToken() {
  return window.desktopInfo?.apiToken || import.meta.env.VITE_QQ_CONSOLE_TOKEN || ''
}

export async function api(path, options, timeoutMs = 15000) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
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
    if (error?.name === 'AbortError') throw new Error('管理服务响应超时，请重启控制台后重试', { cause: error })
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

export function dashboardApi(path) {
  return api(path, undefined, DASHBOARD_REQUEST_TIMEOUT_MS)
}

export async function copyText(value) {
  const text = String(value ?? '')
  if (!text) return false

  // The desktop shell loads the panel from file://, where navigator.clipboard
  // is unavailable. Use the Electron bridge first when it is present.
  if (typeof window.clipboard?.writeText === 'function') {
    try {
      const copied = await window.clipboard.writeText(text)
      if (copied !== false) return true
    } catch {
      // Fall through to browser clipboard implementations.
    }
  }

  if (typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the synchronous DOM fallback.
    }
  }

  const input = document.createElement('textarea')
  input.value = text
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  try {
    return document.execCommand('copy')
  } finally {
    input.remove()
  }
}

export async function fetchAuthenticatedBlob(path) {
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

export async function downloadAuthenticatedFile(path, filename) {
  const blob = await fetchAuthenticatedBlob(path)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
