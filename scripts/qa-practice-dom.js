/*
 * Headless DOM harness for the English Practice page.
 *
 * Unlike qa-practice-align.js (which tests the pure scoring functions), this
 * loads the COMPLETE src/practice.js against a faithful DOM stub and drives
 * the whole user flow: boot -> load lesson -> start listening -> transcript
 * arrives -> lesson completes -> result card.
 *
 * It then asserts on the rendered DOM, so a broken render path (not just a
 * broken algorithm) fails the test.
 *
 * Run: node scripts/qa-practice-dom.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const practiceFile = path.join(__dirname, '..', 'src', 'practice.js');
const htmlFile = path.join(__dirname, '..', 'src', 'practice.html');
const html = fs.readFileSync(htmlFile, 'utf8');
const source = fs.readFileSync(practiceFile, 'utf8');

/* ------------------------------------------------------------------ *
 * Minimal but faithful DOM
 * ------------------------------------------------------------------ */

class ClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...names) { names.forEach((n) => n && this.set.add(n)); }
    remove(...names) { names.forEach((n) => this.set.delete(n)); }
    contains(name) { return this.set.has(name); }
    toggle(name, force) {
        const on = force === undefined ? !this.set.has(name) : Boolean(force);
        if (on) this.set.add(name); else this.set.delete(name);
        return on;
    }
    toString() { return [...this.set].join(' '); }
}

class El {
    constructor(tag = 'div', id = '') {
        this.tagName = tag.toUpperCase();
        this.id = id;
        this.children = [];
        this.parentElement = null;
        this.style = new Proxy({}, {
            get: (t, k) => (k === 'setProperty' ? (n, v) => { t[n] = v; } : t[k]),
            set: (t, k, v) => { t[k] = v; return true; }
        });
        this.classList = new ClassList(this);
        this._text = '';
        this._html = '';
        this.dataset = {};
        this.hidden = false;
        this.scrollTop = 0;
        this.scrollHeight = 100;
        this.offsetTop = 0;
        this.offsetHeight = 0;
        this.clientHeight = 300;
        this.listeners = {};
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; }
    get childElementCount() { return this.children.length; }
    get firstChild() { return this.children[0] || null; }
    appendChild(node) {
        node.parentElement = this;
        this.children.push(node);
        return node;
    }
    scrollTo() {}
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    fire(type, ev) { (this.listeners[type] || []).forEach((fn) => fn(ev)); }
    querySelector(sel) { return this._walk().find((n) => matches(n, sel)) || null; }
    querySelectorAll(sel) { return this._walk().filter((n) => matches(n, sel)); }
    _walk() {
        const out = [];
        const rec = (n) => { for (const c of n.children) { out.push(c); rec(c); } };
        rec(this);
        return out;
    }
}

function classesOf(node) { return node.classList ? [...node.classList.set] : []; }

function matches(node, sel) {
    const parts = sel.trim().split(/(?=[.#])/);
    return parts.every((p) => {
        if (p.startsWith('#')) return node.id === p.slice(1);
        if (p.startsWith('.')) return classesOf(node).includes(p.slice(1));
        return node.tagName === p.toUpperCase();
    });
}

// Instantiate every id= in the HTML so practice.js finds its handles.
const registry = new Map();
for (const m of html.matchAll(/<(\w+)([^>]*?)id="([^"]+)"([^>]*?)>/g)) {
    const el = new El(m[1], m[3]);
    const attrs = m[2] + m[4];
    if (/\bclass="([^"]*)"/.test(attrs)) {
        const cls = attrs.match(/\bclass="([^"]*)"/)[1].split(/\s+/).filter(Boolean);
        cls.forEach((c) => el.classList.add(c));
    }
    if (/\bhidden\b/.test(attrs)) el.hidden = true;
    registry.set(m[3], el);
}

// Give practice-text a real parent so scrollToCurrent has a container.
const practiceTextEl = registry.get('practice-text');
const card = new El('div');
card.appendChild(practiceTextEl);
const sentenceChips = registry.get('sentence-chips');
const waveBars = registry.get('wave-bars');

/* ------------------------------------------------------------------ *
 * Sandbox
 * ------------------------------------------------------------------ */

const speeches = [];
const consoleErrors = [];

const sandbox = {
    document: {
        getElementById: (id) => registry.get(id) || null,
        createElement: (tag) => new El(tag),
        createTextNode: (text) => ({ nodeType: 3, textContent: String(text) })
    },
    window: {
        electronAPI: {
            getPracticeLessons: async () => ([
                { title: 'QA Lesson', text: 'The sun is bright today. I like to walk in the park.' }
            ]),
            startPracticeSpeech: async () => ({ ok: true }),
            stopPracticeSpeech: () => {},
            onPracticeSpeech: (cb) => { sandbox.__sapiCb = cb; },
            onMaterialsUpdated: () => {},
            getOrtWasmDir: async () => ''
        },
        addEventListener: (type, fn) => { (sandbox.__winListeners[type] = sandbox.__winListeners[type] || []).push(fn); }
    },
    __winListeners: {},
    __sapiCb: null,
    speechSynthesis: {
        cancel() {},
        speak(u) { speeches.push(u); },
        getVoices: () => []
    },
    SpeechSynthesisUtterance: function (text) { this.text = text; },
    console: {
        log: () => {},
        warn: () => {},
        error: (...a) => {
            const msg = a.join(' ');
            // The harness intentionally disables Whisper; ignore that sentinel.
            if (msg.includes('whisper disabled in DOM harness')) return;
            consoleErrors.push(msg);
        }
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Map, Set, Array, Object, Number, String, Boolean, Promise, Error, RegExp,
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('no mic in tests'); } } },
    AudioContext: function () { throw new Error('no audio in tests'); }
};
sandbox.globalThis = sandbox;

// Force the SAPI path (no mic / no Whisper in this harness).
const patched = source.replace(
    "whisperApi = await import('./asr-whisper.js');",
    "throw new Error('whisper disabled in DOM harness');"
);
if (patched === source) throw new Error('Failed to force the SAPI fallback path.');

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: practiceFile });

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
}
const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const renderedWords = () => practiceTextEl.children.filter((c) => c.tagName === 'SPAN');
const wordsWithClass = (cls) => renderedWords().filter((w) => w.classList.contains(cls));
const wordEl = (text) => renderedWords().find((w) => w.textContent.replace(/[^a-zA-Z']/g, '').toLowerCase() === text.toLowerCase());

(async () => {
    await tick();
    await tick();
    await wait(60);

    console.log('\n=== 1. Boot ===');    check('lesson title rendered', registry.get('lesson-title').textContent === 'QA Lesson',
        registry.get('lesson-title').textContent);
    check('lesson label rendered', /^\d+ \/ \d+$/.test(registry.get('lesson-label').textContent),
        registry.get('lesson-label').textContent);
    check('paragraph rendered into spans', renderedWords().length > 0, `${renderedWords().length} spans`);
    check('first word is highlighted as current', wordsWithClass('current').length === 1,
        `${wordsWithClass('current').length} current`);
    check('cue is visible (not hidden class)', !registry.get('speak-here-cue').classList.contains('is-hidden'));
    check('cue points at the first word', registry.get('speak-here-word').textContent.toLowerCase() === 'the',
        registry.get('speak-here-word').textContent);
    check('sentence chips built', sentenceChips.children.length === 2, `${sentenceChips.children.length} chips`);
    check('waveform bars built', waveBars.children.length === 18, `${waveBars.children.length} bars`);
    check('score starts at 100%', registry.get('score-value').textContent === '100%',
        registry.get('score-value').textContent);
    check('progress starts at 0%', registry.get('progress-fill').style.width === '0%',
        registry.get('progress-fill').style.width);
    check('result card hidden at boot', registry.get('result-card').hidden === true);
    check('no console errors at boot', consoleErrors.length === 0, consoleErrors.join(' | '));

    console.log('\n=== 2. Start listening (SAPI fallback) ===');
    registry.get('btn-mic').onclick();
    await tick(); await tick(); await wait(60);
    check('mic button switched to Stop', registry.get('btn-mic').textContent === 'Stop',
        registry.get('btn-mic').textContent);
    check('mic meter shown', registry.get('mic-meter').hidden === false);
    check('live dot is active', registry.get('live-dot').classList.contains('is-live'));
    check('SAPI listener was registered', typeof sandbox.__sapiCb === 'function');

    console.log('\n=== 3. Partial transcript (first sentence) ===');
    sandbox.__sapiCb({ kind: 'READY', text: '' });
    sandbox.__sapiCb({ kind: 'FINAL', text: 'the sun is bright today' });
    await tick(); await wait(30);
    check('5 words marked correct', wordsWithClass('correct').length === 5,
        `${wordsWithClass('correct').length} correct`);
    check('"today" got marked, not "bright"', wordEl('today').classList.contains('correct'));
    check('first sentence chip is done', sentenceChips.children[0].classList.contains('is-done'));
    check('second sentence chip is not done', !sentenceChips.children[1].classList.contains('is-done'));
    check('current highlight moved to "I"', wordsWithClass('current').length === 1 &&
        wordEl('i').classList.contains('current'), `current=${wordsWithClass('current').map((w) => w.textContent)}`);
    check('progress bar advanced', registry.get('progress-fill').style.width !== '0%',
        registry.get('progress-fill').style.width);
    check('score is 100%', registry.get('score-value').textContent === '100%',
        registry.get('score-value').textContent);
    check('heard pane shows the transcript', registry.get('heard-sentence').textContent === 'the sun is bright today',
        registry.get('heard-sentence').textContent);

    console.log('\n=== 4. Re-emitted stale audio must not undo marks ===');
    sandbox.__sapiCb?.({ kind: 'FINAL', text: 'the sun is' });
    await tick(); await wait(30);
    // appendTranscript appends; the repeats are simply unmatched extra words.
    check('still at least 5 correct', wordsWithClass('correct').length >= 5,
        `${wordsWithClass('correct').length} correct`);
    check('no correct mark was cleared', wordEl('today').classList.contains('correct'));

    console.log('\n=== 5. Finish the lesson ===');
    sandbox.__sapiCb({ kind: 'FINAL', text: 'i like to walk in the park' });
    await tick(); await wait(30);
    const correct = wordsWithClass('correct').length;
    check('all 12 words correct', correct === 12, `${correct} correct`);
    check('result card is shown', registry.get('result-card').hidden === false);
    check('result is flagged perfect', registry.get('result-card').classList.contains('is-perfect'));
    check('accuracy shows 100%', registry.get('result-accuracy').textContent === '100%',
        registry.get('result-accuracy').textContent);
    check('pace is reported', /^\d+ wpm$/.test(registry.get('result-pace').textContent),
        registry.get('result-pace').textContent);
    check('perfect message rendered', registry.get('result-missed').children.length === 1);
    check('listening auto-stopped', registry.get('btn-mic').textContent === 'Speak',
        registry.get('btn-mic').textContent);
    check('no console errors overall', consoleErrors.length === 0, consoleErrors.join(' | '));

    console.log('\n=== 6. Retry resets everything ===');
    registry.get('btn-retry').onclick();
    await tick(); await tick(); await wait(40);
    check('result card hidden again', registry.get('result-card').hidden === true);
    check('no correct marks remain', wordsWithClass('correct').length === 0,
        `${wordsWithClass('correct').length} correct`);
    check('highlight back on first word', wordsWithClass('current').length === 1 &&
        wordEl('the').classList.contains('current'));
    check('progress reset', registry.get('progress-fill').style.width === '0%',
        registry.get('progress-fill').style.width);
    check('score back to 100%', registry.get('score-value').textContent === '100%');

    console.log('\n=== 7. Skipped words are surfaced, not silently lost ===');
    // btn-retry in test 6 left the mic running; stop it so the next click starts fresh.
    if (registry.get('btn-mic').textContent === 'Stop') {
        registry.get('btn-mic').onclick();
        await tick(); await wait(30);
    }
    check('mic is idle before test 7', registry.get('btn-mic').textContent === 'Speak',
        registry.get('btn-mic').textContent);
    registry.get('btn-mic').onclick();
    await tick(); await tick(); await wait(60);
    check('mic is listening for test 7', registry.get('btn-mic').textContent === 'Stop',
        registry.get('btn-mic').textContent);
    sandbox.__sapiCb({ kind: 'READY', text: '' });
    sandbox.__sapiCb({ kind: 'FINAL', text: 'the sun bright today i like to walk in the park' }); // drops "is"
    await tick(); await wait(40);
    check('"is" is struck through', wordEl('is').classList.contains('missed'),
        [...classesOf(wordEl('is'))].join(' '));
    check('later words still correct', wordEl('park').classList.contains('correct'),
        [...classesOf(wordEl('park'))].join(' '));
    check('result card shown with non-perfect state', registry.get('result-card').hidden === false &&
        !registry.get('result-card').classList.contains('is-perfect'));
    check('accuracy below 100%', parseInt(registry.get('result-accuracy').textContent, 10) < 100,
        registry.get('result-accuracy').textContent);
    check('missed word listed in the summary', registry.get('result-missed').children.length === 1,
        `${registry.get('result-missed').children.length} chips`);

    console.log('\n=== 8. Navigation ===');
    registry.get('btn-reset').onclick();
    await tick(); await wait(30);
    check('reset clears marks', wordsWithClass('correct').length === 0);
    await wait(80);
    registry.get('btn-next').onclick();
    await tick(); await wait(40);
    check('next lesson keeps a valid layout', renderedWords().length > 0 &&
        sentenceChips.children.length > 0 && waveBars.children.length === 18);

    console.log('\n' + '='.repeat(52));
    console.log(`RESULT: ${pass} passed, ${fail} failed`);
    console.log('='.repeat(52));
    process.exit(fail ? 1 : 0);
})();
