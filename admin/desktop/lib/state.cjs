// 主进程共享状态：各模块（api / tray / windows / shutdown / ipc）通过此对象读写
// 窗口引用、管理 API 进程句柄与托盘引用，避免模块之间互相持有对方的内部变量。
module.exports = {
  apiProcess: null,
  apiPid: null,
  apiStopping: false,
  apiMonitorTimer: null,
  apiRestarting: false,
  apiMonitorRunning: false,
  apiOfflineChecks: 0,
  apiRestartAttempts: 0,
  apiHealthySince: 0,
  rendererRecoveryTimer: null,
  rendererRecoveryRunning: false,
  mainWindow: null,
  webUiWindow: null,
  tray: null,
  trayMenu: null,
  trayBalloonShown: false,
  closingApplication: false,
  shutdownFinished: false,
}