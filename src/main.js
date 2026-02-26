const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const fs = require('fs');

const store = new Store();
let mainWindow;
let tray;
let lastClipboardText = '';
let clipboardInterval;

// Default settings
const defaultSettings = {
    ttsEnabled: true,
    clipboardMonitoring: true,
    autoSpeak: true,
    speechRate: 1.0,
    voiceName: null,
    volume: 1.0,
    showIpa: true,
    maxHistory: 50
};

// Initialize settings
if (!store.has('ttsEnabled')) {
    store.set(defaultSettings);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 650,
        height: 750,
        resizable: true,
        icon: path.join(__dirname, '../asset/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
        },
        autoHideMenuBar: false
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('minimize', (event) => {
        event.preventDefault();
        mainWindow.hide();
    });

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
        return false;
    });

    const template = [
        {
            label: 'File',
            submenu: [
                { label: 'Clear Entry', accelerator: 'CmdOrCtrl+K', click: () => mainWindow.webContents.send('clear-entry') },
                { type: 'separator' },
                { label: 'Exit', click: () => { app.isQuitting = true; app.quit(); } }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
                { type: 'separator' },
                { label: 'Clear Entry', accelerator: 'CmdOrCtrl+K', click: () => mainWindow.webContents.send('clear-entry') },
                { label: 'Copy IPA', accelerator: 'CmdOrCtrl+Shift+C', click: () => mainWindow.webContents.send('copy-ipa') }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { type: 'separator' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                { label: 'Learn More', click: async () => { await shell.openExternal('https://github.com/needyamin/lingoLearn-phonetics'); } },
                { label: 'Report Issue', click: async () => { await shell.openExternal('https://github.com/needyamin/lingoLearn-phonetics/issues'); } },
                { type: 'separator' },
                { label: 'About Us', click: () => mainWindow.webContents.send('show-about') }
            ]
        }
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

function createTray() {
    const iconPath = path.join(__dirname, '../asset/icon.png');
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show', click: () => mainWindow.show() },
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('LingoLearn Phonetics');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
        mainWindow.show();
    });
}

function startClipboardMonitor() {
    if (clipboardInterval) clearInterval(clipboardInterval);

    clipboardInterval = setInterval(() => {
        if (!store.get('clipboardMonitoring')) return;

        const text = clipboard.readText();
        if (text && text !== lastClipboardText && text.trim().length > 0) {
            lastClipboardText = text;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('clipboard-update', text.trim());
            }
        }
    }, 1000);
}

app.whenReady().then(() => {
    createWindow();
    createTray();
    startClipboardMonitor();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
    }
});

ipcMain.handle('get-settings', () => store.store);
ipcMain.handle('set-setting', (event, key, value) => {
    store.set(key, value);
    if (key === 'clipboardMonitoring' && value === true) {
        lastClipboardText = clipboard.readText();
    }
});
ipcMain.handle('get-ipa-dict', async () => {
    const dictPath = path.join(__dirname, '../asset/cmudict-0.7b-ipa.txt');
    try {
        return fs.readFileSync(dictPath, 'utf-8');
    } catch (e) {
        console.error("Failed to read IPA dict", e);
        return null;
    }
});
ipcMain.handle('get-bangla-dict', async () => {
    const dictPath = path.join(__dirname, '../asset/bangla_dictionary.txt');
    try {
        return fs.readFileSync(dictPath, 'utf-8');
    } catch (e) {
        console.error("Failed to read Bangla dict", e);
        return null;
    }
});
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));
