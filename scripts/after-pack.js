/*
 * electron-builder `afterPack` hook -- stamps the app icon onto the built exe.
 *
 * Why this is needed instead of just letting electron-builder do it:
 *
 *   `win.signAndEditExecutable` has to stay `false`. Setting it to true makes
 *   electron-builder download the winCodeSign toolchain, which then fails on
 *   Windows unless the process has symlink privileges:
 *       ERROR: Cannot create symbolic link : A required privilege is not held
 *       by the client ... darwin/10.12/lib/libcrypto.dylib
 *   That is presumably why the flag was turned off in the first place.
 *
 *   But that same flag also stops electron-builder writing the icon into the
 *   executable, so the packaged app showed Electron's default logo in the
 *   taskbar.
 *
 * This hook does the one thing that actually matters -- set the icon -- using
 * the local `rcedit` binary, which needs no privileges and no downloads.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

module.exports = async function afterPack(context) {
    // Only Windows executables carry a PE icon resource.
    if (context.electronPlatformName !== 'win32') return;

    const { ROOT, ensureSetupIcon } = require('./pack-utils');

    const productFilename = context.packager.appInfo.productFilename;
    const exePath = path.join(context.appOutDir, `${productFilename}.exe`);

    if (!fs.existsSync(exePath)) {
        console.warn(`afterPack: app executable not found at ${exePath}; skipping icon stamp.`);
        return;
    }

    // Generates installer/icon.ico + asset/icon.ico from the tracked icon.png.
    const icoPath = ensureSetupIcon();

    const rcedit = path.join(
        ROOT,
        'node_modules',
        'rcedit',
        'bin',
        process.arch === 'ia32' ? 'rcedit.exe' : 'rcedit-x64.exe'
    );

    if (!fs.existsSync(rcedit)) {
        console.warn('afterPack: rcedit binary not found; run `npm install`. Skipping icon stamp.');
        return;
    }

    const result = spawnSync(rcedit, [exePath, '--set-icon', icoPath], { stdio: 'inherit' });

    if (result.error || result.status !== 0) {
        // Never fail the whole build over cosmetics -- warn and continue.
        console.warn(`afterPack: could not stamp the icon (${result.error ? result.error.message : `exit ${result.status}`}).`);
        return;
    }

    console.log(`afterPack: stamped app icon onto ${path.basename(exePath)}`);
};
