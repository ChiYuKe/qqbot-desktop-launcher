const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn, spawnSync } = require('child_process')
const { randomBytes } = require('crypto')
const fs = require('fs')
const path = require('path')
const http = require('http')
const API_PROTOCOL_VERSION = 4
const API_HEALTH_TIMEOUT_MS = 5000
const API_HEALTH_FAILURE_THRESHOLD = 6
const SESSION_TOKEN = randomBytes(32).toString('hex')
const API_URL = 'http://127.0.0.1:6700'

// Only one desktop shell may own the fixed management port and session token.
// A second launcher otherwise connects to the first launcher's API with a
// different token and appears as a permanently disconnected console.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

function resolveProjectRoot() {
  const candidates = []
  if (process.env.QQ_BOT_ROOT) candidates.push(path.resolve(process.env.QQ_BOT_ROOT))
  candidates.push(path.resolve(__dirname, '..', '..'))

  if (app.isPackaged) {
    let candidate = path.dirname(process.execPath)
    for (let index = 0; index < 5; index += 1) {
      candidates.push(candidate)
      candidate = path.dirname(candidate)
    }
  }

  return candidates.find(candidate => fs.existsSync(path.join(candidate, 'admin', 'backend'))) || candidates[0]
}

const bundledBackend = path.join(process.resourcesPath, 'backend', 'qqbot-admin.exe')
const bundledPanelDist = path.join(process.resourcesPath, 'panel', 'index.html')
const bundledPython = path.join(process.resourcesPath, 'python-runtime', 'python.exe')
const bundledRuntime = app.isPackaged && fs.existsSync(bundledBackend)
const projectRoot = bundledRuntime ? null : resolveProjectRoot()
const adminRoot = projectRoot ? path.join(projectRoot, 'admin') : null
const panelDist = bundledRuntime ? bundledPanelDist : path.join(adminRoot || '', 'frontend', 'dist', 'index.html')
const python = projectRoot ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe') : null
const iconCandidates = [
  path.join(__dirname, 'assets', 'icon.ico'),
  ...(adminRoot ? [path.join(adminRoot, 'desktop', 'assets', 'icon.ico')] : []),
]
const iconPath = iconCandidates.find(candidate => fs.existsSync(candidate))
let apiProcess
let apiPid
let apiStopping = false
let apiMonitorTimer
let apiRestarting = false
let apiMonitorRunning = false
let apiOfflineChecks = 0
let mainWindow
let webUiWindow

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

ipcMain.on('window-minimize', () => mainWindow?.minimize())
ipcMain.on('window-toggle-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.on('window-close', () => {
  void closeApplication()
})
ipcMain.handle('open-external', async (_, rawUrl) => {
  try {
    const url = new URL(String(rawUrl))
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) return false
    if (!['http:', 'https:'].includes(url.protocol)) return false
    await shell.openExternal(url.toString())
    return true
  } catch {
    return false
  }
})
function isLocalWebUiUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl))
    const hostname = url.hostname.toLowerCase()
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    return ['http:', 'https:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)
      && port >= 1024 && port <= 65535
  } catch {
    return false
  }
}

ipcMain.handle('open-webui', async (_, payload) => {
  const url = typeof payload === 'string' ? payload : payload?.url
  const title = typeof payload === 'object' && payload?.title ? String(payload.title) : 'Bot WebUI'
  if (!mainWindow || !isLocalWebUiUrl(url)) return false

  if (webUiWindow && !webUiWindow.isDestroyed()) {
    try {
      webUiWindow.setTitle(title)
      await webUiWindow.loadURL(String(url))
      webUiWindow.show()
      webUiWindow.focus()
      return true
    } catch {
      return false
    }
  }

  webUiWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title,
    parent: mainWindow,
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  webUiWindow.on('closed', () => { webUiWindow = null })
  webUiWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (isLocalWebUiUrl(targetUrl)) return
    event.preventDefault()
    void shell.openExternal(targetUrl)
  })
  webUiWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (!isLocalWebUiUrl(targetUrl)) void shell.openExternal(targetUrl)
    return { action: 'deny' }
  })
  webUiWindow.once('ready-to-show', () => webUiWindow?.show())
  try {
    await webUiWindow.loadURL(String(url))
    webUiWindow.show()
    webUiWindow.focus()
    return true
  } catch {
    if (webUiWindow && !webUiWindow.isDestroyed()) webUiWindow.close()
    return false
  }
})

ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择资源目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : result.filePaths[0] || null
})

function apiHealthStatus(timeoutMs = API_HEALTH_TIMEOUT_MS) {
  return new Promise(resolve => {
    let settled = false
    const finish = status => {
      if (settled) return
      settled = true
      resolve(status)
    }
    const request = http.get(`${API_URL}/api/health`, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) return finish('offline')
        try {
          const payload = JSON.parse(body)
          finish(payload.api_version === API_PROTOCOL_VERSION ? 'current' : 'incompatible')
        } catch {
          finish('offline')
        }
      })
      response.on('error', () => finish('offline'))
    })
    request.once('error', () => finish('offline'))
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      finish('offline')
    })
  })
}

function waitForApi(timeoutMs = 15000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      void apiHealthStatus(API_HEALTH_TIMEOUT_MS).then(status => {
        if (status === 'current') return resolve()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error('管理 API 启动超时'))
      setTimeout(check, 250)
    }
    check()
  })
}

function apiStatus() {
  return new Promise(resolve => {
    void apiHealthStatus(API_HEALTH_TIMEOUT_MS).then(status => {
      if (status !== 'current') return resolve(status)
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const protectedRequest = http.get(`${API_URL}/api/session`, {
        headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
      }, response => {
        response.resume()
        response.once('end', () => finish(response.statusCode === 200 ? 'current' : 'incompatible'))
        response.once('error', () => finish('incompatible'))
      })
      protectedRequest.once('error', () => finish('incompatible'))
      protectedRequest.setTimeout(API_HEALTH_TIMEOUT_MS, () => {
        protectedRequest.destroy()
        finish('incompatible')
      })
    })
  })
}

async function startApi() {
  const status = await apiStatus()
  if (status === 'current') return
  if (status === 'incompatible') throw new Error('6700 端口上的管理服务版本过旧，请先关闭旧管理服务后再启动桌面端')
  const runtimeRoot = bundledRuntime ? app.getPath('userData') : projectRoot
  if (!runtimeRoot) throw new Error('找不到 QQBot 项目目录，请设置 QQ_BOT_ROOT')
  fs.mkdirSync(runtimeRoot, { recursive: true })
  const command = bundledRuntime ? bundledBackend : python
  const args = bundledRuntime ? [] : [path.join(adminRoot || '', 'server.py')]
  if (!command || !fs.existsSync(command)) {
    throw new Error(
      bundledRuntime
        ? `找不到内置管理服务：${bundledBackend}\n请重新安装 QQBot Desktop Launcher。`
        : `找不到项目虚拟环境：${command}`,
    )
  }
  const environment = {
    ...process.env,
    QQ_CONSOLE_TOKEN: SESSION_TOKEN,
    QQ_BOT_ROOT: runtimeRoot,
  }
  if (bundledRuntime && fs.existsSync(bundledPython)) environment.QQ_BOT_PYTHON = bundledPython
  apiProcess = spawn(command, args, {
    cwd: runtimeRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  })
  apiPid = apiProcess.pid
  apiProcess.on('error', error => dialog.showErrorBox('管理服务启动失败', error.message))
  apiProcess.on('exit', () => {
    if (apiProcess?.pid === apiPid) {
      apiProcess = null
      apiPid = null
    }
  })
  apiProcess.stderr?.on('data', chunk => console.error(`[管理服务] ${String(chunk).trim()}`))
}

function startApiMonitor() {
  if (apiMonitorTimer) clearInterval(apiMonitorTimer)
  apiMonitorTimer = setInterval(async () => {
    if (closingApplication || apiStopping || apiRestarting || apiMonitorRunning) return
    apiMonitorRunning = true
    try {
      const status = await apiHealthStatus(API_HEALTH_TIMEOUT_MS)
      if (status !== 'offline') {
        apiOfflineChecks = 0
        return
      }
      // A temporarily slow health response must not kill a healthy backend.
      // Keep the threshold long enough to cover short CPU/memory pressure
      // while SD WebUI is generating an image.
      apiOfflineChecks += 1
      console.warn(
        `[管理服务] 管理 API 健康检查失败 ${apiOfflineChecks}/${API_HEALTH_FAILURE_THRESHOLD}`,
      )
      if (apiOfflineChecks < API_HEALTH_FAILURE_THRESHOLD) return
      apiOfflineChecks = 0
      apiRestarting = true
      const managedPid = apiPid || apiProcess?.pid
      if (managedPid && process.platform === 'win32') {
        // Do not use /T here. The management API owns the Bot launcher
        // process tree, so taskkill /T would also kill AstrBot and NapCat
        // during an unrelated management-service recovery.
        console.warn(
          `[管理服务] 自动恢复管理 API：仅结束管理服务 PID=${managedPid}，保留 Bot 子进程`,
        )
        spawnSync('taskkill', ['/PID', String(managedPid), '/F'], { windowsHide: true, stdio: 'ignore' })
      } else if (managedPid) {
        try {
          process.kill(managedPid)
        } catch {
          // The process may already have exited between the health check and
          // this recovery attempt.
        }
      }
      apiProcess = null
      apiPid = null
      await startApi()
      await waitForApi(8000)
    } catch (error) {
      console.error(`[管理服务] 自动恢复失败：${error.message}`)
    } finally {
      apiRestarting = false
      apiMonitorRunning = false
    }
  }, 5000)
}

async function createWindow() {
  if (!fs.existsSync(panelDist)) {
    throw new Error(
      `找不到管理面板文件：${panelDist}\n\n请运行 release\\QQBot-Desktop-Launcher-Portable.exe，并保留项目中的 admin、.venv、data、program 目录；也可以设置 QQ_BOT_ROOT 指向项目根目录。`,
    )
  }
  await startApi()
  await waitForApi()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: 'QQBot Desktop Launcher',
    frame: false,
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      additionalArguments: [`--qq-console-token=${SESSION_TOKEN}`],
    },
  })
  mainWindow.on('close', event => {
    if (apiPid && !closingApplication) {
      event.preventDefault()
      void closeApplication()
    }
  })
  await mainWindow.loadFile(panelDist)
  startApiMonitor()
}

function requestBackendShutdown() {
  return new Promise(resolve => {
    const request = http.request(`${API_URL}/api/internal/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode === 200))
    })
    request.on('error', () => resolve(false))
    request.setTimeout(1500, () => { request.destroy(); resolve(false) })
    request.end()
  })
}

function waitForApiExit(timeoutMs = 8000) {
  const started = Date.now()
  return new Promise(resolve => {
    const check = async () => {
      if ((await apiStatus()) === 'offline') return resolve(true)
      if (Date.now() - started >= timeoutMs) return resolve(false)
      setTimeout(check, 200)
    }
    check()
  })
}

async function stopApiProcess() {
  if (apiStopping) return
  const pid = apiPid || apiProcess?.pid
  if (!pid) return
  apiStopping = true
  await requestBackendShutdown()
  const exited = await waitForApiExit()
  if (!exited && process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else if (!exited) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  apiProcess = null
  apiPid = null
  apiStopping = false
}

let closingApplication = false

async function closeApplication() {
  if (closingApplication) return
  closingApplication = true
  if (apiMonitorTimer) {
    clearInterval(apiMonitorTimer)
    apiMonitorTimer = null
  }
  if (webUiWindow && !webUiWindow.isDestroyed()) webUiWindow.close()
  await stopApiProcess()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
}

app.whenReady().then(() => createWindow().catch(error => dialog.showErrorBox('QQBot Desktop Launcher', error.message)))
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', event => {
  if (apiPid && !closingApplication) {
    event.preventDefault()
    void closeApplication()
  }
})
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
