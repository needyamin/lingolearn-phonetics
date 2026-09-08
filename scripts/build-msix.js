const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    ROOT,
    readPackage,
    readStoreConfig,
    msixVersion,
    run,
    findMakeAppx,
    buildUnpacked,
    stageMsix
} = require('./pack-utils');

function buildWithElectronBuilderAppx(store, version) {
    const builder = path.join(ROOT, 'node_modules', '.bin', 'electron-builder.cmd');
    const cmd = fs.existsSync(builder) ? builder : 'npx';
    const prefix = fs.existsSync(builder) ? [] : ['electron-builder'];
    const args = prefix.concat([
        '--win', 'appx',
        '--x64',
        `--config.appx.identityName=${store.identityName}`,
        `--config.appx.publisher=${store.publisher}`,
        `--config.appx.publisherDisplayName=${store.publisherDisplayName}`,
        `--config.appx.applicationId=${store.applicationId}`,
        `--config.appx.displayName=${store.displayName}`
    ]);
    run(cmd, args, { shell: true });
    const dist = path.join(ROOT, 'dist');
    const appx = fs.readdirSync(dist).find((name) => name.toLowerCase().endsWith('.appx'));
    if (!appx) throw new Error('electron-builder did not produce an .appx file.');
    const msix = path.join(dist, `LingoLearn-Phonetics-${version}.msix`);
    fs.copyFileSync(path.join(dist, appx), msix);
    return msix;
}

function main() {
    const version = readPackage().version;
    const store = readStoreConfig();
    if (!store.publisher || store.publisher.includes('XXXX')) {
        console.warn('installer/store.config.json still has a placeholder publisher.');
        console.warn('For Microsoft Store, paste Identity values from Partner Center → App identity.');
    }

    console.log('Building unpacked Windows app…');
    const unpacked = buildUnpacked();
    const fourPart = msixVersion(version);
    const staging = stageMsix(unpacked, store, fourPart);
    const out = path.join(ROOT, 'dist', `LingoLearn-Phonetics-${version}.msix`);
    const makeappx = findMakeAppx();

    if (makeappx) {
        console.log(`Packing MSIX with ${makeappx}`);
        if (fs.existsSync(out)) fs.unlinkSync(out);
        const packed = spawnSync(makeappx, ['pack', '/d', staging, '/p', out, '/o'], {
            cwd: ROOT,
            stdio: 'inherit'
        });
        if (packed.status !== 0) throw new Error('MakeAppx pack failed.');
        console.log(`MSIX package: ${out}`);
        console.log('Upload this file in Partner Center. Fill installer/store.config.json with your Store identity first.');
        return;
    }

    console.warn('MakeAppx.exe not found (Windows SDK). Falling back to electron-builder appx, then copying to .msix');
    const msix = buildWithElectronBuilderAppx(store, version);
    console.log(`MSIX package: ${msix}`);
}

main();
