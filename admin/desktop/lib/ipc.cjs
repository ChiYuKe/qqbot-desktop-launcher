// IPC 注册：渲染进程的窗口控制、桌面配置、外部链接、WebUI 子窗口与目录选择。
const { BrowserWindow, dialog, ipcMain, shell } = require('electron')
const state = require('./state.cjs')
const { getTrayOnClose, setTrayOnClose } = require('./config.cjs')
const { hideToTray } = require('./tray.cjs')
const { closeApplication } = require('./shutdown.cjs')

let iconPath = null

function registerIpc(options) {
  iconPath = options?.iconPath || null

  ipcMain.on('window-minimize', () => state.mainWindow?.minimize())
  ipcMain.on('window-toggle-maximize', () => {
    if (!state.mainWindow) return
    if (state.mainWindow.isMaximized()) state.mainWindow.unmaximize()
    else state.mainWindow.maximize()
  })
  ipcMain.on('window-close', () => {
    if (getTrayOnClose()) hideToTray()
    else void closeApplication()
  })
  ipcMain.handle('get-desktop-config', () => ({ trayOnClose: getTrayOnClose() }))
  ipcMain.on('set-tray-on-close', (_event, enabled) => setTrayOnClose(enabled))

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
    if (!state.mainWindow || !isLocalWebUiUrl(url)) return false

    if (state.webUiWindow && !state.webUiWindow.isDestroyed()) {
      try {
        state.webUiWindow.setTitle(title)
        await state.webUiWindow.loadURL(String(url))
        state.webUiWindow.show()
        state.webUiWindow.focus()
        return true
      } catch {
        return false
      }
    }

    state.webUiWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      title,
      parent: state.mainWindow,
      autoHideMenuBar: true,
      ...(iconPath ? { icon: iconPath } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    state.webUiWindow.on('closed', () => { state.webUiWindow = null })
    state.webUiWindow.webContents.on('will-navigate', (event, targetUrl) => {
      if (isLocalWebUiUrl(targetUrl)) return
      event.preventDefault()
      void shell.openExternal(targetUrl)
    })
    state.webUiWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      if (!isLocalWebUiUrl(targetUrl)) void shell.openExternal(targetUrl)
      return { action: 'deny' }
    })
    state.webUiWindow.once('ready-to-show', () => state.webUiWindow?.show())
    try {
      await state.webUiWindow.loadURL(String(url))
      state.webUiWindow.show()
      state.webUiWindow.focus()
      return true
    } catch {
      if (state.webUiWindow && !state.webUiWindow.isDestroyed()) state.webUiWindow.close()
      return false
    }
  })

  ipcMain.handle('select-directory', async () => {
    if (!state.mainWindow) return null
    const result = await dialog.showOpenDialog(state.mainWindow, {
      title: '选择资源目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] || null
  })
}

module.exports = { registerIpc }