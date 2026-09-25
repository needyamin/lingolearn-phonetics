/*
 * Generates a standalone HTML preview of the English Practice UI states,
 * using the real src/practice.css so the preview reflects production styling.
 *
 * Run: node scripts/preview-practice.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'src', 'practice.css'), 'utf8');

const chip = (cls, n) => `<span class="sentence-chip ${cls}">${n}</span>`;
const word = (text, cls) => `<span class="practice-word ${cls}">${text}</span>`;
const bar = (h) => `<span class="wave-bar" style="height:${h}%"></span>`;

const STATES = [
    {
        name: 'Fresh lesson',
        words: [['The', 'current'], ['sun', ''], ['is', ''], ['bright', ''], ['today.', '']],
        score: '100%', sub: '0 / 5 words', pct: '0%',
        cue: 'Start reading here', cueWord: 'The',
        status: 'Tap Speak, then read out loud at a steady pace.',
        chips: [chip('', 1), chip('', 2)],
        listening: false, result: null
    },
    {
        name: 'Reading — live detection',
        words: [['The', 'correct'], ['sun', 'correct'], ['is', 'missed'], ['bright', 'correct'], ['today.', 'current']],
        score: '75%', sub: '3 / 4 words', pct: '60%',
        cue: 'Read from here', cueWord: 'today.',
        status: 'Listening… continue from “today.”',
        chips: [chip('is-partial', 1), chip('', 2)],
        listening: true, result: null
    },
    {
        name: 'Lesson complete',
        words: [['The', 'correct'], ['sun', 'correct'], ['is', 'correct'], ['bright', 'correct'], ['today.', 'correct']],
        score: '100%', sub: '5 / 5 words', pct: '100%',
        cue: null, cueWord: '',
        status: '',
        chips: [chip('is-done', 1), chip('is-done', 2)],
        listening: false,
        result: {
            accuracy: '100%', pace: '86 wpm',
            missed: '<span class="result-perfect">Every word matched. Excellent.</span>'
        }
    }
];

function frame(state) {
    const ringDeg = Math.round(parseFloat(state.score) * 3.6);
    const wordsHtml = state.words.map(([t, c]) => word(t, c)).join(' ');

    const resultHtml = state.result ? `
            <section class="result-card is-perfect">
                <h2 class="result-title">Lesson complete</h2>
                <div class="result-stats">
                    <div class="result-stat">
                        <span class="result-stat-value">${state.result.accuracy}</span>
                        <span class="result-stat-label">Accuracy</span>
                    </div>
                    <div class="result-stat">
                        <span class="result-stat-value">${state.result.pace}</span>
                        <span class="result-stat-label">Pace</span>
                    </div>
                </div>
                <div class="result-missed">${state.result.missed}</div>
                <div class="result-actions">
                    <button class="btn-ghost" type="button">Try again</button>
                    <button class="btn-mic" type="button">Next lesson ›</button>
                </div>
            </section>` : '';

    const cueHtml = state.cue ? `
            <div class="speak-here-cue">
                <span class="cue-label">${state.cue}</span>
                <strong class="cue-word">${state.cueWord}</strong>
            </div>` : '';

    const wave = Array.from({ length: 18 }, (_, i) =>
        bar(15 + Math.round(Math.abs(Math.sin(i * 0.8)) * 70))).join('');

    const statusCls = state.listening ? 'is-listening' : '';

    return `
    <div class="preview-frame">
        <div class="preview-label">${state.name}</div>
        <div class="practice-page preview-body">
            <div class="practice-shell">
                <header class="practice-top">
                    <button class="btn-icon" type="button">‹</button>
                    <div class="practice-meta">
                        <strong>My School</strong>
                        <span>2 / 8</span>
                    </div>
                    <button class="btn-icon" type="button">›</button>
                </header>

                <section class="practice-hud">
                    <div class="score-ring" style="--angle:${ringDeg}deg">
                        <span class="score-value">${state.score}</span>
                    </div>
                    <div class="score-text">
                        <span class="score-sub">${state.sub}</span>
                        <span class="live-dot is-live"></span>
                        <span class="live-label">Live</span>
                    </div>
                    <div class="sentence-chips">${state.chips.join('')}</div>
                </section>

                <div class="practice-progress">
                    <div class="practice-progress-bar">
                        <div class="practice-progress-fill ${state.words.some(w => w[1] === 'missed') ? 'has-wrong' : ''}" style="width:${state.pct}"></div>
                    </div>
                </div>
${cueHtml}
                <div class="practice-card">
                    <p class="practice-text">${wordsHtml}</p>
                </div>

                <div class="practice-bottom">
                    <div class="heard-panel">
                        <div class="heard-head"><span class="heard-title">Heard</span></div>
                        <p class="heard-sentence">the sun is bright today</p>
                    </div>
${resultHtml}
                    <footer class="practice-dock">
                        <div class="mic-meter">
                            <div class="wave-bars">${wave}</div>
                            <div class="mic-meter-track">
                                <div class="mic-meter-fill" style="width:45%"></div>
                            </div>
                        </div>
                        <p class="practice-status ${statusCls}">${state.status}</p>
                        <div class="practice-actions">
                            <button class="btn-ghost" type="button">Hear</button>
                            <button class="btn-mic ${state.listening ? 'listening' : ''}" type="button">${state.listening ? 'Stop' : 'Speak'}</button>
                            <button class="btn-ghost" type="button">Reset</button>
                        </div>
                    </footer>
                </div>
            </div>
        </div>
    </div>`;
}

const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>English Practice — UI Preview</title>
<style>
${css}

body {
    background: #eef2f7;
    margin: 0;
    padding: 24px;
    font-family: 'Segoe UI', system-ui, sans-serif;
    -webkit-user-select: none;
}

h1 {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0 0 4px;
    color: #0f172a;
}

.preview-intro {
    color: #64748b;
    font-size: 13px;
    margin: 0 0 20px;
}

.preview-row {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
}

.preview-frame {
    background: #fff;
    border-radius: 14px;
    box-shadow: 0 10px 30px -18px rgba(15, 23, 42, 0.45);
    overflow: hidden;
    width: 420px;
    flex: 0 0 auto;
}

.preview-label {
    padding: 9px 14px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #475569;
    background: #f8fafc;
    border-bottom: 1px solid #e5e7eb;
}

.preview-body {
    height: 620px;
}
</style>
</head>
<body>
<h1>English Practice — UI states</h1>
<p class="preview-intro">Static render of the redesigned practice screen using the real practice.css. Not a live app window.</p>
<div class="preview-row">
${STATES.map(frame).join('\n')}
</div>
</body>
</html>
`;

const target = path.join(ROOT, 'practice-preview.html');
fs.writeFileSync(target, out);
console.log(`Wrote ${target} (${out.length} bytes)`);
