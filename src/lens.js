"use strict";

/*
 * LingoLearn Lens - popup renderer.
 *
 * Receives { text, note, result, theme, showDictionary, speakTarget } from the
 * main process and renders the extension-style popup: meaning, /IPA/, note
 * line, optional dictionary chips, Speak/Stop and a Google Translate footer
 * button. Reads fresh settings on every payload and keeps no state between
 * payloads.
 */

const el = {
    lang: document.getElementById('ll-lang'),
    selection: document.getElementById('ll-selection'),
    meaning: document.getElementById('ll-meaning'),
    ipa: document.getElementById('ll-ipa'),
    note: document.getElementById('ll-note'),
    error: document.getElementById('ll-error'),
    dict: document.getElementById('ll-dict'),
    speak: document.getElementById('ll-speak'),
    close: document.getElementById('ll-close'),
    gt: document.getElementById('ll-gt'),
    brand: document.getElementById('ll-brand'),
};

const BANGLA_RE = /[\u0980-\u09FF]/;

let currentText = '';
let currentSpeakText = '';
let currentPreferBangla = false;

const LANG_NAMES = {
    en: 'English', bn: 'Bangla', hi: 'Hindi', ar: 'Arabic', fr: 'French',
    de: 'German', es: 'Spanish', ru: 'Russian', ur: 'Urdu', fa: 'Persian',
    pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
};

function langName(code) {
    const c = String(code || 'en').split('-')[0];
    return LANG_NAMES[c] || String(code || 'Text');
}

function applyTheme(theme) {
    const value = theme === 'dark' || theme === 'light' ? theme : 'auto';
    document.documentElement.dataset.theme = value;
}

function setSpeaking(active) {
    el.speak.classList.toggle('speaking', Boolean(active));
    el.speak.title = active ? 'Speaking - click to stop' : 'Pronounce';
}

function stopSpeech() {
    try { speechSynthesis.cancel(); } catch (_) {}
    setSpeaking(false);
}

function resolveVoice(voices, preferBangla, voiceName) {
    if (voiceName) {
        const forced = voices.find((v) => v.name === voiceName);
        if (forced) return forced;
    }
    if (preferBangla) {
        return voices.find((v) => (v.lang || '').toLowerCase().replace('_', '-').startsWith('bn')) || null;
    }
    return null;
}

function speak(text, settings, preferBangla) {
    if (!settings || !settings.ttsEnabled || !text) return;
    stopSpeech();
    const u = new SpeechSynthesisUtterance(text);
    const voice = resolveVoice(speechSynthesis.getVoices() || [], preferBangla, settings.voiceName);
    if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
    } else if (preferBangla) {
        u.lang = 'bn-IN';
    }
    u.rate = Math.min(2, Math.max(0.5, Number(settings.speechRate) || 1));
    u.volume = Math.min(1, Math.max(0, Number(settings.volume)));
    if (!Number.isFinite(u.volume)) u.volume = 1;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    speechSynthesis.speak(u);
}

function renderDict(groups) {
    el.dict.textContent = '';
    const list = Array.isArray(groups) ? groups.filter((g) => g && g.terms && g.terms.length) : [];
    el.dict.classList.toggle('hidden', list.length === 0);
    for (const group of list) {
        const item = document.createElement('div');
        item.className = 'dict-item';

        const pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = group.pos || '';

        const terms = document.createElement('span');
        terms.className = 'terms';
        for (const term of group.terms.slice(0, 4)) {
            const chip = document.createElement('span');
            chip.className = 'term';
            chip.textContent = term;
            terms.appendChild(chip);
        }

        item.append(pos, terms);
        el.dict.appendChild(item);
    }
}

async function render(payload) {
    currentText = String(payload.text || '');
    currentSpeakText = currentText;
    currentPreferBangla = BANGLA_RE.test(currentText);

    const result = payload.result || {};
    applyTheme(payload.theme);

    stopSpeech();

    // Clear previous content first so a reused popup never flashes stale text.
    el.meaning.textContent = '';
    el.error.textContent = '';
    el.error.classList.add('hidden');
    el.ipa.textContent = '';
    el.ipa.classList.add('hidden');
    el.dict.textContent = '';
    el.dict.classList.add('hidden');
    el.note.textContent = '';
    el.note.classList.add('hidden');

    el.selection.textContent = currentText.length > 120 ? currentText.slice(0, 120) + '\u2026' : currentText;
    el.note.textContent = payload.note || '';
    el.note.classList.toggle('hidden', !payload.note);

    if (result.ok) {
        const detected = String(result.detectedLanguage || 'en');
        const alreadyBn = detected === 'bn';
        el.lang.textContent = alreadyBn ? 'Bangla \u2192 English' : 'English \u2192 Bangla';
        el.error.classList.add('hidden');
        el.meaning.textContent = result.translation || (alreadyBn ? '(Already Bangla)' : '');

        const ipa = String(result.ipa || '').trim();
        el.ipa.textContent = ipa ? `/${ipa}/` : '';
        el.ipa.classList.toggle('hidden', !ipa);

        const showDictionary = payload.showDictionary !== false;
        renderDict(showDictionary ? result.dictionary : []);

        if (payload.speakTarget === 'translation' && result.translation && !alreadyBn) {
            currentSpeakText = String(result.translation);
            currentPreferBangla = true;
        }
    } else {
        el.lang.textContent = 'LingoLearn Lens';
        el.meaning.textContent = '';
        el.ipa.classList.add('hidden');
        el.dict.classList.add('hidden');
        el.error.textContent = result.error || 'Could not translate the selected text.';
        el.error.classList.remove('hidden');
    }

    try {
        await window.electronAPI.resizeLens(document.documentElement.scrollHeight);
    } catch (_) {}

    const settings = await window.electronAPI.getSettings();
    const speakOnShow = payload.speakOnShow !== false;
    if (settings && settings.autoSpeak && settings.ttsEnabled && currentSpeakText && speakOnShow) {
        speak(currentSpeakText, settings, currentPreferBangla);
    }
}

el.speak.addEventListener('click', async () => {
    if (speechSynthesis.speaking) {
        stopSpeech();
        return;
    }
    const settings = await window.electronAPI.getSettings();
    speak(currentSpeakText || currentText, settings, currentPreferBangla);
});

el.close.addEventListener('click', () => {
    stopSpeech();
    window.electronAPI.hideLens();
});

el.gt.addEventListener('click', () => {
    if (!currentText) return;
    window.electronAPI.openGoogleTranslate(currentText);
    window.electronAPI.hideLens();
});

el.brand.addEventListener('click', (event) => {
    event.preventDefault();
    window.electronAPI.openExternal('https://inside.ansnew.com/');
});

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        stopSpeech();
        window.electronAPI.hideLens();
    }
});

window.addEventListener('blur', () => stopSpeech());

window.electronAPI.onLensPayload((payload) => {
    render(payload).catch(() => {});
});

window.electronAPI.onLensHidden(() => stopSpeech());
