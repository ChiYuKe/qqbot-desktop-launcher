const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const API_PROTOCOL_VERSION = 2

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

const projectRoot = resolveProjectRoot()
const adminRoot = path.join(projectRoot, 'admin')
const panelDist = path.join(adminRoot, 'frontend', 'dist', 'index.html')
const python = path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
const iconCandidates = [
  path.join(__dirname, 'assets', 'icon.ico'),
  path.join(adminRoot, 'desktop', 'assets', 'icon.ico'),
]
const iconPath = iconCandidates.find(candidate => fs.existsSync(candidate))
let apiProcess
let apiPid
let apiStopping = false
let mainWindow

ipcMain.on('window-minimize', () => mainWindow?.minimize())
ipcMain.on('window-toggle-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.on('window-close', () => {
  stopApiProcess()
  mainWindow?.close()
})
ipcMain.handle('open-external', async (_, rawUrl) => {
  try {
    const url = new URL(String(rawUrl))
    if (!['http:', 'https:'].includes(url.protocol)) return false
    await shell.openExternal(url.toString())
    return true
  } catch {
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

function waitForApi(timeoutMs = 15000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get('http://127.0.0.1:6700/api/stats', response => {
        response.resume()
        if (response.statusCode === 200) return resolve()
        retry()
      })
      request.on('error', retry)
      request.setTimeout(1000, () => { request.destroy(); retry() })
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
    const request = http.get('http://127.0.0.1:6700/api/health', response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve('offline')
        try {
          const payload = JSON.parse(body)
          resolve(payload.api_version === API_PROTOCOL_VERSION ? 'current' : 'incompatible')
        } catch {
          resolve('incompatible')
        }
      })
    })
    request.on('error', () => resolve('offline'))
    request.setTimeout(800, () => { request.destroy(); resolve('offline') })
  })
}

async function startApi() {
  if (!fs.existsSync(python)) throw new Error(`找不到项目虚拟环境：${python}`)
  const status = await apiStatus()
  if (status === 'current') return
  if (status === 'incompatible') throw new Error('6700 端口上的管理服务版本过旧，请先关闭旧管理服务后再启动桌面端')
  apiProcess = spawn(python, ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '6700'], {
    cwd: adminRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  apiPid = apiProcess.pid
  apiProcess.on('error', error => dialog.showErrorBox('管理服务启动失败', error.message))
  apiProcess.stderr?.on('data', chunk => console.error(`[管理服务] ${String(chunk).trim()}`))
}

async function createWindow() {
  if (!fs.existsSync(panelDist)) throw new Error('前端尚未构建，请先运行 npm run build:panel')
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
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
  })
  await mainWindow.loadFile(panelDist)
}

function stopApiProcess() {
  if (apiStopping) return
  const pid = apiPid || apiProcess?.pid
  if (!pid) return
  apiStopping = true
  apiProcess = null
  apiPid = null
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    apiStopping = false
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } finally {
    apiStopping = false
  }
}

app.whenReady().then(() => createWindow().catch(error => dialog.showErrorBox('QQBot Desktop Launcher', error.message)))
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', stopApiProcess)
app.on('will-quit', stopApiProcess)
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
