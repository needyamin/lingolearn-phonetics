const textInput = document.getElementById('text-input');
const btnSpeak = document.getElementById('btn-speak');
const btnStop = document.getElementById('btn-stop');
const btnClear = document.getElementById('btn-clear');
const ipaDisplay = document.getElementById('ipa-display');
const banglaDisplay = document.getElementById('bangla-display');
const historyList = document.getElementById('history-list');
const btnSettings = document.getElementById('btn-settings');
const settingsModal = document.getElementById('settings-modal');
const closeModal = document.querySelector('.close');
const btnSaveSettings = document.getElementById('btn-save-settings');

// Settings Elements
const settingTtsEnabled = document.getElementById('setting-tts-enabled');
const settingAutoSpeak = document.getElementById('setting-auto-speak');
const settingRate = document.getElementById('setting-rate');
const settingRateValue = document.getElementById('rate-value');
const settingVolume = document.getElementById('setting-volume');
const settingVolumeValue = document.getElementById('volume-value');
const settingVoice = document.getElementById('setting-voice');
const settingClipboard = document.getElementById('setting-clipboard');
const settingShowIpa = document.getElementById('setting-show-ipa');

let settings = {};
let ipaDict = new Map();
let banglaDict = new Map();
let voices = [];
let history = [];
let dictionarySize = 0;
let banglaDictSize = 0;

const CUSTOM_IPA = {
    "yamin": "jɑːˈmiːn",
    "million": "ˈmɪl.jən",
    "billion": "ˈbɪl.jən"
};

async function init() {
    settings = await window.electronAPI.getSettings();
    updateSettingsUI();

    const dictContent = await window.electronAPI.getIpaDict();
    if (dictContent) parseIpaDict(dictContent);
    const banglaContent = await window.electronAPI.getBanglaDict();
    if (banglaContent) parseBanglaDict(banglaContent);

    populateVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = populateVoices;
    }

    setupEventListeners();
}

function parseIpaDict(content) {
    const lines = content.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith(';;;')) {
            // Split on the first sequence of whitespace
            const match = trimmed.match(/^(\S+)\s+(.+)$/);
            if (match) {
                ipaDict.set(match[1].toLowerCase(), match[2]);
            }
        }
    }
    dictionarySize = ipaDict.size;
    console.log(`Loaded ${dictionarySize} words`);
}

function parseBanglaDict(content) {
    const lines = content.split('\n');
    for (const line of lines) {
        const parts = line.trim().split('|').filter(Boolean);
        if (parts.length >= 2) {
            const word = parts[0].toLowerCase().trim();
            const meaning = parts[1].trim();
            if (!banglaDict.has(word)) banglaDict.set(word, []);
            const arr = banglaDict.get(word);
            if (!arr.includes(meaning)) arr.push(meaning);
        }
    }
    banglaDictSize = banglaDict.size;
    console.log(`Loaded Bangla ${banglaDictSize} words`);
}

function populateVoices() {
    voices = speechSynthesis.getVoices();
    settingVoice.innerHTML = '';

    let selectedIndex = 0;
    voices.forEach((voice, index) => {
        const option = document.createElement('option');
        option.textContent = `${voice.name} (${voice.lang})`;
        option.value = voice.name;

        if (voice.default) {
            option.textContent += ' -- DEFAULT';
        }

        settingVoice.appendChild(option);

        if (settings.voiceName && voice.name === settings.voiceName) {
            selectedIndex = index;
        }
    });

    settingVoice.selectedIndex = selectedIndex;
}

function updateSettingsUI() {
    settingTtsEnabled.checked = settings.ttsEnabled;
    settingAutoSpeak.checked = settings.autoSpeak;
    settingRate.value = settings.speechRate || 1.0;
    settingRateValue.textContent = settings.speechRate || 1.0;
    settingVolume.value = settings.volume;
    settingVolumeValue.textContent = settings.volume;
    settingClipboard.checked = settings.clipboardMonitoring;
    settingShowIpa.checked = settings.showIpa;

    const statEl = document.getElementById('dict-stat');
    if (statEl) statEl.textContent = `IPA: ${dictionarySize.toLocaleString()} · Bangla: ${banglaDictSize.toLocaleString()}`;
}

function saveSettingsFromUI() {
    const newSettings = {
        ttsEnabled: settingTtsEnabled.checked,
        autoSpeak: settingAutoSpeak.checked,
        speechRate: parseFloat(settingRate.value),
        voiceName: settingVoice.value,
        volume: parseFloat(settingVolume.value),
        clipboardMonitoring: settingClipboard.checked,
        showIpa: settingShowIpa.checked
    };

    for (const [key, value] of Object.entries(newSettings)) {
        settings[key] = value;
        window.electronAPI.setSetting(key, value);
    }

    settingsModal.style.display = "none";
}

function speak(text) {
    if (!settings.ttsEnabled) return;

    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);

    const voice = voices.find(v => v.name === settings.voiceName);
    if (voice) {
        utterance.voice = voice;
    }

    utterance.rate = settings.speechRate || 1.0;
    utterance.volume = settings.volume || 1.0;

    btnSpeak.textContent = "🔊 Speaking...";
    btnSpeak.classList.add('speaking');
    btnStop.style.display = 'inline-block';

    utterance.onend = () => {
        resetSpeakButton();
    };

    utterance.onerror = (e) => {
        console.error('Speech error', e);
        resetSpeakButton();
    };

    speechSynthesis.speak(utterance);
}

function resetSpeakButton() {
    btnSpeak.textContent = "🔊 Speak";
    btnSpeak.classList.remove('speaking');
    btnStop.style.display = 'none';
}

function getIpa(text) {
    if (!settings.showIpa) return '';

    const lower = text.toLowerCase().trim();
    if (CUSTOM_IPA[lower]) return CUSTOM_IPA[lower];

    if (ipaDict.has(lower)) return ipaDict.get(lower);
    // Clean punctuation for lookup
    const cleanWord = (w) => w.toLowerCase().replace(/[^a-z']/g, '');

    if (lower.includes(' ')) {
        const words = lower.split(/\s+/);
        const ipas = words.map(w => {
            // 1. Try Custom
            if (CUSTOM_IPA[w]) return CUSTOM_IPA[w];

            // 2. Try Exact Match (e.g. "3-d")
            if (ipaDict.has(w)) return ipaDict.get(w);

            // 3. Try Cleaned Match (e.g. "hello." -> "hello")
            const cleaned = cleanWord(w);
            if (cleaned && cleaned !== w) {
                if (CUSTOM_IPA[cleaned]) return CUSTOM_IPA[cleaned];
                if (ipaDict.has(cleaned)) return ipaDict.get(cleaned);
            }

            return w;
        });
        return ipas.join('   '); // Use wider spacing for separation
    }

    // Single word lookup (same logic)
    if (CUSTOM_IPA[lower]) return CUSTOM_IPA[lower];
    if (ipaDict.has(lower)) return ipaDict.get(lower);

    const cleaned = cleanWord(lower);
    if (cleaned && cleaned !== lower && ipaDict.has(cleaned)) return ipaDict.get(cleaned);

    return '(Not found)';
}

function getBangla(text) {
    const lower = text.toLowerCase().trim();
    const cleanWord = (w) => w.toLowerCase().replace(/[^a-z']/g, '');
    if (lower.includes(' ')) {
        const words = lower.split(/\s+/);
        const parts = words.map(w => {
            const key = banglaDict.has(w) ? w : cleanWord(w);
            const arr = banglaDict.get(key);
            return arr && arr.length ? arr.join(', ') : '';
        });
        return parts.join('   ').trim() || '';
    }
    const arr = banglaDict.get(lower) || banglaDict.get(cleanWord(lower));
    return arr && arr.length ? arr.join(', ') : '';
}

function addToHistory(text) {
    if (!text) return;
    history = history.filter(item => item !== text);
    history.unshift(text);
    if (history.length > 50) history.pop();
    renderHistory();
}

function renderHistory() {
    historyList.innerHTML = '';
    history.forEach(item => {
        const div = document.createElement('div');
        div.className = 'history-item';
        div.textContent = item;
        div.onclick = () => {
            textInput.value = item;
            handleInput(item);
        };
        historyList.appendChild(div);
    });
}

function handleInput(text) {
    if (!text) return;

    const ipa = getIpa(text);
    ipaDisplay.textContent = ipa;
    if (ipa === '(Not found)') {
        ipaDisplay.classList.add('ipa-error');
    } else {
        ipaDisplay.classList.remove('ipa-error');
    }
    banglaDisplay.textContent = getBangla(text);

    speak(text);
    addToHistory(text);
}

function setupEventListeners() {
    btnSpeak.onclick = () => handleInput(textInput.value);

    textInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            handleInput(textInput.value);
        }
    });

    btnStop.onclick = () => {
        speechSynthesis.cancel();
        resetSpeakButton();
    };

    btnClear.onclick = () => {
        textInput.value = '';
        ipaDisplay.textContent = '';
        banglaDisplay.textContent = '';
        textInput.focus();
    };

    btnSettings.onclick = () => settingsModal.style.display = "block";
    closeModal.onclick = () => settingsModal.style.display = "none";
    // window.onclick moved to bottom

    btnSaveSettings.onclick = saveSettingsFromUI;

    settingRate.oninput = () => settingRateValue.textContent = settingRate.value;
    settingVolume.oninput = () => settingVolumeValue.textContent = settingVolume.value;

    const btnClearHistoryUI = document.getElementById('btn-clear-history-ui');
    if (btnClearHistoryUI) {
        btnClearHistoryUI.onclick = () => {
            history = [];
            renderHistory();
        };
    }

    window.electronAPI.onClipboardUpdate((text) => {
        if (settings.clipboardMonitoring) {
            textInput.value = text;
            const ipa = getIpa(text);
            ipaDisplay.textContent = ipa;
            if (ipa === '(Not found)') {
                ipaDisplay.classList.add('ipa-error');
            } else {
                ipaDisplay.classList.remove('ipa-error');
            }
            banglaDisplay.textContent = getBangla(text);

            if (settings.autoSpeak) {
                speak(text);
            }
        }
    });

    window.electronAPI.onClearHistory(() => {
        history = [];
        renderHistory();
    });

    window.electronAPI.onClearEntry(() => {
        textInput.value = '';
        ipaDisplay.textContent = '';
        banglaDisplay.textContent = '';
    });

    window.electronAPI.onCopyIpa(() => {
        if (ipaDisplay.textContent) {
            navigator.clipboard.writeText(ipaDisplay.textContent);
        }
    });

    // About Modal Logic
    const aboutModal = document.getElementById('about-modal');
    const closeAbout = document.querySelector('.close-about');
    const btnCloseAbout = document.getElementById('btn-close-about');

    function closeAboutModal() {
        aboutModal.style.display = "none";
    }

    if (closeAbout) closeAbout.onclick = closeAboutModal;
    if (btnCloseAbout) btnCloseAbout.onclick = closeAboutModal;
    const aboutGithub = document.getElementById('about-github');
    if (aboutGithub) aboutGithub.onclick = (e) => { e.preventDefault(); window.electronAPI.openExternal('https://github.com/needyamin'); };

    // Window click to close modals
    window.onclick = (event) => {
        if (event.target == settingsModal) {
            settingsModal.style.display = "none";
        }
        if (event.target == aboutModal) {
            aboutModal.style.display = "none";
        }
    };

    window.electronAPI.onShowAbout(() => {
        aboutModal.style.display = "block";
    });
}

init();
