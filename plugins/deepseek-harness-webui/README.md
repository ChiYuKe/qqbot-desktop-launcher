# DeepSeek Harness WebUI

这个控制台插件会在顶部“切换 WebUI”菜单中添加 `deepseek harness webui`，点击后从本机 checkout 启动 `dsh web`，并在控制台内嵌打开 DSH 页面。插件管理页中可以点击“配置”，由用户选择自己的 checkout 目录和 WebUI 端口。

## 配置

在“插件管理”→“控制台插件”→“DeepSeek Harness WebUI”→“配置”中设置：

- DSH checkout：选择包含 `package.json` 的 `deepseek-harness` 根目录
- WebUI 端口：默认 `3080`，范围为 `1024-65535`
- 启动时显示命令窗口：默认关闭（后台无窗口启动），开启后显示 `dsh web` 的控制台命令窗口

配置页由插件目录里的 [`settings.json`](settings.json) 声明式渲染，宿主自动生成表单，无需手写前端配置组件。

配置保存在项目 `data/admin/console-plugin-settings.json`，不会写回插件源码。保存配置时会停止当前 DSH 进程，再次从顶部菜单打开即可使用新配置。

## 默认配置

- DSH checkout：`C:\\Users\\Administrator\\Desktop\\Project\\deepseek-harness-desktop\\deepseek-harness`
- WebUI 地址：`http://127.0.0.1:3080`
- 启动命令：`pnpm dsh web --port 3080`
- 进程窗口：默认 Windows 后台无窗口启动（可在配置中改为“显示命令窗口”），合并捕获标准输出和错误输出
- 日志位置：控制台“最近活动”和 WebSocket“实时活动”
- 停用行为：点击插件管理中的“停用”会关闭 DSH 及其子进程

可通过管理服务环境变量覆盖：

- `DSH_ROOT`：DeepSeek Harness checkout 目录
- `DSH_WEB_PORT`：WebUI 端口，默认 `3080`
- `DSH_SHOW_WINDOW`：是否显示启动命令窗口，`1` / `true` / `yes` / `on` 为显示，默认关闭

修改插件后，前端刷新控制台即可生效；修改 `backend.py` 后需要重启管理服务。
