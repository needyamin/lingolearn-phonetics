const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, session, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
const updater = require('./updater');

let autoUpdater;
if (app.isPackaged && !process.windowsStore) {
    try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) { autoUpdater = null; }
}

const store = new Store();
if (process.platform === 'win32') {
    app.setAppUserModelId('com.needyamin.lingolearn');
}
let mainWindow;
let practiceWindow;
let tray;
let lastClipboardText = '';
let clipboardInterval;
let practiceSpeechProcess = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        showMainWindow();
    });
}

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === 'win32') {
        mainWindow.moveTop();
        mainWindow.setAlwaysOnTop(true);
        mainWindow.setAlwaysOnTop(false);
    }
}

function registerGlobalShortcuts() {
    globalShortcut.unregisterAll();
    const ok = globalShortcut.register('CommandOrControl+Shift+L', () => {
        showMainWindow();
    });
    if (!ok) {
        console.warn('Could not register Ctrl+Shift+L. Another app may already use this shortcut.');
    }
}

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
        height: 820,
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

    mainWindow.webContents.on('context-menu', (event, params) => {
        if (params.isEditable) {
            const ctxMenu = Menu.buildFromTemplate([
                { role: 'cut', enabled: params.editFlags.canCut },
                { role: 'copy', enabled: params.editFlags.canCopy },
                { role: 'paste', enabled: params.editFlags.canPaste },
                { type: 'separator' },
                { role: 'selectAll' }
            ]);
            ctxMenu.popup({ window: mainWindow });
        } else if (params.selectionText && params.selectionText.trim().length > 0) {
            const ctxMenu = Menu.buildFromTemplate([
                { role: 'copy', enabled: true }
            ]);
            ctxMenu.popup({ window: mainWindow });
        }
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

    mainWindow.on('hide', () => {
        maybeInstallWhenIdle();
    });

    mainWindow.setMenuBarVisibility(false);
    Menu.setApplicationMenu(buildAppMenu());
}

function sendToMain(channel) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
}

function buildAppMenu() {
    return Menu.buildFromTemplate([
        {
            label: 'File',
            submenu: [
                { label: 'Clear', accelerator: 'CmdOrCtrl+K', click: () => sendToMain('clear-entry') },
                { label: 'Practice', click: () => openPracticeWindow() },
                { type: 'separator' },
                { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendToMain('show-settings') },
                { type: 'separator' },
                { label: 'Exit', click: () => { app.isQuitting = true; app.quit(); } }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { role: 'resetZoom' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                { label: 'Check for Updates', click: () => updater.checkForAppUpdatesNow() },
                { type: 'separator' },
                { label: 'Privacy Policy', click: () => shell.openExternal('https://github.com/needyamin/lingoLearn-phonetics/blob/main/PRIVACY.md') },
                { label: 'Report Issue', click: () => shell.openExternal('https://github.com/needyamin/lingoLearn-phonetics/issues') }
            ]
        },
        {
            label: 'About',
            click: () => sendToMain('show-about')
        }
    ]);
}

function openPracticeWindow() {
    if (practiceWindow && !practiceWindow.isDestroyed()) {
        practiceWindow.show();
        practiceWindow.focus();
        return;
    }

    practiceWindow = new BrowserWindow({
        width: 640,
        height: 680,
        minWidth: 480,
        minHeight: 540,
        backgroundColor: '#ffffff',
        title: 'English Practice',
        icon: path.join(__dirname, '../asset/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
        },
        autoHideMenuBar: false
    });

    practiceWindow.setMenu(null);
    practiceWindow.loadFile(path.join(__dirname, 'practice.html'));

    practiceWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    practiceWindow.on('closed', () => {
        stopPracticeSpeech();
        practiceWindow = null;
    });
}

function getAsrScriptPath() {
    const fromSrc = path.join(__dirname, 'windows-asr.ps1');
    if (fromSrc.includes(`${path.sep}app.asar${path.sep}`) || fromSrc.includes('/app.asar/')) {
        return fromSrc.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
            .replace('/app.asar/', '/app.asar.unpacked/');
    }
    return fromSrc;
}

function sendPracticeSpeech(kind, text) {
    if (practiceWindow && !practiceWindow.isDestroyed()) {
        practiceWindow.webContents.send('practice-speech', { kind, text: text || '' });
    }
}

function stopPracticeSpeech() {
    if (!practiceSpeechProcess) return;
    const child = practiceSpeechProcess;
    practiceSpeechProcess = null;
    try {
        if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        } else {
            child.kill();
        }
    } catch (_) {}
}

function startPracticeSpeech(payload) {
    stopPracticeSpeech();

    if (process.platform !== 'win32') {
        return { ok: false, error: 'Offline speaking practice currently works on Windows.' };
    }

    const scriptPath = getAsrScriptPath();
    if (!fs.existsSync(scriptPath)) {
        return { ok: false, error: 'Speech helper script was not found.' };
    }

    const encoded = Buffer.from(JSON.stringify(payload || {}), 'utf8').toString('base64');
    const child = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-PayloadB64', encoded
    ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    practiceSpeechProcess = child;
    let buffer = '';

    const consume = (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
            if (!line) continue;
            const idx = line.indexOf(':');
            if (idx < 0) continue;
            sendPracticeSpeech(line.slice(0, idx), line.slice(idx + 1));
        }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', consume);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
        const msg = String(data).trim();
        if (msg) console.error('practice-asr', msg);
    });
    child.on('error', (err) => {
        sendPracticeSpeech('ERROR', err.message || 'Could not start speech recognition.');
    });
    child.on('exit', () => {
        if (practiceSpeechProcess === child) {
            practiceSpeechProcess = null;
            sendPracticeSpeech('ENDED', '');
        }
    });

    return { ok: true };
}

function grantMediaPermissions() {
    const allowed = new Set(['media', 'microphone', 'audioCapture']);
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(allowed.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler(() => true);
}

function createTray() {
    const iconPath = path.join(__dirname, '../asset/icon.png');
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show', accelerator: 'Ctrl+Shift+L', click: () => showMainWindow() },
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('LingoLearn Phonetics  (Ctrl+Shift+L)');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
        showMainWindow();
    });
}

function broadcast(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    if (practiceWindow && !practiceWindow.isDestroyed()) practiceWindow.webContents.send(channel, payload);
}

function maybeInstallWhenIdle() {
    if (!autoUpdater || !updater.isUpdateReady()) return;
    if (practiceWindow && !practiceWindow.isDestroyed()) return;
    setTimeout(() => {
        if (!updater.isUpdateReady()) return;
        if (practiceWindow && !practiceWindow.isDestroyed()) return;
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return;
        updater.installDownloadedUpdate(autoUpdater);
    }, 1800);
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
    grantMediaPermissions();
    createWindow();
    createTray();
    registerGlobalShortcuts();
    startClipboardMonitor();
    updater.startMaterialsSync(store, broadcast);
    if (autoUpdater) updater.setupAppUpdater(autoUpdater, broadcast);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

ipcMain.handle('get-settings', () => store.store);
ipcMain.handle('set-setting', (event, key, value) => {
    store.set(key, value);
    if (key === 'clipboardMonitoring' && value === true) {
        lastClipboardText = clipboard.readText();
    }
});
ipcMain.handle('get-ipa-dict', async () => updater.readMaterial('cmudict-0.7b-ipa.txt'));
ipcMain.handle('get-bangla-dict', async () => {
    const jsonDict = updater.readMaterial('E2Bdatabase.json');
    if (jsonDict && jsonDict.trim().startsWith('[')) return jsonDict;
    return updater.readMaterial('bangla_dictionary.txt');
});
ipcMain.handle('get-practice-lessons', async () => updater.parseLessons(updater.readMaterial('practice-lessons.json')) || []);
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('install-app-update', () => updater.installDownloadedUpdate(autoUpdater));
ipcMain.handle('check-app-update', () => updater.checkForAppUpdatesNow());
ipcMain.handle('app-hide', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    return true;
});
ipcMain.handle('app-quit', () => {
    app.isQuitting = true;
    app.quit();
    return true;
});
ipcMain.handle('app-zoom', (_event, dir) => {
    if (!mainWindow || mainWindow.isDestroyed()) return 0;
    const view = mainWindow.webContents;
    if (dir === 'reset') view.setZoomLevel(0);
    else if (dir === 'in') view.setZoomLevel(view.getZoomLevel() + 0.5);
    else if (dir === 'out') view.setZoomLevel(view.getZoomLevel() - 0.5);
    return view.getZoomLevel();
});
ipcMain.handle('app-fullscreen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
});
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));
ipcMain.handle('open-practice', () => openPracticeWindow());
ipcMain.handle('get-ort-wasm-dir', () => {
    const dir = path.join(__dirname, '../node_modules/onnxruntime-web/dist');
    const unpacked = String(dir)
        .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
        .replace('/app.asar/', '/app.asar.unpacked/');
    let href = pathToFileURL(unpacked).href;
    if (!href.endsWith('/')) href += '/';
    return href;
});
ipcMain.handle('start-practice-speech', (_event, payload) => startPracticeSpeech(payload));
ipcMain.handle('stop-practice-speech', () => {
    stopPracticeSpeech();
    return { ok: true };
});
