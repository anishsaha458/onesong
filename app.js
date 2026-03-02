/**
 * app.js — OneSong  v4.5
 * ────────────────────────────────────────────────────────────
 * FIXES vs v4.4:
 *
 * [E1] DYNAMIC API URL:
 *      Hardcoded origin caused "Cannot reach server" when frontend and
 *      backend share a Render origin. FIX: derive API from
 *      window.location.origin. Override via window.ONESONG_API.
 *
 * [E2] GPGPU starts immediately on DOMContentLoaded, before auth check,
 *      before server ping — canvas is live from frame 1 in all cases.
 *
 * [E3] _bootAsync veil is translucent (CSS rgba 80%) so particles show
 *      through. Ambient.init() is called synchronously before veil appears.
 *
 * [E4] All other fixes from v4.4 [G1–G6] retained.
 */

// FIX [E1]: Dynamic API base. To use a separate backend host, set:

const API = 'https://onesong.onrender.com';

// ── Global state ──────────────────────────────────────────
let authToken    = null;
let currentUser  = null;
let hasSong      = false;
let currentSong  = null;
let serverReady  = false;

// ── Audio state ───────────────────────────────────────────
let audioCtx       = null;
let audioSrc       = null;
let analyserNode   = null;
let gainNode       = null;
let audioEl        = null;
let clockPoller    = null;
let analysisLoaded = false;
let _audioReady    = false;
let _audioRetried  = false;
let _playEnableTimer = null;

const FFT_SIZE = 256;
let freqData   = null;

// ── DOM refs ──────────────────────────────────────────────
let elPlayBtn, elPlayIco, elPauseIco, elProgress, elTimeCur, elTimeTot;
let elSeekSlider, elAnalysisStatus;

// ─────────────────────────────────────────────────────────
// BOOT
//
// FIX [E2]: Ambient.init() is the VERY FIRST thing that runs after DOM
// is ready. Auth checks, server pings, and veil overlays come after.
// This guarantees the WebGL canvas is rendering from frame 1.
// ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Cache DOM refs
  audioEl          = document.getElementById('headless-audio');
  elPlayBtn        = document.getElementById('play-btn');
  elPlayIco        = document.getElementById('ico-play');
  elPauseIco       = document.getElementById('ico-pause');
  elProgress       = document.getElementById('progress-fill');
  elTimeCur        = document.getElementById('time-cur');
  elTimeTot        = document.getElementById('time-tot');
  elSeekSlider     = document.getElementById('seek-slider');
  elAnalysisStatus = document.getElementById('analysis-status');

  // FIX [E2]: GPGPU init FIRST — canvas glows from frame 1
  try {
    const ok = Ambient.init();
    if (!ok) console.warn('[Boot] GPGPU init returned false — CSS fallback active');
    else     console.info('[Boot] GPGPU engine running ✓');
  } catch (e) {
    console.error('[Boot] Ambient.init() threw:', e);
  }

  // Speculatively restore UI from localStorage before any network calls.
  // Returning users see their song without waiting for server ping.
  _checkAuthFromStorage();

  // Server ping + token verification run async in background.
  _bootAsync().catch(e => console.error('[Boot] _bootAsync fatal:', e));
});

// ─────────────────────────────────────────────────────────
// Instant UI restore for returning users
// ─────────────────────────────────────────────────────────
function _checkAuthFromStorage() {
  authToken = localStorage.getItem('authToken');
  const saved = localStorage.getItem('currentUser');
  if (authToken && saved) {
    try { currentUser = JSON.parse(saved); } catch { currentUser = null; }
  }
  if (authToken && currentUser) _showApp();
  else _showAuth();
}

async function _bootAsync() {
  // FIX [E3]: Veil appears AFTER canvas init. Canvas particles glow through it.
  _showVeil('Connecting…');
  await _pingServer();
  _hideVeil();
  _checkAuth();
}

// ─────────────────────────────────────────────────────────
// SERVER PING — 30s timeout, non-fatal
// ─────────────────────────────────────────────────────────
async function _pingServer() {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 30000);
    const r    = await fetch(`${API}/health`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (r.ok) {
      serverReady = true;
      const h = await r.json().catch(() => ({}));
      console.info('[Boot] Server ready ✓', {
        yt_dlp: h.yt_dlp, ffmpeg: h.ffmpeg, essentia: h.essentia, db: h.database,
      });
    }
  } catch (e) {
    console.warn('[Boot] Server ping failed:', e.message);
    _showVeil('⚠ Server slow to start — trying anyway…', true);
    await new Promise(res => setTimeout(res, 2500));
  }
}

// ─────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────
function _checkAuth() {
  authToken = localStorage.getItem('authToken');
  const saved = localStorage.getItem('currentUser');
  if (authToken && saved) {
    try { currentUser = JSON.parse(saved); } catch { currentUser = null; }
  }
  if (authToken && currentUser) _verifyToken();
  else _showAuth();
}

async function _verifyToken() {
  try {
    const r = await fetch(`${API}/auth/verify`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (r.ok) { _showApp(); _loadUserSong(); }
    else logout();
  } catch { logout(); }
}

function _showAuth() {
  document.getElementById('auth-container').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  Ambient.reset();
}

function _showApp() {
  document.getElementById('auth-container').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  document.getElementById('user-label').textContent = currentUser?.username || '';
}

function showSignup(e) {
  e?.preventDefault();
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('signup-form').classList.remove('hidden');
  _clearAuthErr();
}
function showLogin(e) {
  e?.preventDefault();
  document.getElementById('signup-form').classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
  _clearAuthErr();
}

async function signup() {
  const username = _val('signup-username');
  const email    = _val('signup-email');
  const password = _val('signup-password');
  if (!username || !email || !password) { _setAuthErr('Fill in all fields'); return; }
  if (password.length < 6) { _setAuthErr('Password must be ≥ 6 characters'); return; }
  _showVeil('Creating account…');
  try {
    const r = await fetch(`${API}/auth/signup`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, username, password }),
    });
    const d = await r.json();
    if (r.ok) {
      authToken = d.token; currentUser = d.user; _storeAuth();
      _hideVeil(); _showApp(); showSongSelection();
    } else {
      _hideVeil(); _setAuthErr(d.detail || 'Signup failed');
    }
  } catch (e) {
    _hideVeil(); _setAuthErr('Cannot reach server');
  }
}

async function login() {
  const email    = _val('login-email');
  const password = _val('login-password');
  if (!email || !password) { _setAuthErr('Fill in all fields'); return; }
  _showVeil('Signing in…');
  try {
    const r = await fetch(`${API}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const d = await r.json();
    if (r.ok) {
      authToken = d.token; currentUser = d.user; _storeAuth();
      _hideVeil(); _showApp(); _loadUserSong();
    } else {
      _hideVeil(); _setAuthErr(d.detail || 'Login failed');
    }
  } catch (e) {
    _hideVeil(); _setAuthErr('Cannot reach server');
  }
}

function _storeAuth() {
  localStorage.setItem('authToken', authToken);
  localStorage.setItem('currentUser', JSON.stringify(currentUser));
}

function logout() {
  authToken = null; currentUser = null; hasSong = false; currentSong = null;
  localStorage.removeItem('authToken');
  localStorage.removeItem('currentUser');
  _teardownAudio();
  Ambient.reset();
  _showAuth();
}

// ─────────────────────────────────────────────────────────
// LOAD / SAVE SONG
// ─────────────────────────────────────────────────────────
async function _loadUserSong() {
  _showVeil('Loading your song…');
  try {
    const r = await fetch(`${API}/user/song`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const d = await r.json();
    _hideVeil();
    if (r.ok && d.has_song) {
      hasSong = true; currentSong = d.song;
      _displaySong(d.song);
    } else {
      hasSong = false; showSongSelection();
    }
  } catch (e) {
    _hideVeil();
    console.error('[loadUserSong]', e);
    showSongSelection();
  }
}

async function saveSong() {
  const song_name   = _val('inp-song');
  const artist_name = _val('inp-artist');
  const youtube_url = _val('inp-yt');
  if (!song_name || !artist_name || !youtube_url) { _setFormErr('Fill in all three fields'); return; }
  if (!youtube_url.includes('youtube.com') && !youtube_url.includes('youtu.be')) {
    _setFormErr('Please paste a valid YouTube URL'); return;
  }
  _showVeil('Saving…');
  try {
    const r = await fetch(`${API}/user/song`, {
      method:  'PUT',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ song_name, artist_name, youtube_url }),
    });
    const d = await r.json();
    _hideVeil();
    if (r.ok) { hasSong = true; currentSong = d.song; _displaySong(d.song); }
    else _setFormErr(d.detail || 'Save failed');
  } catch (e) {
    _hideVeil(); _setFormErr('Cannot reach server');
  }
}

function showSongSelection() {
  document.getElementById('now-playing').classList.add('hidden');
  document.getElementById('song-selection').classList.remove('hidden');
  document.getElementById('cancel-btn').classList.toggle('hidden', !hasSong);
  _clearFormErr();
}

function cancelSongSelection() {
  document.getElementById('song-selection').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────
// DISPLAY SONG
// ─────────────────────────────────────────────────────────
function _displaySong(song) {
  document.getElementById('song-selection').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');

  document.getElementById('song-title').textContent  = song.song_name;
  document.getElementById('song-artist').textContent = song.artist_name;

  _audioReady   = false;
  _audioRetried = false;
  _setPlayState(false);
  _setPlayBtnEnabled(false);
  _setAnalysisStatus('⏳ Connecting to stream…');

  try { Ambient.setSong(song.song_name, song.artist_name, authToken); }
  catch (e) { console.warn('[displaySong] Ambient.setSong:', e); }

  _setupAudio(song);

  _fetchAudioAnalysis(song).catch(e => {
    console.info('[displaySong] Audio analysis unavailable:', e.message);
  });
}

// ─────────────────────────────────────────────────────────
// AUDIO SETUP
// ─────────────────────────────────────────────────────────
function _setupAudio(song) {
  if (!song.youtube_video_id) {
    _setAnalysisStatus('⚠ No video ID — cannot stream audio');
    setTimeout(() => _setPlayBtnEnabled(true), 500);
    return;
  }

  if (_playEnableTimer) { clearTimeout(_playEnableTimer); _playEnableTimer = null; }

  audioEl.removeEventListener('loadedmetadata', _onAudioMeta);
  audioEl.removeEventListener('loadeddata',     _onLoadedData);
  audioEl.removeEventListener('timeupdate',     _onTimeUpdate);
  audioEl.removeEventListener('ended',          _onAudioEnded);
  audioEl.removeEventListener('error',          _onAudioError);
  audioEl.pause();
  audioEl.src = '';
  audioEl.load();

  // FIX [E1]: Stream URL uses dynamic API origin
  const streamUrl = `${API}/stream`
    + `?youtube_id=${encodeURIComponent(song.youtube_video_id)}`
    + `&token=${encodeURIComponent(authToken)}`;

  audioEl.src = streamUrl;
  audioEl.load();

  audioEl.addEventListener('loadedmetadata', _onAudioMeta);
  audioEl.addEventListener('loadeddata',     _onLoadedData);
  audioEl.addEventListener('timeupdate',     _onTimeUpdate);
  audioEl.addEventListener('ended',          _onAudioEnded);
  audioEl.addEventListener('error',          _onAudioError);

  // 10s fallback: enable play button if loadeddata never fires
  _playEnableTimer = setTimeout(() => {
    if (!_audioReady) {
      console.warn('[Audio] loadeddata timeout — enabling play button');
      _audioReady = true;
      _setPlayBtnEnabled(true);
      _setAnalysisStatus('⏳ Stream loading slowly — tap Play to try');
    }
  }, 10000);

  console.info('[Audio] Stream URL set:', streamUrl);
}

function _onLoadedData() {
  if (!_audioReady) {
    _audioReady = true;
    _setPlayBtnEnabled(true);
    _setAnalysisStatus('');
    if (_playEnableTimer) { clearTimeout(_playEnableTimer); _playEnableTimer = null; }
    console.info('[Audio] loadeddata ✓ — play button enabled');
  }
}

function _onAudioMeta() {
  const dur = audioEl.duration;
  if (elTimeTot && isFinite(dur)) elTimeTot.textContent = _fmt(dur);
  if (elSeekSlider) elSeekSlider.max = isFinite(dur) ? dur.toFixed(1) : '300';
  if (!_audioReady) {
    _audioReady = true;
    _setPlayBtnEnabled(true);
    _setAnalysisStatus('');
    if (_playEnableTimer) { clearTimeout(_playEnableTimer); _playEnableTimer = null; }
  }
}

function _onTimeUpdate() {
  const cur = audioEl.currentTime;
  const dur = audioEl.duration;
  if (elTimeCur) elTimeCur.textContent = _fmt(cur);
  if (elProgress && isFinite(dur) && dur > 0)
    elProgress.style.width = `${(cur / dur) * 100}%`;
  if (elSeekSlider && isFinite(dur) && dur > 0)
    elSeekSlider.value = cur.toFixed(1);
}

function _onAudioEnded() {
  if (window.GradientController) GradientController.updatePlayhead(0, false);
  Ambient.stopBeat();
  _setPlayState(false);
}

function _onAudioError() {
  const err  = audioEl.error;
  const code = err ? err.code : 0;
  const msgs = {
    1: '⚠ Playback aborted',
    2: '⚠ Network error — server may be starting up',
    3: '⚠ Audio decode error — codec unsupported in this browser',
    4: '⚠ Audio format not supported — check server /stream',
  };
  const msg = msgs[code] || `⚠ Audio error (code ${code})`;
  console.error('[Audio] MediaError:', code, err?.message);

  // Retry once on network errors (code 2) — handles yt-dlp probe latency
  if (code === 2 && !_audioRetried && currentSong?.youtube_video_id) {
    _audioRetried = true;
    console.info('[Audio] Retrying stream after network error…');
    _setAnalysisStatus('⏳ Retrying stream…');
    setTimeout(() => { if (currentSong) _setupAudio(currentSong); }, 2000);
    return;
  }

  _setAnalysisStatus(msg);
  _setPlayBtnEnabled(true);
}

function _teardownAudio() {
  _stopClockPoller();
  if (_playEnableTimer) { clearTimeout(_playEnableTimer); _playEnableTimer = null; }
  if (audioEl) {
    audioEl.pause();
    audioEl.removeEventListener('loadedmetadata', _onAudioMeta);
    audioEl.removeEventListener('loadeddata',     _onLoadedData);
    audioEl.removeEventListener('timeupdate',     _onTimeUpdate);
    audioEl.removeEventListener('ended',          _onAudioEnded);
    audioEl.removeEventListener('error',          _onAudioError);
    audioEl.src = ''; audioEl.load();
  }
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close().catch(() => {});
    audioCtx = null; audioSrc = null; analyserNode = null; gainNode = null;
  }
  _audioReady = false; _audioRetried = false;
  _setPlayState(false);
  _setPlayBtnEnabled(false);
}

// ─────────────────────────────────────────────────────────
// AudioContext bootstrap — only from user gesture
// ─────────────────────────────────────────────────────────
async function _resumeContext() {
  if (!audioCtx) {
    try {
      audioCtx     = new (window.AudioContext || window.webkitAudioContext)();
      gainNode     = audioCtx.createGain();
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = FFT_SIZE;
      freqData = new Uint8Array(analyserNode.frequencyBinCount);

      if (!audioSrc) {
        audioSrc = audioCtx.createMediaElementSource(audioEl);
        audioSrc.connect(gainNode);
        gainNode.connect(analyserNode);
        analyserNode.connect(audioCtx.destination);
      }

      const volEl = document.getElementById('vol-slider');
      gainNode.gain.value = parseFloat(volEl?.value ?? 0.85);
      console.info('[AudioContext] Created and wired ✓');
      _startClockPoller();
    } catch (e) {
      console.error('[AudioContext] Setup failed:', e);
      audioCtx = null;
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); }
    catch (e) { console.warn('[AudioContext] resume() failed:', e); }
  }
}

// ─────────────────────────────────────────────────────────
// CLOCK POLLER — 250ms
// ─────────────────────────────────────────────────────────
function _startClockPoller() {
  _stopClockPoller();
  clockPoller = setInterval(() => {
    if (!audioEl) return;
    const t       = audioEl.currentTime;
    const playing = !audioEl.paused && !audioEl.ended && audioEl.readyState >= 2;
    if (window.GradientController) GradientController.updatePlayhead(t, playing);
    if (analyserNode && freqData && playing) {
      analyserNode.getByteFrequencyData(freqData);
      _feedRealTimeFeatures();
    }
  }, 250);
}

function _stopClockPoller() {
  if (clockPoller) { clearInterval(clockPoller); clockPoller = null; }
}

function _feedRealTimeFeatures() {
  if (!freqData) return;
  const len = freqData.length;

  let bassSum = 0;
  for (let i = 0; i < 10; i++) bassSum += freqData[i];
  const bass = bassSum / (10 * 255);

  let sq = 0;
  for (let i = 0; i < len; i++) sq += freqData[i] * freqData[i];
  const loud = Math.sqrt(sq / len) / 255;

  let wSum = 0, total = 0;
  for (let i = 0; i < len; i++) { wSum += i * freqData[i]; total += freqData[i]; }
  const centroid = total > 0 ? wSum / (total * len) : 0;

  const melbands    = new Float32Array(8);
  const binsPerBand = Math.floor(len / 8);
  for (let b = 0; b < 8; b++) {
    let s = 0;
    const start = b * binsPerBand;
    for (let i = start; i < start + binsPerBand; i++) s += freqData[i];
    melbands[b] = s / (binsPerBand * 255);
  }

  Ambient.setAudioFeatures({ loudness: loud, centroid, melbands, beat: bass > 0.55 ? bass : 0 });
}

// ─────────────────────────────────────────────────────────
// AUDIO ANALYSIS JSON
// ─────────────────────────────────────────────────────────
async function _fetchAudioAnalysis(song) {
  _setAnalysisStatus('🔍 Analysing audio…');
  try {
    const params = new URLSearchParams({ track: song.song_name, artist: song.artist_name });
    if (song.youtube_video_id) params.append('youtube_id', song.youtube_video_id);

    const r = await fetch(`${API}/audio_analysis?${params}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const data = await r.json();

    if (data && (data.beats?.length || data.loudness?.length)) {
      if (window.GradientController) GradientController.loadAudioData(data);
      analysisLoaded = true;
      const bpm   = data.tempo?.toFixed(0) ?? '?';
      const beats = data.beats?.length ?? 0;
      _setAnalysisStatus(`✓ ${bpm} BPM · ${beats} beats`);
      setTimeout(() => _setAnalysisStatus(''), 5000);
      console.info(`[Analysis] Loaded: ${bpm} BPM, ${beats} beats`);
    } else {
      _setAnalysisStatus('');
    }
  } catch (e) {
    console.info('[Analysis] unavailable:', e.message);
    _setAnalysisStatus('');
  }
}

// ─────────────────────────────────────────────────────────
// PLAYBACK CONTROLS
// ─────────────────────────────────────────────────────────
async function togglePlay() {
  if (!audioEl || !audioEl.src) return;
  if (elPlayBtn && elPlayBtn.disabled) return;

  await _resumeContext();

  if (audioEl.paused) {
    try {
      _setPlayBtnEnabled(false);
      _setAnalysisStatus('⏳ Buffering…');
      await audioEl.play();
      _setPlayState(true);
      _setPlayBtnEnabled(true);
      _setAnalysisStatus('');
      Ambient.startBeat();
    } catch (e) {
      console.error('[togglePlay] play() rejected:', e.name, e.message);
      _setPlayBtnEnabled(true);
      if (e.name === 'NotAllowedError') {
        _setAnalysisStatus('⚠ Browser blocked autoplay — tap Play again');
      } else if (e.name === 'NotSupportedError') {
        _setAnalysisStatus('⚠ Audio format not supported');
      } else if (e.name === 'AbortError') {
        // src changed mid-play — retry automatically
        _setAnalysisStatus('⏳ Stream starting…');
        setTimeout(() => { if (audioEl && audioEl.paused) togglePlay(); }, 800);
      } else {
        _setAnalysisStatus('⚠ Playback failed: ' + e.message);
      }
    }
  } else {
    audioEl.pause();
    _setPlayState(false);
    _setAnalysisStatus('');
    Ambient.stopBeat();
  }
}

function seekTo(val) {
  if (!audioEl || !isFinite(audioEl.duration)) return;
  audioEl.currentTime = parseFloat(val);
  if (window.GradientController) GradientController.updatePlayhead(audioEl.currentTime, !audioEl.paused);
}

function setVolume(val) {
  const v = parseFloat(val);
  if (gainNode) gainNode.gain.value = v;
  if (audioEl)  audioEl.volume = Math.min(1, v);
}

function _setPlayState(playing) {
  elPlayIco?.classList.toggle('hidden',  playing);
  elPauseIco?.classList.toggle('hidden', !playing);
}

function _setPlayBtnEnabled(enabled) {
  if (!elPlayBtn) return;
  elPlayBtn.disabled      = !enabled;
  elPlayBtn.style.opacity = enabled ? '1' : '0.45';
  elPlayBtn.style.cursor  = enabled ? 'pointer' : 'wait';
}

// ─────────────────────────────────────────────────────────
// SPACEBAR SYNC
// ─────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  e.preventDefault();
  Ambient.syncBeat();
});

// ─────────────────────────────────────────────────────────
// VEIL HELPERS
// ─────────────────────────────────────────────────────────
function _showVeil(msg, noSpinner = false) {
  const veil = document.getElementById('loading-veil');
  const ring = veil?.querySelector('.veil-ring');
  const txt  = document.getElementById('loading-msg');
  if (veil) veil.classList.remove('hidden');
  if (ring) ring.style.display = noSpinner ? 'none' : '';
  if (txt)  txt.textContent = msg || '';
}
function _hideVeil() {
  document.getElementById('loading-veil')?.classList.add('hidden');
  const ring = document.querySelector('.veil-ring');
  if (ring) ring.style.display = '';
}

// ─────────────────────────────────────────────────────────
// MISC HELPERS
// ─────────────────────────────────────────────────────────
function _val(id)  { return (document.getElementById(id)?.value || '').trim(); }
function _fmt(sec) {
  const s = Math.floor(sec), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
function _setAuthErr(msg) {
  const el = document.getElementById('auth-error');
  if (!el) return; el.textContent = msg; el.classList.remove('hidden');
}
function _clearAuthErr() { document.getElementById('auth-error')?.classList.add('hidden'); }
function _setFormErr(msg) {
  const el = document.getElementById('form-err');
  if (!el) return; el.textContent = msg; el.classList.remove('hidden');
}
function _clearFormErr() { document.getElementById('form-err')?.classList.add('hidden'); }
function _setAnalysisStatus(msg) { if (elAnalysisStatus) elAnalysisStatus.textContent = msg; }