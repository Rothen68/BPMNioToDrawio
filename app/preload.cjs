// Exposes a minimal, safe API to the window.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  convert: (file, outDir) => ipcRenderer.invoke('convert', file, outDir),
  showItem: (file) => ipcRenderer.invoke('shell:showItem', file),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onFilesAdded: (callback) => ipcRenderer.on('files:add', (_event, files) => callback(files))
});
