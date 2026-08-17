// 系统托盘：图标、右键菜单、点击恢复主窗口、隐藏到托盘与托盘退出。
const { app, Tray, Menu } = require('electron')
const state = require('./state.cjs')
const { closeApplication } = require('./shutdown.cjs')

function updateTrayStatus(status) {
  if (!state.tray) return
  const text = status === 'offline'
    ? '管理服务离线'
    : status === 'incompatible'
      ? '管理服务版本不兼容'
      : '管理服务运行中'
  state.tray.setToolTip(`QQBot Desktop Launcher — ${text}`)
}

function showMainWindow() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return
  if (state.mainWindow.isMinimized()) state.mainWindow.restore()
  state.mainWindow.show()
  state.mainWindow.focus()
}

function createTray(iconPath) {
  if (state.tray || !iconPath) return
  state.tray = new Tray(iconPath)
  state.tray.setToolTip('QQBot Desktop Launcher — 正在启动管理服务…')
  state.trayMenu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出 QQBot', click: () => quitFromTray() },
  ])
  state.tray.on('click', () => showMainWindow())
  state.tray.on('double-click', () => showMainWindow())
  state.tray.on('right-click', () => state.tray?.popUpContextMenu(state.trayMenu))
}

function hideToTray() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return
  state.mainWindow.hide()
  if (state.tray && !state.trayBalloonShown && process.platform === 'win32') {
    state.trayBalloonShown = true
    try {
      state.tray.displayBalloon({
        iconType: 'info',
        title: 'QQBot 已最小化到托盘',
        content: 'QQ 机器人仍在后台运行，点击托盘图标可重新打开控制台，右键可退出。',
      })
    } catch {
      // 托盘气泡提示仅 Windows 支持，失败时静默忽略。
    }
  }
}

function quitFromTray() {
  if (state.tray) {
    state.tray.destroy()
    state.tray = null
    state.trayMenu = null
  }
  if (state.closingApplication) return
  void closeApplication().then(() => app.quit())
}

module.exports = {
  updateTrayStatus,
  showMainWindow,
  createTray,
  hideToTray,
  quitFromTray,
}