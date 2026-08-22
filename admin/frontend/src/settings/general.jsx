import {  useEffect, useState  } from 'react'
import { Check, ShieldCheck } from 'lucide-react'
import { SettingsPanel, SettingsRow, SettingsToggle } from './controls.jsx'
import { api } from '../lib/api.js'

// 常规设置：自动刷新、托盘模式与退出时的 Bot 进程保留策略。
export function GeneralSettings({ preferences, onPreferenceChange, onNotice }) {
  const [trayOnClose, setTrayOnClose] = useState(true)
  // 后端默认开启保留；先以 true 渲染，读取到实际值后再校正。
  const [keepProcesses, setKeepProcesses] = useState(true)
  useEffect(() => {
    let active = true
    const configPromise = window.desktopConfig?.get?.()
    if (configPromise) configPromise.then((config) => {
      if (active && config && typeof config.trayOnClose === 'boolean') setTrayOnClose(config.trayOnClose)
    }).catch(() => {})
    api('/api/runtime/behavior').then((payload) => {
      if (active && payload && typeof payload.keep_bot_processes_on_exit === 'boolean') setKeepProcesses(payload.keep_bot_processes_on_exit)
    }).catch(() => {})
    return () => { active = false }
  }, [])
  const changeTrayOnClose = (value) => {
    setTrayOnClose(value)
    window.desktopConfig?.setTrayOnClose?.(value)
    onNotice(value ? '已开启托盘模式：关闭窗口后最小化到托盘' : '已关闭托盘模式：关闭窗口将直接退出程序')
  }
  const changeKeepProcesses = (value) => {
    const previous = keepProcesses
    setKeepProcesses(value)
    api('/api/runtime/behavior', { method: 'PUT', body: JSON.stringify({ keep_bot_processes_on_exit: value }) })
      .then(() => onNotice(value ? '已开启：退出控制台后 AstrBot 与 NapCat 将继续运行' : '已关闭：退出控制台时会一并停止 AstrBot 与 NapCat'))
      .catch(() => {
        setKeepProcesses(previous)
        onNotice('保存失败，请确认管理服务在线后重试')
      })
  }
  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">系统设置</div><h1>常规</h1><p>控制控制台的启动和数据刷新方式。</p></div><SettingsPanel title="运行方式" description="这些选项只影响本地控制台，不会修改 Bot 配置。"><SettingsRow title="自动刷新状态" description="按固定间隔同步账号、日志和运行资源状态。" action={<SettingsToggle checked={preferences.autoRefresh} onChange={(value) => { onPreferenceChange('autoRefresh', value); onNotice(value ? '已开启自动刷新' : '已关闭自动刷新') }} label="自动刷新状态" />} /><SettingsRow title="托盘模式" description="关闭主窗口时最小化到系统托盘，QQ 机器人继续在后台运行；托盘右键菜单可退出程序。" action={<SettingsToggle checked={trayOnClose} onChange={changeTrayOnClose} label="托盘模式" />} /><SettingsRow title="退出时保留 Bot 进程" description="退出控制台后 AstrBot 与 NapCat 继续在后台运行，下次启动控制台会自动接管；插件启动的进程仍会被清理。" action={<SettingsToggle checked={keepProcesses} onChange={changeKeepProcesses} label="退出时保留 Bot 进程" />} /><SettingsRow title="本地数据" description="主题、字体和设置偏好保存在当前设备的浏览器存储中。" action={<span className="settings-status-badge"><Check size={13} />已启用</span>} /></SettingsPanel><SettingsPanel title="安全提示" description="管理服务仍通过本机 API 访问，账号密码不会写入这里。"><div className="settings-note"><ShieldCheck size={18} /><span>建议仅在可信设备上使用 QQ 控制台，并定期检查 Bot 的登录状态。</span></div></SettingsPanel><div className="settings-actions"><span><strong>设置已自动保存</strong><small>修改后无需额外点击保存</small></span><button type="button" className="secondary" onClick={() => onNotice('当前设置已保存')}>确认</button></div></div>
}
