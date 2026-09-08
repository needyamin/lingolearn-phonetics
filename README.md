# LingoLearn Phonetics

LingoLearn is a desktop app for English pronunciation. Look up a word to hear it, see IPA phonetics and a Bangla meaning, or open **English Practice** and read short paragraphs out loud.

<img width="638" height="738" alt="Image" src="https://github.com/user-attachments/assets/c2a65521-d207-408a-b4f4-5b8cafd0b6d3" />

## Features

- **TTS** – Hear words and phrases with system voices
- **IPA** – Phonetic transcription (CMU Dict)
- **Bangla** – English-to-Bangla meanings (`asset/E2Bdatabase.json`)
- **English Practice** – Read a lesson paragraph; the app listens and marks each word
- **Clipboard** – Optional: speak / show IPA when you copy text
- **History** – Recent words; settings for rate, volume, and voice

## English Practice

Open it with the **📖** button on the main window.

1. Wait until the status says **Speech engine ready** (first run may download a local Whisper model).
2. Optionally click **Hear it** to listen to the paragraph.
3. Click **Start Speaking**, then read **one sentence** and **pause** for about half a second.
4. **What you said** shows the transcript. Green words matched; red words were missed. Keep reading forward — do not repeat missed words.

Speech recognition runs **on your PC** (Whisper). It does not need a Google speech API. A quiet room and a mic close to your mouth work best. If the local model cannot load, the app falls back to Windows speech recognition.

## Quick Start

```bash
git clone https://github.com/needyamin/lingoLearn-phonetics.git
cd lingoLearn-phonetics
npm install
npm start
```

## Build

| Platform | Command | Output |
|----------|---------|--------|
| **Windows** (portable exe) | `npm run dist` | `dist/LingoLearn Phonetics 1.0.0.exe` |
| **Linux** (AppImage) | `npm run dist:linux:docker` | `dist/LingoLearn Phonetics-1.0.0.AppImage` |

### Linux AppImage (on Windows)

Use Docker. One command from project root:

```bash
npm run dist:linux:docker
```

Or manually:

```bash
docker build -f Dockerfile.linux-build -t tts-pronunciation-linux-builder .
docker run --rm -v "y:/Projects/lingoLearn-phonetics/dist:/app/dist" tts-pronunciation-linux-builder
```

Output: `dist/LingoLearn Phonetics-1.0.0.AppImage` (~101 MB). Requires Docker Desktop.

**Alternatives:** Enable Windows Developer Mode, or run PowerShell as Administrator, then `npm run dist:linux`. Or use GitHub Actions to build on Linux.

### Using the Linux AppImage

1. Download `LingoLearn Phonetics-1.0.0.AppImage`
2. `chmod +x "LingoLearn Phonetics-1.0.0.AppImage"`
3. `./"LingoLearn Phonetics-1.0.0.AppImage"`

No install needed. Needs Linux kernel 3.10+, GLIBC 2.17+, X11 or Wayland.

## Deploy the single .exe

1. **Build:** `npm run dist` → creates `dist/LingoLearn Phonetics 1.0.0.exe` (single file, no installer).
2. **Share:** Copy the `.exe` anywhere (USB, cloud, another PC). Users double‑click to run; no install needed.
3. **GitHub Releases (recommended):**
   - Repo → **Releases** → **Create a new release** (tag e.g. `v1.0.0`).
   - Attach `LingoLearn Phonetics 1.0.0.exe` (and optionally `LingoLearn Phonetics-1.0.0.AppImage`).
   - Publish. Users download the exe from the release page.

## Auto-update

- **App:** When a new release is published on [GitHub Releases](https://github.com/needyamin/lingoLearn-phonetics/releases) (tag e.g. `v1.0.0`), the app checks and can auto-download and install on quit.
- **Dictionaries:** IPA and Bangla dictionary files are updated automatically from the repo when the app runs; no new app build needed for dict changes.

## Tech

Electron · Web Speech TTS · Whisper (`@huggingface/transformers`, on-device) · Windows SAPI fallback · CMU Pronouncing Dictionary · Bangla dictionary (`asset/E2Bdatabase.json`)

## License

ISC
