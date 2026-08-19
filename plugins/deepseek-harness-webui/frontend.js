(function () {
  'use strict'

  window.__DSH_PLUGINS__.register({
    id: 'deepseek-harness-webui',
    // 配置页由插件目录里的 settings.json 声明式渲染，无需自定义 settings 组件。
    webuiItems: [{
      id: 'deepseek-harness-webui',
      label: 'deepseek harness webui',
      port: 3080,
      icon: 'Terminal',
      onClick: async function (context) {
        var result = await context.api('/api/plugins/deepseek-harness-webui/start', { method: 'POST' }, 70000)
        return {
          url: result.url,
          title: 'deepseek harness webui',
          kind: 'plugin',
        }
      },
    }],
  })
})()
