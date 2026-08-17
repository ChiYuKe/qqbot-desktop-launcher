import {  useEffect, useState  } from 'react'
import { Check, ShieldCheck } from 'lucide-react'
import { SettingsPanel, SettingsRow, SettingsToggle } from './controls.jsx'

// 常规设置：自动刷新与托盘模式。
export function GeneralSettings({ preferences, onPreferenceChange, onNotice }) {
  const [trayOnClose, setTrayOnClose] = useState(true)
  useEffect(() => {
    let active = true
    const configPromise = window.desktopConfig?.get?.()
    if (configPromise) configPromise.then((config) => {
      if (active && config && typeof config.trayOnClose === 'boolean') setTrayOnClose(config.trayOnClose)
    }).catch(() => {})
    return () => { active = false }
  }, [])
  const changeTrayOnClose = (value) => {
    setTrayOnClose(value)
    window.desktopConfig?.setTrayOnClose?.(value)
    onNotice(value ? '已开启托盘模式：关闭窗口后最小化到托盘' : '已关闭托盘模式：关闭窗口将直接退出程序')
  }
  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">系统设置</div><h1>常规</h1><p>控制控制台的启动和数据刷新方式。</p></div><SettingsPanel title="运行方式" description="这些选项只影响本地控制台，不会修改 Bot 配置。"><SettingsRow title="自动刷新状态" description="按固定间隔同步账号、日志和运行资源状态。" action={<SettingsToggle checked={preferences.autoRefresh} onChange={(value) => { onPreferenceChange('autoRefresh', value); onNotice(value ? '已开启自动刷新' : '已关闭自动刷新') }} label="自动刷新状态" />} /><SettingsRow title="托盘模式" description="关闭主窗口时最小化到系统托盘，QQ 机器人继续在后台运行；托盘右键菜单可退出程序。" action={<SettingsToggle checked={trayOnClose} onChange={changeTrayOnClose} label="托盘模式" />} /><SettingsRow title="本地数据" description="主题、字体和设置偏好保存在当前设备的浏览器存储中。" action={<span className="settings-status-badge"><Check size={13} />已启用</span>} /></SettingsPanel><SettingsPanel title="安全提示" description="管理服务仍通过本机 API 访问，账号密码不会写入这里。"><div className="settings-note"><ShieldCheck size={18} /><span>建议仅在可信设备上使用 QQ 控制台，并定期检查 Bot 的登录状态。</span></div></SettingsPanel><div className="settings-actions"><span><strong>设置已自动保存</strong><small>修改后无需额外点击保存</small></span><button type="button" className="secondary" onClick={() => onNotice('当前设置已保存')}>确认</button></div></div>
}

