# QQBot Desktop Launcher

这是一个基于 Electron/Chromium 的 Windows 桌面快速启动器，当前主要运行 NoneBot2，并兼容 NapCat；启动时会自动运行本地 FastAPI 管理服务，然后加载 React 管理面板。

## 运行

首次运行：

```powershell
cd admin\desktop
npm install
npm run desktop
```

以后可以直接双击项目根目录的 `start-desktop.ps1`。

首次启动初始化：

- 控制台会检查 NapCat 和 NoneBot 是否存在
- 已有资源可点击“选择”指定目录
- 没有资源可点击下载图标打开官方获取页，下载完成后再选择目录
- 也可以直接点击“一键配置”，自动下载 NapCat、创建 NoneBot 项目并安装运行依赖
- 路径会保存到项目的 `data\admin\resources.json`

NapCat 和 NoneBot 页面也可以随时重新选择资源目录。

## 打包 Windows 启动程序

```powershell
npm run dist:win
```

打包完成后，启动程序位于项目根目录的 `release\QQBot-Desktop-Launcher-Portable.exe` 和 `release\QQBot-Desktop-Launcher-Setup.exe`。两种版本都包含前端、管理 API 和 Python 运行时，可以发给其他 Windows 用户直接安装运行；用户首次配置 Bot 时，再从向导下载 NapCat、NoneBot 或 AstrBot 资源到用户数据目录。

`release\win-unpacked` 是 Electron 的内部解包目录，不要单独复制或运行其中的 exe。
