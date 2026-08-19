import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, Minus, Plus, X } from 'lucide-react'
import { SettingsSelect, SettingsToggle } from './controls.jsx'

/**
 * 声明式插件配置渲染器。
 *
 * 当插件目录里有 settings.json（声明式配置模式）且插件没有注册自定义
 * settings 组件时，宿主用本组件把配置模式自动渲染成表单：
 *
 * - 字段类型：text / textarea / number / slider / boolean(toggle) /
 *   select / directory / file / color / password / key-value
 * - 通过 GET/PUT /api/console-plugins/<id>/settings 读写配置
 * - 支持 required、min/max/step、placeholder、description 等约束
 */
function defaultValueFor(field) {
  switch (field.type) {
    case 'boolean':
    case 'toggle':
      return false
    case 'number':
    case 'slider':
      return field.min !== undefined ? field.min : 0
    case 'key-value':
      return []
    case 'select':
      return field.options?.[0]?.value ?? ''
    default:
      return ''
  }
}

const STRING_TYPES = new Set(['text', 'password'])

export function AutoSettingsForm({ api, plugin, onClose }) {
  const settingsPath = `/api/console-plugins/${encodeURIComponent(plugin.id)}/settings`
  const settingsSchema = plugin.settingsSchema
  const schema = useMemo(
    () => (Array.isArray(settingsSchema) ? settingsSchema : []),
    [settingsSchema]
  )
  const initial = useMemo(() => {
    const result = {}
    schema.forEach((field) => {
      const id = field.id
      result[id] = field.default !== undefined ? field.default : defaultValueFor(field)
    })
    return result
  }, [schema])

  const [values, setValues] = useState(initial)
  const [loading, setLoading] = useState(schema.length > 0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!schema.length) return undefined
    let active = true
    api(settingsPath)
      .then((data) => {
        if (!active) return
        const settings = (data && typeof data.settings === 'object') ? data.settings : {}
        setValues((prev) => {
          const next = { ...prev }
          schema.forEach((field) => {
            const id = field.id
            if (id in settings) next[id] = settings[id]
          })
          return next
        })
      })
      .catch((reason) => {
        if (active) setError(reason.message || '读取配置失败')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.id])

  const update = (id, value) => setValues((prev) => ({ ...prev, [id]: value }))

  const setNumberValue = (field, raw) => {
    if (raw === '' || raw === undefined || raw === null) {
      update(field.id, '')
      return
    }
    const num = Number(raw)
    update(field.id, Number.isFinite(num) ? num : raw)
  }

  const validate = () => {
    for (const field of schema) {
      if (field.required) {
        const value = values[field.id]
        const empty = value === '' || value === undefined || value === null
          || (Array.isArray(value) && value.length === 0)
        if (empty) return `请填写「${field.label || field.id}」`
      }
      if ((field.type === 'number' || field.type === 'slider') && values[field.id] !== '') {
        const num = Number(values[field.id])
        if (!Number.isFinite(num)) return `「${field.label || field.id}」必须是数字`
        if (field.min !== undefined && num < field.min) return `「${field.label || field.id}」不能小于 ${field.min}`
        if (field.max !== undefined && num > field.max) return `「${field.label || field.id}」不能大于 ${field.max}`
      }
    }
    return ''
  }

  const save = async (event) => {
    event.preventDefault()
    const invalid = validate()
    if (invalid) {
      setError(invalid)
      return
    }
    const payload = {}
    for (const field of schema) {
      let value = values[field.id]
      if (STRING_TYPES.has(field.type) || field.type === 'textarea' || field.type === 'select') {
        value = String(value ?? '')
      }
      payload[field.id] = value
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await api(settingsPath, {
        method: 'PUT',
        body: JSON.stringify({ settings: payload }),
      })
      setNotice('配置已保存。')
    } catch (reason) {
      setError(reason.message || '保存配置失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="plugin-settings-notice">正在读取配置…</div>
  }
  if (!schema.length) {
    return <div className="plugin-settings-notice">插件没有可配置项。</div>
  }

  const choosePath = async (field, kind) => {
    let selected
    try {
      selected = await window.fileDialog?.[kind === 'directory' ? 'selectDirectory' : 'selectFile'](`${plugin.id}-${field.id}`)
    } catch {
      selected = null
    }
    if (!selected) selected = window.prompt(`请输入${field.label || field.id}路径`, values[field.id] || '')
    if (selected) update(field.id, selected)
  }

  return <form className="plugin-settings-form" onSubmit={save}>
    {schema.map((field) => (
      <SettingsField
        key={field.id}
        field={field}
        value={values[field.id]}
        disabled={saving}
        onChange={update}
        onNumberChange={setNumberValue}
        onChoosePath={choosePath}
      />
    ))}
    {notice ? <div className="plugin-settings-notice" role="status">{notice}</div> : null}
    {error ? <div className="plugin-settings-error" role="alert">{error}</div> : null}
    <div className="modal-actions">
      <button type="button" className="secondary" onClick={onClose} disabled={saving}>取消</button>
      <button type="submit" className="action-button" disabled={saving}>{saving ? '保存中…' : '保存配置'}</button>
    </div>
  </form>
}

function SettingsField({ field, value, disabled, onChange, onNumberChange, onChoosePath }) {
  const label = field.label || field.id
  const description = field.description

  const wrap = (control, action = null) => (
    <label>
      <span>{label}{field.required ? ' *' : ''}</span>
      {action ? <div className="plugin-settings-field-with-action"><label style={{ display: 'grid', gap: 0, padding: 0 }}>{control}</label>{action}</div> : control}
      {description ? <small>{description}</small> : null}
    </label>
  )

  switch (field.type) {
    case 'boolean':
    case 'toggle':
      return <div className="settings-row" style={{ minHeight: 'auto', borderBottom: 0 }}><div className="settings-row-copy"><strong>{label}</strong>{description ? <span>{description}</span> : null}</div><SettingsToggle checked={Boolean(value)} onChange={(next) => onChange(field.id, next)} label={label} /></div>

    case 'number':
      return wrap(
        <NumberStepper
          value={value}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={disabled}
          onChange={(raw) => onNumberChange(field, raw)}
        />
      )

    case 'slider': {
      const rangeMin = field.min !== undefined ? field.min : 0
      const rangeMax = field.max !== undefined ? field.max : 100
      const span = rangeMax - rangeMin || 1
      const fill = Math.min(100, Math.max(0, (((Number(value) || rangeMin) - rangeMin) / span) * 100))
      return wrap(
        <div className="settings-slider-row">
          <input
            type="range"
            min={rangeMin}
            max={rangeMax}
            step={field.step !== undefined ? field.step : 1}
            value={Number(value ?? rangeMin)}
            style={{ '--slider-fill': `${fill}%` }}
            onChange={(event) => onNumberChange(field, event.target.value)}
            disabled={disabled}
          />
          <span className="settings-slider-value">{String(value ?? '')}</span>
        </div>
      )
    }

    case 'select':
      return wrap(
        <SettingsSelect
          value={value}
          onChange={(next) => onChange(field.id, next)}
          options={field.options || []}
          disabled={disabled}
          ariaLabel={`选择${label}`}
        />
      )

    case 'directory':
    case 'file':
      return wrap(
        <input
          value={String(value ?? '')}
          onChange={(event) => onChange(field.id, event.target.value)}
          placeholder={field.placeholder}
          spellCheck={false}
          disabled={disabled}
        />,
        <button
          type="button"
          className="secondary"
          onClick={() => onChoosePath(field, field.type)}
          disabled={disabled}
          aria-label={`选择${label}`}
        ><FolderOpen size={14} />选择</button>
      )

    case 'textarea':
      return wrap(
        <textarea
          rows={field.rows || 4}
          value={String(value ?? '')}
          onChange={(event) => onChange(field.id, event.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      )

    case 'color':
      return wrap(
        <ColorField
          value={value}
          disabled={disabled}
          onChange={(next) => onChange(field.id, next)}
        />
      )

    case 'password':
      return wrap(
        <input
          type="password"
          value={String(value ?? '')}
          onChange={(event) => onChange(field.id, event.target.value)}
          placeholder={field.placeholder || (value ? '••••••' : '')}
          autoComplete="new-password"
          disabled={disabled}
        />
      )

    case 'key-value':
      return <KeyValueList field={field} value={value} disabled={disabled} onChange={onChange} />

    case 'text':
    default:
      return wrap(
        <input
          value={String(value ?? '')}
          onChange={(event) => onChange(field.id, event.target.value)}
          placeholder={field.placeholder}
          spellCheck={false}
          disabled={disabled}
        />
      )
  }
}

// 数字输入：隐藏原生箭头，改用自定义 -/+ 步进按钮（受 min/max/step 约束）。
function NumberStepper({ value, min, max, step = 1, disabled, onChange }) {
  const numValue = (() => {
    const n = Number(value)
    return value === '' || value === undefined || value === null || !Number.isFinite(n) ? NaN : n
  })()

  const applyStep = (direction) => {
    const base = Number.isFinite(numValue) ? numValue : Number(min ?? 0)
    let next = base + direction * step
    if (min !== undefined && next < min) next = min
    if (max !== undefined && next > max) next = max
    onChange(String(next))
  }

  const atMin = min !== undefined && Number.isFinite(numValue) && numValue <= min
  const atMax = max !== undefined && Number.isFinite(numValue) && numValue >= max

  return (
    <div className="plugin-settings-number">
      <input
        type="text"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={value === undefined || value === null ? '' : value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
      <div className="plugin-settings-number-steps">
        <button
          type="button"
          className="plain-icon"
          onClick={() => applyStep(-1)}
          disabled={disabled || atMin}
          aria-label="减少"
        ><Minus size={13} /></button>
        <button
          type="button"
          className="plain-icon"
          onClick={() => applyStep(1)}
          disabled={disabled || atMax}
          aria-label="增加"
        ><Plus size={13} /></button>
      </div>
    </div>
  )
}

// 颜色选择：不使用原生取色弹窗，改为「色块 + HEX 输入框」；支持 #RGB / #RRGGBB。
function normalizeHex(input) {
  const raw = String(input ?? '').trim().toLowerCase()
  if (!raw.startsWith('#')) return ''
  let hex = raw.slice(1)
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : ''
}

function ColorField({ value, disabled, onChange }) {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const current = normalizeHex(value) || '#000000'

  const commit = (raw) => {
    const normalized = normalizeHex(raw)
    setEditing(false)
    if (normalized) onChange(normalized)
  }

  return (
    <div className={`plugin-settings-color ${disabled ? 'disabled' : ''}`}>
      <span className="plugin-settings-color-swatch" style={{ background: current }} aria-hidden />
      <input
        type="text"
        spellCheck={false}
        value={editing ? draft : current}
        onFocus={() => { setEditing(true); setDraft(current) }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit(draft)
          }
        }}
        disabled={disabled}
      />
    </div>
  )
}

function KeyValueList({ field, value, disabled, onChange }) {
  const raw = Array.isArray(value) ? value : []
  // 每行是一个 { key, value } 对象；从原始数组（可能是字符串数组或对象数组）归一化。
  const rows = raw.length
    ? raw.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return { key: String(item.key ?? ''), value: String(item.value ?? '') }
      }
      return { key: String(item ?? ''), value: '' }
    })
    : [{ key: '', value: '' }]

  const commit = (nextRows) => {
    const cleaned = nextRows
      .filter((row) => String(row.key).trim() !== '')
      .map((row) => ({ key: String(row.key).trim(), value: String(row.value) }))
    onChange(field.id, cleaned.length ? cleaned : [])
  }

  const updateRow = (index, patch) => {
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const removeRow = (index) => {
    const next = rows.filter((_, i) => i !== index)
    commit(next.length ? next : [{ key: '', value: '' }])
  }

  const addRow = () => {
    commit([...rows, { key: '', value: '' }])
  }

  return <div className="settings-key-value">
    <span className="settings-key-value-label">{field.label}{field.required ? ' *' : ''}</span>
    {field.description ? <small>{field.description}</small> : null}
    <div className="settings-key-value-list">
      {rows.map((row, index) => (
        <div className="settings-key-value-row" key={index}>
          <input
            value={row.key}
            onChange={(event) => updateRow(index, { key: event.target.value })}
            placeholder={field.keyLabel || '键'}
            disabled={disabled}
          />
          <input
            value={row.value}
            onChange={(event) => updateRow(index, { value: event.target.value })}
            placeholder={field.valueLabel || '值'}
            disabled={disabled}
          />
          <button
            type="button"
            className="plain-icon"
            onClick={() => removeRow(index)}
            disabled={disabled || rows.length === 1}
            aria-label="删除这一项"
          ><X size={14} /></button>
        </div>
      ))}
    </div>
    <button type="button" className="secondary" onClick={addRow} disabled={disabled}>添加</button>
  </div>
}
