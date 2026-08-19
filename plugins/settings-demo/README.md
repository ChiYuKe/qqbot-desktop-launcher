# 配置渲染示例

这是一个**纯声明式**演示插件，不含任何 `frontend.js` 或 `backend.py`。它只通过
插件目录里的 [`settings.json`](settings.json) 声明配置模式，宿主据此自动渲染
插件管理页中的“配置”弹窗。

## 怎么查看效果

1. 进入「插件管理」→「控制台插件」标签页，找到「配置渲染示例」。
2. 点击卡片打开详情，右上角点击「配置」。
3. 弹窗中的表单由 `settings.json` 自动生成，保存后会写入
   `data/admin/console-plugin-settings.json`（键名为各字段的 `id`）。

## 演示的控件类型

| 字段 id | 类型 | 控件 |
| --- | --- | --- |
| `enabled` | `boolean` | 开关 |
| `nickname` | `text` | 单行输入框（必填） |
| `description_notes` | `textarea` | 多行文本框 |
| `api_token` | `password` | 密码输入框 |
| `interval` | `number` | 数字输入框（min/max/step） |
| `threshold` | `slider` | 范围滑动条 |
| `log_level` | `select` | 下拉选择（对象 options） |
| `hooks_tags` | `select` | 下拉选择（字符串数组 options） |
| `workspace` | `directory` | 目录选择（带“选择”按钮） |
| `config_file` | `file` | 文件选择（带“选择”按钮） |
| `accent_color` | `color` | 颜色选择器 |
| `custom_headers` | `key-value` | 可增删的键值对列表 |

## 说明

- 该插件没有声明导航（`nav`），因此不会出现在左侧菜单，只提供配置入口。
- 想测试后端消费配置，可复制本目录并补上 `backend.py`，通过
  `GET /api/console-plugins/settings-demo/settings` 读取用户保存的值。
- 完整字段类型与属性说明见 plugins 根目录的 `README.md`。