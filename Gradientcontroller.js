// ============================================================
// gradientController.js  v2.1 — GPGPU Edition
// Audio feature store + per-frame visual state.
//
// DESIGN:
//   app.js polls audioEl.currentTime every 250ms (via AudioContext
//   master clock) and calls GradientController.updatePlayhead(t, isPlaying).
//   ambient.js calls GradientController.frame(dt) every render
//   frame (~60fps) to advance smooth decays.
//   JSON timeline is interpolated between frames for 120Hz+ support.
//   Real-time PCM fallback via Ambient.setAudioFeatures() feeds the
//   GPGPU engine directly when 60Hz JSON is unavailable.
// ============================================================

const GradientController = (() => {

  // ── Audio feature timelines (60Hz JSON data) ─────────────────
  let _beats    = [];   // [{ t: seconds }]
  let _loudness = [];   // [{ t, v: 0–1 }]
  let _spectral = [];   // [{ t, c: 0–1 }]   // centroid
  let _bass     = [];   // [{ t, b: 0–1 }]
  let _melbands = [];   // [{ t, bands: Float32Array(8) }]
  let _tempo    = 120;
  let _beatIdx  = 0;

  // Playhead state
  let _currentT  = 0;
  let _prevT     = 0;
  let _isPlaying = false;

  // Smoothed feature values (EMA filter to kill JSON jitter)
  let _vol      = 0;
  let _spec     = 0;
  let _bass_val = 0;
  let _mels     = new Float32Array(8);

  // EMA smoothing constants (lower = smoother, more lag)
  const SMOOTH_SLOW   = 0.08;  // loudness, centroid
  const SMOOTH_FAST   = 0.25;  // beat pulse decay
  const SMOOTH_MELS   = 0.15;  // melbands

  // ── Public gfx state — read by ambient.js every frame ────────
  const gfx = {
    pulse:       0.0,     // beat ripple 0→1, decays per frame
    pulse2:      0.0,     // secondary ring on strong beats
    phase:       0.0,     // accumulated flow phase
    intensity:   1.0,     // brightness from loudness
    bassFlow:    0.0,     // bass-driven vertical warp
    topColor:    [0.2, 0.5, 0.9],
    bottomColor: [0.05, 0.05, 0.12],
    melbands:    new Float32Array(8),
    centroid:    0.0,
    tempo:       120,
  };

  // Base palette
  let _baseTop    = [0.2, 0.5, 0.9];
  let _baseBottom = [0.05, 0.05, 0.12];

  // ── Public API ───────────────────────────────────────────────

  /**
   * Called by app.js every 250ms with current YT playback position.
   * Samples timeline at current time and fires beat events.
   */
  function updatePlayhead(t, isPlaying) {
    _prevT     = _currentT;
    _currentT  = t;
    _isPlaying = isPlaying;

    if (!isPlaying) return;

    // Lerp-interpolated sample (handles 250ms polling → smooth values)
    const rawVol  = _lerp2(_loudness, t, 'v');
    const rawSpec = _lerp2(_spectral, t, 'c');
    const rawBass = _lerp2(_bass,     t, 'b');

    // Apply EMA smoothing to suppress JSON jitter
    _vol      += (rawVol  - _vol)      * SMOOTH_SLOW;
    _spec     += (rawSpec - _spec)     * SMOOTH_SLOW;
    _bass_val += (rawBass - _bass_val) * SMOOTH_FAST;

    // Smooth each melband independently
    if (_melbands.length) {
      const rawMels = _lerpMelbands(t);
      for (let i = 0; i < 8; i++) {
        _mels[i] += (rawMels[i] - _mels[i]) * SMOOTH_MELS;
      }
      gfx.melbands.set(_mels);
    }

    // Beat detection — fire once per beat crossing
    if (_checkBeat(t)) {
      gfx.pulse  = 1.0;
      gfx.pulse2 = _vol > 0.55 ? 0.75 : 0;
    }
  }

  /**
   * Called by ambient.js every render frame (~60–144fps).
   * dt = seconds since last frame (uncapped physics).
   */
  function frame(dt) {
    dt = Math.min(dt || 0.016, 0.05);

    if (!_isPlaying) {
      // Graceful idle decay
      gfx.pulse    *= Math.pow(0.80, dt * 60);
      gfx.pulse2   *= Math.pow(0.75, dt * 60);
      gfx.bassFlow *= Math.pow(0.90, dt * 60);
      gfx.intensity += (1.0 - gfx.intensity) * dt * 3;
      return;
    }

    // Phase advances with tempo — faster songs feel livelier
    const tempoScale = _tempo / 120;
    gfx.phase    += dt * tempoScale * 0.55;
    gfx.phase    += _bass_val * dt * 2.8;        // bass warps speed
    gfx.bassFlow += (_bass_val - gfx.bassFlow) * dt * 9;

    // Beat pulse decay (tuned: full decay between beats at 120 BPM)
    const pulseDecay  = Math.pow(0.940, dt * 60);
    const pulse2Decay = Math.pow(0.910, dt * 60);
    gfx.pulse  *= pulseDecay;
    gfx.pulse2 *= pulse2Decay;
    if (gfx.pulse  < 0.001) gfx.pulse  = 0;
    if (gfx.pulse2 < 0.001) gfx.pulse2 = 0;

    // Loudness → brightness (never fully dark)
    const targetBright = 0.70 + _vol * 1.2;
    gfx.intensity += (targetBright - gfx.intensity) * dt * 5;

    // Centroid → hue shift of palette
    gfx.centroid = _spec;
    const shift = _spec * 0.22;
    gfx.topColor    = _shiftHue(_baseTop,    shift);
    gfx.bottomColor = _shiftHue(_baseBottom, shift * 0.4);

    gfx.tempo = _tempo;
  }

  /** Load 60Hz audio analysis JSON from backend */
  function loadAudioData(data) {
    _beats    = data.beats    || [];
    _loudness = data.loudness || [];
    _spectral = data.spectral || [];
    _bass     = data.bass     || [];
    _melbands = data.melbands || [];
    _tempo    = data.tempo    || 120;
    _beatIdx  = 0;
    console.log(`[GC] Audio loaded — ${_tempo.toFixed(1)} BPM · ${_beats.length} beats · ${_loudness.length} loudness frames`);
  }

  /** Set the base palette (called by Ambient.setSong) */
  function setBasePalette(top, bottom) {
    _baseTop    = Array.from(top);
    _baseBottom = Array.from(bottom);
    gfx.topColor    = Array.from(top);
    gfx.bottomColor = Array.from(bottom);
  }

  /** Manual beat tap (spacebar sync) */
  function triggerBeat() {
    gfx.pulse  = 1.0;
    gfx.pulse2 = 0.6;
  }

  function reset() {
    _beats=[]; _loudness=[]; _spectral=[]; _bass=[]; _melbands=[];
    _tempo=120; _beatIdx=0; _currentT=0; _prevT=0; _isPlaying=false;
    _vol=0; _spec=0; _bass_val=0; _mels.fill(0);

    gfx.pulse=0; gfx.pulse2=0; gfx.phase=0;
    gfx.intensity=1.0; gfx.bassFlow=0; gfx.centroid=0;
    gfx.topColor    = [0.2, 0.5, 0.9];
    gfx.bottomColor = [0.05, 0.05, 0.12];
    gfx.melbands.fill(0);
    _baseTop    = [0.2, 0.5, 0.9];
    _baseBottom = [0.05, 0.05, 0.12];
  }

  // ── Private helpers ──────────────────────────────────────────

  /** Binary search + linear interpolation between adjacent JSON frames */
  function _lerp2(arr, t, key) {
    if (!arr.length) return 0;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    const a = arr[lo];
    const b = arr[Math.min(lo + 1, arr.length - 1)];
    if (b.t === a.t) return a[key] || 0;
    const alpha = (t - a.t) / (b.t - a.t);
    return (a[key] || 0) + ((b[key] || 0) - (a[key] || 0)) * Math.max(0, Math.min(1, alpha));
  }

  function _lerpMelbands(t) {
    const result = new Float32Array(8);
    if (!_melbands.length) return result;

    let lo = 0, hi = _melbands.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (_melbands[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    const a = _melbands[lo];
    const b = _melbands[Math.min(lo + 1, _melbands.length - 1)];
    const alpha = b.t !== a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;

    for (let i = 0; i < 8; i++) {
      result[i] = (a.bands?.[i] || 0) + ((b.bands?.[i] || 0) - (a.bands?.[i] || 0)) * alpha;
    }
    return result;
  }

  function _checkBeat(t) {
    // Advance through all beats that have passed since last check
    let fired = false;
    while (_beatIdx < _beats.length && t >= _beats[_beatIdx].t) {
      _beatIdx++;
      fired = true;
    }
    return fired;
  }

  /** Luminance-preserving hue rotation */
  function _shiftHue(rgb, amount) {
    const [r, g, b] = rgb;
    const a   = amount * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return [
      Math.max(0, Math.min(1, r*(0.299+0.701*cos+0.168*sin) + g*(0.587-0.587*cos+0.330*sin) + b*(0.114-0.114*cos-0.497*sin))),
      Math.max(0, Math.min(1, r*(0.299-0.299*cos-0.328*sin) + g*(0.587+0.413*cos+0.035*sin) + b*(0.114-0.114*cos+0.292*sin))),
      Math.max(0, Math.min(1, r*(0.299-0.300*cos+1.250*sin) + g*(0.587-0.588*cos-1.050*sin) + b*(0.114+0.886*cos-0.203*sin))),
    ];
  }

  return { gfx, loadAudioData, setBasePalette, updatePlayhead, frame, triggerBeat, reset };
})();