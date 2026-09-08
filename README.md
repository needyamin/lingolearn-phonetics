# LingoLearn Phonetics

Desktop app for English pronunciation. Look up a word to hear it, see IPA and a Bangla meaning, or open **English Practice** and read short paragraphs out loud.

<img width="638" height="738" alt="LingoLearn Phonetics" src="https://github.com/user-attachments/assets/c2a65521-d207-408a-b4f4-5b8cafd0b6d3" />

**Author:** [Md. Yamin Hossain](https://github.com/needyamin) · License: ISC

## Features

- **Speak** — system TTS for any word or phrase
- **IPA** — phonetic transcription (CMU Pronouncing Dictionary)
- **Bangla** — English-to-Bangla meanings (`asset/E2Bdatabase.json`)
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
| **Inno Setup installer** (share / GitHub) | `npm run dist:inno` | `dist/LingoLearn-Phonetics-Setup-2.0.0.exe` |
| **MSIX** (Microsoft Store) | `npm run dist:msix` | `dist/LingoLearn-Phonetics-2.0.0.msix` |
| **Inno + MSIX** | `npm run dist:win` | both files in `dist/` |
| **Portable + NSIS** | `npm run dist` | `dist/LingoLearn Phonetics 2.0.0.exe` and NSIS setup |
| **Linux AppImage** | `npm run dist:linux:docker` | `dist/LingoLearn Phonetics-2.0.0.AppImage` |

Bump `version` in `package.json` before each release (and tag it, e.g. `v2.0.1`).

### Inno Setup (single .exe)

One installer you can publish on GitHub Releases or send to users.

1. Install [Inno Setup 6](https://jrsoftware.org/isinfo.php) if needed (`npm run dist:inno` will try `winget` first).
2. Run `npm run dist:inno`.
3. Publish `dist/LingoLearn-Phonetics-Setup-2.0.0.exe`.

Installs per user under Programs, adds Start Menu and Desktop shortcuts, and does not need admin unless the user picks all-users install.

### MSIX (Microsoft Store)

1. Reserve **LingoLearn Phonetics** in [Partner Center](https://partner.microsoft.com/dashboard).
2. Open **Product management → App identity** and paste **Name**, **Publisher**, and **Publisher display name** into `installer/store.config.json`.
3. Install the [Windows SDK](https://developer.microsoft.com/windows/downloads/windows-sdk/) so `MakeAppx.exe` is available. If it is missing, the script builds `.appx` and copies it to `.msix`.
4. Run `npm run dist:msix`.
5. Upload `dist/LingoLearn-Phonetics-2.0.0.msix` on the Store **Packages** page.

The Store listing also needs screenshots, an age rating, a description, and a **privacy policy URL**.

Paste this in Partner Center → **Privacy policy URL**:

https://github.com/needyamin/lingoLearn-phonetics/blob/main/PRIVACY.md

Paste this in Partner Center → **Website**:

https://github.com/needyamin/lingoLearn-phonetics/blob/main/website.html

Push `PRIVACY.md` and `website.html` to `main` first so those links work. The privacy page is also **Help → Privacy Policy** in the app.

### Linux AppImage

From Windows, with Docker Desktop:

```bash
npm run dist:linux:docker
```

On Linux: `chmod +x "LingoLearn Phonetics-2.0.0.AppImage"` then run it. Needs kernel 3.10+, GLIBC 2.17+, X11 or Wayland.

## Updates

| Kind | How it works |
|------|----------------|
| **Dictionaries & lessons** | All builds. Checked a few seconds after launch, then every few hours. Unchanged files are skipped. |
| **Microsoft Store app** | Store updates the MSIX package. GitHub auto-update is off in Store builds. |
| **NSIS install** (`npm run dist`) | Downloads a new app build from [GitHub Releases](https://github.com/needyamin/lingoLearn-phonetics/releases) in the background. Applies when you close to the tray, click **Restart**, or Quit. Help → **Check for Updates**. |
| **Inno Setup / portable / `npm start`** | Program files do not self-replace. Install the new Setup `.exe` (or run a new portable). Materials still update. |

For GitHub app updates, attach `latest.yml` (from the NSIS build) plus the installer you want users to download.

## Tech

Electron · Web Speech TTS · Whisper (`@huggingface/transformers`, on-device) · Windows SAPI fallback · CMU Pronouncing Dictionary · Bangla dictionary · Inno Setup · MSIX

## License

ISC

## Privacy

[Privacy Policy](PRIVACY.md) · [Product website](website.html)

Partner Center URLs (after you push to `main`):

- Privacy: https://github.com/needyamin/lingoLearn-phonetics/blob/main/PRIVACY.md
- Website: https://github.com/needyamin/lingoLearn-phonetics/blob/main/website.html
