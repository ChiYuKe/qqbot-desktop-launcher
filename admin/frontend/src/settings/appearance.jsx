import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { FONT_OPTIONS } from '../constants.js'
import { FontSelect, SettingsPanel, SettingsRow, SettingsToggle } from './controls.jsx'

// 外观设置：主题、界面字体与显示偏好。
export function AppearanceSettings({ theme, font, preferences, onThemeChange, onFontChange, onPreferenceChange, onNotice }) {
  const themeOptions = [
    { value: 'system', label: '系统', icon: Monitor },
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
  ]
  const currentTheme = themeOptions.find((option) => option.value === theme) || themeOptions[0]
  const currentFont = FONT_OPTIONS.find((option) => option.value === font) || FONT_OPTIONS[0]
  const resetAppearance = () => {
    onThemeChange('system')
    onFontChange('system')
    onPreferenceChange('density', 'comfortable')
    onPreferenceChange('reduceMotion', false)
    onNotice('外观设置已恢复默认')
  }

  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">系统设置</div><h1>外观</h1><p>主题、字体和布局偏好会立即应用，并保存到本机。</p></div><section className="settings-section"><h2>主题</h2><div className="theme-options">{themeOptions.map(({ value, label, icon: Icon }) => <button type="button" key={value} className={`theme-option ${theme === value ? 'selected' : ''}`} onClick={() => onThemeChange(value)}><div className={`theme-preview theme-preview-${value}`}><div className="theme-preview-top" /><div className="theme-preview-body"><div /><div /><div /></div><Icon size={15} /></div><span>{label}</span>{theme === value && <Check className="theme-option-check" size={14} />}</button>)}</div></section><SettingsPanel title="界面字体" description="选择控制台使用的字体，中文和数字会同步更新。"><SettingsRow title="字体" description={currentFont.description} action={<FontSelect value={font} onChange={onFontChange} />} /></SettingsPanel><SettingsPanel title="显示偏好" description="调整信息密度和交互动画。"><SettingsRow title="布局密度" description="紧凑布局可以在同一屏显示更多内容。" action={<div className="settings-segmented"><button type="button" className={preferences.density === 'comfortable' ? 'selected' : ''} onClick={() => onPreferenceChange('density', 'comfortable')}>舒适</button><button type="button" className={preferences.density === 'compact' ? 'selected' : ''} onClick={() => onPreferenceChange('density', 'compact')}>紧凑</button></div>} /><SettingsRow title="减少动效" description="关闭按钮和面板的过渡动画。" action={<SettingsToggle checked={preferences.reduceMotion} onChange={(value) => onPreferenceChange('reduceMotion', value)} label="减少动效" />} /></SettingsPanel><div className="settings-actions"><span><strong>{currentTheme.label} · {currentFont.label}</strong><small>当前外观配置</small></span><button type="button" className="secondary" onClick={resetAppearance}>恢复默认</button></div></div>
}

