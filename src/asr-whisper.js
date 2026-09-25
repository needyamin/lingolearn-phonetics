import { pipeline, env } from '../node_modules/@huggingface/transformers/dist/transformers.web.js';

let transcriber = null;
let loadPromise = null;
let loadedSize = '';      // which model size is currently in memory
let loadingSize = '';     // which size the in-flight load is for
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
/*
 * Lesson text fed to Whisper as an initial prompt. Whisper conditions its
 * output on this context, which massively improves accuracy when the speaker
 * is reading a known passage (especially with a non-native accent) because
 * the model expects the vocabulary and phrasing it is about to hear.
 */
let initialPrompt = '';

export function isWhisperReady() {
    return Boolean(transcriber);
}

export async function loadWhisperAsr(onProgress, preferredSize) {
    /*
     * The cached model is keyed on the requested size, so switching the
     * "Speech model size" setting actually swaps the model instead of silently
     * reusing whatever was loaded first.
     */
    const wanted = ['small', 'base', 'tiny'].includes(preferredSize) ? preferredSize : 'small';
    if (transcriber && loadedSize === wanted) return transcriber;
    if (loadPromise && loadingSize === wanted) return loadPromise;

    loadingSize = wanted;
    loadPromise = (async () => {
        try {
            if (window.electronAPI && window.electronAPI.getOrtWasmDir) {
                const wasmDir = await window.electronAPI.getOrtWasmDir();
                if (wasmDir) env.backends.onnx.wasm.wasmPaths = wasmDir;
            }
            env.allowLocalModels = false;
            env.useBrowserCache = true;
            /*
             * Multi-threading. Single-threaded WASM inference is the slowest
             * and least accurate path; onnxruntime-web will still fall back to
             * 1 thread if the page is not cross-origin-isolated.
             */
            try {
                const cores = (navigator.hardwareConcurrency || 4);
                env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, cores - 1));
            } catch (_) {
                env.backends.onnx.wasm.numThreads = 1;
            }
            env.backends.onnx.wasm.proxy = false;
            env.backends.onnx.wasm.simd = true;

            onProgress?.('Loading speech model…');
            const modelOptions = {
                // fp32 is noticeably more accurate than q8 for accented speech.
                // The en-only models are small enough that this stays practical.
                dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
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
            /*
             * Model ladder, best first. The user's chosen size leads; the rest
             * act as fallbacks if that model fails to download or initialise.
             */
            const ladderBySize = {
                small: ['Xenova/whisper-small.en', 'Xenova/whisper-base.en', 'Xenova/whisper-tiny.en'],
                base: ['Xenova/whisper-base.en', 'Xenova/whisper-small.en', 'Xenova/whisper-tiny.en'],
                tiny: ['Xenova/whisper-tiny.en', 'Xenova/whisper-base.en']
            };
            const ladder = ladderBySize[wanted] || ladderBySize.small;
            let lastErr = null;
            for (const modelId of ladder) {
                try {
                    transcriber = await pipeline('automatic-speech-recognition', modelId, modelOptions);
                    loadedSize = wanted;
                    console.log('[ASR] loaded', modelId);
                    break;
                } catch (err) {
                    lastErr = err;
                    console.warn('[ASR] failed to load', modelId, err);
                    onProgress?.('Trying a different speech model…');
                    transcriber = null;
                }
            }
            if (!transcriber) throw lastErr || new Error('Could not load a speech model.');
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

/**
 * How many trailing samples to re-feed after a forced (non-pause) cut.
 *
 * Scans backwards in 20ms frames for the first frame that is clearly silent,
 * then keeps everything after it. That guarantees the next transcription
 * window starts on a word boundary instead of mid-syllable, which is what
 * caused garbled/duplicated words at chunk seams.
 */
function findLastSpeechOffset(pcm, rate) {
    const frame = Math.max(1, Math.round(rate * 0.02));
    const minKeep = Math.round(rate * 0.25);
    const maxKeep = Math.round(rate * 2.2);
    let keep = 0;
    for (let end = pcm.length; end > 0 && keep < maxKeep; end -= frame) {
        const start = Math.max(0, end - frame);
        if (rms(pcm.subarray(start, end)) < 0.004) {
            // First genuine silence going backwards - start here.
            break;
        }
        keep = pcm.length - start;
    }
    return Math.max(minKeep, Math.min(maxKeep, keep));
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

    const options = {
        temperature: 0,
        do_sample: false,
        chunk_length_s: 20,
        language: 'en',
        task: 'transcribe'
    };
    /*
     * Conditioning on the lesson text is the single biggest accuracy win for
     * read-aloud practice: the model stops guessing and starts matching the
     * words it already expects. Keep it short - Whisper only uses ~224 tokens.
     */
    if (initialPrompt) options.initial_prompt = initialPrompt;

    const output = await transcriber(pcm, options);
    const text = cleanTranscript(transcriptText(output));
    if (!text || isLikelyHallucination(text, pcm)) return '';
    return text;
}

export async function startWhisperListening({ onTranscript, onLevel, onError, prompt }) {
    await loadWhisperAsr();
    await stopWhisperListening({ flush: false });

    listening = true;
    samples = [];
    sessionCommitted = '';
    sessionOnTranscript = onTranscript;
    initialPrompt = String(prompt || '').slice(0, 900);

    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            /*
             * For read-aloud practice the speaker is close to the mic and we
             * are NOT playing audio at the same time, so:
             *   - echoCancellation OFF: it can gate out quiet or unusual
             *     speech (a known problem with accented English).
             *   - noiseSuppression ON: removes fan hum / room hiss that the
             *     model would otherwise try to decode as words.
             *   - autoGainControl ON: lifts a quiet speaker to a usable level.
             */
            echoCancellation: false,
            noiseSuppression: true,
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

        /*
         * Look at a longer trailing window than before (0.45s vs 0.28s) so a
         * brief inter-word gap is not mistaken for the end of an utterance.
         */
        const tailLen = Math.max(1, Math.round(inputRate * 0.45));
        const recent = raw.subarray(Math.max(0, raw.length - tailLen));
        const quiet = rms(recent) < 0.004;
        const paused = quiet && Date.now() - lastLoudAt > 420;

        /*
         * Hard ceiling raised 2.8s -> 6s. Cutting every 2.8s chopped words in
         * half and forced the model to re-hear stale overlap; a longer window
         * keeps whole sentences together and is far more accurate.
         */
        const tooLong = duration >= 6;
        if (!paused && !tooLong) return;

        transcribing = true;
        const snapshotLen = raw.length;
        try {
            const piece = await transcribeBuffer(raw, inputRate);
            /*
             * Overlap is only needed when we were forced to cut mid-utterance.
             * Find the last loud sample and keep audio from there, so the next
             * pass re-starts on a real sound rather than an arbitrary offset.
             */
            let overlap = 0;
            if (tooLong && !paused) {
                overlap = findLastSpeechOffset(raw, inputRate);
            }
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
    initialPrompt = '';
}
