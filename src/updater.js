const fs = require('fs');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const MATERIAL_BASE = 'https://raw.githubusercontent.com/needyamin/lingoLearn-phonetics/main/asset';
const MATERIAL_FILES = [
    'cmudict-0.7b-ipa.txt',
    'E2Bdatabase.json',
    'practice-lessons.json'
];
const CHECK_DELAY_MS = 12000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const APP_CHECK_DELAY_MS = 18000;

let materialsTimer = null;
let appCheckTimer = null;
let pendingAppUpdate = false;
let lastProgressAt = 0;
let broadcast = () => {};
let autoUpdaterRef = null;

function userDictDir() {
    const dir = path.join(app.getPath('userData'), 'dicts');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function materialPath(name) {
    return path.join(userDictDir(), name);
}

function bundledPath(name) {
    return path.join(__dirname, '../asset', name);
}

function fileHash(filePath) {
    try {
        const hash = crypto.createHash('sha1');
        hash.update(fs.readFileSync(filePath));
        return hash.digest('hex');
    } catch (_) {
        return '';
    }
}

function readMaterial(name) {
    const userFile = materialPath(name);
    const bundled = bundledPath(name);
    try {
        if (fs.existsSync(userFile)) return fs.readFileSync(userFile, 'utf-8');
    } catch (_) {}
    try {
        return fs.readFileSync(bundled, 'utf-8');
    } catch (_) {
        return null;
    }
}

function parseLessons(raw) {
    try {
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) return null;
        const lessons = data.filter((item) => item && typeof item.title === 'string' && typeof item.text === 'string');
        return lessons.length ? lessons : null;
    } catch (_) {
        return null;
    }
}

function httpsRequest(url, headers) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                httpsRequest(res.headers.location, headers).then(resolve, reject);
                return;
            }
            if (res.statusCode === 304) {
                resolve({ status: 304, headers: res.headers, body: null });
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: 200,
                headers: res.headers,
                body: Buffer.concat(chunks)
            }));
        });
        req.on('error', reject);
        req.setTimeout(90000, () => {
            req.destroy();
            reject(new Error('timeout'));
        });
    });
}

async function syncOneMaterial(name, store) {
    const metaKey = `materialMeta.${name}`;
    const meta = store.get(metaKey) || {};
    const headers = {
        'User-Agent': 'LingoLearn-Phonetics',
        Accept: '*/*'
    };
    if (meta.etag) headers['If-None-Match'] = meta.etag;
    if (meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;

    const result = await httpsRequest(`${MATERIAL_BASE}/${name}`, headers);
    if (result.status === 304 || !result.body || result.body.length < 20) return false;

    const dest = materialPath(name);
    const nextHash = crypto.createHash('sha1').update(result.body).digest('hex');
    const destHash = fileHash(dest);
    const bundledHash = fileHash(bundledPath(name));
    const unchanged = nextHash && (nextHash === destHash || nextHash === bundledHash);
    store.set(metaKey, {
        etag: result.headers.etag || meta.etag || '',
        lastModified: result.headers['last-modified'] || meta.lastModified || '',
        hash: nextHash
    });
    if (unchanged && destHash) return false;

    const tmp = `${dest}.tmp`;
    await fs.promises.writeFile(tmp, result.body);
    await fs.promises.rename(tmp, dest);
    return !unchanged;
}

async function syncMaterials(store) {
    let changed = [];
    for (const name of MATERIAL_FILES) {
        try {
            if (await syncOneMaterial(name, store)) changed.push(name);
        } catch (_) {}
    }
    if (changed.length) {
        broadcast('materials-updated', { files: changed });
        if (changed.some((name) => name !== 'practice-lessons.json')) {
            broadcast('dicts-updated', { files: changed });
        }
    }
    return changed;
}

let materialStore = null;

function startMaterialsSync(store, send) {
    materialStore = store;
    broadcast = send;
    const run = () => { syncMaterials(store).catch(() => {}); };
    setTimeout(run, CHECK_DELAY_MS);
    if (materialsTimer) clearInterval(materialsTimer);
    materialsTimer = setInterval(run, CHECK_EVERY_MS);
}

function sendUpdate(payload) {
    broadcast('app-update', payload);
}

function isUpdateReady() {
    return pendingAppUpdate;
}

function installDownloadedUpdate(autoUpdater) {
    if (!autoUpdater || !pendingAppUpdate) return false;
    try {
        app.isQuitting = true;
        autoUpdater.quitAndInstall(true, true);
        return true;
    } catch (_) {
        try {
            autoUpdater.quitAndInstall();
            return true;
        } catch (err) {
            app.isQuitting = false;
            console.error('quitAndInstall failed', err);
            return false;
        }
    }
}

function setupAppUpdater(autoUpdater, send) {
    autoUpdaterRef = autoUpdater;
    broadcast = send;
    if (!autoUpdater || !app.isPackaged) return;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('update-available', (info) => {
        sendUpdate({ kind: 'available', version: info && info.version });
    });
    autoUpdater.on('download-progress', (progress) => {
        const now = Date.now();
        if (now - lastProgressAt < 400) return;
        lastProgressAt = now;
        sendUpdate({
            kind: 'downloading',
            percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0)))
        });
    });
    autoUpdater.on('update-downloaded', (info) => {
        pendingAppUpdate = true;
        sendUpdate({ kind: 'ready', version: info && info.version });
    });
    autoUpdater.on('update-not-available', (info) => {
        sendUpdate({ kind: 'current', version: (info && info.version) || app.getVersion() });
    });
    autoUpdater.on('error', () => {
        sendUpdate({ kind: 'error', message: 'Could not check for updates.' });
    });

    const check = () => {
        autoUpdater.checkForUpdates().catch(() => {});
    };
    setTimeout(check, APP_CHECK_DELAY_MS);
    if (appCheckTimer) clearInterval(appCheckTimer);
    appCheckTimer = setInterval(check, CHECK_EVERY_MS);
}

async function checkForAppUpdatesNow() {
    try {
        sendUpdate({ kind: 'checking', version: app.getVersion() });

        let changed = [];
        if (materialStore) {
            try { changed = await syncMaterials(materialStore); } catch (_) {}
        }

        if (!autoUpdaterRef || !app.isPackaged) {
            if (changed.length) sendUpdate({ kind: 'materials', files: changed });
            else sendUpdate({ kind: 'current', version: app.getVersion() });
            return { ok: true, reason: 'dev' };
        }

        await autoUpdaterRef.checkForUpdates();
        return { ok: true };
    } catch (err) {
        sendUpdate({ kind: 'error', message: 'Could not reach the update server.' });
        return { ok: false, error: err && err.message };
    }
}

module.exports = {
    readMaterial,
    parseLessons,
    startMaterialsSync,
    setupAppUpdater,
    installDownloadedUpdate,
    isUpdateReady,
    checkForAppUpdatesNow,
    bundledPath,
    materialPath
};
