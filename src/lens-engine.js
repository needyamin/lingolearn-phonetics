"use strict";

/*
 * LingoLearn Lens - offline lookup engine (Electron main process).
 *
 * Ported from the lingolearn-lens browser extension (common/offline-engine.js
 * and common/translate-link.js) so the desktop popup answers lookups from the
 * same bundled dictionaries: E2Bdatabase.json (english -> bangla),
 * bangla_dictionary.txt (extra meanings) and cmudict-0.7b-ipa.txt (IPA).
 *
 * Deliberately free of Electron requires so it can be unit-tested with plain
 * node. There is NO lookup-result cache: every translate() call is a fresh
 * query against the in-memory dictionaries, so nothing the user selects is
 * ever remembered between requests.
 */

const BANGLA_RE = /[\u0980-\u09FF]/;
const MAX_PHRASE_WORDS = 12;
const MAX_GROUPS = 3;
const MAX_TERMS_PER_GROUP = 4;
const MAX_GLOSSES_IN_TRANSLATION = 3;

const TRANSLATE_LINK_BASE = "https://translate.google.com/";
const TRANSLATE_TEXT_MAX = 1500;
const TRANSLATE_TARGET_PATTERN = /^[a-z]{2}(-[A-Za-z]{2,4})?$/i;
const TRANSLATE_TARGET_FALLBACK = "bn";

let loadMaterial = null;
let readyPromise = null;
let e2bMap = null;
let dictMap = null;
let ipaMap = null;
let reverseMap = null;

/* --------------------------------------------------- text helpers ---- */

function stripEdges(value) {
    const text = String(value == null ? "" : value);
    return text
        .replace(/^[\p{P}\p{S}\s]+/u, "")
        .replace(/[\p{P}\p{S}\s]+$/u, "")
        .replace(/\s+/g, " ")
        .trim();
}

function splitPos(sense) {
    const tags = [];
    const bare = String(sense)
        .replace(/\(([^)]*)\)/g, (match, inner) => {
            const tag = String(inner).trim();
            if (tag) tags.push(tag);
            return " ";
        })
        .replace(/\s+/g, " ")
        .trim();
    return { pos: tags.join(" "), bare };
}

function sensesFromRaw(raw) {
    return String(raw)
        .split(",")
        .map((sense) => sense.trim())
        .filter(Boolean);
}

function buildGroups(senses) {
    const groups = [];
    const byPos = new Map();
    for (const sense of senses) {
        const { pos, bare } = splitPos(sense);
        if (!bare) continue;
        let group = byPos.get(pos);
        if (!group) {
            if (groups.length >= MAX_GROUPS) continue;
            group = { pos, terms: [] };
            byPos.set(pos, group);
            groups.push(group);
        }
        if (!group.terms.includes(bare) && group.terms.length < MAX_TERMS_PER_GROUP) {
            group.terms.push(bare);
        }
    }
    return groups;
}

/* ------------------------------------------------- asset parsing ---- */

function buildE2BMap(rows) {
    const map = new Map();
    for (const entry of rows) {
        if (!entry || typeof entry !== "object") continue;
        const en = typeof entry.en === "string" ? entry.en.trim().toLowerCase() : "";
        const bn = typeof entry.bn === "string" ? entry.bn.trim() : "";
        if (!en || !bn) continue;
        if (map.has(en)) continue;
        map.set(en, bn);
    }
    if (map.size === 0) {
        throw new Error("E2Bdatabase.json: no usable entries found.");
    }
    return map;
}

function parseBanglaDictionary(text) {
    const map = new Map();
    for (const rawLine of String(text).split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const parts = line.split("|");
        if (parts.length !== 3 || parts[0].trim() !== "") continue;
        const en = parts[1].trim().toLowerCase();
        const bn = parts[2].trim();
        if (!en || !bn) continue;
        let meanings = map.get(en);
        if (!meanings) {
            meanings = [];
            map.set(en, meanings);
        }
        if (!meanings.includes(bn)) meanings.push(bn);
    }
    return map;
}

function parsePronunciation(text) {
    const map = new Map();
    for (const rawLine of String(text).split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith(";;;")) continue;
        const tab = line.indexOf("\t");
        if (tab <= 0) continue;
        const word = line.slice(0, tab).trim().toUpperCase();
        const ipa = line.slice(tab + 1).trim();
        if (!word || !ipa) continue;
        if (map.has(word)) continue;
        map.set(word, ipa);
    }
    return map;
}

function buildReverse() {
    const map = new Map();
    for (const [en, raw] of e2bMap) {
        for (const sense of sensesFromRaw(raw)) {
            const { bare } = splitPos(sense);
            if (!bare) continue;
            let words = map.get(bare);
            if (!words) {
                words = [];
                map.set(bare, words);
            }
            if (!words.includes(en)) words.push(en);
        }
    }
    return map;
}

/* --------------------------------------------------------- init ---- */

function init(options) {
    if (readyPromise) return readyPromise;
    const opts = options || {};
    if (typeof opts.loadMaterial !== "function") {
        readyPromise = Promise.reject(new Error("lens-engine init requires a loadMaterial(name) function."));
        readyPromise.catch(() => { readyPromise = null; });
        return readyPromise;
    }
    loadMaterial = opts.loadMaterial;

    readyPromise = (async () => {
        const [jsonRaw, dictText, ipaText] = await Promise.all([
            Promise.resolve(loadMaterial("E2Bdatabase.json")),
            Promise.resolve(loadMaterial("bangla_dictionary.txt")),
            Promise.resolve(loadMaterial("cmudict-0.7b-ipa.txt")),
        ]);

        let rows = [];
        const trimmedJson = String(jsonRaw || "").trim();
        if (trimmedJson.startsWith("[")) {
            rows = JSON.parse(trimmedJson);
            if (!Array.isArray(rows)) rows = [];
        } else if (trimmedJson) {
            for (const line of trimmedJson.split("\n")) {
                const parts = line.trim().split("|");
                if (parts.length >= 3) rows.push({ en: parts[1], bn: parts.slice(2).join("|") });
            }
        }

        e2bMap = buildE2BMap(rows);
        dictMap = parseBanglaDictionary(String(dictText || ""));
        ipaMap = parsePronunciation(String(ipaText || ""));
        reverseMap = null;
        return api;
    })();

    readyPromise.catch(() => { readyPromise = null; });
    return readyPromise;
}

function invalidate() {
    readyPromise = null;
    e2bMap = null;
    dictMap = null;
    ipaMap = null;
    reverseMap = null;
}

/* ---------------------------------------------------- translate ---- */

function succeed(fields) {
    return {
        ok: true,
        translation: "",
        romanization: "",
        dictionary: [],
        detectedLanguage: "en",
        ipa: "",
        partial: false,
        ...fields,
    };
}

function noMeaning(query) {
    return { ok: false, error: 'No offline meaning found for "' + query + '".' };
}

async function translate(text, target) {
    if (!e2bMap || !dictMap || !ipaMap) {
        throw new Error("Lens engine is not ready; call init() first.");
    }
    if (target !== "bn") {
        return { ok: false, error: "This offline build supports Bangla only." };
    }

    const query = stripEdges(text);
    if (!query) return noMeaning(query);

    if (BANGLA_RE.test(query)) {
        if (!/\s/.test(query)) {
            if (!reverseMap) reverseMap = buildReverse();
            const glosses = reverseMap.get(splitPos(query).bare);
            if (glosses && glosses.length) {
                return succeed({
                    translation: glosses.slice(0, MAX_GLOSSES_IN_TRANSLATION).join(", "),
                    dictionary: [{ pos: "English", terms: glosses.slice(0, MAX_TERMS_PER_GROUP) }],
                    detectedLanguage: "bn",
                });
            }
        }
        return succeed({ detectedLanguage: "bn" });
    }

    const lower = query.toLowerCase();
    const raw = e2bMap.get(lower);
    const dictMeanings = dictMap.get(lower);

    if (raw) {
        const groups = buildGroups(sensesFromRaw(raw));
        if (dictMeanings && dictMeanings.length) {
            let plain = groups.find((group) => group.pos === "");
            if (!plain) {
                plain = { pos: "", terms: [] };
                groups.push(plain);
            }
            for (const meaning of dictMeanings) {
                const present = groups.some((group) => group.terms.includes(meaning));
                if (!present && plain.terms.length < MAX_TERMS_PER_GROUP) {
                    plain.terms.push(meaning);
                }
            }
        }
        return succeed({
            translation: raw,
            dictionary: groups,
            detectedLanguage: "en",
            ipa: ipaMap.get(query.toUpperCase()) || "",
        });
    }

    if (!/\s/.test(query)) {
        if (dictMeanings && dictMeanings.length) {
            const terms = dictMeanings.slice(0, MAX_TERMS_PER_GROUP);
            return succeed({
                translation: dictMeanings[0],
                dictionary: [{ pos: "", terms }],
                detectedLanguage: "en",
                ipa: ipaMap.get(query.toUpperCase()) || "",
            });
        }
        return noMeaning(query);
    }

    const words = query.split(" ").slice(0, MAX_PHRASE_WORDS);
    const out = [];
    let mappedAny = false;
    for (const word of words) {
        const token = stripEdges(word);
        const tokenLower = token.toLowerCase();
        let replacement = "";
        const wordRaw = e2bMap.get(tokenLower);
        if (wordRaw) {
            const first = sensesFromRaw(wordRaw)[0];
            if (first) replacement = splitPos(first).bare || first.trim();
        }
        if (!replacement) {
            const meanings = dictMap.get(tokenLower);
            if (meanings && meanings.length) replacement = meanings[0];
        }
        if (replacement) {
            out.push(replacement);
            mappedAny = true;
        } else {
            out.push(token || word);
        }
    }
    if (!mappedAny) return noMeaning(query);

    return succeed({
        translation: out.join(" "),
        detectedLanguage: "en",
        partial: true,
    });
}

/* ------------------------------------------- google translate link ---- */

function buildTranslateLink(text, target) {
    const code =
        typeof target === "string" && TRANSLATE_TARGET_PATTERN.test(target)
            ? target
            : TRANSLATE_TARGET_FALLBACK;
    let href = TRANSLATE_LINK_BASE;
    try {
        const url = new URL(TRANSLATE_LINK_BASE);
        url.searchParams.set("sl", "auto");
        url.searchParams.set("tl", code);
        url.searchParams.set("text", String(text).slice(0, TRANSLATE_TEXT_MAX));
        url.searchParams.set("op", "translate");
        href = url.toString();
    } catch (_) {
        href = TRANSLATE_LINK_BASE;
    }
    return href;
}

const api = { init, translate, invalidate, buildTranslateLink };

module.exports = api;
