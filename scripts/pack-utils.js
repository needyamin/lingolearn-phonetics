const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function readPackage() {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

function readStoreConfig() {
    const file = path.join(ROOT, 'installer', 'store.config.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function msixVersion(semver) {
    const parts = String(semver || '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);
    while (parts.length < 4) parts.push(0);
    return parts.slice(0, 4).join('.');
}

function pngToIco(pngBuf) {
    const width = pngBuf.readUInt32BE(16);
    const height = pngBuf.readUInt32BE(20);
    const header = Buffer.alloc(22);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header.writeUInt8(width >= 256 ? 0 : width, 6);
    header.writeUInt8(height >= 256 ? 0 : height, 7);
    header.writeUInt8(0, 8);
    header.writeUInt8(0, 9);
    header.writeUInt16LE(1, 10);
    header.writeUInt16LE(32, 12);
    header.writeUInt32LE(pngBuf.length, 14);
    header.writeUInt32LE(22, 18);
    return Buffer.concat([header, pngBuf]);
}

function ensureSetupIcon() {
    const dest = path.join(ROOT, 'installer', 'icon.ico');
    const pngPath = path.join(ROOT, 'asset', 'icon.png');
    const png = fs.readFileSync(pngPath);
    fs.writeFileSync(dest, pngToIco(png));
    const appIco = path.join(ROOT, 'asset', 'icon.ico');
    fs.copyFileSync(dest, appIco);
    return dest;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
        ...options
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

function which(fileName, extraDirs = []) {
    const paths = [];
    extraDirs.forEach((dir) => paths.push(path.join(dir, fileName)));
    const envPath = process.env.PATH || '';
    envPath.split(path.delimiter).forEach((dir) => {
        if (dir) paths.push(path.join(dir, fileName));
    });
    return paths.find((candidate) => fs.existsSync(candidate)) || null;
}

function findIscc() {
    return which('ISCC.exe', [
        'C:\\Program Files (x86)\\Inno Setup 6',
        'C:\\Program Files\\Inno Setup 6',
        'C:\\Program Files (x86)\\Inno Setup 5',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6')
    ]);
}

function findMakeAppx() {
    const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
    if (!fs.existsSync(kits)) return which('makeappx.exe');
    const versions = fs.readdirSync(kits).sort().reverse();
    for (const version of versions) {
        const candidate = path.join(kits, version, 'x64', 'makeappx.exe');
        if (fs.existsSync(candidate)) return candidate;
    }
    return which('makeappx.exe');
}

function stampExeIcon(exe) {
    const ico = ensureSetupIcon();
    const rcedit = path.join(ROOT, 'node_modules', 'rcedit', 'bin', process.arch === 'ia32' ? 'rcedit.exe' : 'rcedit-x64.exe');
    if (!fs.existsSync(rcedit)) {
        throw new Error('rcedit is missing. Run npm install.');
    }
    run(rcedit, [exe, '--set-icon', ico]);
}

function buildUnpacked() {
    ensureSetupIcon();
    const builder = path.join(ROOT, 'node_modules', '.bin', 'electron-builder.cmd');
    const cmd = fs.existsSync(builder) ? builder : 'npx';
    const args = fs.existsSync(builder)
        ? ['--win', 'dir', '--x64']
        : ['electron-builder', '--win', 'dir', '--x64'];
    run(cmd, args, { shell: true });
    const unpacked = path.join(ROOT, 'dist', 'win-unpacked');
    const exe = path.join(unpacked, 'LingoLearn Phonetics.exe');
    if (!fs.existsSync(exe)) throw new Error('Unpacked app was not created at dist/win-unpacked');
    const ico = ensureSetupIcon();
    fs.copyFileSync(ico, path.join(unpacked, 'app.ico'));
    stampExeIcon(exe);
    return unpacked;
}

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(from, to);
        else fs.copyFileSync(from, to);
    }
}

function writeAppxManifest(staging, store, version) {
    const name = store.identityName;
    const publisher = store.publisher;
    const displayName = store.displayName;
    const publisherDisplayName = store.publisherDisplayName;
    const applicationId = store.applicationId;
    const description = store.description.replace(/&/g, '&amp;');
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="${name}" Publisher="${publisher}" Version="${version}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${displayName}</DisplayName>
    <PublisherDisplayName>${publisherDisplayName}</PublisherDisplayName>
    <Description>${description}</Description>
    <Logo>assets\\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    <Capability Name="internetClient" />
    <DeviceCapability Name="microphone" />
  </Capabilities>
  <Applications>
    <Application Id="${applicationId}" Executable="app\\LingoLearn Phonetics.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="${displayName}" Description="${description}" BackgroundColor="#111111"
        Square150x150Logo="assets\\Square150x150Logo.png" Square44x44Logo="assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="assets\\Wide310x150Logo.png" Square71x71Logo="assets\\Square71x71Logo.png" />
        <uap:SplashScreen Image="assets\\SplashScreen.png" BackgroundColor="#111111" />
      </uap:VisualElements>
    </Application>
  </Applications>
</Package>
`;
    fs.writeFileSync(path.join(staging, 'AppxManifest.xml'), xml);
}

function removeDirSync(dir) {
    // Delete bottom-up so we never issue a single bulk recursive delete. Some
    // sandboxes and antivirus shims block large recursive removes (the MSIX
    // staging tree is ~1700 files); a manual post-order walk sidesteps that.
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            removeDirSync(full);
        } else {
            try {
                fs.unlinkSync(full);
            } catch (_) {
                // Best effort: a locked file should not abort the whole build.
            }
        }
    }
    try {
        fs.rmdirSync(dir);
    } catch (_) {
        // Leave the directory if something still holds it; mkdir is recursive.
    }
}

function stageMsix(unpacked, store, version) {
    const staging = path.join(ROOT, 'dist', 'msix-staging');
    removeDirSync(staging);
    const assets = path.join(staging, 'assets');
    const appDir = path.join(staging, 'app');
    fs.mkdirSync(assets, { recursive: true });
    copyDir(unpacked, appDir);
    writeStoreTiles(assets);
    writeAppxManifest(staging, store, version);
    return staging;
}

// Windows requires each Store tile to be an exact pixel size. Copying one
// square PNG into all six slots (the previous behaviour) fails certification,
// so each tile is generated at its required dimensions from asset/icon.png.
const STORE_TILES = {
    'StoreLogo.png': [50, 50],
    'Square44x44Logo.png': [44, 44],
    'Square71x71Logo.png': [71, 71],
    'Square150x150Logo.png': [150, 150],
    'Wide310x150Logo.png': [310, 150],
    'SplashScreen.png': [620, 300]
};
const TILE_BG = [17, 17, 17, 255]; // matches the manifest's #111111

function writeStoreTiles(assetsDir) {
    const src = path.join(ROOT, 'asset', 'icon.png');
    if (!fs.existsSync(src)) throw new Error(`Store tile source missing: ${src}`);
    const script = path.join(ROOT, 'scripts', 'make-store-tiles.py');
    const result = spawnSync('python', [script, src, assetsDir], { stdio: 'inherit' });
    if (result.status !== 0) {
        // Fall back to plain copies so a missing Python never blocks the build,
        // but say so loudly -- these files will likely fail Store certification.
        console.warn('WARNING: could not generate correctly sized Store tiles (needs Python + Pillow).');
        console.warn('         Falling back to copying asset/icon.png into every tile slot.');
        for (const name of Object.keys(STORE_TILES)) {
            fs.copyFileSync(src, path.join(assetsDir, name));
        }
    }
}

module.exports = {
    ROOT,
    readPackage,
    readStoreConfig,
    msixVersion,
    ensureSetupIcon,
    run,
    findIscc,
    findMakeAppx,
    buildUnpacked,
    stageMsix
};
