# TTS Pronunciation Practice

Desktop app for practicing English pronunciation with Text-to-Speech and IPA. Includes an English–Bangla dictionary.

<img width="639" height="745" alt="Image" src="https://github.com/user-attachments/assets/8ea55153-e1d5-4683-9ca9-c137c7c962be" />

## Features

- **TTS** – Hear words/phrases with system voices
- **IPA** – Phonetic transcription (CMU Dict)
- **Bangla** – English-to-Bangla meanings
- **Clipboard** – Optional: speak/show IPA when you copy text
- **History** – Recent words; settings for rate, volume, voice

## Quick Start

```bash
git clone https://github.com/needyamin/tts-pronunciation-practice.git
cd tts-pronunciation-practice
npm install
npm start
```

## Build

| Platform | Command | Output |
|----------|---------|--------|
| **Windows** (portable exe) | `npm run dist` | `dist/TTS Pronunciation Practice 1.0.0.exe` |
| **Linux** (AppImage) | `npm run dist:linux:docker` | `dist/TTS Pronunciation Practice-1.0.0.AppImage` |

**Linux on Windows:** Need Docker. See [build-linux.md](build-linux.md).

## Tech

Electron · Web Speech API · CMU Pronouncing Dictionary · Bangla dictionary (asset)

## License

ISC

