# 控制台插件

QQBot Desktop Launcher 的桌面控制台支持插件扩展。插件放在项目根目录的
`plugins/` 下，每个插件是一个独立目录，改插件 **不需要重新打包**：

- 前端插件：刷新控制台页面即可生效
- 后端插件：重启管理服务（桌面端会自动托管重启）后生效

## 目录结构

```text
plugins/
└── <plugin-id>/
    ├── plugin.json     # 插件清单（必需）
    ├── settings.json   # 声明式配置模式（可选，自动渲染配置页）
    ├── README.md       # 插件说明文档（可选，详情弹窗中渲染）
    ├── frontend.js     # 前端入口（可选）
    ├── backend.py      # 后端入口（可选）
    └── ...             # 其他静态资源（CSS、图片等）
```

## plugin.json 格式

```json
{
  "id": "example-plugin",
  "name": "示例插件",
  "version": "1.0.0",
  "description": "插件描述",
  "author": "作者",
  "readme": "README.md",
  "frontend": "frontend.js",
  "backend": "backend.py",
  "nav": {
    "key": "page:example-plugin",
    "label": "示例插件",
    "icon": "Puzzle"
  }
}
```

字段说明：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | 是 | 插件唯一 id，只能包含字母、数字、`-`、`_`、`.`，最长 64 字符 |
| `name` | 是 | 显示名称 |
| `version` | 否 | 版本号 |
| `description` | 否 | 插件描述 |
| `author` | 否 | 作者 |
| `readme` | 否 | 详情弹窗渲染的 Markdown 文件，相对于插件目录，默认 `README.md` |
| `frontend` | 否 | 前端入口文件名，相对于插件目录 |
| `backend` | 否 | 后端入口文件名，相对于插件目录 |
| `nav` | 否 | 导航声明：`key`（页面 key，必须唯一，建议 `page:<id>`）、`label`（显示名）、`icon`（lucide 图标名，如 `Puzzle`、`Bot`、`Server`，不填默认 `Puzzle`） |

## 从 Git 安装

控制台插件页提供“从 Git 安装”入口。仓库根目录必须包含有效的 `plugin.json`，并且 `id`、`name` 与入口文件路径必须通过校验。支持：

- `https://github.com/owner/plugin.git`
- `ssh://git@host/owner/plugin.git`
- `git@github.com:owner/plugin.git`
- 可选分支或 Tag

如果目标插件 id 已存在，必须在安装弹窗中主动勾选覆盖。安装会先克隆到临时目录，校验通过后再移动到 `plugins/<id>/`，失败不会替换原插件。

带 `backend.py` 的新插件会尝试即时加载后端；覆盖已有插件或后端加载失败时，需要重启管理服务。插件代码拥有与控制台进程相同的本机权限，只安装信任的仓库。

## 声明式配置（settings.json）

如果插件需要用户配置，但不想手写前端配置组件，可以在插件目录里放一个
`settings.json`。宿主会自动读取它，并在插件管理页的“配置”弹窗中**自动渲染**
对应的输入框、滑动条、开关等控件，无需任何 React 代码。

插件也可以只提供 `settings.json`（不需要 `frontend.js` 或 `backend.py`）。

### 基本结构

```json
{
  "fields": [
    {
      "id": "web_port",
      "type": "number",
      "label": "WebUI 端口",
      "default": 3080,
      "min": 1024,
      "max": 65535,
      "description": "本机端口，范围 1024-65535",
      "required": true
    },
    {
      "id": "auto_start",
      "type": "boolean",
      "label": "启动时自动启动",
      "default": false,
      "description": "控制台启动时自动启动服务"
    },
    {
      "id": "root_dir",
      "type": "directory",
      "label": "工作目录",
      "description": "选择包含入口文件的目录"
    },
    {
      "id": "log_level",
      "type": "slider",
      "label": "日志级别",
      "default": 3,
      "min": 1,
      "max": 5,
      "step": 1
    },
    {
      "id": "theme",
      "type": "select",
      "label": "主题",
      "default": "auto",
      "options": [
        { "label": "跟随系统", "value": "auto" },
        { "label": "浅色", "value": "light" },
        { "label": "深色", "value": "dark" }
      ]
    }
  ]
}
```

也可以是更宽松的裸数组形式（等价于上面的 `fields`）：

```json
[
  { "id": "name", "type": "text", "label": "名称", "default": "示例" }
]
```

### 字段通用属性

| 属性 | 说明 |
| --- | --- |
| `id` | 配置项唯一 id，保存进配置 JSON 时的键名 |
| `type` | 控件类型，见下表 |
| `label` | 显示名称（缺省用 `id`） |
| `description` | 控件下方的说明文字 |
| `default` | 默认值（未保存过配置时使用） |
| `required` | 是否必填，保存时校验非空 |

### 字段类型

| type | 渲染控件 | 附加属性 |
| --- | --- | --- |
| `text` | 单行输入框 | `placeholder` |
| `textarea` | 多行文本框 | `placeholder`、`rows` |
| `password` | 密码输入框 | `placeholder` |
| `number` | 数字输入框 | `min`、`max`、`step` |
| `slider` | 范围滑动条 | `min`、`max`、`step` |
| `boolean` / `toggle` | 开关 | — |
| `select` | 下拉选择 | `options: [{label, value}]` |
| `directory` | 输入框 + “选择目录”按钮 | `placeholder` |
| `file` | 输入框 + “选择文件”按钮 | `placeholder` |
| `color` | 颜色选择器 | `default`（如 `#000000`） |
| `key-value` | 可增删的键值对列表 | `keyLabel`、`valueLabel` |

`select` 的 `options` 既可以是 `[{ "label", "value" }]` 对象数组，也可以是
普通字符串数组（`label` 与 `value` 相同）。

### 配置的读写

自动渲染的配置页通过 `GET/PUT /api/console-plugins/<id>/settings` 读写，与
手写组件的接口一致，配置同样保存在 `data/admin/console-plugin-settings.json`。
前端插件组件可通过 `props.api('/api/console-plugins/<id>/settings')` 读取自己
的配置；后端插件也可调用宿主注册表读取。

## 前端插件（frontend.js）

`frontend.js` 是一个普通脚本（IIFE），通过 `window.__DSH_PLUGINS__.register()`
向宿主注册页面组件。宿主暴露 `window.React` 供插件使用。

```js
(function () {
  window.__DSH_PLUGINS__.register({
    id: 'example-plugin',
    pages: {
      'page:example-plugin': function ExamplePage(props) {
        var React = window.React
        var useState = React.useState
        return React.createElement('div', { className: 'example-plugin' },
          React.createElement('h2', null, '来自插件的页面'),
          React.createElement('p', null, '这个页面由控制台插件提供。'))
      },
    },
  })
})()
```

- `pages` 的 key 必须与 `plugin.json` 中 `nav.key` 一致
- 组件是普通的 React 函数组件，可以使用 hooks（`useState`、`useEffect` 等）
- 组件通过 `props` 接收宿主提供的上下文：
  - `theme` / `themePackage` / `font`：当前外观设置
  - `online`：管理 API 是否在线
  - `bots` / `stats` / `napcat` / `resources`：运行数据
  - `active`：当前页面 key
  - `navigate(pageKey)`：跳转到其他页面
  - `notify(message)`：显示提示条
  - `api(path, options)`：调用管理 API（自动携带会话令牌）
  - `refresh()`：刷新面板数据

如果插件需要复杂或自定义的用户配置界面，可以注册一个 `settings` 组件。宿主会在插件管理页显示“配置”按钮，并传入 `api`、`plugin` 和 `onClose`。没有注册 `settings` 组件、但插件目录里有 `settings.json` 的插件，会自动使用声明式配置渲染器生成配置页：

```js
window.__DSH_PLUGINS__.register({
  id: 'example-plugin',
  settings: function SettingsPanel({ api, onClose }) {
    // 通过 GET/PUT /api/console-plugins/example-plugin/settings 读写配置。
    return window.React.createElement('div', null, '插件配置')
  },
})
```

配置由宿主统一保存在 `data/admin/console-plugin-settings.json`，每个插件使用自己的 id 隔离。

插件还可以在注册对象中提供 `webuiItems`，向顶部“切换 WebUI”菜单添加项目：

```js
window.__DSH_PLUGINS__.register({
  id: 'example-plugin',
  webuiItems: [{
    id: 'example-webui',
    label: '示例 WebUI',
    port: 3080,
    icon: 'Terminal',
    onClick: async ({ api }) => {
      const result = await api('/api/plugins/example/start', { method: 'POST' })
      return { url: result.url, title: '示例 WebUI', kind: 'plugin' }
    },
  }],
})
```

`onClick` 会收到宿主上下文，返回包含 `url` 的对象后，控制台会在内嵌 WebUI 页面中打开该地址。

插件还可以把自己的 CSS 放在插件目录里，然后在 `frontend.js` 中通过
`document.head` 动态注入 `<link>` 标签引用（路径为
`/plugin-assets/<id>/style.css`）。

## 后端插件（backend.py）

`backend.py` 定义一个 `register(app)` 函数，在管理服务启动时被调用。
`app` 是 FastAPI 应用实例，插件可以在其中挂载路由。

```python
from fastapi import APIRouter

router = APIRouter(prefix="/api/plugins/example")


@router.get("/hello")
async def hello():
    return {"message": "Hello from example plugin"}


def register(app):
    app.include_router(router)
```

- 路由建议放在 `/api/plugins/<id>/...` 下，这样会自动受会话令牌保护
- 前端插件通过 `props.api('/api/plugins/example/hello')` 调用
- 修改 `backend.py` 后需要重启管理服务
- 插件后端加载失败不会影响控制台启动，错误会显示在插件列表中

## 静态资源

插件目录里的 `.js`、`.css`、`.json`、图片、字体等文件会通过
`/plugin-assets/<id>/<文件名>` 提供（不要求会话令牌，因为 `<script src>`
标签无法携带 Authorization 头）。`backend.py` 等 `.py` 文件不会被公开。

## 安全说明

插件代码在控制台进程内运行，拥有与桌面控制台相同的权限。只安装你信任的
插件。
