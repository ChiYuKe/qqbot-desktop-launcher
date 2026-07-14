# QQBot Desktop Launcher

QQBot Desktop Launcher 是一个面向 QQ Bot 的本地桌面启动与管理端，当前以 NoneBot2 为主要运行框架，兼容 NapCat 作为 QQ 协议端，并通过适配器边界为后续接入其他协议端保留扩展空间。桌面端采用 Electron + React/Vite + FastAPI 的分层架构；Electron 负责窗口、桌面生命周期和管理 API 的启动，账号管理、NapCat/OneBot 进程、日志、事件和数据持久化由 FastAPI 后端负责。

```text
React/Vite
    │ HTTP + WebSocket
Electron 桌面宿主
    │ 本地管理 API
FastAPI API
    │
BotService → BotManager → NapCatAdapter / OneBotAdapter
    │              │
SQLite Repository  EventBus → 日志与实时界面
```

## 后端目录

```text
backend/
├── api/          兼容现有 /api/* 接口
├── adapter/      NapCat、OneBot、子进程适配器
├── database/     SQLite 数据仓储与 bots.json 一次性迁移
├── domain/       Bot 模型和领域错误
├── event/        实时事件总线
├── manager/      Bot 生命周期编排
├── plugin/       插件注册边界
├── service/      业务用例
└── websocket/    /ws/events 实时推送
```

当前协议适配器是本地 NapCat + NoneBot/OneBot v11；以后增加其他协议时只需要新增 Adapter，并由 BotManager 编排，不需要改 React 页面。

## 启动前端

```powershell
cd admin/frontend
npm install
npm run dev
```

## 启动管理 API

```powershell
cd ..
..\.venv\Scripts\python.exe -m uvicorn server:app --host 127.0.0.1 --port 6700
```

也可以从项目根目录运行 `start-desktop.ps1`，它会构建前端并启动桌面程序；Electron 会复用已经运行的 6700 端口 API，不会重复启动管理服务。

当前 UI 不预置任何假账号。点击“新建账号”填写真实名称、QQ 号和端口后，配置会保存到 `data/admin/bots.db`，并自动生成该实例的独立启动脚本；之后即可在面板中启动、停止和重启。已有 `data/admin/bots.json` 会在首次启动时自动迁移。

点击 Bot 的“启动”时，管理器会先启动本机 NapCat，再启动 NoneBot。默认 NapCat 路径为 `program\NapCat\app\NapCat.44498.Shell\NapCatWinBootMain.exe`；如果安装位置不同，可设置环境变量 `NAPCAT_DIR` 指向包含 `NapCatWinBootMain.exe` 的目录。
