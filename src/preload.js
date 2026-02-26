const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
    getIpaDict: () => ipcRenderer.invoke('get-ipa-dict'),
    getBanglaDict: () => ipcRenderer.invoke('get-bangla-dict'),
    onClipboardUpdate: (callback) => ipcRenderer.on('clipboard-update', (_event, value) => callback(value)),
    onClearHistory: (callback) => ipcRenderer.on('clear-history', (_event) => callback()),
    onClearEntry: (callback) => ipcRenderer.on('clear-entry', (_event) => callback()),
    onCopyIpa: (callback) => ipcRenderer.on('copy-ipa', (_event) => callback()),
    onShowSettings: (callback) => ipcRenderer.on('show-settings', (_event) => callback()),
    onShowAbout: (callback) => ipcRenderer.on('show-about', (_event) => callback()),
    openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
