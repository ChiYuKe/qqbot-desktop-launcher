// 桌面端本地配置：目前仅有「关闭窗口时最小化到托盘」开关。
// 配置文件保存在 Electron userData 目录下的 desktop-config.json。
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const DESKTOP_CONFIG_FILE = 'desktop-config.json'

function desktopConfigPath() {
  return path.join(app.getPath('userData'), DESKTOP_CONFIG_FILE)
}

function loadDesktopConfig() {
  try {
    const payload = JSON.parse(fs.readFileSync(desktopConfigPath(), 'utf8'))
    return { trayOnClose: payload.trayOnClose !== false }
  } catch {
    return { trayOnClose: true }
  }
}

function saveDesktopConfig(config) {
  try {
    const file = desktopConfigPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
  } catch (error) {
    console.error(`[托盘] 配置保存失败：${error.message}`)
  }
}

let trayOnClose = loadDesktopConfig().trayOnClose

module.exports = {
  getTrayOnClose: () => trayOnClose,
  setTrayOnClose: (enabled) => {
    trayOnClose = Boolean(enabled)
    saveDesktopConfig({ trayOnClose })
  },
}