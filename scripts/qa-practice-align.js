/*
 * QA harness for the English Practice alignment engine.
 *
 * Loads the pure scoring functions straight out of src/practice.js by
 * evaluating the file with a minimal DOM stub, then drives them with
 * realistic recognizer transcripts.
 *
 * Run: node scripts/qa-practice-align.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'src', 'practice.js');
let source = fs.readFileSync(file, 'utf8');

// Cut the file at the first side-effecting statement (the onPracticeSpeech
// listener) - everything above it is pure logic plus DOM handles.
const cutAt = source.indexOf('window.electronAPI.onPracticeSpeech');
if (cutAt < 0) throw new Error('Could not locate the SAPI listener boundary.');
source = source.slice(0, cutAt);

// Expose the internals we want to poke at.
source += `
;globalThis.__qa = {
    tokenize, buildLessonModel, consumeWords, settleMissed, wordsMatch, normalizeWord,
    scoreStats, resetLesson, setMatchSensitivity,
    getMarks: () => marks, getCursor: () => cursor, getTokens: () => tokens,
    getTargets: () => targets,
    initLesson: (text) => resetLesson(text)
};
`;

const stubEl = () => ({
    style: { setProperty() {}, width: '' },
    classList: { toggle() {}, add() {}, remove() {} },
    dataset: {},
    children: [],
    childElementCount: 0,
    appendChild() {},
    scrollTo() {},
    offsetTop: 0,
    offsetHeight: 0,
    hidden: false,
    textContent: '',
    innerHTML: ''
});

const tabEl = [];
const sandbox = {
    document: {
        getElementById: () => null,
        createElement: () => stubEl(),
        createTextNode: () => ({})
    },
    window: { addEventListener() {}, electronAPI: null },
    speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [] },
    SpeechSynthesisUtterance: function () {},
    console,
    setTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    Map,
    Set,
    Array,
    Object,
    Number,
    String,
    Promise
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: file });

const qa = sandbox.__qa;

/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
    if (condition) {
        pass++;
        console.log(`  PASS  ${name}`);
    } else {
        fail++;
        console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
    }
}

function marksToString(tokens, marks) {
    return tokens
        .map((t, i) => (t.isWord && t.normalized ? `${t.raw}[${marks[i] || '-'}]` : t.raw))
        .join('');
}

function markedWords(tokens, marks, wanted) {
    return tokens
        .filter((t, i) => t.isWord && t.normalized && marks[i] === wanted)
        .map((t) => t.raw.replace(/[^a-zA-Z']/g, '').toLowerCase());
}

/** marks is indexed by TOKEN index (whitespace included). Map word -> mark. */
function wordMarkMap(tokens, marks) {
    const map = [];
    tokens.forEach((t, i) => {
        if (t.isWord && t.normalized) map.push({ word: t.raw.replace(/[^a-zA-Z']/g, '').toLowerCase(), mark: marks[i] || '' });
    });
    return map;
}

function markOf(tokens, marks, word) {
    const entry = wordMarkMap(tokens, marks).find((e) => e.word === word.toLowerCase());
    return entry ? entry.mark : '(absent)';
}

/* ------------------------------------------------------------------ */

console.log('\n=== 1. wordsMatch: fuzzy recognizer tolerance ===');
check('exact', qa.wordsMatch('walk', 'walk'));
check('plural drop (walk vs walks)', qa.wordsMatch('walk', 'walks'));
check('past tense (walk vs walked)', qa.wordsMatch('walk', 'walked'));
check('ing form (sleep vs sleeping)', qa.wordsMatch('sleep', 'sleeping'));
check('one edit on 4+ chars (bright vs brigh)', qa.wordsMatch('brigh', 'bright'));
check('rejects unrelated (cat vs dog)', !qa.wordsMatch('cat', 'dog'));
check('rejects short near-miss (is vs in)', !qa.wordsMatch('is', 'in'), 'minLen<4 so edit distance is not allowed');
check('empty guard', !qa.wordsMatch('', 'walk'));

console.log('\n=== 2. normalizeWord ===');
check('lowercase + strip punctuation', qa.normalizeWord('Today.') === 'today');
check('digit 3 -> three', qa.normalizeWord('3') === 'three');
check('apostrophe removed (it\'s -> its)', qa.normalizeWord("it's") === 'its');
check('keeps empty for symbols', qa.normalizeWord('...') === '');

console.log('\n=== 3. Perfect read: every word marked correct ===');
const LESSON = 'The sun is bright today. I like to walk in the park. Birds sing in the trees. It is a happy day.';
const WORDS = LESSON.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);

qa.initLesson(LESSON);
let changed = qa.consumeWords(WORDS);
let stats = qa.scoreStats();
let marks = qa.getMarks();
check('consumeWords reported a change', changed);
check('all words correct', stats.correct === stats.total, `correct=${stats.correct} total=${stats.total}`);
check('no missed', stats.missed === 0, `missed=${stats.missed}`);
check('accuracy 100', stats.accuracy === 100, `accuracy=${stats.accuracy}`);
check('cursor at end', qa.getCursor() === stats.total);
void marksToString;

console.log('\n=== 4. Monotonic: re-feeding old transcript never clears marks ===');
qa.initLesson(LESSON);
qa.consumeWords(['the', 'sun', 'is', 'bright', 'today']);
const cursorAfterFirst = qa.getCursor();
const markedAfterFirst = qa.getMarks().filter((m) => m === 'correct').length;
// Whisper slides a window and can re-emit the beginning of the audio.
qa.consumeWords(['the', 'sun', 'is', 'bright', 'today']);
const markedAfterRepeat = qa.getMarks().filter((m) => m === 'correct').length;
check('cursor did not move backwards', qa.getCursor() === cursorAfterFirst, `${qa.getCursor()} vs ${cursorAfterFirst}`);
check('no marks were cleared', markedAfterRepeat === markedAfterFirst, `${markedAfterRepeat} vs ${markedAfterFirst}`);

console.log('\n=== 5. Skipped word is marked missed, reading continues ===');
qa.initLesson(LESSON);
// User says "The sun bright today" - drops "is".
qa.consumeWords(['the', 'sun', 'bright', 'today']);
stats = qa.scoreStats();
marks = qa.getMarks();
const tokens5 = qa.getTokens();
check('"is" marked missed', markOf(tokens5, marks, 'is') === 'missed', `is=${markOf(tokens5, marks, 'is')}`);
check('"bright" marked correct', markOf(tokens5, marks, 'bright') === 'correct', `bright=${markOf(tokens5, marks, 'bright')}`);
check('"today" marked correct', markOf(tokens5, marks, 'today') === 'correct', `today=${markOf(tokens5, marks, 'today')}`);
check('cursor advanced to word position 5 (4 read + 1 skipped)', qa.getCursor() === 5, `cursor=${qa.getCursor()}`);
check('1 missed recorded', stats.missed === 1, `missed=${stats.missed}`);

console.log('\n=== 6. Filler words are ignored, not counted as missed ===');
qa.initLesson(LESSON);
qa.consumeWords(['the', 'sun', 'um', 'is', 'bright', 'uh', 'today']);
marks = qa.getMarks();
stats = qa.scoreStats();
check('5 real words correct (the sun is bright today)', stats.correct === 5, `correct=${stats.correct}`);
check('no missed from fillers', stats.missed === 0, `missed=${stats.missed}`);

console.log('\n=== 7. Pause + resume: second sentence appended after a break ===');
qa.initLesson(LESSON);
qa.consumeWords(WORDS.slice(0, 6));       // "the sun is bright today i"
stats = qa.scoreStats();
check('partial: 6 marked', stats.correct === 6, `correct=${stats.correct}`);
check('partial: remaining unjudged', stats.left === stats.total - 6, `left=${stats.left}`);
qa.consumeWords(WORDS.slice(6));          // rest of the paragraph
stats = qa.scoreStats();
check('after resume: complete', stats.judged === stats.total, `judged=${stats.judged} total=${stats.total}`);
check('after resume: accuracy 100', stats.accuracy === 100, `accuracy=${stats.accuracy}`);

console.log('\n=== 8. Extra/misheard noise does not derail alignment ===');
qa.initLesson(LESSON);
qa.consumeWords(['the', 'sun', 'is', 'bright', 'blah', 'today']);
stats = qa.scoreStats();
check('noise word ignored, 5 correct', stats.correct === 5, `correct=${stats.correct}`);
check('noise did not create missed', stats.missed === 0, `missed=${stats.missed}`);

console.log('\n=== 9. settleMissed only fills after real progress ===');
qa.initLesson(LESSON);
qa.consumeWords(['the', 'sun']);
qa.settleMissed();
stats = qa.scoreStats();
check('no missed before any gap', stats.missed === 0, `missed=${stats.missed}`);
qa.initLesson(LESSON);
qa.consumeWords(['the', 'sun', 'bright']);  // dropped "is"
qa.settleMissed();
stats = qa.scoreStats();
check('settle keeps the earlier missed mark', stats.missed === 1, `missed=${stats.missed}`);

console.log('\n=== 10. buildLessonModel: sentence split + word count ===');
qa.initLesson(LESSON);
stats = qa.scoreStats();
// The lesson has 22 words (the original count in the old file was wrong).
check('word count is 22', stats.total === 22, `total=${stats.total}`);

console.log('\n=== 11. Accuracy math (settle only fills BEFORE the cursor) ===');
// settleMissed deliberately only back-fills unfinished words before the read
// cursor, so stopping mid-lesson must NOT dump the unread tail as "missed".
qa.initLesson('one two three four five six seven eight nine ten');
qa.consumeWords(['one', 'two', 'three', 'four']);
qa.settleMissed();
stats = qa.scoreStats();
check('4 correct, 0 missed (tail stays unjudged)', stats.correct === 4 && stats.missed === 0,
    `correct=${stats.correct} missed=${stats.missed}`);
check('accuracy 100 on what was actually read', stats.accuracy === 100, `accuracy=${stats.accuracy}`);
check('6 words still to read', stats.left === 6, `left=${stats.left}`);

console.log('\n=== 12. Sensitivity profiles ===');
// Normal is the tuned default; each profile must be reproducible and ordered.
qa.setMatchSensitivity('normal');
check('normal: walk vs walking', qa.wordsMatch('walk', 'walking'));
check('normal: rejects unrelated', !qa.wordsMatch('cat', 'dog'));

qa.setMatchSensitivity('lenient');
check('lenient: accepts a looser stem (read vs reading)', qa.wordsMatch('read', 'reading'));
check('lenient: still rejects unrelated', !qa.wordsMatch('cat', 'dog'));
check('lenient: accepts a 3-char prefix', qa.wordsMatch('beau', 'beautiful'));

qa.setMatchSensitivity('strict');
check('strict: rejects a 4-char prefix', !qa.wordsMatch('beau', 'beautiful'));
// The stem rule (walk/walked) is deliberate and applies at every strictness,
// because recognizers very often drop inflections. Only the prefix and edit
// rules tighten.
check('strict: still accepts the stem rule (walk vs walked)', qa.wordsMatch('walk', 'walked'));
check('strict: rejects a 3-char prefix', !qa.wordsMatch('bea', 'beautiful'));
check('strict: still accepts exact', qa.wordsMatch('walk', 'walk'));

// A lenient profile must never score WORSE than strict on the same input.
function scoreWith(profile, words) {
    qa.setMatchSensitivity(profile);
    qa.initLesson(LESSON);
    qa.consumeWords(words);
    return qa.scoreStats().correct;
}
const messy = ['the', 'sun', 'iz', 'bright', 'today'];  // "iz" is a mis-heard "is"
const cLenient = scoreWith('lenient', messy);
const cStrict = scoreWith('strict', messy);
check('lenient scores >= strict on a messy transcript', cLenient >= cStrict,
    `lenient=${cLenient} strict=${cStrict}`);

qa.setMatchSensitivity('normal');
check('unknown profile falls back to normal',
    (qa.setMatchSensitivity('wat'), qa.wordsMatch('walk', 'walking')));

console.log('\n' + '='.repeat(52));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
