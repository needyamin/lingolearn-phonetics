const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, session, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
const lensEngine = require('./lens-engine');
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
let lensWindow = null;
let lensHideTimer = null;
let lensCaptureInFlight = false;
let suppressNextClipboardText = null;
let lensWatcher = null;
let lensWatcherRestarts = 0;
let lastCursorPoint = null;
let pendingPosRequest = null;
// Anchor (cursor) point the popup is currently pinned to, so a resize keeps it
// next to the same spot instead of jumping.
let lensAnchorPoint = null;
// Last content height the renderer reported, reused as the pre-show size so the
// popup does not visibly grow/jump right after appearing.
let lensLastContentHeight = 0;
// Last text rendered in the popup. Used to avoid re-popping the same text when
// the user copies what is already being shown.
let lastShownLensText = '';

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
    const lensOk = globalShortcut.register('CommandOrControl+Shift+G', () => {
        captureSelectionViaHotkey();
    });
    if (!lensOk) {
        console.warn('Could not register Ctrl+Shift+G. Another app may already use this shortcut.');
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
    showBangla: true,
    // Popup (translate screen / Lens) controls
    lensEnabled: true,
    lensOnCopy: true,
    lensSpeakTarget: 'source',
    lensTheme: 'auto',
    lensMaxSelection: 600,
    lensShowDictionary: true,
    lensAutoHideSeconds: 20,
    lensPosition: 'cursor',
    // Per-source speak controls
    speakOnSelection: true,
    speakOnCopy: true,
    // Behaviour toggles
    minimizeToTray: true,
    launchAtLogin: true,
    startMinimized: true,
    // Speaking practice (speech recognition tuning)
    practiceSensitivity: 'normal',
    practiceModel: 'small',
    practiceUsePrompt: true,
    maxHistory: 50
};

// Initialize settings
if (!store.has('ttsEnabled')) {
    store.set(defaultSettings);
}

// Was this run launched automatically at sign-in?
function launchedAtLogin() {
    try {
        return app.getLoginItemSettings().wasOpenedAtLogin === true;
    } catch (_) {
        // Not available on every platform; treat as a normal launch.
        return false;
    }
}

// Turn "start with Windows/macOS login" on or off to match the setting.
function applyLaunchAtLogin(enabled) {
    try {
        // openAsHidden is Windows-only; macOS uses open at login instead.
        const open = { openAtLogin: !!enabled };
        if (process.platform === 'win32') {
            open.openAsHidden = store.get('startMinimized', true) !== false;
        }
        if (process.platform === 'linux') {
            open.path = process.execPath;
        }
        app.setLoginItemSettings(open);
    } catch (err) {
        console.warn('Could not update startup setting:', err && err.message);
    }
}

function syncLaunchAtLogin() {
    applyLaunchAtLogin(store.get('launchAtLogin', true) !== false);
}

function createWindow() {
    // Only auto-start-in-tray should keep the window hidden; a normal launch
    // shows it once it is ready.
    const silent = launchedAtLogin() && store.get('startMinimized', true) !== false;
    mainWindow = new BrowserWindow({
        width: 700,
        height: 840,
        minWidth: 460,
        minHeight: 540,
        show: false,
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
        if (store.get('minimizeToTray', true) === false) return; // let it minimise normally
        event.preventDefault();
        mainWindow.hide();
    });

    mainWindow.on('close', (event) => {
        if (!app.isQuitting && store.get('minimizeToTray', true) !== false) {
            event.preventDefault();
            mainWindow.hide();
            return false;
        }
    });

    mainWindow.on('hide', () => {
        maybeInstallWhenIdle();
    });

    // The GUI is taking focus; the popup has nothing to add here.
    mainWindow.on('show', () => {
        if (lensWindow && !lensWindow.isDestroyed() && lensWindow.isVisible()) hideLensWindow();
    });

    // Show on ready unless this run should stay in the tray (auto-start).
    mainWindow.once('ready-to-show', () => {
        if (!silent && mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
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
        width: 660,
        height: 760,
        minWidth: 460,
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

function createLensWindow() {
    if (lensWindow && !lensWindow.isDestroyed()) return lensWindow;
    lensWindow = new BrowserWindow({
        width: 420,
        height: 240,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        focusable: true,
        alwaysOnTop: true,
        hasShadow: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
        }
    });
    lensWindow.setAlwaysOnTop(true, 'screen-saver');
    lensWindow.loadFile(path.join(__dirname, 'lens.html'));
    lensWindow.on('blur', () => {
        if (lensWindow && !lensWindow.isDestroyed() && lensWindow.isVisible()) {
            hideLensWindow();
        }
    });
    return lensWindow;
}

function hideLensWindow() {
    if (lensHideTimer) {
        clearTimeout(lensHideTimer);
        lensHideTimer = null;
    }
    if (lensWindow && !lensWindow.isDestroyed() && lensWindow.isVisible()) {
        lensWindow.webContents.send('lens-hidden');
        lensWindow.hide();
    }
    sendWatcherCommand('WATCH:0');
}

function scheduleLensAutoHide() {
    if (lensHideTimer) clearTimeout(lensHideTimer);
    // 0 disables auto-hide entirely (the popup stays until dismissed).
    const seconds = Number(store.get('lensAutoHideSeconds', 20));
    const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    if (!ms) return;
    lensHideTimer = setTimeout(() => {
        hideLensWindow();
    }, ms);
}

function positionLensWindow(point) {
    if (!lensWindow || lensWindow.isDestroyed()) return;
    try {
        // Prefer an explicit point from the trigger; otherwise fall back to the
        // live cursor. Remember it so a later resize keeps the same anchor.
        const anchor = point && Number.isFinite(point.x) && Number.isFinite(point.y)
            ? point
            : (lastCursorPoint || screen.getCursorScreenPoint());
        lensAnchorPoint = anchor;

        const display = screen.getDisplayNearestPoint(anchor);
        const area = display.workArea;
        // Use the *current* size (after any setSize/setContentSize) so clamping
        // is accurate and the popup never lands off-screen.
        const [width, height] = lensWindow.getSize();

        // A fixed spot centres the popup horizontally, near the top; the
        // default 'cursor' mode hugs the point like a tooltip.
        const mode = store.get('lensPosition', 'cursor');
        const gap = 8;
        let x;
        let y;
        if (mode === 'center') {
            x = area.x + Math.round((area.width - width) / 2);
            y = area.y + Math.round(area.height * 0.18);
        } else {
            // Horizontal: prefer the right of the cursor, otherwise left.
            x = anchor.x + gap;
            if (x + width > area.x + area.width) x = anchor.x - width - gap;

            // Vertical: prefer BELOW the cursor. Only lift it above when there
            // is genuinely no room below AND the space above is better — and
            // even then keep it as close to the cursor as possible instead of
            // jumping to the far top of the screen.
            y = anchor.y + gap;
            const overflowBelow = (y + height) - (area.y + area.height);
            if (overflowBelow > 0) {
                const spaceAbove = anchor.y - area.y - gap;
                if (spaceAbove >= height) {
                    // Fits above the cursor: sit directly above it.
                    y = anchor.y - height - gap;
                } else {
                    // Not enough room either side: pin to the cursor and let it
                    // extend downward, only shifting up by the overflow amount.
                    y = anchor.y + gap - overflowBelow;
                }
            }
        }

        if (x < area.x) x = area.x;
        if (x + width > area.x + area.width) x = area.x + area.width - width;
        if (y < area.y) y = area.y;
        if (y + height > area.y + area.height) y = area.y + area.height - height;

        lensWindow.setPosition(Math.round(x), Math.round(y), false);
    } catch (err) {
        console.warn('lens position failed', err && err.message);
    }
}

function showLensWindow(point) {
    if (!lensWindow || lensWindow.isDestroyed()) createLensWindow();
    // Reuse the last measured height so the pre-show position is already close
    // to the final one; the renderer's resize then only fine-tunes it. This
    // avoids the popup visibly growing/jumping after it appears.
    const h = lensLastContentHeight || 240;
    try { lensWindow.setContentSize(420, h + 16); } catch (_) {}
    positionLensWindow(point);
    lensWindow.showInactive();
    scheduleLensAutoHide();
    sendWatcherCommand('WATCH:1');
}

function getLensScriptPath() {
    const fromSrc = path.join(__dirname, 'capture-selection.ps1');
    if (fromSrc.includes(`${path.sep}app.asar${path.sep}`) || fromSrc.includes('/app.asar/')) {
        return fromSrc.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
            .replace('/app.asar/', '/app.asar.unpacked/');
    }
    return fromSrc;
}

function getLensWatcherPath() {
    const fromSrc = path.join(__dirname, 'selection-watch.ps1');
    if (fromSrc.includes(`${path.sep}app.asar${path.sep}`) || fromSrc.includes('/app.asar/')) {
        return fromSrc.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
            .replace('/app.asar/', '/app.asar.unpacked/');
    }
    return fromSrc;
}

function sendWatcherCommand(cmd) {
    if (!lensWatcher || !lensWatcher.stdin || lensWatcher.stdin.destroyed) return false;
    try {
        lensWatcher.stdin.write(cmd + '\n');
        return true;
    } catch (_) {
        return false;
    }
}

// Ask the watcher for the cursor position it last observed. Resolves with a
// {x,y} point, or null when the watcher is unavailable or does not answer in
// time. Falls back to the cached point so the copy popup never anchors at a
// stale screen-centre default.
function requestCursorPoint(timeoutMs = 120) {
    return new Promise((resolve) => {
        const fallback = () => {
            if (lastCursorPoint) return lastCursorPoint;
            try { return screen.getCursorScreenPoint(); } catch (_) { return null; }
        };
        if (!sendWatcherCommand('POS')) {
            resolve(fallback());
            return;
        }
        let settled = false;
        let timer = null;
        const done = (point) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (pendingPosRequest === done) pendingPosRequest = null;
            resolve(point || fallback());
        };
        timer = setTimeout(() => done(null), timeoutMs);
        pendingPosRequest = done;
    });
}

function startLensWatcher() {
    if (process.platform !== 'win32') return;
    if (lensWatcher && !lensWatcher.killed) return;
    const scriptPath = getLensWatcherPath();
    if (!fs.existsSync(scriptPath)) {
        console.warn('selection-watch.ps1 not found:', scriptPath);
        return;
    }

    let child;
    try {
        child = spawn('powershell.exe', [
            '-NoProfile',
            '-STA',
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath
        ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
        console.warn('Could not start the selection watcher.', err && err.message);
        return;
    }

    lensWatcher = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) handleWatcherLine(line.trim());
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
        const msg = String(data).trim();
        if (msg) console.warn('selection-watch:', msg);
    });
    child.on('error', (err) => {
        console.warn('selection watcher error.', err && err.message);
    });
    child.on('exit', () => {
        if (lensWatcher === child) lensWatcher = null;
        if (app.isQuitting) return;
        if (lensWatcherRestarts >= 5) {
            console.warn('Selection watcher stopped repeatedly; auto popup disabled for this session.');
            return;
        }
        lensWatcherRestarts += 1;
        setTimeout(() => startLensWatcher(), 4000);
    });

    sendWatcherCommand('HOSTPID:' + process.pid);
    sendWatcherCommand('AUTO:' + (store.get('lensEnabled', true) ? '1' : '0'));
}

function handleWatcherLine(line) {
    if (!line) return;
    if (line === 'READY') {
        lensWatcherRestarts = 0;
        sendWatcherCommand('HOSTPID:' + process.pid);
        sendWatcherCommand('AUTO:' + (store.get('lensEnabled', true) ? '1' : '0'));
        console.log('[Lens] selection watcher ready. Select text anywhere to translate.');
        return;
    }
    let payload = null;
    try {
        payload = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
    } catch (_) {
        return;
    }
    if (!payload || payload.pong) return;
    if (payload.pos) {
        const point = { x: Number(payload.x) || 0, y: Number(payload.y) || 0 };
        lastCursorPoint = point;
        if (pendingPosRequest) {
            const resolve = pendingPosRequest;
            pendingPosRequest = null;
            resolve(point);
        }
        return;
    }
    if (payload.hook !== undefined) {
        if (payload.hook === false) {
            console.warn('[Lens] MOUSE HOOK FAILED (err ' + payload.err + '). The selection popup will not work. Antivirus software may block mouse hooks.');
        } else {
            console.log('[Lens] mouse hook installed.');
        }
        return;
    }
    if (payload.cliptest !== undefined) {
        console.log('[Lens] clipboard self-test ' + (payload.cliptest ? 'OK.' : 'FAILED.'));
        return;
    }
    if (payload.dismiss) {
        if (lensWindow && !lensWindow.isDestroyed() && lensWindow.isVisible()) {
            try {
                const b = lensWindow.getBounds();
                const inside = payload.x >= b.x && payload.x <= b.x + b.width && payload.y >= b.y && payload.y <= b.y + b.height;
                if (!inside) hideLensWindow();
            } catch (_) {}
        }
        return;
    }
    if (payload.ok && typeof payload.text === 'string' && payload.text.trim()) {
        const point = { x: Number(payload.x) || 0, y: Number(payload.y) || 0 };
        if (isPointInsideOwnWindows(point)) return;
        // Mark this text as handled synchronously: the watcher's own Ctrl+C can
        // make the clipboard monitor race to "copy" the very same text, and we
        // must never double-pop it.
        lastShownLensText = String(payload.text).replace(/\s+/g, ' ').trim();
        showLens(payload.text, point, 'selection');
    }
}

function isPointInsideOwnWindows(point) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win || win.isDestroyed() || !win.isVisible()) continue;
        // The popup itself must never count: a selection ending near the popup
        // would otherwise be silently dropped, which looks like "selection
        // sometimes does nothing".
        if (win === lensWindow) continue;
        try {
            const b = win.getBounds();
            if (point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height) {
                return true;
            }
        } catch (_) {}
    }
    return false;
}

// True only while the user is actively using one of the app's own GUI windows
// (main or practice). A window that merely exists — hidden to tray, minimised,
// or behind another app — must NOT suppress the popup, otherwise selecting text
// anywhere would stop working.
function isOwnGuiActive() {
    for (const win of [mainWindow, practiceWindow]) {
        if (!win || win.isDestroyed() || !win.isVisible()) continue;
        try {
            if (win.isMinimized()) continue;
            if (win.isFocused()) return true;
        } catch (_) {}
    }
    return false;
}

function captureSelectionViaHotkey() {
    if (process.platform !== 'win32') return;
    if (sendWatcherCommand('CAPTURE')) return;
    runFallbackCapture();
}

function runFallbackCapture() {
    if (lensCaptureInFlight) return;
    if (process.platform !== 'win32') return;

    const scriptPath = getLensScriptPath();
    if (!fs.existsSync(scriptPath)) {
        console.warn('capture-selection.ps1 not found:', scriptPath);
        return;
    }

    lensCaptureInFlight = true;
    let child;
    let settled = false;
    try {
        child = spawn('powershell.exe', [
            '-NoProfile',
            '-STA',
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
        lensCaptureInFlight = false;
        console.warn('Could not start selection capture.', err && err.message);
        return;
    }

    const finish = () => {
        if (settled) return;
        settled = true;
        lensCaptureInFlight = false;
        // Resync after the helper restored the original clipboard so the
        // monitor never re-shows the restored text as a fresh copy.
        suppressNextClipboardText = clipboard.readText() || null;
        lastClipboardText = clipboard.readText() || '';
    };

    const killTimer = setTimeout(() => {
        try {
            if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        } catch (_) {}
        finish();
    }, 4000);

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const payload = JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
                if (payload && payload.ok && typeof payload.text === 'string' && payload.text.trim()) {
                    showLens(payload.text, undefined, 'hotkey');
                }
            } catch (_) {
                // Ignore malformed output; the capture simply fails silently.
            }
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
        const msg = String(data).trim();
        if (msg) console.warn('capture-selection:', msg);
    });
    child.on('error', (err) => {
        console.warn('selection capture failed to start.', err && err.message);
        clearTimeout(killTimer);
        finish();
    });
    child.on('exit', () => {
        clearTimeout(killTimer);
        finish();
    });
}

async function showLens(rawText, point, source) {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (!text || !/\p{L}/u.test(text)) return;
    // The GUI handles translation itself, so don't cover it while the user is
    // actively working in it. Merely being visible (tray/background) must not
    // block the popup.
    if (isOwnGuiActive()) return;
    // Trigger pattern:
    //   - Selecting text always shows the popup.
    //   - Copying text shows the popup ONLY when it differs from the text
    //     currently being shown. Copying the same text that is already on the
    //     popup must not pop it again (no matter how long ago it was shown).
    if (source === 'copy' && text === lastShownLensText) {
        return;
    }
    if (!lensWindow || lensWindow.isDestroyed()) createLensWindow();

    const maxLen = Math.max(50, Math.min(1500, Number(store.get('lensMaxSelection', 600)) || 600));
    let handled = text;
    let note = '';
    if (handled.length > maxLen) {
        handled = handled.slice(0, maxLen).trim();
        note = `Only the first ${maxLen} characters were translated.`;
    }

    let result;
    try {
        result = await lensEngine.translate(handled, 'bn');
    } catch (err) {
        result = { ok: false, error: String((err && err.message) || err) };
    }

    if (!lensWindow || lensWindow.isDestroyed()) return;
    // Whether the popup should auto-speak for this trigger, per the user's
    // per-source speak settings.
    const speakOnShow = source === 'copy'
        ? store.get('speakOnCopy', true) !== false
        : store.get('speakOnSelection', true) !== false;
    lensWindow.webContents.send('lens-payload', {
        text: handled,
        note,
        result,
        theme: store.get('lensTheme', 'auto'),
        showDictionary: store.get('lensShowDictionary', true) !== false,
        speakOnShow,
        speakTarget: store.get('lensSpeakTarget', 'source') === 'translation' ? 'translation' : 'source'
    });
    lastShownLensText = text;
    showLensWindow(point);
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
    if (channel === 'dicts-updated') {
        try { lensEngine.invalidate(); } catch (_) {}
    }
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
        if (lensCaptureInFlight) {
            lastClipboardText = clipboard.readText();
            return;
        }

        const text = clipboard.readText();
        if (text && text !== lastClipboardText && text.trim().length > 0) {
            lastClipboardText = text;
            if (suppressNextClipboardText !== null) {
                if (text === suppressNextClipboardText) {
                    suppressNextClipboardText = null;
                    return;
                }
                suppressNextClipboardText = null;
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('clipboard-update', text.trim());
            }
            if (store.get('lensOnCopy', true)) {
                const copied = text.trim();
                requestCursorPoint().then((point) => {
                    showLens(copied, point, 'copy');
                });
            }
        }
    }, 1000);
}

app.whenReady().then(() => {
    grantMediaPermissions();
    syncLaunchAtLogin();
    createWindow();
    createTray();
    createLensWindow();
    startLensWatcher();
    registerGlobalShortcuts();
    startClipboardMonitor();
    updater.startMaterialsSync(store, broadcast);
    if (autoUpdater) updater.setupAppUpdater(autoUpdater, broadcast);

    setImmediate(() => {
        lensEngine.init({ loadMaterial: (name) => updater.readMaterial(name) }).catch((err) => {
            console.warn('Lens dictionaries failed to load:', err && err.message);
        });
    });

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
    if (lensWatcher) {
        sendWatcherCommand('QUIT');
        const watcher = lensWatcher;
        setTimeout(() => {
            try { if (watcher && !watcher.killed) watcher.kill(); } catch (_) {}
        }, 400);
        lensWatcher = null;
    }
});

ipcMain.handle('get-settings', () => store.store);
ipcMain.handle('set-setting', (event, key, value) => {
    store.set(key, value);
    if (key === 'clipboardMonitoring' && value === true) {
        lastClipboardText = clipboard.readText();
    }
    if (key === 'lensEnabled') {
        sendWatcherCommand('AUTO:' + (value ? '1' : '0'));
    }
    if (key === 'launchAtLogin' || key === 'startMinimized') {
        syncLaunchAtLogin();
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
ipcMain.handle('open-external', (_, url) => {
    /*
     * Only ever hand http(s) URLs to the OS. Without this guard a compromised
     * renderer could pass a file:// or custom-scheme URI and ask the shell to
     * launch an arbitrary handler.
     */
    let parsed;
    try {
        parsed = new URL(String(url));
    } catch (_) {
        return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return shell.openExternal(parsed.href);
});
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
ipcMain.handle('lens-hide', () => {
    hideLensWindow();
    return true;
});
ipcMain.handle('lens-resize', (_event, height) => {
    if (!lensWindow || lensWindow.isDestroyed()) return false;
    const h = Math.max(120, Math.min(600, Number(height) || 240));
    lensLastContentHeight = h;
    try {
        lensWindow.setContentSize(420, h + 16);
        // Re-anchor to the stored point so the popup stays next to the cursor
        // it was opened at, then grows away from it.
        positionLensWindow(lensAnchorPoint);
    } catch (_) {}
    return true;
});
ipcMain.handle('lens-open-translate', (_event, text) => {
    try {
        shell.openExternal(lensEngine.buildTranslateLink(String(text || ''), 'bn'));
    } catch (_) {}
    return true;
});
