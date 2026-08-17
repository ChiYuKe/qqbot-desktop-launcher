import {  useState  } from 'react'
import { SettingsPanel } from './controls.jsx'

// 个人资料设置。
export function ProfileSettings({ profileName, onProfileNameChange, onNotice }) {
  const [draftName, setDraftName] = useState(profileName || '管理员')
  const saveName = () => {
    const value = draftName.trim() || '管理员'
    onProfileNameChange(value)
    setDraftName(value)
    onNotice('个人资料已保存')
  }

  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">个人设置</div><h1>个人资料</h1><p>设置本机控制台中显示的称呼。</p></div><SettingsPanel title="显示信息" description="该名称只用于本机界面，不会同步到 QQ 或机器人平台。"><label className="settings-form-field"><span>显示名称</span><input value={draftName} maxLength={32} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveName() }} placeholder="例如：管理员" /><small>最多 32 个字符。</small></label><div className="settings-actions inline"><span><strong>{draftName.trim() || '管理员'}</strong><small>预览名称</small></span><button type="button" className="action-button" onClick={saveName}>保存资料</button></div></SettingsPanel></div>
}

