// 管理 API（本地 FastAPI 后端）生命周期管理：健康检查、启动、异常监控与自动恢复、
// 退出前优雅停机。所有可变句柄读写 lib/state.cjs。
const { app, dialog } = require('electron')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const state = require('./state.cjs')

const API_PROTOCOL_VERSION = 4
const API_HEALTH_TIMEOUT_MS = 5000
const API_HEALTH_FAILURE_THRESHOLD = 6
const API_RESTART_BASE_DELAY_MS = 1000
const API_RESTART_MAX_DELAY_MS = 30000
const API_URL = 'http://127.0.0.1:6700'

let sessionToken = ''
let runtime = { bundledRuntime: false, bundledBackend: '', bundledPython: '', projectRoot: null, adminRoot: null, python: '' }
let statusListener = null

// main.cjs 在 app ready 前注入会话令牌、运行环境信息，以及托盘状态回调。
function configureApiManager(options) {
  sessionToken = String(options?.sessionToken || '')
  if (options?.runtime) runtime = { ...runtime, ...options.runtime }
  statusListener = typeof options?.onStatus === 'function' ? options.onStatus : null
}

function notifyStatus(status) {
  if (statusListener) statusListener(status)
}

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
        headers: { Authorization: `Bearer ${sessionToken}` },
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
  const runtimeRoot = runtime.bundledRuntime ? app.getPath('userData') : runtime.projectRoot
  if (!runtimeRoot) throw new Error('找不到 QQBot 项目目录，请设置 QQ_BOT_ROOT')
  fs.mkdirSync(runtimeRoot, { recursive: true })
  const command = runtime.bundledRuntime ? runtime.bundledBackend : runtime.python
  const args = runtime.bundledRuntime ? [] : [path.join(runtime.adminRoot || '', 'server.py')]
  if (!command || !fs.existsSync(command)) {
    throw new Error(
      runtime.bundledRuntime
        ? `找不到内置管理服务：${runtime.bundledBackend}\n请重新安装 QQBot Desktop Launcher。`
        : `找不到项目虚拟环境：${command}`,
    )
  }
  const environment = {
    ...process.env,
    QQ_CONSOLE_TOKEN: sessionToken,
    QQ_BOT_ROOT: runtimeRoot,
  }
  if (runtime.bundledRuntime && fs.existsSync(runtime.bundledPython)) environment.QQ_BOT_PYTHON = runtime.bundledPython
  // 打包版把 plugins/ 一起打包进 resources；传给后端以便合并内置插件与用户插件。
  if (runtime.bundledRuntime) {
    const bundledPlugins = path.join(process.resourcesPath, 'plugins')
    if (fs.existsSync(bundledPlugins)) environment.QQ_BOT_PLUGINS_DIR = bundledPlugins
  }
  state.apiProcess = spawn(command, args, {
    cwd: runtimeRoot,
    windowsHide: true,
    // Uvicorn access output is intentionally discarded. A pipe that is not
    // consumed reliably will eventually fill and freeze the backend.
    stdio: ['ignore', 'ignore', 'pipe'],
    env: environment,
  })
  const startedProcess = state.apiProcess
  state.apiPid = state.apiProcess.pid
  state.apiProcess.on('error', error => dialog.showErrorBox('管理服务启动失败', error.message))
  state.apiProcess.on('exit', (code, signal) => {
    // A delayed exit event from the previous backend must not clear the
    // handle of a replacement process that is already running.
    if (state.apiProcess === startedProcess) {
      state.apiProcess = null
      state.apiPid = null
    }
    if (!state.closingApplication && !state.apiStopping) {
      console.error(`[管理服务] 进程异常退出 code=${code} signal=${signal}`)
    }
  })
  state.apiProcess.stderr?.on('data', chunk => console.error(`[管理服务] ${String(chunk).trim()}`))
}

function apiRestartDelay() {
  return Math.min(API_RESTART_MAX_DELAY_MS, API_RESTART_BASE_DELAY_MS * (2 ** Math.min(state.apiRestartAttempts, 5)))
}

function delay(timeoutMs) {
  return new Promise(resolve => setTimeout(resolve, timeoutMs))
}

function startApiMonitor() {
  if (state.apiMonitorTimer) clearInterval(state.apiMonitorTimer)
  state.apiMonitorTimer = setInterval(async () => {
    if (state.closingApplication || state.apiStopping || state.apiRestarting || state.apiMonitorRunning) return
    state.apiMonitorRunning = true
    try {
      const status = await apiHealthStatus(API_HEALTH_TIMEOUT_MS)
      notifyStatus(status)
      if (status !== 'offline') {
        state.apiOfflineChecks = 0
        if (!state.apiHealthySince) state.apiHealthySince = Date.now()
        if (Date.now() - state.apiHealthySince >= 60000) state.apiRestartAttempts = 0
        return
      }
      state.apiHealthySince = 0
      // A temporarily slow health response must not kill a healthy backend.
      // Keep the threshold long enough to cover short CPU/memory pressure
      // while SD WebUI is generating an image.
      state.apiOfflineChecks += 1
      console.warn(
        `[管理服务] 管理 API 健康检查失败 ${state.apiOfflineChecks}/${API_HEALTH_FAILURE_THRESHOLD}`,
      )
      if (state.apiOfflineChecks < API_HEALTH_FAILURE_THRESHOLD) return
      state.apiOfflineChecks = 0
      state.apiRestarting = true
      const restartDelay = apiRestartDelay()
      state.apiRestartAttempts += 1
      const managedPid = state.apiPid || state.apiProcess?.pid
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
      state.apiProcess = null
      state.apiPid = null
      console.warn(`[管理服务] ${restartDelay}ms 后尝试第 ${state.apiRestartAttempts} 次恢复`)
      await delay(restartDelay)
      if (state.closingApplication || state.apiStopping) return
      await startApi()
      await waitForApi(8000)
    } catch (error) {
      console.error(`[管理服务] 自动恢复失败：${error.message}`)
    } finally {
      state.apiRestarting = false
      state.apiMonitorRunning = false
    }
  }, 5000)
}

function requestBackendShutdown() {
  return new Promise(resolve => {
    const request = http.request(`${API_URL}/api/internal/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    }, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve(null)
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    request.on('error', () => resolve(null))
    request.setTimeout(1500, () => { request.destroy(); resolve(null) })
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

function waitForProcessExit(processHandle, timeoutMs = 20000) {
  return new Promise(resolve => {
    if (!processHandle || processHandle.exitCode !== null || processHandle.killed) return resolve(true)
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      processHandle.removeListener('exit', onExit)
      clearTimeout(timer)
      resolve(value)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    processHandle.once('exit', onExit)
  })
}

async function stopApiProcess() {
  if (state.apiStopping) return
  const processHandle = state.apiProcess
  const pid = state.apiPid || processHandle?.pid
  if (!pid) return
  state.apiStopping = true
  const shutdownInfo = await requestBackendShutdown()
  // Uvicorn closes its listening socket before running the lifespan shutdown
  // that terminates or detaches the tracked processes, so the health probe
  // going offline does not mean the cleanup finished.  Wait for the real
  // process exit; fall back to the probe only when we hold no process handle
  // (e.g. the backend was adopted from an external session).
  const exited = processHandle
    ? await waitForProcessExit(processHandle, 20000)
    : await waitForApiExit(15000)
  // The shutdown response reports whether the "retain Bot processes on exit"
  // behavior is enabled. Bot children live inside this process tree, so the
  // tree kill below would take AstrBot/NapCat down together with the backend.
  // It stays as the fallback for when the retain setting is off or the backend
  // failed to exit gracefully (then plugin processes like DSH also need the
  // forced cleanup).  taskkill is a no-op when the process has already exited.
  const keepBotProcesses = Boolean(shutdownInfo?.keep_bot_processes)
  if (process.platform === 'win32') {
    if (!keepBotProcesses || !exited) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
  } else if (!exited) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  state.apiProcess = null
  state.apiPid = null
  state.apiStopping = false
}

module.exports = {
  configureApiManager,
  startApi,
  waitForApi,
  apiStatus,
  startApiMonitor,
  stopApiProcess,
}