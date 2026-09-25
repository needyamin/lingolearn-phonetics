/*
 * Builds the Linux AppImage inside Docker.
 *
 * Why a script instead of a one-line npm command:
 *  1. electron-builder CLEARS its output directory at the start of every build.
 *     Mounting the shared `dist/` into the container therefore DELETED the
 *     Windows artifacts. This script mounts a dedicated `dist-linux/` instead,
 *     so the Windows build output is never touched.
 *  2. The old inline command used `%cd%`, which only expands in cmd.exe -- it
 *     is a literal string under bash/zsh. Computing the path here works in any
 *     shell.
 *
 * Run: npm run dist:linux:docker
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IMAGE = 'lingolearn-linux-builder';
const OUT_DIR = path.join(ROOT, 'dist-linux');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false, ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status})`);
    }
}

function dockerPath(p) {
    // Docker Desktop on Windows accepts forward slashes; POSIX hosts are unchanged.
    return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

function main() {
    if (spawnSync('docker', ['--version'], { stdio: 'ignore', shell: false }).status !== 0) {
        throw new Error('Docker is not available on PATH. Start Docker Desktop (or the docker service) and retry.');
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    console.log('Building Linux builder image…');
    run('docker', ['build', '-f', 'Dockerfile.linux-build', '-t', IMAGE, '.']);

    console.log(`\nBuilding AppImage (output -> ${OUT_DIR})…`);
    console.log('Note: mounting a dedicated output dir so dist/ (Windows artifacts) is left alone.\n');
    run('docker', ['run', '--rm', '-v', `${dockerPath(OUT_DIR)}:/app/dist`, IMAGE]);

    const produced = fs.readdirSync(OUT_DIR).filter((name) => name.endsWith('.AppImage'));
    if (produced.length === 0) {
        throw new Error(`No .AppImage was produced in ${OUT_DIR}. Check the build log above.`);
    }

    console.log('\nLinux build complete:');
    for (const name of produced) {
        const full = path.join(OUT_DIR, name);
        const mb = (fs.statSync(full).size / (1024 * 1024)).toFixed(1);
        console.log(`  ${name}  (${mb} MB)`);
    }
    console.log('\nRun it with:  chmod +x "<file>.AppImage" && "./<file>.AppImage"');
}

try {
    main();
} catch (err) {
    console.error(`\nLinux build failed: ${err.message}`);
    process.exit(1);
}
