/* 示例插件前端入口：系统监控页面。
 *
 * 演示插件系统的完整能力：
 * - 注册 React 页面组件（使用 window.React 的 hooks）
 * - 通过 props.api 调用后端接口（自动携带会话令牌）
 * - 动态注入插件自己的样式表（style.css）
 * - 使用 setInterval 轮询刷新数据
 */
(function () {
  'use strict'

  var React = window.React
  var API_BASE = 'http://127.0.0.1:6700'

  // 动态加载插件自己的样式表（不要求会话令牌）。
  var styleLink = document.createElement('link')
  styleLink.rel = 'stylesheet'
  styleLink.href = API_BASE + '/plugin-assets/example-plugin/style.css?v=' + Date.now()
  document.head.appendChild(styleLink)

  function formatUptime(totalSeconds) {
    var seconds = Math.max(0, Math.floor(totalSeconds || 0))
    if (seconds < 60) return seconds + ' 秒'
    var minutes = Math.floor(seconds / 60)
    if (minutes < 60) return minutes + ' 分 ' + (seconds % 60) + ' 秒'
    var hours = Math.floor(minutes / 60)
    if (hours < 24) return hours + ' 小时 ' + (minutes % 60) + ' 分'
    var days = Math.floor(hours / 24)
    return days + ' 天 ' + (hours % 24) + ' 小时'
  }

  // 进度条小部件：显示百分比和数值。
  function Meter(props) {
    var width = Math.max(2, Math.min(100, Number(props.value) || 0))
    return React.createElement('div', { className: 'monitor-meter' },
      React.createElement('div', { className: 'monitor-meter-head' },
        React.createElement('span', null, props.label),
        React.createElement('strong', null, props.valueText || props.value + '%')),
      React.createElement('div', { className: 'monitor-meter-track' },
        React.createElement('div', {
          className: 'monitor-meter-fill ' + (props.tone || ''),
          style: { width: width + '%' },
        })))
  }

  function SystemMonitorPage(props) {
    var api = props.api
    var useState = React.useState
    var useEffect = React.useEffect
    var [overview, setOverview] = useState(null)
    var [processData, setProcessData] = useState({ groups: {}, processes: [] })
    var [error, setError] = useState('')
    var [lastUpdated, setLastUpdated] = useState('')

    useEffect(function () {
      var disposed = false
      var load = function () {
        api('/api/plugins/example/overview')
          .then(function (data) {
            if (disposed) return
            setOverview(data)
            setError('')
            setLastUpdated(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
          })
          .catch(function (err) {
            if (!disposed) setError(err.message)
          })
        api('/api/plugins/example/processes')
          .then(function (data) {
            if (disposed) return
            setProcessData({
              groups: data && data.groups ? data.groups : {},
              processes: data && Array.isArray(data.processes) ? data.processes : [],
            })
          })
          .catch(function () {})
      }
      load()
      var timer = window.setInterval(load, 2000)
      return function () {
        disposed = true
        window.clearInterval(timer)
      }
    }, [api])

    // 结束进程确认弹窗状态。
    var [confirmTarget, setConfirmTarget] = useState(null)
    var [killing, setKilling] = useState(false)

    function openConfirm(proc) {
      setConfirmTarget(proc)
    }

    function closeConfirm() {
      if (!killing) setConfirmTarget(null)
    }

    function doKill() {
      var proc = confirmTarget
      if (!proc) return
      setKilling(true)
      api('/api/plugins/example/kill', {
        method: 'POST',
        body: JSON.stringify({ pid: proc.pid, name: proc.name }),
      })
        .then(function () {
          setConfirmTarget(null)
          setProcessData(function (prev) {
            return {
              groups: prev.groups,
              processes: (prev.processes || []).filter(function (p) { return p.pid !== proc.pid }),
            }
          })
        })
        .catch(function (err) {
          window.alert('结束进程失败：' + (err && err.message ? err.message : String(err)))
        })
        .finally(function () {
          setKilling(false)
        })
    }

    function ConfirmModal() {
      if (!confirmTarget) return null
      var protectedKind = confirmTarget.kind === 'console' || confirmTarget.kind === 'backend'
      var warning = '进程：' + confirmTarget.name + '　PID：' + confirmTarget.pid + '　分组：' + confirmTarget.group + '\n\n' +
        (protectedKind ? '这是关键进程，结束后控制台或管理服务可能崩溃。' : '结束将立即终止该进程，可能导致其相关服务（Bot 框架、NapCat、DeepSeek Harness 等）中断。') +
        '\n\n此操作无法撤销。'
      return React.createElement('div', { className: 'modal-backdrop', onMouseDown: function (event) { if (event.target === event.currentTarget) closeConfirm() } },
        React.createElement('div', { className: 'delete-modal', role: 'alertdialog', 'aria-modal': 'true' },
          React.createElement('div', { className: 'modal-header' },
            React.createElement('div', null,
              React.createElement('div', { className: 'eyebrow' }, '系统监控'),
              React.createElement('h2', null, '结束进程'),
              React.createElement('p', null, '确认结束「' + confirmTarget.name + '」？')),
            React.createElement('button', { type: 'button', className: 'modal-close', onClick: closeConfirm, disabled: killing, 'aria-label': '关闭' }, '×')),
          React.createElement('div', { className: 'delete-warning' }, warning),
          React.createElement('div', { className: 'modal-actions' },
            React.createElement('button', { type: 'button', className: 'secondary', onClick: closeConfirm, disabled: killing }, '取消'),
            React.createElement('button', { type: 'button', className: 'action-button danger', onClick: doKill, disabled: killing }, killing ? '结束中…' : '确认结束'))))
    }

    // 空态：数据还没回来。
    if (!overview) {
      return React.createElement('div', { className: 'monitor-loading' },
        error ? '读取监控数据失败：' + error : '正在采集本机监控数据…')
    }

    var processes = processData.processes || []

    return React.createElement('div', { className: 'monitor-page' },
      // 状态条
      React.createElement('div', { className: 'monitor-status' },
        React.createElement('span', { className: 'monitor-live-dot' }),
        React.createElement('span', null, '实时监控（每 2 秒刷新）'),
        React.createElement('span', null, '仅显示本程序、DSH、Bot 框架与协议端'),
        React.createElement('span', { className: 'monitor-updated' }, '更新于 ' + lastUpdated),
        error && React.createElement('span', { className: 'monitor-error' }, '接口异常：' + error)),

      // 概览卡片
      React.createElement('div', { className: 'monitor-grid' },
        React.createElement('div', { className: 'config-card monitor-card' },
          React.createElement('div', { className: 'config-card-title' },
            React.createElement('div', null,
              React.createElement('strong', null, 'CPU'),
              React.createElement('span', null, overview.cpu_count + ' 核'))),
          React.createElement(Meter, { label: '使用率', value: overview.cpu_percent, tone: overview.cpu_percent > 80 ? 'high' : '' })),
        React.createElement('div', { className: 'config-card monitor-card' },
          React.createElement('div', { className: 'config-card-title' },
            React.createElement('div', null,
              React.createElement('strong', null, '内存'),
              React.createElement('span', null, overview.memory_used + ' / ' + overview.memory_total))),
          React.createElement(Meter, { label: '占用', value: overview.memory_percent, tone: overview.memory_percent > 85 ? 'high' : '' })),
        React.createElement('div', { className: 'config-card monitor-card' },
          React.createElement('div', { className: 'config-card-title' },
            React.createElement('div', null,
              React.createElement('strong', null, '磁盘'),
              React.createElement('span', null, overview.disk_used + ' / ' + overview.disk_total))),
          React.createElement(Meter, { label: '占用', value: overview.disk_percent, tone: overview.disk_percent > 90 ? 'high' : '' })),
        React.createElement('div', { className: 'config-card monitor-card' },
          React.createElement('div', { className: 'config-card-title' },
            React.createElement('div', null,
              React.createElement('strong', null, '本机运行时间'),
              React.createElement('span', null, '自系统启动'))),
          React.createElement('div', { className: 'monitor-uptime' },
            React.createElement('strong', null, formatUptime(overview.uptime_seconds))))),

      // 相关进程列表
      React.createElement('div', { className: 'config-card monitor-processes' },
        React.createElement('div', { className: 'config-card-title' },
          React.createElement('div', null,
            React.createElement('strong', null, '相关进程'),
            React.createElement('span', null, '仅本程序、DSH、Bot 框架与协议端'))),
        processes.length
          ? React.createElement('table', { className: 'monitor-table' },
              React.createElement('thead', null,
                React.createElement('tr', null,
                  React.createElement('th', null, '分组'),
                  React.createElement('th', null, '进程'),
                  React.createElement('th', null, 'PID'),
                  React.createElement('th', null, 'CPU %'),
                  React.createElement('th', null, '内存 %'),
                  React.createElement('th', null, '操作'))),
              React.createElement('tbody', null, processes.map(function (proc, index) {
                return React.createElement('tr', { key: proc.pid || index },
                  React.createElement('td', null,
                    React.createElement('span', { className: 'monitor-kind ' + proc.kind },
                      proc.group + (proc.bot_name ? ' · ' + proc.bot_name : ''))),
                  React.createElement('td', null, proc.name),
                  React.createElement('td', null, proc.pid),
                  React.createElement('td', null, proc.cpu.toFixed(2)),
                  React.createElement('td', null, proc.memory.toFixed(2)),
                  React.createElement('td', null,
                    React.createElement('button', {
                      className: 'action-button danger monitor-kill-cell',
                      onClick: function () { openConfirm(proc) },
                    }, '结束')))
              })))
          : React.createElement('div', { className: 'monitor-empty' }, '没有发现相关进程')),
      // 结束进程确认弹窗：复用宿主 .modal-backdrop / .delete-modal 样式。
      React.createElement(ConfirmModal))
  }

  window.__DSH_PLUGINS__.register({
    id: 'example-plugin',
    pages: {
      'page:example-plugin': SystemMonitorPage,
    },
  })
})()
