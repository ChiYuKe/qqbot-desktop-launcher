import {  useState  } from 'react'
import { Check, Download, ExternalLink, FileText, FolderOpen, MoreHorizontal, RefreshCw, RotateCcw, X } from 'lucide-react'
import { downloadAuthenticatedFile } from '../lib/api.js'
import { openExternal } from '../lib/bot.js'

// 运行资源页（NapCat / NoneBot / AstrBot）与首次启动的一键配置弹窗。
export function ResourcePage({ kind, resource, setup, onOpenSetup, onSelect, onRefresh, onBack, officialUrl }) {
  const isNapCat = kind === 'napcat'
  const labels = { nonebot: 'NoneBot', astrbot: 'AstrBot', napcat: 'NapCat' }
  const descriptions = { nonebot: 'NoneBot2 机器人运行环境与插件项目', astrbot: 'AstrBot Agent 机器人运行环境与插件项目', napcat: 'QQ 协议端与 WebUI 运行资源' }
  const title = labels[kind] || kind
  const description = descriptions[kind] || '机器人运行资源'
  const unavailable = !resource
  const valid = Boolean(resource?.valid)
  const missing = resource?.missing
  const installerReady = Boolean(resource?.installer_exists)
  const statusTitle = unavailable ? '等待管理 API' : valid ? `${title} 已就绪` : installerReady && isNapCat ? '等待 NapCatInstaller' : missing === 'qq' ? '缺少 QQ 主程序' : `尚未配置 ${title}`
  const statusDescription = unavailable ? '暂时无法读取本机资源状态，请检查管理服务连接。' : valid ? '控制台可以使用该资源启动 Bot。' : installerReady && isNapCat ? '已找到 NapCatInstaller.exe，一键配置会先执行 OneKey；QQ 下载失败时会切换官方 Shell 版。' : missing === 'qq' ? '已找到 NapCat 启动器，但暂未检测到 QQ.exe。官方 Shell 版会使用本机已安装的 QQ，请先安装 QQ 或选择完整目录。' : `请选择本机已有的 ${title} 目录，或打开官方页面下载。`
  const pathLabel = unavailable ? '等待管理 API' : resource.path || '尚未选择目录'
  const pathState = unavailable ? '状态未知' : valid ? '路径有效' : installerReady ? '等待安装器部署' : missing === 'qq' ? '缺少 QQ.exe' : '路径无效或不存在'
  return <section className="resource-page"><div className="resource-page-header"><div><button className="resource-back" onClick={onBack}><RotateCcw size={14} />返回上一页</button><div className="eyebrow">运行资源</div><h1>{title}</h1><p>{description}</p></div><div className="resource-page-actions"><button className="action-button" onClick={onOpenSetup} disabled={unavailable}><Download size={15} />{setup?.status === 'running' ? '查看配置进度' : '一键配置'}</button><button className="plain-icon" onClick={onRefresh} aria-label="刷新资源状态"><RefreshCw size={16} /></button></div></div><div className={`resource-status-card ${valid ? 'ready' : unavailable ? 'unavailable' : 'missing'}`}><div className="resource-status-icon">{valid ? <Check size={22} /> : <FolderOpen size={22} />}</div><div><strong>{statusTitle}</strong><span>{statusDescription}</span></div><span className="resource-status-pill">{unavailable ? '状态未知' : valid ? '已就绪' : '待设置'}</span></div><section className="resource-card"><div className="resource-card-heading"><div><h2>资源目录</h2><p>控制台会从此目录读取并启动 {title}。</p></div><span className="resource-path-state">{pathState}</span></div><div className="resource-path"><FolderOpen size={16} /><span title={pathLabel}>{pathLabel}</span></div><div className="resource-actions"><button className="secondary" onClick={() => onSelect(kind)} disabled={unavailable}><FolderOpen size={15} />选择本地目录</button><button className="secondary" onClick={() => officialUrl && openExternal(officialUrl)}><Download size={15} />打开官方获取页<ExternalLink size={13} /></button></div></section><section className="resource-help"><strong>首次使用建议</strong><p>{isNapCat ? 'NapCat 会连接已选择的机器人框架；OneBot 反向 WS 地址会根据框架自动配置。' : '一键配置会安装并校验该机器人框架。选择 AstrBot 时，每个 QQ 账号会使用独立的数据和配置目录。'}</p></section></section>
}

export function ResourceSetupModal({ resources, setup, onSetup, onSelect, onRefresh, onClose }) {
  const items = [
    { kind: 'nonebot', label: 'NoneBot', resource: resources.nonebot, file: 'bot.py + pyproject.toml', description: '可选机器人框架，负责运行机器人和插件。' },
    { kind: 'astrbot', label: 'AstrBot', resource: resources.astrbot, file: 'main.py + pyproject.toml', description: '可选机器人框架，使用官方源码和 OneBot 反向 WS。' },
    { kind: 'napcat', label: 'NapCat', resource: resources.napcat, file: 'NapCatWinBootMain.exe', description: '可选协议端，优先执行官方 OneKey；失败时切换 Shell 并使用本机 QQ。' },
  ]
  const [selectedKinds, setSelectedKinds] = useState(() => {
    if (Array.isArray(setup?.kinds) && setup.kinds.length) return setup.kinds.filter((kind) => items.some((item) => item.kind === kind))
    return ['nonebot', 'napcat']
  })
  const setupRunning = setup?.status === 'running'
  const [logDownloading, setLogDownloading] = useState(false)
  const downloadInstallerLog = async () => {
    if (!setup?.installer_log_url || logDownloading) return
    setLogDownloading(true)
    try {
      await downloadAuthenticatedFile(setup.installer_log_url, 'napcat-installer.log')
    } catch (error) {
      window.alert(error.message || '安装器日志下载失败')
    } finally {
      setLogDownloading(false)
    }
  }
  const toggleKind = (kind) => {
    if (setupRunning) return
    setSelectedKinds((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind])
  }

  const taskMap = new Map((Array.isArray(setup?.tasks) ? setup.tasks : []).map((task) => [task.kind, task]))
  const workflowTasks = Array.isArray(setup?.tasks) && setup.tasks.length
    ? setup.tasks
    : items.filter((item) => selectedKinds.includes(item.kind)).map((item) => ({ kind: item.kind, label: item.label, status: 'queued', progress: 0, message: '等待执行' }))
  const statusLabels = { queued: '等待执行', running: '执行中', succeeded: '已完成', failed: '失败' }
  const stepStatusLabels = { queued: '等待', running: '执行中', succeeded: '完成', failed: '失败' }
  const setupStarted = Boolean(setup?.status && setup.status !== 'idle')
  const currentTask = items.find((item) => item.kind === setup?.current_task)?.label || taskMap.get(setup?.current_task)?.label
  const workflowTitle = setup?.status === 'succeeded' ? '配置流程已完成' : setup?.status === 'failed' ? '配置流程未完成' : '正在执行配置流程'

  return <div className="modal-backdrop resource-setup-backdrop"><section className="resource-setup-modal" role="dialog" aria-modal="true" aria-labelledby="resource-setup-title"><div className="modal-header"><div><div className="eyebrow">首次启动设置</div><h2 id="resource-setup-title">准备运行资源</h2><p>按官方流程完成下载、安装、环境配置、协议配置和校验。</p></div><div className="resource-setup-header-actions"><button className="action-button" onClick={() => onSetup(selectedKinds)} disabled={setupRunning || !selectedKinds.length}><Download size={15} />{setupRunning ? '配置中…' : setupStarted ? '重新配置' : '一键配置'}</button><button className="plain-icon resource-setup-refresh" onClick={onRefresh} aria-label="刷新资源状态" title="刷新资源状态"><RefreshCw size={18} /></button><button className="plain-icon resource-setup-close" onClick={onClose} aria-label="收起弹窗" title="收起"><X size={17} /></button></div></div><div className="resource-setup-list">{items.map(({ kind, label, resource, file, required, unavailable, description }) => { const selected = selectedKinds.includes(kind); return <div className={`resource-setup-item setup-option ${selected ? 'selected' : ''} ${unavailable ? 'unavailable' : ''}`} key={kind}><label className="resource-setup-choice"><input type="checkbox" checked={selected} disabled={required || unavailable || setupRunning} onChange={() => toggleKind(kind)} /><span className="resource-setup-check" aria-hidden="true">{selected && <Check size={13} />}</span></label><div className={`resource-setup-icon ${resource?.valid ? 'ready' : ''}`}><FolderOpen size={18} /></div><div className="resource-setup-copy"><strong>{label}<em>{required ? '默认' : unavailable ? '暂未接入' : '可选'}</em></strong><span>{resource?.valid ? '已检测到有效目录，执行时会跳过下载并重新校验配置' : resource?.installer_exists ? '已找到 NapCatInstaller.exe，配置会先下载并部署内置 QQ' : resource?.missing === 'qq' ? '已找到启动器，但缺少 QQ.exe，配置会重新执行官方安装器' : unavailable ? description : `${description} 需要包含 ${file}`}</span><small>{resource?.path || (unavailable ? '暂不参与本次配置' : '尚未配置')}</small></div>{!unavailable && <div className="resource-setup-actions"><button className="secondary" onClick={() => onSelect(kind)} disabled={setupRunning}>选择目录</button></div>}</div> })}</div>{setupStarted && <div className={`resource-setup-progress workflow-panel ${setup.status}`}><div className="resource-setup-progress-heading"><strong>{workflowTitle}</strong><span>{Math.round(setup.progress || 0)}%</span></div>{setup.status === 'running' && <p className="resource-current-task">当前任务：{currentTask || setup.step || '准备中'}</p>}<div className="resource-progress-track"><i style={{ width: `${Math.max(0, Math.min(100, setup.progress || 0))}%` }} /></div><div className="resource-task-list">{workflowTasks.map((task) => <div className={`resource-task-item ${task.status}`} key={task.kind}><div className="resource-task-status" aria-hidden="true">{task.status === 'succeeded' ? <Check size={14} /> : task.status === 'failed' ? <X size={14} /> : task.status === 'running' ? <RefreshCw size={14} /> : <MoreHorizontal size={14} />}</div><div className="resource-task-copy"><strong>{task.label}</strong><span>{task.message || statusLabels[task.status] || '等待执行'}</span>{Array.isArray(task.steps) && <div className="resource-task-steps">{task.steps.map((step) => <span className={step.status} key={step.id}><i />{step.label}<small>{stepStatusLabels[step.status] || step.status}</small></span>)}</div>}</div><span className="resource-task-state">{statusLabels[task.status] || task.status} · {Math.round(task.progress || 0)}%</span></div>)}</div>{setup.message && setup.status !== 'running' && <p className="resource-setup-summary">{setup.message}</p>}{setup.error && <div className="resource-setup-error"><p>{setup.error}</p>{setup.installer_log_url && <button className="resource-log-download" onClick={downloadInstallerLog} disabled={logDownloading}><FileText size={13} />{logDownloading ? '日志下载中…' : '下载安装器日志'}</button>}</div>}</div>}<div className="resource-setup-note">NoneBot、AstrBot 和 NapCat 可分别选择；AstrBot 会为每个账号生成独立的 data/cmd_config.json，NapCat 会按框架写入反向 WS 地址。安装器输出会保存为 napcat-installer.log。</div></section></div>
}
