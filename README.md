# LingoLearn Phonetics

Desktop app for English pronunciation and translation. Look up a word to hear it, see IPA and a Bangla meaning, open **English Practice** and read short paragraphs out loud, or select text in any other app and get a translate popup right there.

<img width="638" height="738" alt="LingoLearn Phonetics" src="https://github.com/user-attachments/assets/c2a65521-d207-408a-b4f4-5b8cafd0b6d3" />

**Author:** [Md. Yamin Hossain](https://github.com/needyamin) · License: ISC

## Features

- **Speak** — system TTS for any word or phrase
- **IPA** — phonetic transcription (CMU Pronouncing Dictionary)
- **Bangla** — English-to-Bangla meanings (`asset/E2Bdatabase.json`)
- **Lens** — select or copy text in any app and a translate popup appears where you are
- **English Practice** — read a lesson; the app listens and marks each word
- **Clipboard** — optional speak / IPA when you copy text
- **History** — recent lookups; rate, volume, and voice in Settings
- **Tray** — closing the window hides to the tray; **Ctrl+Shift+L** brings the main window back
- **Materials update** — IPA, Bangla dictionary, and practice lessons refresh in the background from GitHub

## English Practice

Open it with the **📖** button on the main window.

1. Wait until the status says **Speech engine ready** (first run may download a local Whisper model).
2. Optionally click **Hear it** to listen to the paragraph.
3. Click **Start Speaking**, then read **one sentence** and **pause** for about half a second.
4. **What you said** is the transcript. Green words matched; red words were missed. Keep reading forward — do not repeat missed words.

Speech recognition runs **on your PC** (Whisper). No Google speech API is required. A quiet room and a mic close to your mouth work best. If the local model cannot load, the app falls back to Windows speech recognition.

## Lens (translate anywhere)

Select or copy text in **any** application and a small translate popup appears — you do
not have to switch back to LingoLearn. It shows the Bangla meaning and IPA, and can
speak the word.

- **Ctrl+Shift+G** captures the current selection manually.
- Works on both selection and copy by default, and appears near the cursor.
- Auto-hides after 20 seconds; selections are never stored or sent anywhere. Lookups run
  locally against the bundled dictionaries.
- Everything is adjustable under **Settings → Translate Popup** — popup on selection,
  popup on copy, dictionary meanings, position (near cursor or top centre), theme
  (auto / light / dark), max selection length, and auto-hide delay.

Selection capture uses a Windows hook, so this feature is **Windows only**.

## Quick start

```bash
git clone https://github.com/needyamin/lingoLearn-phonetics.git
cd lingoLearn-phonetics
npm install
npm start
```

While the app is running (including in the tray), press **Ctrl+Shift+L** to show the main window.

## Build

| What | Command | Output |
|------|---------|--------|
| **NSIS installer + portable** (Windows) | `npm run dist` | `dist/LingoLearn Phonetics Setup 2.1.0.exe`, `dist/LingoLearn Phonetics 2.1.0.exe` |
| **MSIX** (Microsoft Store) | `npm run dist:msix` | `dist/LingoLearn-Phonetics-2.1.0.msix` |
| **Inno Setup installer** (single .exe) | `npm run dist:inno` | `dist/LingoLearn-Phonetics-Setup-2.1.0.exe` |
| **Inno + MSIX** | `npm run dist:win` | both files in `dist/` |
| **Linux AppImage** | `npm run dist:linux:docker` | `dist-linux/LingoLearn Phonetics-2.1.0.AppImage` |
| **Linux AppImage** (on a Linux host) | `npm run dist:linux` | `dist/LingoLearn Phonetics-2.1.0.AppImage` |

Bump `version` in `package.json` before each release, then tag it (e.g. `v2.1.0`). The
version drives the MSIX four-part version, the installer filenames, and the version
shown in the app's About dialog, so it is the only place you need to change.

Windows output goes to `dist/`, Linux output to `dist-linux/`. They are kept apart on
purpose: electron-builder **empties its output directory at the start of every build**,
so building Linux into `dist/` would delete the Windows installers.

### Inno Setup (single .exe)

One installer you can publish on GitHub Releases or send to users.

1. Install [Inno Setup 6](https://jrsoftware.org/isinfo.php) if needed (`npm run dist:inno` will try `winget` first).
2. Run `npm run dist:inno`.
3. Publish `dist/LingoLearn-Phonetics-Setup-2.1.0.exe`.

Installs per user under Programs, adds Start Menu and Desktop shortcuts, and does not need admin unless the user picks all-users install.

### MSIX (Microsoft Store)

1. Reserve **LingoLearn Phonetics** in [Partner Center](https://partner.microsoft.com/dashboard).
2. Store identity is in `installer/store.config.json` (`ANSNEWTECH.LingoLearnPhonetics`, publisher `ANSNEW TECH.`).
3. Install the [Windows SDK](https://developer.microsoft.com/windows/downloads/windows-sdk/) so `MakeAppx.exe` is available. If it is missing, the script builds `.appx` and copies it to `.msix`.
4. Run `npm run dist:msix`.
5. Upload `dist/LingoLearn-Phonetics-2.1.0.msix` on the Store **Packages** page.

The Store listing also needs screenshots, an age rating, a description, and a **privacy policy URL**.

Paste this in Partner Center → **Privacy policy URL**:

https://github.com/needyamin/lingoLearn-phonetics/blob/main/PRIVACY.md

Paste this in Partner Center → **Website**:

https://github.com/needyamin/lingoLearn-phonetics/blob/main/website.html

Push `PRIVACY.md` and `website.html` to `main` first so those links work. The privacy page is also **Help → Privacy Policy** in the app.

### Linux AppImage

Building from Windows needs Docker Desktop running (it uses WSL 2):

```bash
npm run dist:linux:docker
```

That script builds the image from `Dockerfile.linux-build`, runs electron-builder inside
it, and writes the result to **`dist-linux/`**. It takes a few minutes on the first run
because Electron for Linux is downloaded inside the container.

On a Linux host you can skip Docker entirely and run `npm run dist:linux`.

To use the AppImage:

```bash
chmod +x "LingoLearn Phonetics-2.1.0.AppImage"
"./LingoLearn Phonetics-2.1.0.AppImage"
```

Needs kernel 3.10+, GLIBC 2.17+, and X11 or Wayland. Linux builds skip the
Windows-only features (the PowerShell selection watcher and the SAPI fallback); the
on-device Whisper engine and everything else work normally.

If you change what the build needs to copy, update `.dockerignore` too. It must keep
`node_modules` excluded — the Dockerfile installs Linux-native modules and then copies
the source over them, so a Windows `node_modules` slipping in would break the build.

## Packaging notes

Three things here are easy to break and awkward to debug, so they are worth knowing
before you touch the build config.

**App icon.** The packaged `.exe` gets its icon from `scripts/after-pack.js`, an
electron-builder `afterPack` hook that stamps it with the local `rcedit` binary.

`win.signAndEditExecutable` must stay `false` in `package.json`. Setting it to `true`
makes electron-builder download the `winCodeSign` toolchain, which fails on Windows
without symlink privileges:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client
```

But that flag also stops electron-builder writing the icon — which is exactly why the
hook exists. If the taskbar shows Electron's default logo instead of the app icon,
check the build log for `afterPack: stamped app icon onto ...`. If that line is
missing, the hook did not run.

**Store tiles.** `scripts/make-store-tiles.py` generates the six tile images at the
exact sizes the Store requires — `StoreLogo` 50×50, `Square44x44` 44×44,
`Square71x71` 71×71, `Square150x150` 150×150, `Wide310x150` 310×150, `SplashScreen`
620×300. Windows rejects a package whose tile dimensions do not match the manifest.
This needs Python with Pillow (`pip install Pillow`); without it the build warns and
copies one square PNG into every slot, which fails certification.

**Store identity.** `installer/store.config.json` holds the Partner Center identity.
Once the app is published, `identityName` and `publisher` must not change — they
determine the package family name, and changing either makes the Store treat the upload
as a new app rather than an update.

## Release checklist

1. Bump `version` in `package.json`.
2. `npm test` — alignment and DOM suites must pass.
3. `npm run dist` — Windows installer + portable.
4. `npm run dist:msix` — Store package. Confirm the manifest version is one step above
   what is live in Partner Center.
5. `npm run dist:linux:docker` — Linux AppImage.
6. Upload the `.msix` on Partner Center → **Packages**, and write the "What's new" text
   (the package itself carries no release notes).
7. Attach the Windows installer and `latest.yml` to the GitHub release so the NSIS
   auto-updater can find them.

## Updates

| Kind | How it works |
|------|----------------|
| **Dictionaries & lessons** | All builds. Checked a few seconds after launch, then every few hours. Unchanged files are skipped. |
| **Microsoft Store app** | Store updates the MSIX package. GitHub auto-update is off in Store builds. |
| **NSIS install** (`npm run dist`) | Downloads a new app build from [GitHub Releases](https://github.com/needyamin/lingoLearn-phonetics/releases) in the background. Applies when you close to the tray, click **Restart**, or Quit. Help → **Check for Updates**. |
| **Inno Setup / portable / `npm start`** | Program files do not self-replace. Install the new Setup `.exe` (or run a new portable). Materials still update. |

For GitHub app updates, attach `latest.yml` (from the NSIS build) plus the installer you want users to download.

## Tech

Electron · Web Speech TTS · Whisper (`@huggingface/transformers`, on-device) · Windows SAPI fallback · CMU Pronouncing Dictionary · Bangla dictionary · electron-builder (NSIS, portable, MSIX, AppImage) · Inno Setup · Docker for Linux builds

## License

ISC

## Privacy

[Privacy Policy](PRIVACY.md) · [Product website](website.html)

Partner Center URLs (after you push to `main`):

- Privacy: https://github.com/needyamin/lingoLearn-phonetics/blob/main/PRIVACY.md
- Website: https://github.com/needyamin/lingoLearn-phonetics/blob/main/website.html
