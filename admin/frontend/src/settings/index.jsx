import {  useState  } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import { SETTINGS_SECTIONS } from '../constants.js'
import { AppearanceSettings } from './appearance.jsx'
import { CacheSettings } from './cache.jsx'
import { GeneralSettings } from './general.jsx'
import { NotificationSettings } from './notifications.jsx'
import { ProfileSettings } from './profile.jsx'
import { ServiceSettings } from './services.jsx'
import { ShortcutSettings } from './shortcuts.jsx'
import { ThemePackageSettings } from './theme-package.jsx'

// 设置页外壳：侧栏分区导航与内容渲染。
export function SettingsPage({ theme, themePackage, font, preferences, online, onThemeChange, onThemePackageChange, onFontChange, onPreferenceChange, onBack, onNavigate, onRefresh, onNotice }) {
  const [section, setSection] = useState('外观')
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const filteredSections = query
    ? SETTINGS_SECTIONS.map((group) => ({ ...group, items: group.items.filter((item) => item.label.toLowerCase().includes(query)) })).filter((group) => group.items.length)
    : SETTINGS_SECTIONS

  const chooseSection = (label) => setSection(label)
  const renderContent = () => {
    if (section === '外观') return <AppearanceSettings theme={theme} font={font} preferences={preferences} onThemeChange={onThemeChange} onFontChange={onFontChange} onPreferenceChange={onPreferenceChange} onNotice={onNotice} />
    if (section === '常规') return <GeneralSettings preferences={preferences} onPreferenceChange={onPreferenceChange} onNotice={onNotice} />
    if (section === '个人资料') return <ProfileSettings profileName={preferences.profileName} onProfileNameChange={(value) => onPreferenceChange('profileName', value)} onNotice={onNotice} />
    if (section === '快捷键') return <ShortcutSettings onNotice={onNotice} />
    if (section === '通知') return <NotificationSettings preferences={preferences} onPreferenceChange={onPreferenceChange} onNotice={onNotice} />
    if (section === '主题插件包') return <ThemePackageSettings themePackage={themePackage} onThemePackageChange={onThemePackageChange} onNotice={onNotice} />
    if (section === '缓存清理') return <CacheSettings onNotice={onNotice} />
    return <ServiceSettings online={online} onNavigate={onNavigate} onRefresh={onRefresh} />
  }

  return <section className="settings-shell"><aside className="settings-sidebar"><button className="settings-back" onClick={onBack}><ArrowLeft size={15} />返回上一页</button><div className="settings-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索设置…" aria-label="搜索设置" /></div><div className="settings-nav-list">{filteredSections.length ? filteredSections.map((group) => <div className="settings-group" key={group.title}><div className="settings-group-title">{group.title}</div>{group.items.map(({ label, icon: Icon }) => <button key={label} className={`settings-nav-item ${section === label ? 'active' : ''}`} onClick={() => chooseSection(label)}><Icon size={15} /><span>{label}</span></button>)}</div>) : <div className="settings-search-empty">没有匹配的设置</div>}</div></aside><main className="settings-main">{renderContent()}</main></section>
}

