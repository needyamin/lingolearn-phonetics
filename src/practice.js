const FALLBACK_LESSONS = [
    {
        title: 'A Sunny Day',
        text: 'The sun is bright today. I like to walk in the park. Birds sing in the trees. It is a happy day.'
    },
    {
        title: 'My School',
        text: 'My name is Tom. I am a student. I go to school every day. I like to read books and play with my friends.'
    },
    {
        title: 'My Cat',
        text: 'This is my cat. She is small and white. She likes to sleep on the sofa. I give her milk every morning.'
    },
    {
        title: 'At Home',
        text: 'I live in a small house. We eat dinner at six. My mother cooks rice and fish. We sit together and talk.'
    },
    {
        title: 'Good Morning',
        text: 'I wake up early in the morning. I wash my face and brush my teeth. Then I eat breakfast and go to school.'
    },
    {
        title: 'My Friend',
        text: 'Sara is my best friend. She is kind and funny. We play football after class. We help each other with homework.'
    },
    {
        title: 'The Market',
        text: 'I go to the market with my father. We buy apples, bread, and milk. The shop is busy. I say thank you to the man.'
    },
    {
        title: 'A Rainy Day',
        text: 'It is raining today. I take my umbrella to school. The streets are wet. I jump in a small water puddle.'
    }
];

let LESSONS = FALLBACK_LESSONS;
const READY_HINT = 'Tap Speak, then read. Pause after each sentence.';

const practiceText = document.getElementById('practice-text');
const lessonLabel = document.getElementById('lesson-label');
const lessonTitle = document.getElementById('lesson-title');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');
const heardWordsEl = document.getElementById('heard-words');
const heardPanel = document.getElementById('heard-panel');
const heardCountEl = document.getElementById('heard-count');
const statusEl = document.getElementById('practice-status');
const successEl = document.getElementById('practice-success');
const speakHereCue = document.getElementById('speak-here-cue');
const speakHereLabel = document.getElementById('speak-here-label');
const speakHereWord = document.getElementById('speak-here-word');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnListen = document.getElementById('btn-listen');
const btnMic = document.getElementById('btn-mic');
const btnReset = document.getElementById('btn-reset');
const micMeter = document.getElementById('mic-meter');
const micMeterFill = document.getElementById('mic-meter-fill');

let lessonIndex = 0;
let tokens = [];
let marks = [];
let listening = false;
let engineMode = 'none';
let spokenCursor = 0;
let whisperReady = false;

const NUMBER_WORDS = {
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
    '10': 'ten'
};

function normalizeWord(word) {
    const cleaned = String(word || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return NUMBER_WORDS[cleaned] || cleaned;
}

function levenshtein(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (let i = 0; i < rows; i++) dp[i][0] = i;
    for (let j = 0; j < cols; j++) dp[0][j] = j;
    for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return dp[a.length][b.length];
}

function wordsMatch(spoken, expected) {
    if (!spoken || !expected) return false;
    if (spoken === expected) return true;

    const minLen = Math.min(spoken.length, expected.length);
    const dist = levenshtein(spoken, expected);
    if (minLen >= 4 && dist === 1) return true;

    const stem = (word) => word.replace(/(ing|ed|es|s)$/g, '');
    const a = stem(spoken);
    const b = stem(expected);
    return a.length >= 3 && a === b;
}

function tokenize(text) {
    return text.split(/(\s+)/).map((part) => ({
        raw: part,
        isWord: !/^\s+$/.test(part),
        normalized: normalizeWord(part)
    }));
}

function targetIndexes() {
    return tokens.reduce((list, token, i) => {
        if (token.isWord && token.normalized) list.push(i);
        return list;
    }, []);
}

function wordCount() {
    return targetIndexes().length;
}

function currentWordIndex() {
    return tokens.findIndex((token, i) => token.isWord && token.normalized && !marks[i]);
}

function displayWord(token) {
    return token ? String(token.raw).replace(/[.,!?;:]+$/g, '') : '';
}

function updateSpeakHereCue() {
    const current = currentWordIndex();
    const complete = current < 0;
    if (speakHereCue) speakHereCue.classList.toggle('is-hidden', complete);
    if (complete) return;

    const word = displayWord(tokens[current]);
    if (speakHereWord) speakHereWord.textContent = word;

    const judged = marks.some(Boolean);
    const last = judged ? marks.filter(Boolean).pop() : '';
    const skipped = last === 'wrong' || last === 'missed';
    if (speakHereLabel) {
        speakHereLabel.textContent = skipped ? 'Missed. Keep reading from here' : (judged ? 'Keep reading from here' : 'Start reading from here');
    }
}

function renderParagraph() {
    practiceText.innerHTML = '';
    const current = currentWordIndex();

    tokens.forEach((token, i) => {
        if (!token.isWord) {
            practiceText.appendChild(document.createTextNode(token.raw));
            return;
        }

        const span = document.createElement('span');
        span.className = 'practice-word';
        span.textContent = token.raw;
        if (marks[i] === 'correct') span.classList.add('correct');
        else if (marks[i] === 'missed') span.classList.add('missed');
        else if (marks[i] === 'wrong') span.classList.add('wrong');
        else if (i === current) span.classList.add('current');
        practiceText.appendChild(span);
    });

    updateSpeakHereCue();
}

function updateProgress() {
    const total = wordCount();
    const correct = marks.filter((mark) => mark === 'correct').length;
    const wrong = marks.filter((mark) => mark === 'wrong' || mark === 'missed').length;
    const judged = correct + wrong;
    const left = Math.max(total - judged, 0);
    progressFill.style.width = `${total ? Math.round((judged / total) * 100) : 0}%`;
    progressFill.classList.toggle('has-wrong', wrong > 0);
    progressLabel.textContent = `${correct} correct · ${wrong} missed · ${left} left`;

    const complete = total > 0 && judged === total;
    successEl.hidden = !complete;
    successEl.classList.toggle('is-mixed', complete && wrong > 0);
    if (complete) {
        successEl.textContent = wrong === 0
            ? 'Done. Every word matched.'
            : `Done. ${correct} correct, ${wrong} missed.`;
        if (listening) stopListening();
        return;
    }

    const current = currentWordIndex();
    if (listening && current >= 0) {
        const nextWord = displayWord(tokens[current]);
        if (wrong > 0 && (marks.filter(Boolean).pop() === 'wrong' || marks.filter(Boolean).pop() === 'missed')) {
            setStatus(`Missed. Continue from “${nextWord}”.`, 'listening');
        } else {
            setStatus(`Listening from “${nextWord}”`, 'listening');
        }
    }
}

function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.classList.toggle('is-error', kind === 'error');
    statusEl.classList.toggle('is-listening', kind === 'listening');
}

const FILLERS = new Set(['um', 'uh', 'er', 'ah', 'hmm', 'mm', 'mhm', 'uhh', 'uhm']);
let spokenLog = [];
let heardSentence = '';
const heardSentenceEl = document.getElementById('heard-sentence');

function skipWindow(word, remainingSpoken) {
    if (remainingSpoken >= 12) return 10;
    if (!word || word.length <= 2) return 2;
    if (word.length <= 3) return 4;
    return 8;
}

function alignParagraph(spoken) {
    const targets = targetIndexes();
    const expected = targets.map((idx) => tokens[idx].normalized);
    const matchedAt = new Array(expected.length).fill(-1);
    let nextExpected = 0;

    for (let si = 0; si < spoken.length && nextExpected < expected.length; si++) {
        const word = spoken[si];
        const limit = Math.min(expected.length, nextExpected + skipWindow(expected[nextExpected], spoken.length - si));
        let found = -1;
        for (let ei = nextExpected; ei < limit; ei++) {
            if (matchedAt[ei] >= 0) continue;
            if (wordsMatch(word, expected[ei])) {
                found = ei;
                break;
            }
        }
        if (found >= 0) {
            matchedAt[found] = si;
            nextExpected = found + 1;
        }
    }

    let lastMatched = -1;
    for (let ei = 0; ei < matchedAt.length; ei++) {
        if (matchedAt[ei] >= 0) lastMatched = ei;
    }

    const aligned = tokens.map(() => '');
    for (let ei = 0; ei < expected.length; ei++) {
        const idx = targets[ei];
        if (matchedAt[ei] >= 0) aligned[idx] = 'correct';
        else if (ei < lastMatched) aligned[idx] = 'missed';
    }
    return aligned;
}

function displaySpokenWords(text) {
    return String(text || '')
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/^[^a-zA-Z0-9']+|[^a-zA-Z0-9']+$/g, ''))
        .filter(Boolean);
}

function renderHeardWords(spoken) {
    const chips = heardSentence ? displaySpokenWords(heardSentence) : spoken;
    if (heardPanel) heardPanel.hidden = !heardSentence && !chips.length;
    if (heardCountEl) {
        heardCountEl.hidden = true;
        heardCountEl.textContent = String(chips.length);
    }
    if (heardSentenceEl) {
        heardSentenceEl.textContent = heardSentence;
        heardSentenceEl.hidden = !heardSentence;
    }
    if (!heardWordsEl) return;
    heardWordsEl.innerHTML = '';
    if (!chips.length) {
        const empty = document.createElement('span');
        empty.className = 'heard-empty';
        empty.textContent = 'Read a phrase, then pause. Your exact words appear here.';
        heardWordsEl.appendChild(empty);
        return;
    }
    chips.forEach((word, i) => {
        const chip = document.createElement('span');
        chip.className = i === chips.length - 1 ? 'heard-chip is-latest' : 'heard-chip';
        chip.textContent = word;
        heardWordsEl.appendChild(chip);
    });
    heardWordsEl.scrollTop = heardWordsEl.scrollHeight;
}

function scoreSpoken(spokenWords) {
    const spoken = spokenWords.filter((word) => word && !FILLERS.has(word));
    renderHeardWords(spoken);
    marks = alignParagraph(spoken);
    spokenCursor = targetIndexes().filter((idx) => marks[idx]).length;
    renderParagraph();
    updateProgress();
}

function applyTranscript(spokenText) {
    heardSentence = String(spokenText || '').replace(/\s+/g, ' ').trim();
    spokenLog = heardSentence.split(/\s+/).map(normalizeWord).filter(Boolean);
    scoreSpoken(spokenLog);
}

function consumeSpokenWords(words) {
    if (!words.length) return;
    spokenLog = spokenLog.concat(words);
    heardSentence = spokenLog.join(' ');
    scoreSpoken(spokenLog);
}

function setMicLevel(level) {
    if (!micMeterFill) return;
    const pct = Math.min(100, Math.round(level * 320));
    micMeterFill.style.width = `${pct}%`;
    micMeterFill.classList.toggle('is-hot', pct > 55);
}

function loadLesson(index) {
    stopListening();
    speechSynthesis.cancel();
    lessonIndex = (index + LESSONS.length) % LESSONS.length;
    const lesson = LESSONS[lessonIndex];
    tokens = tokenize(lesson.text);
    marks = tokens.map(() => '');
    spokenCursor = 0;
    spokenLog = [];
    heardSentence = '';
    lessonLabel.textContent = `${lessonIndex + 1} / ${LESSONS.length}`;
    lessonTitle.textContent = lesson.title;
    renderHeardWords([]);
    successEl.hidden = true;
    setStatus(READY_HINT);
    renderParagraph();
    updateProgress();
}

function speakLesson() {
    if (listening) stopListening();
    const text = LESSONS[lessonIndex].text;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    speechSynthesis.speak(utterance);
}

function lessonPayload() {
    const words = [...new Set(tokens.filter((t) => t.isWord && t.normalized).map((t) => t.normalized))];
    const sentences = LESSONS[lessonIndex].text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    return { words, sentences };
}

function setListeningUi(isOn) {
    listening = isOn;
    btnMic.classList.toggle('listening', isOn);
    btnMic.textContent = isOn ? 'Stop' : 'Speak';
    if (micMeter) micMeter.hidden = !isOn;
    if (!isOn) setMicLevel(0);
}

let whisperApi = null;

async function getWhisperApi() {
    if (whisperApi) return whisperApi;
    whisperApi = await import('./asr-whisper.js');
    return whisperApi;
}

async function startWithWhisper() {
    setStatus('Opening microphone…', 'listening');
    const asr = await getWhisperApi();
    await asr.startWhisperListening({
        onTranscript: (text) => {
            if (!listening || engineMode !== 'whisper') return;
            applyTranscript(text);
        },
        onLevel: (level) => {
            if (listening && engineMode === 'whisper') setMicLevel(level);
        },
        onError: (err) => {
            console.error(err);
            setStatus('Speech engine hit an error. Try again.', 'error');
        }
    });
    engineMode = 'whisper';
    const word = displayWord(tokens[currentWordIndex()]);
    setStatus(word ? `Listening from “${word}”` : 'Listening…', 'listening');
}

async function startWithSapi() {
    setStatus('Starting Windows speech recognition…', 'listening');
    const result = await window.electronAPI.startPracticeSpeech(lessonPayload());
    if (!result || !result.ok) {
        throw new Error(result && result.error ? result.error : 'Could not start Windows speech recognition.');
    }
    engineMode = 'sapi';
}

async function startListening() {
    if (listening) return;

    speechSynthesis.cancel();
    marks = tokens.map(() => '');
    spokenCursor = 0;
    spokenLog = [];
    heardSentence = '';
    applyTranscript('');
    setListeningUi(true);

    try {
        if (!whisperReady) {
            setStatus('Preparing speech… first use may download a model.', 'listening');
            try {
                const asr = await getWhisperApi();
                await asr.loadWhisperAsr((message) => setStatus(message, 'listening'));
                whisperReady = true;
            } catch (err) {
                console.error(err);
                whisperReady = false;
            }
        }

        if (whisperReady) {
            await startWithWhisper();
            return;
        }

        await startWithSapi();
    } catch (err) {
        setListeningUi(false);
        engineMode = 'none';
        if (whisperApi) await whisperApi.stopWhisperListening();
        window.electronAPI.stopPracticeSpeech();
        setStatus(err && err.message ? err.message : 'Could not start speech recognition.', 'error');
    }
}

function stopListening() {
    const wasListening = listening;
    setListeningUi(false);
    engineMode = 'none';
    getWhisperApi().then((asr) => asr.stopWhisperListening()).catch(() => {});
    window.electronAPI.stopPracticeSpeech();
    if (!wasListening) return;
    if (!successEl.hidden) return;
    if (statusEl.classList.contains('is-error')) return;
    setStatus(READY_HINT);
}

window.electronAPI.onPracticeSpeech((event) => {
    if (!event || engineMode !== 'sapi') return;
    if (event.kind === 'READY') {
        const current = currentWordIndex();
        const word = current >= 0 ? displayWord(tokens[current]) : '';
        setStatus(word ? `Listening from “${word}”` : 'Listening…', 'listening');
        return;
    }
    if (event.kind === 'ERROR') {
        setListeningUi(false);
        engineMode = 'none';
        window.electronAPI.stopPracticeSpeech();
        setStatus(event.text || 'Could not start speech recognition.', 'error');
        return;
    }
    if (event.kind === 'ENDED') {
        if (listening) {
            setListeningUi(false);
            engineMode = 'none';
            if (!successEl.hidden) return;
            setStatus('Mic stopped. Tap Speak to try again.', 'error');
        }
        return;
    }
    if (event.kind === 'FINAL' && event.text) {
        consumeSpokenWords(event.text.split(/\s+/).map(normalizeWord).filter(Boolean));
    }
});

btnPrev.onclick = () => loadLesson(lessonIndex - 1);
btnNext.onclick = () => loadLesson(lessonIndex + 1);
btnListen.onclick = speakLesson;
btnReset.onclick = () => loadLesson(lessonIndex);
btnMic.onclick = () => {
    if (listening) stopListening();
    else startListening();
};

window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.key === ' ' && !event.repeat) {
        event.preventDefault();
        if (listening) stopListening();
        else startListening();
        return;
    }
    if (event.key === 'Escape' && listening) {
        event.preventDefault();
        stopListening();
        return;
    }
    if (event.key === 'ArrowLeft') {
        event.preventDefault();
        loadLesson(lessonIndex - 1);
        return;
    }
    if (event.key === 'ArrowRight') {
        event.preventDefault();
        loadLesson(lessonIndex + 1);
    }
});

window.addEventListener('beforeunload', () => {
    stopListening();
    speechSynthesis.cancel();
});

function useLessons(list) {
    if (!Array.isArray(list) || !list.length) return false;
    const next = list.filter((item) => item && item.title && item.text);
    if (!next.length) return false;
    LESSONS = next;
    return true;
}

async function bootPractice() {
    try {
        const remote = await window.electronAPI.getPracticeLessons();
        useLessons(remote);
    } catch (_) {}

    loadLesson(0);
    setStatus('Preparing speech…', 'listening');
    getWhisperApi()
        .then((asr) => asr.loadWhisperAsr((message) => {
            if (!listening) setStatus(message, 'listening');
        }))
        .then(() => {
            whisperReady = true;
            if (!listening) setStatus(READY_HINT);
        })
        .catch((err) => {
            console.error(err);
            whisperReady = false;
            whisperApi = null;
            if (!listening) setStatus(READY_HINT);
        });

    window.electronAPI.onMaterialsUpdated?.(() => {
        if (listening) return;
        window.electronAPI.getPracticeLessons().then((list) => {
            if (!useLessons(list)) return;
            loadLesson(Math.min(lessonIndex, LESSONS.length - 1));
        }).catch(() => {});
    });
}

bootPractice();
