# 系统监控

系统监控是 QQBot Desktop Launcher 的示例控制台插件，用于展示控制台、管理后端、机器人框架与 NapCat 协议进程的实时资源使用情况。

## 功能

- 汇总 CPU、内存、磁盘与运行进程数量
- 按控制台、管理后端、NoneBot / AstrBot、NapCat 分组展示进程
- 每 2 秒刷新一次运行状态
- 仅采集 QQBot 运行链路相关进程，不展示无关的系统进程

## 使用方式

1. 在控制台插件管理页启用此插件。
2. 点击卡片底部的“打开页面”。
3. 在“系统监控”导航页查看当前运行状态。

> 停用插件会立即从控制台导航中隐藏其页面；重新启用后会重新加载页面脚本。

## 后端接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/plugins/example/overview` | 返回 CPU、内存、磁盘和 QQBot 运行计数。 |
| `GET /api/plugins/example/processes` | 返回 QQBot 相关进程及其分组统计。 |
| `POST /api/plugins/example/kill` | 结束指定进程（危险操作），请求体 `{ pid, name, tree }`。管理后端与桌面控制台等关键进程会被拒绝保护。 |

## 开发说明

前端入口为 `frontend.js`，后端入口为 `backend.py`。插件目录中可额外放置 `style.css`、图片或字体等静态资源。

```text
plugins/example-plugin/
├── plugin.json
├── README.md
├── frontend.js
├── backend.py
└── style.css
```
