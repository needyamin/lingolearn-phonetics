const textInput = document.getElementById('text-input');
const btnSpeak = document.getElementById('btn-speak');
const btnStop = document.getElementById('btn-stop');
const btnClear = document.getElementById('btn-clear');
const ipaDisplay = document.getElementById('ipa-display');
const banglaDisplay = document.getElementById('bangla-display');
const btnSettings = document.getElementById('btn-settings');
const btnAnsnew = document.getElementById('btn-ansnew');
const settingsModal = document.getElementById('settings-modal');
const closeModal = document.querySelector('#settings-modal .close');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnResetSettings = document.getElementById('btn-reset-settings');

// Settings Elements
const settingTtsEnabled = document.getElementById('setting-tts-enabled');
const settingAutoSpeak = document.getElementById('setting-auto-speak');
const settingSpeakSelection = document.getElementById('setting-speak-selection');
const settingSpeakCopy = document.getElementById('setting-speak-copy');
const settingRate = document.getElementById('setting-rate');
const settingRateValue = document.getElementById('rate-value');
const settingVolume = document.getElementById('setting-volume');
const settingVolumeValue = document.getElementById('volume-value');
const settingVoice = document.getElementById('setting-voice');
const settingClipboard = document.getElementById('setting-clipboard');
const settingShowIpa = document.getElementById('setting-show-ipa');
const settingShowBangla = document.getElementById('setting-show-bangla');
const settingMinimizeTray = document.getElementById('setting-minimize-tray');
const settingLaunchLogin = document.getElementById('setting-launch-login');
const settingStartMinimized = document.getElementById('setting-start-minimized');
const settingPracticeSensitivity = document.getElementById('setting-practice-sensitivity');
const settingPracticeModel = document.getElementById('setting-practice-model');
const settingPracticePrompt = document.getElementById('setting-practice-prompt');
const settingLens = document.getElementById('setting-lens');
const settingLensCopy = document.getElementById('setting-lens-copy');
const settingLensDict = document.getElementById('setting-lens-dict');
const settingLensSpeakTarget = document.getElementById('setting-lens-speaktarget');
const settingLensTheme = document.getElementById('setting-lens-theme');
const settingLensMax = document.getElementById('setting-lens-max');
const settingLensAutoHide = document.getElementById('setting-lens-autohide');
const settingLensPosition = document.getElementById('setting-lens-position');

let settings = {};
let ipaDict = new Map();
let banglaDict = new Map();
let voices = [];
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

function addBanglaMeaning(word, meaning) {
    const key = String(word || '').toLowerCase().trim();
    const value = String(meaning || '').trim();
    if (!key || !value) return;
    if (!banglaDict.has(key)) banglaDict.set(key, []);
    const arr = banglaDict.get(key);
    if (!arr.includes(value)) arr.push(value);
}

function parseBanglaDict(content) {
    const trimmed = String(content || '').trim();
    if (!trimmed) return;

    if (trimmed.startsWith('[')) {
        try {
            const rows = JSON.parse(trimmed);
            if (Array.isArray(rows)) {
                for (const row of rows) {
                    addBanglaMeaning(row && row.en, row && row.bn);
                }
                banglaDictSize = banglaDict.size;
                console.log(`Loaded Bangla ${banglaDictSize} words`);
                return;
            }
        } catch (e) {
            console.error('Failed to parse E2B JSON dictionary', e);
        }
    }

    const lines = trimmed.split('\n');
    for (const line of lines) {
        const parts = line.trim().split('|').filter(Boolean);
        if (parts.length >= 2) addBanglaMeaning(parts[0], parts[1]);
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
    settingTtsEnabled.checked = settings.ttsEnabled !== false;
    settingAutoSpeak.checked = settings.autoSpeak !== false;
    settingSpeakSelection.checked = settings.speakOnSelection !== false;
    settingSpeakCopy.checked = settings.speakOnCopy !== false;
    settingRate.value = settings.speechRate || 1.0;
    settingRateValue.textContent = settings.speechRate || 1.0;
    settingVolume.value = settings.volume != null ? settings.volume : 1.0;
    settingVolumeValue.textContent = settings.volume != null ? settings.volume : 1.0;
    settingVoice.value = settings.voiceName || '';
    settingClipboard.checked = settings.clipboardMonitoring !== false;
    settingShowIpa.checked = settings.showIpa !== false;
    settingShowBangla.checked = settings.showBangla !== false;
    settingMinimizeTray.checked = settings.minimizeToTray !== false;
    settingLaunchLogin.checked = settings.launchAtLogin !== false;
    settingStartMinimized.checked = settings.startMinimized !== false;
    settingPracticeSensitivity.value = ['lenient', 'normal', 'strict'].includes(settings.practiceSensitivity)
        ? settings.practiceSensitivity : 'normal';
    settingPracticeModel.value = ['small', 'base', 'tiny'].includes(settings.practiceModel)
        ? settings.practiceModel : 'small';
    settingPracticePrompt.checked = settings.practiceUsePrompt !== false;
    settingLens.checked = settings.lensEnabled !== false;
    settingLensCopy.checked = settings.lensOnCopy !== false;
    settingLensDict.checked = settings.lensShowDictionary !== false;
    settingLensSpeakTarget.value = settings.lensSpeakTarget === 'translation' ? 'translation' : 'source';
    settingLensTheme.value = ['auto', 'light', 'dark'].includes(settings.lensTheme) ? settings.lensTheme : 'auto';
    settingLensMax.value = settings.lensMaxSelection || 600;
    settingLensAutoHide.value = settings.lensAutoHideSeconds != null ? settings.lensAutoHideSeconds : 20;
    settingLensPosition.value = settings.lensPosition === 'center' ? 'center' : 'cursor';

    applyDisplaySettings();

    const statEl = document.getElementById('dict-stat');
    if (statEl) statEl.textContent = `IPA: ${dictionarySize.toLocaleString()} · Bangla: ${banglaDictSize.toLocaleString()}`;
}

// Show/hide the IPA and Bangla blocks in the main window per settings.
function applyDisplaySettings() {
    const ipaContainer = document.querySelector('.ipa-container');
    const banglaContainer = document.querySelector('.bangla-container');
    if (ipaContainer) ipaContainer.style.display = settings.showIpa === false ? 'none' : '';
    if (banglaContainer) banglaContainer.style.display = settings.showBangla === false ? 'none' : '';
}

function collectSettingsFromUI() {
    return {
        ttsEnabled: settingTtsEnabled.checked,
        autoSpeak: settingAutoSpeak.checked,
        speakOnSelection: settingSpeakSelection.checked,
        speakOnCopy: settingSpeakCopy.checked,
        speechRate: parseFloat(settingRate.value) || 1.0,
        voiceName: settingVoice.value || null,
        volume: parseFloat(settingVolume.value),
        clipboardMonitoring: settingClipboard.checked,
        showIpa: settingShowIpa.checked,
        showBangla: settingShowBangla.checked,
        minimizeToTray: settingMinimizeTray.checked,
        launchAtLogin: settingLaunchLogin.checked,
        startMinimized: settingStartMinimized.checked,
        practiceSensitivity: settingPracticeSensitivity.value,
        practiceModel: settingPracticeModel.value,
        practiceUsePrompt: settingPracticePrompt.checked,
        lensEnabled: settingLens.checked,
        lensOnCopy: settingLensCopy.checked,
        lensShowDictionary: settingLensDict.checked,
        lensSpeakTarget: settingLensSpeakTarget.value === 'translation' ? 'translation' : 'source',
        lensTheme: ['auto', 'light', 'dark'].includes(settingLensTheme.value) ? settingLensTheme.value : 'auto',
        lensMaxSelection: Math.max(50, Math.min(1500, parseInt(settingLensMax.value, 10) || 600)),
        lensAutoHideSeconds: Math.max(0, Math.min(120, parseInt(settingLensAutoHide.value, 10) || 0)),
        lensPosition: settingLensPosition.value === 'center' ? 'center' : 'cursor'
    };
}

function saveSettingsFromUI() {
    const newSettings = collectSettingsFromUI();

    for (const [key, value] of Object.entries(newSettings)) {
        settings[key] = value;
        window.electronAPI.setSetting(key, value);
    }

    applyDisplaySettings();
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

    const btnPractice = document.getElementById('btn-practice');
    if (btnPractice) btnPractice.onclick = () => window.electronAPI.openPractice();

    // Footer attribution link - open in the system browser, never in-app.
    if (btnAnsnew) {
        btnAnsnew.onclick = (event) => {
            event.preventDefault();
            window.electronAPI.openExternal('https://inside.ansnew.com/');
        };
    }

    btnSettings.onclick = () => {
        updateSettingsUI();
        settingsModal.style.display = "block";
    };
    closeModal.onclick = () => settingsModal.style.display = "none";
    // window.onclick moved to bottom

    btnSaveSettings.onclick = saveSettingsFromUI;
    if (btnResetSettings) {
        btnResetSettings.onclick = async () => {
            const defaults = {
                ttsEnabled: true, autoSpeak: true, speakOnSelection: true, speakOnCopy: true,
                speechRate: 1.0, voiceName: null, volume: 1.0,
                clipboardMonitoring: true, showIpa: true, showBangla: true, minimizeToTray: true,
                launchAtLogin: true, startMinimized: true,
                lensEnabled: true, lensOnCopy: true, lensShowDictionary: true,
                lensSpeakTarget: 'source', lensTheme: 'auto', lensMaxSelection: 600,
                lensAutoHideSeconds: 20, lensPosition: 'cursor',
                practiceSensitivity: 'normal', practiceModel: 'small', practiceUsePrompt: true
            };
            for (const [key, value] of Object.entries(defaults)) {
                settings[key] = value;
                await window.electronAPI.setSetting(key, value);
            }
            updateSettingsUI();
        };
    }

    settingRate.oninput = () => settingRateValue.textContent = settingRate.value;
    settingVolume.oninput = () => settingVolumeValue.textContent = settingVolume.value;

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

    window.electronAPI.onCopyBangla?.(() => {
        if (banglaDisplay.textContent) navigator.clipboard.writeText(banglaDisplay.textContent);
    });

    window.electronAPI.onShowSettings?.(() => {
        settingsModal.style.display = 'block';
    });

    // About Modal Logic
    const aboutModal = document.getElementById('about-modal');
    const closeAbout = document.querySelector('.close-about');

    function closeAboutModal() {
        aboutModal.style.display = "none";
    }

    if (closeAbout) closeAbout.onclick = closeAboutModal;
    aboutModal.querySelectorAll('[data-url]').forEach((link) => {
        link.addEventListener('click', (event) => {
            event.preventDefault();
            window.electronAPI.openExternal(link.dataset.url);
        });
    });

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

    window.electronAPI.onDictsUpdated?.(async () => {
        setTimeout(async () => {
            ipaDict.clear();
            banglaDict.clear();
            const dictContent = await window.electronAPI.getIpaDict();
            if (dictContent) parseIpaDict(dictContent);
            const banglaContent = await window.electronAPI.getBanglaDict();
            if (banglaContent) parseBanglaDict(banglaContent);
            updateSettingsUI();
        }, 250);
    });

    setupUpdateBanner();
    setupAppMenu();
}

function setupAppMenu() {
    const bar = document.getElementById('app-menubar');
    if (!bar) return;
    const roots = [...bar.querySelectorAll('.menu-root')];
    const closeAll = () => roots.forEach((el) => el.classList.remove('is-open'));

    bar.querySelectorAll('.menu-btn').forEach((btn) => {
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            if (btn.dataset.action) {
                closeAll();
                runMenuAction(btn.dataset.action);
                return;
            }
            const root = btn.closest('.menu-root');
            const open = root.classList.contains('is-open');
            closeAll();
            if (!open) root.classList.add('is-open');
        });
    });

    roots.forEach((root) => {
        root.addEventListener('mouseenter', () => {
            if (!roots.some((item) => item.classList.contains('is-open'))) return;
            if (!root.querySelector('.menu-panel')) return;
            closeAll();
            root.classList.add('is-open');
        });
    });

    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeAll();
    });

    bar.addEventListener('click', (event) => {
        const item = event.target.closest('[data-action]');
        if (!item) return;
        closeAll();
        runMenuAction(item.dataset.action);
    });
}

function runMenuAction(action) {
    if (action === 'clear') btnClear.click();
    else if (action === 'practice') window.electronAPI.openPractice();
    else if (action === 'settings') settingsModal.style.display = 'block';
    else if (action === 'exit') window.electronAPI.quitApp();
    else if (action === 'zoomIn') window.electronAPI.setZoom('in');
    else if (action === 'zoomOut') window.electronAPI.setZoom('out');
    else if (action === 'zoomReset') window.electronAPI.setZoom('reset');
    else if (action === 'fullscreen') window.electronAPI.toggleFullScreen();
    else if (action === 'updates') window.electronAPI.checkAppUpdate().catch(() => {});
    else if (action === 'privacy') window.electronAPI.openExternal('https://github.com/needyamin/lingoLearn-phonetics/blob/main/PRIVACY.md');
    else if (action === 'issue') window.electronAPI.openExternal('https://github.com/needyamin/lingoLearn-phonetics/issues');
    else if (action === 'about') {
        const aboutModal = document.getElementById('about-modal');
        if (aboutModal) aboutModal.style.display = 'block';
    }
}

function setupUpdateBanner() {
    const banner = document.getElementById('update-banner');
    const text = document.getElementById('update-banner-text');
    const action = document.getElementById('update-banner-action');
    const closeBtn = document.getElementById('update-banner-close');
    if (!banner || !text) return;

    let hideTimer = null;
    const showBanner = (message, { ready = false, materials = false, current = false, error = false, actionLabel = '' } = {}) => {
        banner.hidden = false;
        banner.classList.toggle('is-ready', ready);
        banner.classList.toggle('is-materials', materials && !ready);
        banner.classList.toggle('is-current', current);
        banner.classList.toggle('is-error', error);
        text.textContent = message;
        if (action) {
            action.hidden = !actionLabel;
            action.textContent = actionLabel || 'Restart';
        }
    };
    const hideBanner = () => {
        banner.hidden = true;
        if (action) action.hidden = true;
    };

    if (action) action.onclick = () => window.electronAPI.installAppUpdate();
    if (closeBtn) closeBtn.onclick = hideBanner;

    window.electronAPI.onAppUpdate?.((event) => {
        if (!event) return;
        clearTimeout(hideTimer);
        if (event.kind === 'checking') showBanner('Checking for updates…');
        if (event.kind === 'available') showBanner(`Downloading version ${event.version || ''}…`);
        if (event.kind === 'downloading') showBanner(`Updating in the background… ${event.percent || 0}%`);
        if (event.kind === 'ready') showBanner(`Version ${event.version || ''} is ready.`, { ready: true, actionLabel: 'Restart' });
        if (event.kind === 'current') {
            const version = event.version ? ` v${event.version}` : '';
            showBanner(`You're up to date.${version}`, { current: true });
            hideTimer = setTimeout(hideBanner, 4000);
        }
        if (event.kind === 'materials') {
            showBanner('Dictionaries and practice lessons updated.', { materials: true });
            hideTimer = setTimeout(hideBanner, 4000);
        }
        if (event.kind === 'error') {
            showBanner(event.message || 'Could not check for updates.', { error: true });
            hideTimer = setTimeout(hideBanner, 5000);
        }
        if (event.kind === 'idle' && !banner.classList.contains('is-ready')) hideBanner();
    });

    window.electronAPI.onMaterialsUpdated?.(() => {
        if (banner.classList.contains('is-ready')) return;
        showBanner('Dictionaries and practice lessons updated.', { materials: true });
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            if (banner.classList.contains('is-materials')) hideBanner();
        }, 4000);
    });
}

init();
