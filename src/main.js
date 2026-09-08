const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const Store = require('electron-store');

let autoUpdater;
if (app.isPackaged) {
    try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) { autoUpdater = null; }
}

const store = new Store();
let mainWindow;
let practiceWindow;
let tray;
let lastClipboardText = '';
let clipboardInterval;
let practiceSpeechProcess = null;

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

function openPracticeWindow() {
    if (practiceWindow && !practiceWindow.isDestroyed()) {
        practiceWindow.show();
        practiceWindow.focus();
        return;
    }

    practiceWindow = new BrowserWindow({
        width: 720,
        height: 780,
        minWidth: 560,
        minHeight: 680,
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
    grantMediaPermissions();
    createWindow();
    createTray();
    startClipboardMonitor();
    if (autoUpdater) {
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }
    fetchDictUpdates();

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
const DICT_BASE = 'https://raw.githubusercontent.com/needyamin/lingoLearn-phonetics/main/asset';

function getDictPath(name) {
    const userDir = path.join(app.getPath('userData'), 'dicts');
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    return path.join(userDir, name);
}

function readDict(userPath, bundledPath) {
    try {
        if (fs.existsSync(userPath)) return fs.readFileSync(userPath, 'utf-8');
    } catch (_) {}
    try {
        return fs.readFileSync(bundledPath, 'utf-8');
    } catch (e) {
        console.error('Failed to read dict', e);
        return null;
    }
}

function fetchDictUpdates() {
    const files = [
        { name: 'cmudict-0.7b-ipa.txt', bundled: path.join(__dirname, '../asset/cmudict-0.7b-ipa.txt') },
        { name: 'E2Bdatabase.json', bundled: path.join(__dirname, '../asset/E2Bdatabase.json') }
    ];
    files.forEach(({ name, bundled }) => {
        const userPath = getDictPath(name);
        const url = `${DICT_BASE}/${name}`;
        https.get(url, (res) => {
            if (res.statusCode !== 200) return;
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf-8');
                if (data && data.length > 100) {
                    try { fs.writeFileSync(userPath, data); } catch (_) {}
                    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dicts-updated');
                }
            });
        }).on('error', () => {});
    });
}

ipcMain.handle('get-ipa-dict', async () => readDict(getDictPath('cmudict-0.7b-ipa.txt'), path.join(__dirname, '../asset/cmudict-0.7b-ipa.txt')));
ipcMain.handle('get-bangla-dict', async () => {
    const jsonDict = readDict(getDictPath('E2Bdatabase.json'), path.join(__dirname, '../asset/E2Bdatabase.json'));
    if (jsonDict && jsonDict.trim().startsWith('[')) return jsonDict;
    return readDict(getDictPath('bangla_dictionary.txt'), path.join(__dirname, '../asset/bangla_dictionary.txt'));
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
