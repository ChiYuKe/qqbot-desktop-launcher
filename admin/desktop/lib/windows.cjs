// 窗口管理：主窗口创建、渲染进程诊断与自动恢复、面板加载。
const { BrowserWindow, dialog } = require('electron')
const fs = require('fs')
const path = require('path')
const state = require('./state.cjs')
const { startApi, waitForApi, startApiMonitor } = require('./api.cjs')
const { createTray, updateTrayStatus, hideToTray } = require('./tray.cjs')
const { getTrayOnClose } = require('./config.cjs')
const { closeApplication } = require('./shutdown.cjs')

let panelDist = ''
let iconPath = null
let sessionToken = ''

// main.cjs 在 app ready 前注入面板路径、图标与会话令牌。
function configureWindows(options) {
  panelDist = String(options?.panelDist || '')
  iconPath = options?.iconPath || null
  sessionToken = String(options?.sessionToken || '')
}

function attachMainWindowDiagnostics() {
  const contents = state.mainWindow?.webContents
  if (!contents) return

  contents.on('console-message', (_event, details) => {
    const level = typeof details?.level === 'number'
      ? details.level
      : ({ verbose: 0, info: 1, warning: 2, error: 3 }[details?.level] ?? 0)
    if (level >= 2) {
      console.warn(`[渲染进程] ${details.message} (${details.sourceId}:${details.lineNumber})`)
    }
  })
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      console.error(`[渲染进程] 页面加载失败 code=${errorCode} ${errorDescription}: ${validatedURL}`)
    }
  })
  contents.on('unresponsive', () => console.error('[渲染进程] 页面无响应'))
  contents.on('responsive', () => console.info('[渲染进程] 页面恢复响应'))
  contents.on('render-process-gone', (_event, details) => {
    console.error(`[渲染进程] 已退出 reason=${details.reason} exitCode=${details.exitCode}`)
    if (state.closingApplication || state.rendererRecoveryRunning || !state.mainWindow || state.mainWindow.isDestroyed()) return
    state.rendererRecoveryRunning = true
    state.rendererRecoveryTimer = setTimeout(async () => {
      state.rendererRecoveryTimer = null
      try {
        if (!state.closingApplication && state.mainWindow && !state.mainWindow.isDestroyed()) {
          await state.mainWindow.loadFile(panelDist)
          console.info('[渲染进程] 已自动重新加载管理面板')
        }
      } catch (error) {
        console.error(`[渲染进程] 自动恢复失败：${error.message}`)
        if (!state.closingApplication) dialog.showErrorBox('QQBot 管理面板异常', error.message)
      } finally {
        state.rendererRecoveryRunning = false
      }
    }, 500)
  })
}

async function createWindow() {
  if (!fs.existsSync(panelDist)) {
    throw new Error(
      `找不到管理面板文件：${panelDist}\n\n请运行 release\\QQBot-Desktop-Launcher-Portable.exe，并保留项目中的 admin、.venv、data、program 目录；也可以设置 QQ_BOT_ROOT 指向项目根目录。`,
    )
  }
  await startApi()
  await waitForApi()
  state.mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: 'QQBot Desktop Launcher',
    show: false,
    frame: false,
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      additionalArguments: [`--qq-console-token=${sessionToken}`],
    },
  })
  state.mainWindow.once('ready-to-show', () => state.mainWindow?.show())
  attachMainWindowDiagnostics()
  state.mainWindow.on('close', event => {
    if (state.closingApplication) return
    event.preventDefault()
    if (getTrayOnClose()) hideToTray()
    else void closeApplication()
  })
  createTray(iconPath)
  updateTrayStatus('current')
  await state.mainWindow.loadFile(panelDist)
  startApiMonitor()
}

module.exports = {
  configureWindows,
  createWindow,
}