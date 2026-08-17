import { Volume2 } from 'lucide-react'
import { SettingsPanel, SettingsRow, SettingsToggle } from './controls.jsx'

// 通知设置。
export function NotificationSettings({ preferences, onPreferenceChange, onNotice }) {
  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">应用设置</div><h1>通知</h1><p>管理 GitHub 更新通知和控制台提醒。</p></div><SettingsPanel title="通知中心" description="关闭后将暂停远程通知同步，并隐藏顶部未读提示。"><SettingsRow title="显示更新通知" description="在顶部通知按钮中显示新的控制台更新。" action={<SettingsToggle checked={preferences.notificationsEnabled} onChange={(value) => { onPreferenceChange('notificationsEnabled', value); onNotice(value ? '已开启更新通知' : '已关闭更新通知') }} label="显示更新通知" />} /><SettingsRow title="通知提示音" description="桌面壳支持时播放提示音，浏览器预览不会自动播放声音。" action={<SettingsToggle checked={preferences.notificationSound} onChange={(value) => onPreferenceChange('notificationSound', value)} label="通知提示音" />} /></SettingsPanel><div className="settings-note"><Volume2 size={18} /><span>通知内容只保存最近 50 条，并会随本机设置一起保存在浏览器存储中。</span></div></div>
}

