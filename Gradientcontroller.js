// ============================================================
// gradientController.js
// Owns all audio feature data + maps it to shader-ready values.
// Imported by ambient.js and called once per render frame.
// ============================================================

// ── Audio feature timelines (populated by loadAudioData) ────
let _beats    = [];   // [{ t: seconds }]
let _loudness = [];   // [{ t, v: 0-1 }]
let _spectral = [];   // [{ t, c: 0-1 }]
let _bass     = [];   // [{ t, b: 0-1 }]
let _tempo    = 120;  // BPM scalar

// Pointer that walks forward through _beats in real-time
let _beatIndex = 0;

// ── Public gradient control state (read by ambient.js) ──────
export const gfx = {
    phase:        0.0,   // colour drift accumulator
    pulse:        0.0,   // beat flash (0–1, decays each frame)
    intensity:    1.0,   // overall brightness multiplier
    hueShift:     0.0,   // spectral-driven hue rotation (0–1)
    bassFlow:     0.0,   // bass-driven vertical warp strength
    topColor:     [0.2, 0.5, 0.9],
    bottomColor:  [0.05, 0.05, 0.1],
};

// Base palette colours (set when a song is loaded, before hue shift)
let _baseTop    = [0.2, 0.5, 0.9];
let _baseBottom = [0.05, 0.05, 0.1];

// ── Public API ───────────────────────────────────────────────

/**
 * Called by app.js after the backend returns audio analysis.
 * Resets all pointers so the controller is ready for playback.
 */
export function loadAudioData(data) {
    _beats    = data.beats    ?? [];
    _loudness = data.loudness ?? [];
    _spectral = data.spectral ?? [];
    _bass     = data.bass     ?? [];
    _tempo    = data.tempo    ?? 120;
    _beatIndex = 0;

    console.log(`[GC] loaded: tempo=${_tempo}, beats=${_beats.length}, frames=${_loudness.length}`);
}

/**
 * Update base palette when the song changes (before hue shift is applied).
 */
export function setBasePalette(top, bottom) {
    _baseTop    = [...top];
    _baseBottom = [...bottom];
}

/**
 * Called once per render frame with the current YouTube playback time.
 * Mutates `gfx` in-place; ambient.js reads `gfx` to set shader uniforms.
 */
export function tick(playbackTime, isPlaying) {
    if (!isPlaying) {
        // Let pulse and bass flow decay naturally even when paused
        gfx.pulse    *= 0.90;
        gfx.bassFlow *= 0.85;
        return;
    }

    const t   = playbackTime;
    const vol = _getLoudness(t);
    const spec = _getSpectral(t);
    const bass = _getBass(t);

    // ── Tempo → phase speed ─────────────────────────────────
    // Normalise against 120 BPM so songs always feel "right"
    gfx.phase += 0.01 * (_tempo / 120);

    // ── Bass → extra vertical warp ──────────────────────────
    gfx.phase    += bass * 0.05;
    gfx.bassFlow  = bass;

    // ── Beat → sharp pulse ──────────────────────────────────
    if (_checkBeat(t)) {
        gfx.pulse = 1.0;
    }
    gfx.pulse *= 0.92;   // ~12-frame decay

    // ── Loudness → brightness ───────────────────────────────
    gfx.intensity = 0.8 + vol * 1.2;

    // ── Spectral centroid → hue shift ───────────────────────
    gfx.hueShift = spec * 0.3;
    gfx.topColor    = _shiftHue(_baseTop,    gfx.hueShift);
    gfx.bottomColor = _shiftHue(_baseBottom, gfx.hueShift * 0.5);
}

// ── Private helpers ──────────────────────────────────────────

/** O(log n) binary search: find the latest entry whose .t <= playbackTime */
function _lookup(arr, t, valueKey) {
    if (!arr.length) return 0;
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].t < t) lo = mid + 1;
        else hi = mid - 1;
    }
    return arr[Math.max(0, hi)]?.[valueKey] ?? 0;
}

function _getLoudness(t) { return _lookup(_loudness, t, 'v'); }
function _getSpectral(t) { return _lookup(_spectral, t, 'c'); }
function _getBass(t)     { return _lookup(_bass,     t, 'b'); }

/** Advance beat pointer and return true on the frame a beat fires */
function _checkBeat(t) {
    if (_beatIndex < _beats.length && t >= _beats[_beatIndex].t) {
        _beatIndex++;
        return true;
    }
    return false;
}

/**
 * Rotate hue of an RGB triplet by `amount` (0–1 = full circle).
 * Uses a luminance-preserving rotation matrix.
 */
function _shiftHue([r, g, b], amount) {
    const a   = amount * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);

    return [
        r * (0.299 + 0.701*cos + 0.168*sin) + g * (0.587 - 0.587*cos + 0.330*sin) + b * (0.114 - 0.114*cos - 0.497*sin),
        r * (0.299 - 0.299*cos - 0.328*sin) + g * (0.587 + 0.413*cos + 0.035*sin) + b * (0.114 - 0.114*cos + 0.292*sin),
        r * (0.299 - 0.300*cos + 1.250*sin) + g * (0.587 - 0.588*cos - 1.050*sin) + b * (0.114 + 0.886*cos - 0.203*sin),
    ];
}