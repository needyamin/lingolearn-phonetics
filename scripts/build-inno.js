const path = require('path');
const { spawnSync } = require('child_process');
const {
    ROOT,
    readPackage,
    ensureSetupIcon,
    findIscc,
    buildUnpacked
} = require('./pack-utils');

function installInnoSetup() {
    console.log('Inno Setup not found. Trying winget install JRSoftware.InnoSetup…');
    const result = spawnSync('winget', [
        'install',
        '--id', 'JRSoftware.InnoSetup',
        '-e',
        '--accept-package-agreements',
        '--accept-source-agreements'
    ], { stdio: 'inherit', shell: true });
    return result.status === 0;
}

function main() {
    const version = readPackage().version;
    ensureSetupIcon();
    console.log('Building unpacked Windows app…');
    buildUnpacked();

    let iscc = findIscc();
    if (!iscc) {
        installInnoSetup();
        iscc = findIscc();
    }
    if (!iscc) {
        throw new Error('Inno Setup 6 is required. Install it from https://jrsoftware.org/isinfo.php then run npm run dist:inno again.');
    }

    const iss = path.join(ROOT, 'installer', 'lingolearn.iss');
    const result = spawnSync(iscc, [`/DAppVersion=${version}`, iss], {
        cwd: ROOT,
        stdio: 'inherit'
    });
    if (result.status !== 0) throw new Error('Inno Setup compile failed.');

    const out = path.join(ROOT, 'dist', `LingoLearn-Phonetics-Setup-${version}.exe`);
    console.log(`Inno Setup installer: ${out}`);
}

main();
