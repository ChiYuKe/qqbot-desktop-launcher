import {  useEffect, useRef, useState  } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { FONT_OPTIONS } from '../constants.js'

// 设置页基础控件：行、开关、面板与界面字体选择。
export function SettingsRow({ title, description, action }) {
  return <div className="settings-row"><div className="settings-row-copy"><strong>{title}</strong><span>{description}</span></div>{action}</div>
}

export function SettingsToggle({ checked, onChange, label }) {
  return <button type="button" className={`settings-toggle ${checked ? 'checked' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>
}

export function SettingsPanel({ title, description, children }) {
  return <section className="settings-panel"><div className="settings-panel-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div></div>{children}</section>
}

export function FontSelect({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const selected = FONT_OPTIONS.find((option) => option.value === value) || FONT_OPTIONS[0]

  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const choose = (nextValue) => {
    onChange(nextValue)
    setOpen(false)
  }

  return <div className={`settings-font-select ${open ? 'open' : ''}`} ref={rootRef}><button type="button" className="settings-font-select-trigger" onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open} aria-label="界面字体选择"><span className="settings-font-select-copy"><strong>{selected.label}</strong><small>{selected.description}</small></span><ChevronDown size={15} className="settings-font-select-chevron" /></button>{open && <div className="settings-font-select-menu" role="listbox" aria-label="界面字体选项">{FONT_OPTIONS.map((option) => { const isSelected = option.value === selected.value; return <button type="button" className={`settings-font-select-option ${isSelected ? 'selected' : ''}`} role="option" aria-selected={isSelected} key={option.value} onClick={() => choose(option.value)}><span><strong>{option.label}</strong><small>{option.description}</small></span>{isSelected && <Check size={14} />}</button> })}</div>}</div>
}

