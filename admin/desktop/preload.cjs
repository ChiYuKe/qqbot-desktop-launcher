const { contextBridge, ipcRenderer } = require('electron')

const tokenArgument = process.argv.find(argument => argument.startsWith('--qq-console-token='))
const apiToken = tokenArgument ? tokenArgument.slice('--qq-console-token='.length) : ''

contextBridge.exposeInMainWorld('desktopInfo', {
  isDesktop: true,
  platform: process.platform,
  apiToken,
})

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.send('window-minimize'),
  toggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
  close: () => ipcRenderer.send('window-close'),
})

contextBridge.exposeInMainWorld('externalLinks', {
  open: (url) => ipcRenderer.invoke('open-external', url),
})

contextBridge.exposeInMainWorld('fileDialog', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
})
