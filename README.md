# QQBot Desktop Launcher

QQBot Desktop Launcher 是一个面向 QQ Bot 的快速启动桌面端，当前以 NoneBot2 为主要运行框架，兼容 NapCat 作为 QQ 协议端，并通过适配器边界为后续接入其他协议端保留扩展空间。

当前核心组件：

- `NoneBot2`
- `nonebot-adapter-onebot`
- `OneBot v11`
- 反向 WebSocket 连接

## 1. 准备环境

建议使用 Python 3.10 到 3.12。

在 NoneBot 程序目录安装依赖：

```powershell
cd program\NoneBot
..\..\.venv\Scripts\Activate.ps1
pip install -U pip
pip install -e .
```

首次打开桌面控制台时，会检查 `program\NapCat` 和 `program\NoneBot`。如果资源不在默认目录，向导会让你选择本机目录，或打开官方获取页下载后再选择；选择结果会保存到 `data\admin\resources.json`。

有效目录要求：

- NapCat：目录中能找到 `NapCatWinBootMain.exe`
- NoneBot：目录中同时包含 `bot.py` 和 `pyproject.toml`

也可以在左侧“服务”下的 NapCat / NoneBot 页面中重新调整目录。

如果两个资源都没有，也可以在控制台的 NapCat 或 NoneBot 页面点击“一键配置”：控制台会从 NapCat 官方发布页获取 Windows 压缩包，创建基础 NoneBot 项目并在项目虚拟环境中安装 `nonebot2` 与 OneBot 适配器。NapCat 下载包较大，配置期间请保持控制台运行。

## 2. 启动 Bot

```powershell
python program\NoneBot\bot.py
```

默认监听地址：

- `127.0.0.1:8082`
- OneBot v11 反向 WebSocket 地址：`ws://127.0.0.1:8082/onebot/v11/ws`

如果你要同时接两个 QQ 账号，建议启动两个 Bot 实例，分别监听不同端口：

- 账号 1：`ws://127.0.0.1:8082/onebot/v11/ws`
- 账号 2：`ws://127.0.0.1:8083/onebot/v11/ws`

可直接使用项目内置脚本启动：

```powershell
.\start-bot-8082.ps1
.\start-bot-8083.ps1
```

## 3. 连接 QQ 协议端

你还需要一个 OneBot v11 协议实现端，常见选择：

- NapCatQQ
- LLOneBot

在协议端里配置反向 WebSocket 上报地址为：

```text
ws://127.0.0.1:8082/onebot/v11/ws
```

如果是双账号，则第二个账号改为：

```text
ws://127.0.0.1:8083/onebot/v11/ws
```

如果你设置了访问令牌，那么协议端也要配置同样的 token。

## 4. 测试

当前已经内置了这些功能：

- 发送 `/ping`，机器人回复 `pong`
- 发送 `/help`，查看命令菜单
- 发送 `/list_keyword`，查看当前关键词
- 发送 `/oni 词条名`，查询缺氧中文 Wiki
- 发送 `/perf`，查看本机当前性能图
- 指定群聊里普通消息可按概率触发 AI 回复
- `@机器人` 并说一句话，机器人会复读
- 超级用户可以新增和删除关键词
- 超级用户可以用 `/say` 让机器人代发内容

## 5. 管理员命令

在 `.env.prod` 里配置你的 QQ 号为超级用户：

```env
SUPERUSERS=["123456789"]
```

然后可使用：

```text
/say 你好
/add_keyword 早上好=早上好呀
/del_keyword 早上好
```

## 6. 数据存储

NoneBot 的运行数据统一保存在 `program/NoneBot/data`；管理面板自身的数据单独保存在 `data/admin`。

关键词会保存在：

```text
program/NoneBot/data/keywords.json
```

## 7. 缺氧 Wiki 查询

可使用下面这些命令：

```text
/oni 氧气
/缺氧 藻类箱
wiki 石油发电机
```

插件会优先返回最匹配的词条、首段简介和词条链接；如果有相近结果，也会顺带给出几个候选词条。

对应缓存文件保存在：

```text
program/NoneBot/data/oni_wiki/oni_wiki_cache.json
```

## 8. 下一步可加的功能

- 关键词回复
- 群管命令
- 定时任务
- 数据库存储

## 9. 访问控制服务

项目已内置本地插件 `program/NoneBot/plugins/access_control`，结构如下：

```text
program/NoneBot/plugins/access_control/
  __init__.py
  main.py
  handler.py
  service.py
```

- `main.py` 作为插件入口
- `handler.py` 当前不注册群内命令
- `service.py` 负责群白名单、聊天配置和屏蔽 bot QQ 的读写

数据文件保存到：

```text
program/NoneBot/data/access_control/access_control.json
```

目前访问控制主要由 `group_chat` 的群聊管理指令间接使用，例如 `开启聊天` 会把当前群加入白名单并开启聊天。

## 10. 智能体插件

项目已内置本地插件 `program/NoneBot/plugins/agent_chat`，结构如下：

```text
program/NoneBot/plugins/agent_chat/
  __init__.py
  main.py
  handler.py
  service.py
```

- `main.py` 作为插件入口
- `handler.py` 负责命令处理
- `service.py` 负责上下文存储和 DeepSeek 请求逻辑

数据文件保存到：

```text
program/NoneBot/data/agent_chat/agent_chat.json
```

环境变量配置：

```env
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_SYSTEM_PROMPT=你是 QQ 里的猫娘「猫猫」，和群友正常聊天，回答自然、简洁。
DEEPSEEK_GROUP_CHAT_SYSTEM_PROMPT=你是 QQ 群里的猫娘「猫猫」，群聊接话时优先短句自然回复。
```

可用指令：

```text
问智能体 今天天气怎么样
清空智能体对话
查看智能体状态
查看智能体余额
```

`agent_chat` 只通过以上明确指令驱动，不监听普通群聊消息。

## 11. 群聊接话插件

项目已内置本地插件 `program/NoneBot/plugins/group_chat`，结构如下：

```text
program/NoneBot/plugins/group_chat/
  __init__.py
  main.py
  handler.py
  rules.py
  README.md
```

`group_chat` 只负责群聊自动接话和群内聊天配置；`agent_chat` 只负责智能体命令、余额、状态和手动提问。

提示词也已拆分：

- `DEEPSEEK_SYSTEM_PROMPT`：手动使用 `问智能体` 时的提示词
- `DEEPSEEK_GROUP_CHAT_SYSTEM_PROMPT`：群聊自动接话时的提示词

群聊自动接话规则：

- 只在群白名单内生效
- 使用群聊专用提示词接话
- 普通消息按当前群概率和冷却自动触发
- @ 当前 bot 可绕过概率和冷却，但不能绕过群白名单和聊天开关
- 每次回复前会收集最近 6 条群消息作为上下文
- 能识别引用、@、群主、管理员和普通成员身份
- 会跳过其他 bot 消息，并带 bot-loop 熔断，避免多个 bot 互相刷屏

群主或超级管理员可用指令：

```text
聊天帮助
开启聊天 [聊天概率] [聊天冷却]
关闭聊天
查看聊天状态
设置聊天概率 <0-1>
设置聊天冷却 <秒数>
设置屏蔽bot <botQQ...>
清空屏蔽bot
清空聊天上下文
设置好感度 <QQ> <0-100>
调整好感度 <QQ> <+/-数值>
```

示例：

```text
开启聊天 0.25 60
设置聊天概率 0.1
设置聊天冷却 120
设置屏蔽bot 123456789,987654321
查看聊天状态
```

环境变量：

```env
DEEPSEEK_GROUP_CHAT_SYSTEM_PROMPT=你是 QQ 群里的猫娘「猫猫」，群聊接话时优先短句自然回复。
GROUP_CHAT_BOT_USER_IDS=123456789,987654321
```

- `GROUP_CHAT_BOT_USER_IDS` 是全局屏蔽 bot QQ。
- `设置屏蔽bot` 是当前群屏蔽 bot QQ。
- 最终生效列表是“全局屏蔽 + 当前群屏蔽”。

详细说明见：

```text
program/NoneBot/plugins/group_chat/README.md
```
