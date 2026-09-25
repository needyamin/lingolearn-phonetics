/*
 * English Practice - live read-aloud detection.
 *
 * Design notes
 * ------------
 * The old engine re-aligned the WHOLE accumulated transcript on every update.
 * Because the Whisper loop re-transcribes a sliding audio window, each pass
 * could produce slightly different text, so previously-marked words flipped
 * back to unmarked. That made the paragraph flicker and the progress bar
 * jump backwards.
 *
 * This version scores INCREMENTALLY and MONOTONICALLY:
 *
 *   - `marks[i]` is written once and never cleared during a session.
 *   - A pointer `cursor` walks forward through the expected words. Only the
 *     new tail of the transcript is examined on each update, so old (already
 *     merged) audio cannot re-open settled decisions.
 *   - `alignParagraph` is kept as a pure helper for a final consistency pass
 *     that can only ADD marks, never remove them.
 *
 * Additional features
 * -------------------
 *   - Live accuracy %, correct/missed counters, and a score badge.
 *   - "Read from here" cue anchored to the next unread word.
 *   - Sentence-level progress chips.
 *   - Waveform microphone meter driven by RMS level.
 *   - Result card with accuracy, pace (words/min) and a list of missed words.
 */

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

const READY_HINT = 'Tap Speak, then read out loud at a steady pace.';
const FILLERS = new Set(['um', 'uh', 'er', 'ah', 'hmm', 'mm', 'mhm', 'uhh', 'uhm', 'eh']);
const NUMBER_WORDS = {
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
    '10': 'ten', '11': 'eleven', '12': 'twelve'
};

/* ------------------------------------------------------------------ *
 * DOM handles
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const practiceText = $('practice-text');
const lessonLabel = $('lesson-label');
const lessonTitle = $('lesson-title');
const progressFill = $('progress-fill');
const progressLabel = $('progress-label');
const heardWordsEl = $('heard-words');
const heardPanel = $('heard-panel');
const heardCountEl = $('heard-count');
const heardSentenceEl = $('heard-sentence');
const statusEl = $('practice-status');
const successEl = $('practice-success');
const speakHereCue = $('speak-here-cue');
const speakHereLabelEl = $('speak-here-label');
const speakHereWord = $('speak-here-word');
const btnPrev = $('btn-prev');
const btnNext = $('btn-next');
const btnListen = $('btn-listen');
const btnMic = $('btn-mic');
const btnReset = $('btn-reset');
const micMeter = $('mic-meter');
const micMeterFill = $('mic-meter-fill');
const scoreValueEl = $('score-value');
const scoreSubEl = $('score-sub');
const scoreRingEl = $('score-ring');
const sentenceChipsEl = $('sentence-chips');
const resultCardEl = $('result-card');
const resultAccuracyEl = $('result-accuracy');
const resultPaceEl = $('result-pace');
const resultMissedEl = $('result-missed');
const btnRetry = $('btn-retry');
const btnContinue = $('btn-continue');
const liveDotEl = $('live-dot');
const waveBarsEl = $('wave-bars');

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

let LESSONS = FALLBACK_LESSONS;

let lessonIndex = 0;
let tokens = [];          // { raw, isWord, normalized, sentence }
let marks = [];           // '' | 'correct' | 'missed' | 'wrong'
let sentences = [];       // { start, end, indexes: [] }  (token indexes)
let cursor = 0;           // walk pointer over target-indexes
let targets = [];         // token indexes that are scorable words
let transcriptWords = []; // normalized words the engine has consumed so far
let heardRaw = '';        // raw (unnormalized) transcript for the "heard" pane
let listening = false;
let engineMode = 'none';  // 'whisper' | 'sapi' | 'none'
let whisperApi = null;
let whisperReady = false;
let startedAt = 0;
let finished = false;
let lastLevelAt = 0;

/*
 * User preferences for speech recognition, mirroring the app's settings.
 * Loaded at boot and re-read whenever the mic starts, so changing a setting in
 * the main window takes effect on the next Speak tap.
 */
let practicePrefs = { sensitivity: 'normal', model: 'small', usePrompt: true };

async function loadPracticePrefs() {
    try {
        const settings = await window.electronAPI.getSettings();
        if (!settings) return;
        practicePrefs = {
            sensitivity: ['lenient', 'normal', 'strict'].includes(settings.practiceSensitivity)
                ? settings.practiceSensitivity : 'normal',
            model: ['small', 'base', 'tiny'].includes(settings.practiceModel)
                ? settings.practiceModel : 'small',
            usePrompt: settings.practiceUsePrompt !== false
        };
    } catch (_) {}
    setMatchSensitivity(practicePrefs.sensitivity);
}

/* ------------------------------------------------------------------ *
 * Text utilities
 * ------------------------------------------------------------------ */

function normalizeWord(word) {
    const cleaned = String(word || '').toLowerCase().replace(/[^a-z0-9']/g, '');
    const bare = cleaned.replace(/'/g, '');
    return NUMBER_WORDS[bare] || bare;
}

function cleanDisplayWord(word) {
    return String(word || '').replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
}

function levenshtein(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const dp = new Array(cols);
    for (let j = 0; j < cols; j++) dp[j] = j;
    for (let i = 1; i < rows; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j < cols; j++) {
            const tmp = dp[j];
            dp[j] = Math.min(
                dp[j] + 1,
                dp[j - 1] + 1,
                prev + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
            prev = tmp;
        }
    }
    return dp[b.length];
}

/**
 * Word-matching strictness. Because English ASR is trained mostly on native
 * speech, an accented reader gets systematically degraded transcripts. Rather
 * than telling that user "you read it wrong", we let them choose how forgiving
 * the matcher should be.
 *
 *   lenient -> accepts near-misses freely (best for strong accents)
 *   normal  -> the tuned default
 *   strict  -> demands a close match (for native / confident speakers)
 */
const MATCH_PROFILES = {
    lenient: { editFloor: 3, stemMin: 2, prefixLen: 3, skip: 1.6 },
    normal: { editFloor: 4, stemMin: 3, prefixLen: 4, skip: 1.0 },
    strict: { editFloor: 5, stemMin: 4, prefixLen: 5, skip: 0.7 }
};

let matchProfile = MATCH_PROFILES.normal;

function setMatchSensitivity(level) {
    matchProfile = MATCH_PROFILES[level] || MATCH_PROFILES.normal;
}

/**
 * Fuzzy word equality tuned for speech recognition noise:
 *  - exact match
 *  - a small edit distance for reasonably long words
 *  - shared stem ("sleep" / "sleeping")
 *  - a shared prefix (handles recognizer truncation)
 */
function wordsMatch(spoken, expected) {
    if (!spoken || !expected) return false;
    if (spoken === expected) return true;

    const minLen = Math.min(spoken.length, expected.length);
    const { editFloor, stemMin, prefixLen } = matchProfile;

    if (minLen >= editFloor && levenshtein(spoken, expected) === 1) return true;

    const stem = (word) => word.replace(/(ing|ed|es|s)$/g, '');
    const a = stem(spoken);
    const b = stem(expected);
    if (a.length >= stemMin && a === b) return true;

    // Prefix safety net: "beauti" vs "beautiful" (recognition truncation).
    if (minLen >= prefixLen && (spoken.startsWith(expected.slice(0, prefixLen)) || expected.startsWith(spoken.slice(0, prefixLen)))) {
        return true;
    }
    return false;
}

function tokenize(text) {
    return String(text).split(/(\s+)/).map((part) => ({
        raw: part,
        isWord: !/^\s+$/.test(part),
        normalized: normalizeWord(part)
    }));
}

/* ------------------------------------------------------------------ *
 * Lesson model
 * ------------------------------------------------------------------ */

function buildLessonModel() {
    targets = [];
    sentences = [];

    let current = null;
    tokens.forEach((token, i) => {
        if (token.isWord && token.normalized) {
            targets.push(i);
            if (current) current.indexes.push(i);
        }
        if (current) current.end = i;
        if (token.isWord && /[.!?]$/.test(token.raw)) {
            current = null;
        } else if (!current && token.isWord && token.normalized) {
            current = { start: i, end: i, indexes: [i] };
            sentences.push(current);
        }
    });

    // Attach sentence index to every token so we can render chips.
    const sentenceOf = new Map();
    sentences.forEach((sentence, si) => {
        sentence.indexes.forEach((idx) => sentenceOf.set(idx, si));
    });
    tokens.forEach((token, i) => {
        token.sentence = sentenceOf.has(i) ? sentenceOf.get(i) : -1;
    });

    // Trailing punctuation after the final word still belongs to the sentence.
    let last = -1;
    sentences.forEach((sentence, si) => {
        for (let i = sentence.end + 1; i < tokens.length; i++) {
            if (tokens[i].isWord) break;
            if (tokens[i].sentence < 0) tokens[i].sentence = si;
        }
        if (sentence.indexes.length) last = si;
    });
    void last;
}

function wordCount() {
    return targets.length;
}

function cursorTargetIndex() {
    return cursor < targets.length ? targets[cursor] : -1;
}

function displayWord(token) {
    return token ? cleanDisplayWord(token.raw) : '';
}

/* ------------------------------------------------------------------ *
 * Incremental alignment - the core of the engine
 * ------------------------------------------------------------------ */

/**
 * How far ahead we may look for a match before declaring words "missed".
 * Longer utterances get a wider window because the recognizer can reorder
 * or drop several words in a row.
 */
function skipWindow(spokenWord, remainingSpoken) {
    const scale = matchProfile.skip;
    if (remainingSpoken >= 14) return Math.round(12 * scale);
    if (!spokenWord || spokenWord.length <= 2) return Math.max(1, Math.round(2 * scale));
    if (spokenWord.length <= 3) return Math.max(1, Math.round(3 * scale));
    return Math.max(2, Math.round(5 * scale));
}

/**
 * Consume a batch of newly-heard words.
 *
 * Walks `cursor` forward. For each heard word we look for the best match in
 * the next `skipWindow` expected words:
 *   - an immediate match marks the expected word 'correct';
 *   - a match further ahead marks the skipped words 'missed' first;
 *   - no match anywhere means the heard word was extra -> ignored.
 *
 * Returns true when anything changed (so the caller can re-render).
 */
function consumeWords(words) {
    if (!words.length || cursor >= targets.length) return false;

    let changed = false;

    for (let wi = 0; wi < words.length; wi++) {
        if (cursor >= targets.length) break;
        const heard = words[wi];
        const remaining = words.length - wi;
        const window = skipWindow(heard, remaining);
        const limit = Math.min(targets.length, cursor + window);

        let found = -1;
        for (let ti = cursor; ti < limit; ti++) {
            if (marks[targets[ti]]) continue;
            if (wordsMatch(heard, tokens[targets[ti]].normalized)) {
                found = ti;
                break;
            }
        }
        if (found < 0) continue; // extra word (filler / misheard) - ignore

        for (let ti = cursor; ti < found; ti++) {
            marks[targets[ti]] = 'missed';
            changed = true;
        }
        marks[targets[found]] = 'correct';
        cursor = found + 1;
        changed = true;
    }

    return changed;
}

/**
 * Final consolidation pass. Runs after the recognizer settles (pause or stop).
 * Uses the same fuzzy matcher over the whole transcript, but can only turn
 * unmarked words into 'missed' - it never clears an existing mark.
 */
function settleMissed() {
    if (cursor >= targets.length) return false;
    const lastCorrect = cursor - 1;
    if (lastCorrect < 0) return false;

    let changed = false;
    // Mark a short run of words before the cursor that were never matched.
    for (let ti = 0; ti < cursor; ti++) {
        const idx = targets[ti];
        if (!marks[idx]) {
            marks[idx] = 'missed';
            changed = true;
        }
    }
    return changed;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

let wordNodes = [];

function renderParagraph() {
    practiceText.innerHTML = '';
    wordNodes = [];

    const nextIdx = cursorTargetIndex();

    tokens.forEach((token, i) => {
        if (!token.isWord) {
            practiceText.appendChild(document.createTextNode(token.raw));
            wordNodes.push(null);
            return;
        }

        const span = document.createElement('span');
        span.className = 'practice-word';
        span.textContent = token.raw;

        if (marks[i] === 'correct') span.classList.add('correct');
        else if (marks[i] === 'missed') span.classList.add('missed');
        else if (marks[i] === 'wrong') span.classList.add('wrong');
        else if (i === nextIdx) span.classList.add('current');

        practiceText.appendChild(span);
        wordNodes.push(span);
    });

    updateCue();
    scrollToCurrent();
}

function scrollToCurrent() {
    const node = wordNodes[cursorTargetIndex()];
    if (!node || !practiceText) return;
    const card = practiceText.parentElement;
    if (!card) return;
    const top = node.offsetTop - card.clientHeight / 2 + node.offsetHeight / 2;
    card.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function updateCue() {
    const idx = cursorTargetIndex();
    const complete = idx < 0;

    if (speakHereCue) speakHereCue.classList.toggle('is-hidden', complete);
    if (complete) return;

    if (speakHereWord) speakHereWord.textContent = displayWord(tokens[idx]);
    if (speakHereLabelEl) {
        const missed = marks.filter((m) => m === 'missed').length;
        speakHereLabelEl.textContent = missed > 0 ? 'Read from here' : 'Start reading here';
    }
}

function scoreStats() {
    const total = wordCount();
    const correct = marks.filter((m) => m === 'correct').length;
    const missed = marks.filter((m) => m === 'missed' || m === 'wrong').length;
    const judged = correct + missed;
    const left = Math.max(total - judged, 0);
    const accuracy = judged ? Math.round((correct / judged) * 100) : 100;
    return { total, correct, missed, judged, left, accuracy };
}

function updateProgress() {
    const stats = scoreStats();
    const pct = stats.total ? Math.round((stats.judged / stats.total) * 100) : 0;

    if (progressFill) {
        progressFill.style.width = `${pct}%`;
        progressFill.classList.toggle('has-wrong', stats.missed > 0);
    }
    if (progressLabel) {
        progressLabel.textContent = `${stats.correct} correct · ${stats.missed} missed · ${stats.left} left`;
    }

    if (scoreValueEl) scoreValueEl.textContent = `${stats.accuracy}%`;
    if (scoreSubEl) scoreSubEl.textContent = `${stats.correct}/${stats.total} words`;
    if (scoreRingEl) {
        const deg = Math.round((stats.accuracy / 100) * 360);
        scoreRingEl.style.setProperty('--angle', `${deg}deg`);
        scoreRingEl.classList.toggle('is-low', stats.accuracy < 70 && stats.judged > 3);
    }

    renderSentenceChips();

    const complete = stats.total > 0 && stats.judged === stats.total;
    if (complete && !finished) {
        finished = true;
        showResult(stats);
        if (listening) stopListening();
        return;
    }
    if (successEl) successEl.hidden = true;

    if (listening) {
        const idx = cursorTargetIndex();
        if (idx >= 0) {
            const word = displayWord(tokens[idx]);
            setStatus(
                stats.missed > 0
                    ? `Listening… continue from “${word}”`
                    : `Listening… next: “${word}”`,
                'listening'
            );
        } else {
            setStatus('Listening…', 'listening');
        }
    }
}

function renderSentenceChips() {
    if (!sentenceChipsEl) return;

    if (!sentenceChipsEl.childElementCount || sentenceChipsEl.dataset.count !== String(sentences.length)) {
        sentenceChipsEl.innerHTML = '';
        sentences.forEach((_, si) => {
            const chip = document.createElement('span');
            chip.className = 'sentence-chip';
            chip.dataset.index = String(si);
            chip.textContent = String(si + 1);
            sentenceChipsEl.appendChild(chip);
        });
        sentenceChipsEl.dataset.count = String(sentences.length);
    }

    sentences.forEach((sentence, si) => {
        const chip = sentenceChipsEl.children[si];
        if (!chip) return;
        const total = sentence.indexes.length;
        const missed = sentence.indexes.filter((i) => marks[i] === 'missed' || marks[i] === 'wrong').length;
        const done = sentence.indexes.filter((i) => marks[i]).length;

        chip.classList.toggle('is-done', done === total && total > 0);
        chip.classList.toggle('is-partial', done > 0 && done < total);
        chip.classList.toggle('is-current', sentence.indexes.includes(cursorTargetIndex()));
        chip.title = missed ? `${missed} word${missed === 1 ? '' : 's'} missed` : `${done}/${total} words`;
    });
}

function setStatus(message, kind) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('is-error', kind === 'error');
    statusEl.classList.toggle('is-listening', kind === 'listening');
}

function renderHeardWords() {
    const chips = transcriptWords.slice(-60);
    if (heardPanel) heardPanel.hidden = !chips.length;
    if (heardCountEl) heardCountEl.hidden = true;
    if (heardSentenceEl) {
        heardSentenceEl.textContent = heardRaw.trim();
        heardSentenceEl.hidden = !heardRaw.trim();
    }
    if (!heardWordsEl) return;

    heardWordsEl.innerHTML = '';
    if (!chips.length) {
        const empty = document.createElement('span');
        empty.className = 'heard-empty';
        empty.textContent = 'Your words appear here as you read.';
        heardWordsEl.appendChild(empty);
        return;
    }
    const offset = Math.max(0, transcriptWords.length - chips.length);
    chips.forEach((word, i) => {
        const chip = document.createElement('span');
        const isLatest = offset + i === transcriptWords.length - 1;
        chip.className = isLatest ? 'heard-chip is-latest' : 'heard-chip';
        chip.textContent = word;
        heardWordsEl.appendChild(chip);
    });
    heardWordsEl.scrollTop = heardWordsEl.scrollHeight;
}

/* ------------------------------------------------------------------ *
 * Result card
 * ------------------------------------------------------------------ */

function showResult(stats) {
    if (!resultCardEl) return;

    if (resultAccuracyEl) resultAccuracyEl.textContent = `${stats.accuracy}%`;
    if (resultPaceEl) {
        const seconds = Math.max(1, (Date.now() - startedAt) / 1000);
        const wpm = Math.round((stats.total / seconds) * 60);
        resultPaceEl.textContent = `${wpm} wpm`;
    }
    if (resultMissedEl) {
        const missedWords = targets.filter((idx) => marks[idx] === 'missed' || marks[idx] === 'wrong');
        resultMissedEl.innerHTML = '';
        if (!missedWords.length) {
            const p = document.createElement('span');
            p.className = 'result-perfect';
            p.textContent = 'Every word matched. Excellent.';
            resultMissedEl.appendChild(p);
        } else {
            missedWords.slice(0, 12).forEach((idx) => {
                const chip = document.createElement('span');
                chip.className = 'missed-chip';
                chip.textContent = displayWord(tokens[idx]);
                resultMissedEl.appendChild(chip);
            });
            if (missedWords.length > 12) {
                const more = document.createElement('span');
                more.className = 'missed-more';
                more.textContent = `+${missedWords.length - 12} more`;
                resultMissedEl.appendChild(more);
            }
        }
    }

    resultCardEl.hidden = false;
    resultCardEl.classList.toggle('is-perfect', stats.missed === 0);
    if (successEl) successEl.hidden = true;
}

function hideResult() {
    finished = false;
    if (resultCardEl) resultCardEl.hidden = true;
}

/* ------------------------------------------------------------------ *
 * Transcript ingestion
 * ------------------------------------------------------------------ */

function applyTranscript(rawText) {
    heardRaw = String(rawText || '').replace(/\s+/g, ' ').trim();
    const words = heardRaw.split(/\s+/).map(normalizeWord).filter(Boolean);
    transcriptWords = words;
    const changed = consumeWords(words);
    if (changed) renderParagraph();
    renderHeardWords();
    updateProgress();
}

/** SAPI streams FINAL fragments; append them instead of replacing. */
function appendTranscript(fragment) {
    const piece = String(fragment || '').replace(/\s+/g, ' ').trim();
    if (!piece) return;
    heardRaw = heardRaw ? `${heardRaw} ${piece}` : piece;
    const words = piece.split(/\s+/).map(normalizeWord).filter(Boolean);
    transcriptWords = transcriptWords.concat(words);
    const changed = consumeWords(words);
    if (changed) renderParagraph();
    renderHeardWords();
    updateProgress();
}

/* ------------------------------------------------------------------ *
 * Microphone meter
 * ------------------------------------------------------------------ */

function buildWaveBars() {
    if (!waveBarsEl || waveBarsEl.childElementCount) return;
    for (let i = 0; i < 18; i++) {
        const bar = document.createElement('span');
        bar.className = 'wave-bar';
        waveBarsEl.appendChild(bar);
    }
}

function setMicLevel(level) {
    if (micMeterFill) {
        const pct = Math.min(100, Math.round(level * 320));
        micMeterFill.style.width = `${pct}%`;
        micMeterFill.classList.toggle('is-hot', pct > 55);
    }

    const now = Date.now();
    if (now - lastLevelAt < 70) return;
    lastLevelAt = now;

    if (waveBarsEl) {
        const bars = waveBarsEl.children;
        const energy = Math.min(1, level * 14);
        for (let i = 0; i < bars.length; i++) {
            const wave = Math.abs(Math.sin(now / 260 + i * 0.7));
            const h = 12 + Math.round((energy * 0.75 + wave * 0.25) * 88);
            bars[i].style.height = `${Math.min(100, h)}%`;
        }
    }

    if (liveDotEl) liveDotEl.classList.toggle('is-hot', level > 0.03);
}

/* ------------------------------------------------------------------ *
 * Lesson lifecycle
 * ------------------------------------------------------------------ */

/**
 * Pure reset: rebuild the token/mark/sentence model for a lesson's text.
 * Shared by loadLesson() and the QA harness so tests exercise the exact
 * production path.
 */
function resetLesson(text) {
    tokens = tokenize(text);
    marks = tokens.map(() => '');
    targets = [];
    cursor = 0;
    transcriptWords = [];
    heardRaw = '';
    finished = false;
    startedAt = 0;
    buildLessonModel();
}

function loadLesson(index) {
    stopListening();
    try { speechSynthesis.cancel(); } catch (_) {}

    lessonIndex = (index + LESSONS.length) % LESSONS.length;
    const lesson = LESSONS[lessonIndex];

    resetLesson(lesson.text);

    if (lessonLabel) lessonLabel.textContent = `${lessonIndex + 1} / ${LESSONS.length}`;
    if (lessonTitle) lessonTitle.textContent = lesson.title;

    hideResult();
    renderHeardWords();
    renderParagraph();
    updateProgress();
    setStatus(READY_HINT);

    if (progressFill) progressFill.style.width = '0%';
}

function speakLesson() {
    if (listening) stopListening();
    try { speechSynthesis.cancel(); } catch (_) {}
    const utterance = new SpeechSynthesisUtterance(LESSONS[lessonIndex].text);
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    speechSynthesis.speak(utterance);
}

function lessonPayload() {
    const words = [...new Set(tokens.filter((t) => t.isWord && t.normalized).map((t) => t.normalized))];
    const list = sentences.map((sentence) =>
        sentence.indexes.map((idx) => tokens[idx].raw).join('').replace(/\s+$/, '')
    );
    return { words, sentences: list };
}

/* ------------------------------------------------------------------ *
 * Listening UI
 * ------------------------------------------------------------------ */

function setListeningUi(isOn) {
    listening = isOn;
    if (btnMic) {
        btnMic.classList.toggle('listening', isOn);
        btnMic.textContent = isOn ? 'Stop' : 'Speak';
    }
    if (micMeter) micMeter.hidden = !isOn;
    if (liveDotEl) liveDotEl.classList.toggle('is-live', isOn);
    if (!isOn) {
        setMicLevel(0);
        if (waveBarsEl) {
            for (const bar of waveBarsEl.children) bar.style.height = '12%';
        }
    }
}

async function getWhisperApi() {
    if (whisperApi) return whisperApi;
    whisperApi = await import('./asr-whisper.js');
    return whisperApi;
}

/* ------------------------------------------------------------------ *
 * Start / stop
 * ------------------------------------------------------------------ */

async function startWithWhisper() {
    setStatus('Opening microphone…', 'listening');
    const asr = await getWhisperApi();
    await asr.startWhisperListening({
        /*
         * Feeding the lesson text as an initial prompt conditions Whisper on
         * the exact passage being read. This is the single biggest accuracy
         * win for accented speech: the model expects these words instead of
         * guessing from scratch.
         */
        prompt: practicePrefs.usePrompt ? LESSONS[lessonIndex].text : '',
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
    const idx = cursorTargetIndex();
    const word = idx >= 0 ? displayWord(tokens[idx]) : '';
    setStatus(word ? `Listening… start with “${word}”` : 'Listening…', 'listening');
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

    try { speechSynthesis.cancel(); } catch (_) {}
    marks = tokens.map(() => '');
    cursor = 0;
    transcriptWords = [];
    heardRaw = '';
    finished = false;
    startedAt = Date.now();

    hideResult();
    renderHeardWords();
    renderParagraph();
    updateProgress();
    setListeningUi(true);

    try {
        /*
         * Re-read preferences each time the mic starts so a settings change in
         * the main window is picked up without restarting the app. The match
         * profile is re-applied because it affects the whole alignment pass.
         */
        await loadPracticePrefs();

        if (!whisperReady) {
            setStatus('Preparing speech… first use may download a model.', 'listening');
            try {
                const asr = await getWhisperApi();
                await asr.loadWhisperAsr((message) => {
                    if (listening && engineMode !== 'sapi') setStatus(message, 'listening');
                }, practicePrefs.model);
                whisperReady = true;
            } catch (err) {
                console.error(err);
                whisperReady = false;
                whisperApi = null;
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
        if (whisperApi) await whisperApi.stopWhisperListening().catch(() => {});
        window.electronAPI.stopPracticeSpeech();
        setStatus(err && err.message ? err.message : 'Could not start speech recognition.', 'error');
    }
}

function stopListening() {
    const wasListening = listening;
    setListeningUi(false);
    engineMode = 'none';

    if (whisperApi) whisperApi.stopWhisperListening().catch(() => {});
    window.electronAPI.stopPracticeSpeech();

    if (!wasListening) return;
    if (settleMissed()) renderParagraph();
    updateProgress();
    if (!finished) setStatus(READY_HINT);
}

/* ------------------------------------------------------------------ *
 * SAPI stream
 * ------------------------------------------------------------------ */

window.electronAPI.onPracticeSpeech((event) => {
    if (!event || engineMode !== 'sapi') return;

    if (event.kind === 'READY') {
        const idx = cursorTargetIndex();
        const word = idx >= 0 ? displayWord(tokens[idx]) : '';
        setStatus(word ? `Listening… start with “${word}”` : 'Listening…', 'listening');
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
            if (settleMissed()) renderParagraph();
            updateProgress();
            if (!finished) setStatus('Mic stopped. Tap Speak to try again.', 'error');
        }
        return;
    }
    if (event.kind === 'FINAL' && event.text) {
        appendTranscript(event.text);
    }
});

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

if (btnPrev) btnPrev.onclick = () => loadLesson(lessonIndex - 1);
if (btnNext) btnNext.onclick = () => loadLesson(lessonIndex + 1);
if (btnListen) btnListen.onclick = speakLesson;
if (btnReset) btnReset.onclick = () => loadLesson(lessonIndex);
if (btnMic) btnMic.onclick = () => (listening ? stopListening() : startListening());
if (btnRetry) btnRetry.onclick = () => startListening();
if (btnContinue) btnContinue.onclick = () => loadLesson(lessonIndex + 1);

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
    try { speechSynthesis.cancel(); } catch (_) {}
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function useLessons(list) {
    if (!Array.isArray(list) || !list.length) return false;
    const next = list.filter((item) => item && typeof item.title === 'string' && typeof item.text === 'string' && item.text.trim());
    if (!next.length) return false;
    LESSONS = next;
    return true;
}

async function bootPractice() {
    buildWaveBars();

    await loadPracticePrefs();

    try {
        const remote = await window.electronAPI.getPracticeLessons();
        useLessons(remote);
    } catch (_) {}

    loadLesson(0);
    setStatus('Preparing speech…', 'listening');

    getWhisperApi()
        .then((asr) => asr.loadWhisperAsr((message) => {
            if (!listening) setStatus(message, 'listening');
        }, practicePrefs.model))
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
