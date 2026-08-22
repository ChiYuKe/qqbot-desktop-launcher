// 应用关闭流程：清理定时器、关闭 WebUI 窗口、销毁主窗口后等待管理 API 完成优雅
// 停机。窗口先消失再等后端：渲染进程的 WebSocket 会拖住 uvicorn 的关闭流程，
// 而后端清理（终止或保留 Bot 进程）也可能需要数秒，不应让界面留在屏幕上等待。
const { app } = require('electron')
const state = require('./state.cjs')
const { stopApiProcess } = require('./api.cjs')

async function closeApplication() {
  if (state.closingApplication) return
  state.closingApplication = true
  if (state.rendererRecoveryTimer) {
    clearTimeout(state.rendererRecoveryTimer)
    state.rendererRecoveryTimer = null
  }
  if (state.apiMonitorTimer) {
    clearInterval(state.apiMonitorTimer)
    state.apiMonitorTimer = null
  }
  if (state.webUiWindow && !state.webUiWindow.isDestroyed()) state.webUiWindow.close()
  if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.destroy()
  await stopApiProcess()
  state.shutdownFinished = true
  app.quit()
}

module.exports = { closeApplication }
