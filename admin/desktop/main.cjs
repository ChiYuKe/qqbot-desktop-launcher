// QQBot Desktop Launcher 主进程入口。
//
// 本文件只负责应用生命周期编排与运行环境探测，具体功能按职责拆分：
//   lib/api.cjs        管理 API 启停 / 健康检查 / 自动恢复
//   lib/config.cjs     桌面端本地配置（托盘开关等）持久化
//   lib/tray.cjs       系统托盘与隐藏/恢复
//   lib/windows.cjs    主窗口创建与渲染进程恢复
//   lib/ipc.cjs        IPC 处理器注册
//   lib/shutdown.cjs   应用关闭流程
//   lib/state.cjs      各模块共享的可变状态
const { app, BrowserWindow, dialog } = require('electron')
const { randomBytes } = require('crypto')
const fs = require('fs')
const path = require('path')
const state = require('./lib/state.cjs')
const { configureApiManager } = require('./lib/api.cjs')
const { configureWindows, createWindow } = require('./lib/windows.cjs')
const { registerIpc } = require('./lib/ipc.cjs')
const { showMainWindow, updateTrayStatus } = require('./lib/tray.cjs')
const { closeApplication } = require('./lib/shutdown.cjs')

const SESSION_TOKEN = randomBytes(32).toString('hex')

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

configureApiManager({
  sessionToken: SESSION_TOKEN,
  runtime: { bundledRuntime, bundledBackend, bundledPython, projectRoot, adminRoot, python },
  onStatus: status => updateTrayStatus(status),
})

app.on('second-instance', () => {
  showMainWindow()
})

app.whenReady().then(() => {
  configureWindows({ panelDist, iconPath, sessionToken: SESSION_TOKEN })
  registerIpc({ iconPath })
  return createWindow()
}).catch(error => dialog.showErrorBox('QQBot Desktop Launcher', error.message))

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', event => {
  if (state.apiPid && !state.closingApplication) {
    event.preventDefault()
    void closeApplication()
  }
})
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })