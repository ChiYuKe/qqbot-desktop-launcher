import { SettingsPanel } from './controls.jsx'

// 快捷键说明。
export function ShortcutSettings({ onNotice }) {
  const shortcuts = [
    ['打开设置', 'Ctrl / ⌘ + ,'],
    ['刷新状态', 'Ctrl / ⌘ + R'],
    ['关闭弹窗', 'Esc'],
    ['切换账号搜索', 'Ctrl / ⌘ + K'],
  ]
  return <div className="settings-content"><div className="settings-page-heading"><div className="eyebrow">个人设置</div><h1>快捷键</h1><p>常用操作的默认快捷键，桌面端会优先响应这些组合键。</p></div><SettingsPanel title="默认快捷键" description="快捷键展示与桌面壳保持一致。"><div className="shortcut-list">{shortcuts.map(([label, key]) => <div className="shortcut-row" key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div></SettingsPanel><div className="settings-actions"><span><strong>默认快捷键</strong><small>当前版本暂不支持自定义组合键</small></span><button type="button" className="secondary" onClick={() => onNotice('快捷键已是默认配置')}>恢复默认</button></div></div>
}

