import { Check, Paintbrush } from 'lucide-react'
import { DEFAULT_THEME_PACKAGE, getThemePackage, THEME_PACKAGES } from '../theme-packages/index.js'
import { SettingsPanel } from './controls.jsx'

// 主题插件包设置。
export function ThemePackageSettings({ themePackage, onThemePackageChange, onNotice }) {
  const currentPackage = getThemePackage(themePackage)
  const choosePackage = (id) => {
    const nextPackage = getThemePackage(id)
    onThemePackageChange(nextPackage.id)
    onNotice(`${nextPackage.label}已启用`)
  }
  const resetPackage = () => choosePackage(DEFAULT_THEME_PACKAGE.id)

  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">外观扩展</div><h1>主题插件包</h1><p>安装并切换控制台的配色插件包，选择后会立即应用并保存到本机。</p></div><SettingsPanel title="已安装主题包" description="主题插件包只改变颜色和强调色，不会影响账号或服务配置。"><div className="theme-package-grid">{THEME_PACKAGES.map((item) => { const selected = item.id === currentPackage.id; return <button type="button" className={`theme-package-card ${selected ? 'selected' : ''}`} key={item.id} onClick={() => choosePackage(item.id)} aria-pressed={selected}><div className={`theme-package-preview theme-package-preview-${item.id}`}><div className="theme-package-preview-top"><i /><i /><i /></div><div className="theme-package-preview-body"><div className="theme-package-preview-nav" /><div className="theme-package-preview-content"><i /><i /><i /></div></div></div><div className="theme-package-card-copy"><span><strong>{item.label}</strong><small>{item.description}</small></span>{selected && <span className="theme-package-check" aria-label="当前已启用"><Check size={13} /></span>}</div><div className="theme-package-card-meta"><span>{item.version}</span><strong>{selected ? '已启用' : '启用'}</strong></div></button> })}</div></SettingsPanel><div className="settings-note"><Paintbrush size={18} /><span>蓝色主题插件包使用海洋蓝强调色，并兼容系统、浅色和深色模式。</span></div><div className="settings-actions"><span><strong>{currentPackage.label}</strong><small>当前主题插件包</small></span><button type="button" className="secondary" onClick={resetPackage}>恢复默认</button></div></div>
}

