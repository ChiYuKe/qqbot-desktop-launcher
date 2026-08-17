// 应用关闭流程：清理定时器、关闭 WebUI 窗口、优雅停机管理 API、销毁主窗口。
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
  await stopApiProcess()
  if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.destroy()
}

module.exports = { closeApplication }