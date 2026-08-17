import { Bot, ChevronRight, RefreshCw, Server, SquareTerminal } from 'lucide-react'
import { SettingsPanel, SettingsRow } from './controls.jsx'

// 服务设置：管理 API 状态与运行资源入口。
export function ServiceSettings({ online, onNavigate, onRefresh }) {
  const resources = [['NapCat', Server], ['NoneBot', SquareTerminal], ['AstrBot', Bot]]
  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">应用设置</div><h1>服务</h1><p>查看管理服务连接状态，并快速打开运行资源配置。</p></div><SettingsPanel title="管理服务" description="控制台会从本机管理 API 读取状态。"><SettingsRow title="管理 API" description="本机 6700 端口的后台服务。" action={<span className={`settings-status-badge ${online ? 'online' : ''}`}><i />{online ? '连接正常' : '等待连接'}</span>} /><div className="settings-actions inline"><span><strong>{online ? '服务在线' : '服务离线'}</strong><small>重新读取账号与资源状态</small></span><button type="button" className="secondary" onClick={onRefresh}><RefreshCw size={14} />刷新状态</button></div></SettingsPanel><SettingsPanel title="运行资源" description="进入对应资源页面可以选择目录或执行一键配置。"><div className="service-entry-list">{resources.map(([label, Icon]) => <button type="button" className="service-entry" key={label} onClick={() => onNavigate(label)}><span className="service-entry-icon"><Icon size={16} /></span><span><strong>{label}</strong><small>打开资源配置</small></span><ChevronRight size={15} /></button>)}</div></SettingsPanel></div>
}

