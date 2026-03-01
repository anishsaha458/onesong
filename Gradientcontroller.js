// ============================================================
// gradientController.js
// Audio feature store + per-frame visual state.
//
// IMPORTANT DESIGN NOTE:
//   app.js polls ytPlayer.getCurrentTime() every 250 ms and calls
//   GradientController.updatePlayhead(t, isPlaying).
//   ambient.js calls GradientController.frame() on EVERY render
//   frame (~60 fps) to advance decays smoothly.
//   These are two separate concerns — keep them separate.
// ============================================================

const GradientController = (() => {

    // ── Audio feature timelines ──────────────────────────────
    let _beats    = [];   // [{ t: float seconds }]
    let _loudness = [];   // [{ t, v: 0-1 }]
    let _spectral = [];   // [{ t, c: 0-1 }]
    let _bass     = [];   // [{ t, b: 0-1 }]
    let _tempo    = 120;
    let _beatIdx  = 0;

    // Playhead state set by updatePlayhead()
    let _currentT  = 0;
    let _isPlaying = false;

    // Per-frame sampled values (set in updatePlayhead, read in frame)
    let _vol  = 0;
    let _spec = 0;
    let _bass_val = 0;

    // ── Public gfx state — read by ambient.js every frame ────
    const gfx = {
        // Beat ripple: 0→1 on beat, decays to 0 smoothly each frame
        pulse:       0.0,
        // Accumulated phase for fluid drift speed
        phase:       0.0,
        // Brightness multiplier from loudness
        intensity:   1.0,
        // Bass-driven vertical warp strength
        bassFlow:    0.0,
        // Hue-shifted colours (updated each frame)
        topColor:    [0.2, 0.5, 0.9],
        bottomColor: [0.05, 0.05, 0.1],
        // Second ripple ring for graceful double-wave on strong beats
        pulse2:      0.0,
    };

    // Base palette (set from video colour sample or mood)
    let _baseTop    = [0.2, 0.5, 0.9];
    let _baseBottom = [0.05, 0.05, 0.1];

    // ── Public API ───────────────────────────────────────────

    /** Called by app.js every 250ms with current YT playback time */
    function updatePlayhead(t, isPlaying) {
        _currentT  = t;
        _isPlaying = isPlaying;

        if (!isPlaying) return;

        // Look up current audio features at this timestamp
        _vol      = _lookup(_loudness, t, 'v');
        _spec     = _lookup(_spectral, t, 'c');
        _bass_val = _lookup(_bass, t, 'b');

        // Trigger beat pulse (only fires once per beat crossing)
        if (_checkBeat(t)) {
            gfx.pulse  = 1.0;
            // Strong beats get a second ring with a slight delay feel
            if (_vol > 0.6) gfx.pulse2 = 0.7;
        }
    }

    /**
     * Called by ambient.js every render frame (~60fps).
     * Advances all smooth decays and accumulations.
     * dt is seconds since last frame (defaults to 1/60).
     */
    function frame(dt) {
        dt = dt || 0.016;

        if (!_isPlaying) {
            // Graceful decay when paused
            gfx.pulse    *= Math.pow(0.85, dt * 60);
            gfx.pulse2   *= Math.pow(0.80, dt * 60);
            gfx.bassFlow *= Math.pow(0.90, dt * 60);
            gfx.intensity += (1.0 - gfx.intensity) * 0.05;
            return;
        }

        // Tempo drives base phase drift
        // At 120 BPM this advances ~0.01/frame; faster songs feel livelier
        gfx.phase += dt * (_tempo / 120) * 0.6;

        // Bass energy adds extra vertical warp on top of phase
        gfx.phase    += _bass_val * dt * 3.0;
        // Smooth bassFlow toward current value (no hard jumps)
        gfx.bassFlow += (_bass_val - gfx.bassFlow) * (dt * 8.0);

        // Beat pulse decays — tuned so a beat at 120 BPM fully fades
        // before the next one arrives (~0.5 s at 0.94^60 ≈ 0.024/frame)
        gfx.pulse  *= Math.pow(0.94, dt * 60);
        gfx.pulse2 *= Math.pow(0.91, dt * 60);
        if (gfx.pulse  < 0.001) gfx.pulse  = 0;
        if (gfx.pulse2 < 0.001) gfx.pulse2 = 0;

        // Loudness → brightness (smooth approach, never fully dark)
        const targetIntensity = 0.75 + _vol * 1.1;
        gfx.intensity += (targetIntensity - gfx.intensity) * (dt * 4.0);

        // Spectral centroid → slowly shift hue of the base palette
        const hueShift = _spec * 0.25;
        gfx.topColor    = _shiftHue(_baseTop,    hueShift);
        gfx.bottomColor = _shiftHue(_baseBottom, hueShift * 0.5);
    }

    function loadAudioData(data) {
        _beats    = data.beats    || [];
        _loudness = data.loudness || [];
        _spectral = data.spectral || [];
        _bass     = data.bass     || [];
        _tempo    = data.tempo    || 120;
        _beatIdx  = 0;
        console.log(`[GC] audio loaded — tempo=${_tempo.toFixed(1)} bpm, ${_beats.length} beats`);
    }

    /** Set the base palette that hue-shift operates on */
    function setBasePalette(top, bottom) {
        _baseTop    = top.slice();
        _baseBottom = bottom.slice();
        gfx.topColor    = top.slice();
        gfx.bottomColor = bottom.slice();
    }

    /** Manual beat tap (spacebar) */
    function triggerBeat() {
        gfx.pulse  = 1.0;
        gfx.pulse2 = 0.6;
    }

    function reset() {
        _beats=[]; _loudness=[]; _spectral=[]; _bass=[];
        _tempo=120; _beatIdx=0; _currentT=0; _isPlaying=false;
        _vol=0; _spec=0; _bass_val=0;
        gfx.pulse=0; gfx.pulse2=0; gfx.phase=0;
        gfx.intensity=1.0; gfx.bassFlow=0;
        gfx.topColor    = [0.2, 0.5, 0.9];
        gfx.bottomColor = [0.05, 0.05, 0.1];
        _baseTop    = [0.2, 0.5, 0.9];
        _baseBottom = [0.05, 0.05, 0.1];
    }

    // ── Private helpers ──────────────────────────────────────

    function _lookup(arr, t, key) {
        if (!arr.length) return 0;
        let lo = 0, hi = arr.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].t < t) lo = mid + 1; else hi = mid - 1;
        }
        return (arr[Math.max(0, hi)] || {})[key] || 0;
    }

    function _checkBeat(t) {
        if (_beatIdx < _beats.length && t >= _beats[_beatIdx].t) {
            _beatIdx++;
            return true;
        }
        return false;
    }

    // Luminance-preserving hue rotation matrix
    function _shiftHue(rgb, amount) {
        const [r, g, b] = rgb;
        const a = amount * Math.PI * 2;
        const cos = Math.cos(a), sin = Math.sin(a);
        return [
            Math.max(0, r*(0.299+0.701*cos+0.168*sin) + g*(0.587-0.587*cos+0.330*sin) + b*(0.114-0.114*cos-0.497*sin)),
            Math.max(0, r*(0.299-0.299*cos-0.328*sin) + g*(0.587+0.413*cos+0.035*sin) + b*(0.114-0.114*cos+0.292*sin)),
            Math.max(0, r*(0.299-0.300*cos+1.250*sin) + g*(0.587-0.588*cos-1.050*sin) + b*(0.114+0.886*cos-0.203*sin)),
        ];
    }

    return { gfx, loadAudioData, setBasePalette, updatePlayhead, frame, triggerBeat, reset };
})();