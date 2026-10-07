// Electron main process: window, native dialogs and file conversion.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertFile, isBpmnFile, isDrawioFile } from '../src/files.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Files passed on the command line ("Open with…", drag onto the .exe).
const filesFromArgs = (argv) => argv.slice(1).filter((a) => isBpmnFile(a) || isDrawioFile(a));

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 600,
    minHeight: 480,
    title: 'BPMN vers draw.io',
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(here, 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    const files = filesFromArgs(process.argv);
    if (files.length) mainWindow.webContents.send('files:add', files);
  });
}

ipcMain.handle('dialog:openFiles', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir des fichiers BPMN',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Fichiers BPMN', extensions: ['bpmn'] },
      { name: 'Fichiers draw.io (restauration du BPMN)', extensions: ['drawio'] },
      { name: 'Tous les fichiers', extensions: ['*'] }
    ]
  });
  return canceled ? [] : filePaths;
});

ipcMain.handle('dialog:chooseFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Dossier de destination',
    properties: ['openDirectory', 'createDirectory']
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('convert', async (_event, file, outDir) => {
  try {
    const result = await convertFile(file, { outDir: outDir || undefined });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, input: file, error: err.message };
  }
});

ipcMain.handle('shell:showItem', (_event, file) => shell.showItemInFolder(file));

// A second launch (e.g. "Open with…" while the app is running) adds its files to this window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const files = filesFromArgs(argv);
    if (files.length) mainWindow.webContents.send('files:add', files);
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
