import { pipeline, env } from '../node_modules/@huggingface/transformers/dist/transformers.web.js';

let transcriber = null;
let loadPromise = null;
let listening = false;
let transcribing = false;
let timer = null;
let inputRate = 16000;
let samples = [];
let audio = {
    ctx: null,
    stream: null,
    processor: null,
    source: null,
    mute: null
};
let sessionOnTranscript = null;
let sessionCommitted = '';

export function isWhisperReady() {
    return Boolean(transcriber);
}

export async function loadWhisperAsr(onProgress) {
    if (transcriber) return transcriber;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        try {
            if (window.electronAPI && window.electronAPI.getOrtWasmDir) {
                const wasmDir = await window.electronAPI.getOrtWasmDir();
                if (wasmDir) env.backends.onnx.wasm.wasmPaths = wasmDir;
            }
            env.allowLocalModels = false;
            env.useBrowserCache = true;
            env.backends.onnx.wasm.numThreads = 1;
            env.backends.onnx.wasm.proxy = false;

            onProgress?.('Loading speech model…');
            const modelOptions = {
                dtype: 'q8',
                device: 'wasm',
                progress_callback: (info) => {
                    if (!info) return;
                    if (info.status === 'progress' && typeof info.progress === 'number') {
                        onProgress?.(`Downloading model… ${Math.round(info.progress)}%`);
                    } else if (info.status === 'download') {
                        onProgress?.('Downloading speech model…');
                    }
                }
            };
            try {
                transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', modelOptions);
            } catch (err) {
                console.warn('whisper-base.en failed, falling back to tiny.en', err);
                onProgress?.('Using a lighter speech model…');
                transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', modelOptions);
            }
            onProgress?.('Ready. Tap Speak, then read.');
            return transcriber;
        } catch (err) {
            loadPromise = null;
            transcriber = null;
            throw err;
        }
    })();

    return loadPromise;
}

function rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / Math.max(buf.length, 1));
}

function concat(chunks) {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

function resample(float32, fromRate, toRate = 16000) {
    if (fromRate === toRate) return float32;
    const ratio = fromRate / toRate;
    const outLen = Math.max(1, Math.round(float32.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const x = i * ratio;
        const i0 = Math.floor(x);
        const i1 = Math.min(i0 + 1, float32.length - 1);
        const t = x - i0;
        out[i] = float32[i0] * (1 - t) + float32[i1] * t;
    }
    return out;
}

function normalizePcm(pcm) {
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak < 0.02) return pcm;
    const gain = Math.min(0.92 / peak, 3.5);
    if (gain < 1.08) return pcm;
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
        const sample = pcm[i] * gain;
        out[i] = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    }
    return out;
}

function cleanTranscript(text) {
    return String(text || '')
        .replace(/\[.*?\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\b(blank audio|music|applause|laughter|subtitle[s]? by)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function mergeTranscript(prev, next) {
    const a = String(prev || '').trim().split(/\s+/).filter(Boolean);
    const b = String(next || '').trim().split(/\s+/).filter(Boolean);
    if (!a.length) return b.join(' ');
    if (!b.length) return a.join(' ');
    const max = Math.min(8, a.length, b.length);
    const norm = (words) => words.join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, '');
    for (let n = max; n >= 1; n--) {
        if (norm(a.slice(-n)) === norm(b.slice(0, n))) return [...a, ...b.slice(n)].join(' ');
    }
    return `${a.join(' ')} ${b.join(' ')}`;
}

function isLikelyHallucination(text, pcm) {
    const cleaned = cleanTranscript(text).toLowerCase().replace(/[.,!?]+/g, '');
    if (!cleaned) return true;
    const boilerplate = /^(thank you|thanks for watching|thanks|you|okay|ok|the|a|i|hello|bye|please subscribe)$/;
    if (boilerplate.test(cleaned) && rms(pcm) < 0.025) return true;
    return false;
}

function dropFront(count) {
    if (count <= 0) return;
    const all = concat(samples);
    if (all.length <= count) {
        samples = [];
        return;
    }
    samples = [new Float32Array(all.subarray(count))];
}

function transcriptText(result) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    if (result.text) return result.text;
    if (Array.isArray(result) && result[0] && result[0].text) return result[0].text;
    return '';
}

async function transcribeBuffer(float32, fromRate) {
    const pcm = normalizePcm(resample(float32, fromRate, 16000));
    if (rms(pcm) < 0.006) return '';
    const output = await transcriber(pcm, {
        temperature: 0,
        do_sample: false,
        chunk_length_s: 20
    });
    const text = cleanTranscript(transcriptText(output));
    if (!text || isLikelyHallucination(text, pcm)) return '';
    return text;
}

export async function startWhisperListening({ onTranscript, onLevel, onError }) {
    await loadWhisperAsr();
    await stopWhisperListening({ flush: false });

    listening = true;
    samples = [];
    sessionCommitted = '';
    sessionOnTranscript = onTranscript;

    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 16000
        }
    });

    let ctx;
    try {
        ctx = new AudioContext({ sampleRate: 16000 });
    } catch (_) {
        ctx = new AudioContext();
    }
    if (ctx.state === 'suspended') await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    inputRate = ctx.sampleRate;

    let lastLoudAt = 0;
    let heardSpeech = false;

    processor.onaudioprocess = (event) => {
        if (!listening) return;
        const data = event.inputBuffer.getChannelData(0);
        samples.push(new Float32Array(data));
        const level = rms(data);
        onLevel?.(level);
        if (level > 0.012) {
            lastLoudAt = Date.now();
            heardSpeech = true;
        }
    };

    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);
    audio = { ctx, stream, processor, source, mute };

    const publish = (piece) => {
        if (!piece) return;
        sessionCommitted = mergeTranscript(sessionCommitted, piece);
        sessionOnTranscript?.(sessionCommitted);
    };

    const tick = async () => {
        if (!listening || transcribing || !transcriber || !heardSpeech) return;
        const raw = concat(samples);
        const duration = raw.length / inputRate;
        if (duration < 0.55) return;

        const recent = raw.subarray(Math.max(0, raw.length - Math.round(inputRate * 0.28)));
        const quiet = rms(recent) < 0.004;
        const paused = quiet && Date.now() - lastLoudAt > 480;
        const tooLong = duration >= 2.8;
        if (!paused && !tooLong) return;

        transcribing = true;
        const snapshotLen = raw.length;
        try {
            const piece = await transcribeBuffer(raw, inputRate);
            const overlap = tooLong && !paused ? Math.round(inputRate * 0.3) : 0;
            dropFront(Math.max(0, snapshotLen - overlap));
            heardSpeech = paused ? false : !quiet;
            publish(piece);
        } catch (err) {
            onError?.(err);
        } finally {
            transcribing = false;
        }
    };

    timer = setInterval(tick, 180);
    return true;
}

export async function stopWhisperListening({ flush = true } = {}) {
    const shouldFlush = flush && listening && sessionOnTranscript;
    listening = false;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    const waitStart = Date.now();
    while (transcribing && Date.now() - waitStart < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (shouldFlush && transcriber && samples.length) {
        try {
            const leftover = concat(samples);
            if (leftover.length / Math.max(inputRate, 1) >= 0.4 && rms(leftover) >= 0.006) {
                const piece = await transcribeBuffer(leftover, inputRate);
                if (piece) {
                    sessionCommitted = mergeTranscript(sessionCommitted, piece);
                    sessionOnTranscript(sessionCommitted);
                }
            }
        } catch (_) {}
    }
    transcribing = false;
    try { audio.processor && audio.processor.disconnect(); } catch (_) {}
    try { audio.source && audio.source.disconnect(); } catch (_) {}
    try { audio.mute && audio.mute.disconnect(); } catch (_) {}
    if (audio.stream) audio.stream.getTracks().forEach((track) => track.stop());
    if (audio.ctx && audio.ctx.state !== 'closed') {
        try { await audio.ctx.close(); } catch (_) {}
    }
    audio = { ctx: null, stream: null, processor: null, source: null, mute: null };
    samples = [];
    sessionOnTranscript = null;
}
