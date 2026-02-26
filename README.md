# LingoLearn Phonetics

LingoLearn helps students master English pronunciation using real voice output, IPA phonetics, and a built-in English–Bangla dictionary.

<img width="639" height="745" alt="Image" src="https://github.com/user-attachments/assets/8ea55153-e1d5-4683-9ca9-c137c7c962be" />

## Features

- **TTS** – Hear words/phrases with system voices
- **IPA** – Phonetic transcription (CMU Dict)
- **Bangla** – English-to-Bangla meanings
- **Clipboard** – Optional: speak/show IPA when you copy text
- **History** – Recent words; settings for rate, volume, voice

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

## Tech

Electron · Web Speech API · CMU Pronouncing Dictionary · Bangla dictionary (asset)

## License

ISC
