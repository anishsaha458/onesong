/**
 * app.js — OneSong  v4.0  (Headless Audio Pivot)
 * ────────────────────────────────────────────────────────────
 * Boot sequence (each stage is try/catch isolated):
 *   1.  DOMContentLoaded → Ambient.init()   [GPGPU starts immediately]
 *   2.  pingServer()                         [wake Render.com cold start]
 *   3.  checkAuth()                          [JWT verify / show auth]
 *   4.  loadUserSong()                       [GET /user/song]
 *   5.  _setupAudio(streamUrl)               [<audio> + AudioContext + AnalyserNode]
 *   6.  _fetchAudioAnalysis(song)            [GET /audio_analysis → GradientController]
 *   7.  rAF AudioContext clock loop          [250ms sample → GradientController.updatePlayhead()]
 *
 * REMOVED: YouTube IFrame API (was causing init crashes)
 * REMOVED: Recommendations UI
 *
 * Master clock: audioContext.currentTime (replaces ytPlayer.getCurrentTime)
 * Audio source: https://onesong.onrender.com/stream?youtube_id=...
 *
 * The <audio> element is the only media player.
 * AudioContext analyses the raw PCM for real-time feature feedback
 * while the 60Hz JSON from /audio_analysis drives the deterministic sync.
 */

const API = 'https://onesong.onrender.com';

// ── Global state ──────────────────────────────────────────────
let authToken   = null;
let currentUser = null;
let hasSong     = false;
let currentSong = null;
let serverReady = false;

// ── Audio state ────────────────────────────────────────────────
let audioCtx      = null;   // AudioContext (created on first user gesture)
let audioSrc      = null;   // MediaElementSourceNode
let analyserNode  = null;   // AnalyserNode for real-time PCM analysis
let gainNode      = null;   // GainNode for volume
let audioEl       = null;   // <audio id="headless-audio">
let clockPoller   = null;   // setInterval handle — 250ms playhead poller
let analysisLoaded = false;

// rAF frequency analyser state
const FFT_SIZE  = 256;
let freqData    = null;   // Uint8Array for frequency bins

// ── DOM refs (cached after DOMContentLoaded) ──────────────────
let elPlayBtn, elPlayIco, elPauseIco, elProgress, elTimeCur, elTimeTot;
let elSeekSlider, elAnalysisStatus;

// ─────────────────────────────────────────────────────────────
// BOOT
// Order matters: GPGPU first, then server, then auth, then media.
// Each step is isolated so a failure in one doesn't black-screen the rest.
// ─────────────────────────────────────────────────────────────
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

  // STEP 1: Boot GPGPU — must happen before any await so THREE.js
  // starts its rAF loop immediately regardless of network state.
  try {
    Ambient.init();
    console.info('[Boot] GPGPU engine started');
  } catch(e) {
    console.error('[Boot] Ambient.init() failed:', e);
    // Non-fatal — page still shows UI, just no particle field
  }

  // STEP 2–3: Server ping + auth (async, don't block rAF)
  _bootAsync();
});

async function _bootAsync() {
  _showVeil('Waking up…');
  await _pingServer();
  _hideVeil();
  _checkAuth();
}

// ─────────────────────────────────────────────────────────────
// SERVER HEALTH PING (Render.com cold start can take 30–60s)
// ─────────────────────────────────────────────────────────────
async function _pingServer() {
  try {
    const ctrl = new AbortController();
    const tid   = setTimeout(() => ctrl.abort(), 65000);
    const r     = await fetch(`${API}/health`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (r.ok) { serverReady = true; console.info('[Boot] Server ready'); }
  } catch(e) {
    console.warn('[Boot] Server ping failed:', e.message);
    _showVeil('⚠ Server offline — refresh in 30s', true);
    await new Promise(res => setTimeout(res, 4000));
    _hideVeil();
  }
}

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────
function _checkAuth() {
  authToken   = localStorage.getItem('authToken');
  const saved = localStorage.getItem('currentUser');
  if (authToken && saved) {
    try { currentUser = JSON.parse(saved); } catch{ currentUser = null; }
  }
  if (authToken && currentUser) _verifyToken();
  else _showAuth();
}

async function _verifyToken() {
  try {
    const r = await fetch(`${API}/auth/verify`, {
      headers: { Authorization: `Bearer ${authToken}` }
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

// Public toggle helpers called from HTML onclick
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, password }),
    });
    const d = await r.json();
    if (r.ok) {
      authToken = d.token; currentUser = d.user; _storeAuth();
      _hideVeil(); _showApp(); showSongSelection();
    } else { _hideVeil(); _setAuthErr(d.detail || 'Signup failed'); }
  } catch(e) { _hideVeil(); _setAuthErr('Cannot reach server'); }
}

async function login() {
  const email    = _val('login-email');
  const password = _val('login-password');
  if (!email || !password) { _setAuthErr('Fill in all fields'); return; }
  _showVeil('Signing in…');
  try {
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const d = await r.json();
    if (r.ok) {
      authToken = d.token; currentUser = d.user; _storeAuth();
      _hideVeil(); _showApp(); _loadUserSong();
    } else { _hideVeil(); _setAuthErr(d.detail || 'Login failed'); }
  } catch(e) { _hideVeil(); _setAuthErr('Cannot reach server'); }
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

// ─────────────────────────────────────────────────────────────
// LOAD / SAVE SONG
// ─────────────────────────────────────────────────────────────
async function _loadUserSong() {
  _showVeil('Loading your song…');
  try {
    const r = await fetch(`${API}/user/song`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const d = await r.json();
    _hideVeil();
    if (r.ok && d.has_song) {
      hasSong = true; currentSong = d.song;
      _displaySong(d.song);
    } else {
      hasSong = false; showSongSelection();
    }
  } catch(e) {
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
      method: 'PUT',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ song_name, artist_name, youtube_url }),
    });
    const d = await r.json();
    _hideVeil();
    if (r.ok) { hasSong = true; currentSong = d.song; _displaySong(d.song); }
    else _setFormErr(d.detail || 'Save failed');
  } catch(e) { _hideVeil(); _setFormErr('Cannot reach server'); }
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

// ─────────────────────────────────────────────────────────────
// DISPLAY SONG
// The core pipeline: set identity → palette → audio → analysis
// Each stage is isolated — one failure must NOT break the others.
// ─────────────────────────────────────────────────────────────
function _displaySong(song) {
  // Reveal now-playing panel
  document.getElementById('song-selection').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');

  // Set identity text
  document.getElementById('song-title').textContent  = song.song_name;
  document.getElementById('song-artist').textContent = song.artist_name;

  // STAGE A: Mood-driven palette (non-blocking)
  try { Ambient.setSong(song.song_name, song.artist_name, authToken); }
  catch(e) { console.warn('[displaySong] Ambient.setSong:', e); }

  // STAGE B: Headless audio setup
  _setupAudio(song).catch(e => {
    console.warn('[displaySong] _setupAudio failed (non-fatal):', e);
    _setAnalysisStatus('Audio unavailable — visuals running on idle field');
  });

  // STAGE C: 60Hz audio analysis JSON (non-blocking)
  _fetchAudioAnalysis(song).catch(e => {
    console.info('[displaySong] Audio analysis not available:', e.message);
  });
}

// ─────────────────────────────────────────────────────────────
// HEADLESS AUDIO SETUP
//
// Flow:
//   1. Set <audio> src to /stream?youtube_id=...
//   2. On user gesture, create AudioContext and connect:
//        <audio> → MediaElementSource → GainNode → AnalyserNode → destination
//   3. Start clockPoller — every 250ms pushes audioContext.currentTime
//      to GradientController.updatePlayhead()
//
// Why not autoplay: browsers block AudioContext.resume() without gesture.
// The play button provides the gesture; _resumeContext() is called inside togglePlay().
// ─────────────────────────────────────────────────────────────
async function _setupAudio(song) {
  if (!song.youtube_video_id) {
    throw new Error('No youtube_video_id on song');
  }

  // Build stream URL — backend pipes yt-dlp audio through this endpoint
  const streamUrl = `${API}/stream?youtube_id=${encodeURIComponent(song.youtube_video_id)}&token=${encodeURIComponent(authToken)}`;

  // Set source on headless audio element
  audioEl.src = streamUrl;
  audioEl.load();

  // Event wiring
  audioEl.addEventListener('loadedmetadata', _onAudioMeta,  { once: true });
  audioEl.addEventListener('timeupdate',     _onTimeUpdate);
  audioEl.addEventListener('ended',          _onAudioEnded);
  audioEl.addEventListener('error',          _onAudioError);

  // Build AudioContext lazily — created on first togglePlay() gesture
  // so we don't trigger browser autoplay policy here
  _setAnalysisStatus('⏳ Buffering audio…');

  console.info('[Audio] Stream URL set:', streamUrl);
}

function _onAudioMeta() {
  const dur = audioEl.duration;
  if (elTimeTot && isFinite(dur)) elTimeTot.textContent = _fmt(dur);
  if (elSeekSlider) elSeekSlider.max = isFinite(dur) ? dur.toFixed(1) : '300';
  _setAnalysisStatus('');
}

function _onTimeUpdate() {
  const cur = audioEl.currentTime;
  const dur = audioEl.duration;

  if (elTimeCur) elTimeCur.textContent = _fmt(cur);
  if (elProgress && isFinite(dur) && dur > 0) {
    elProgress.style.width = `${(cur / dur) * 100}%`;
  }
  if (elSeekSlider && isFinite(dur) && dur > 0) {
    elSeekSlider.value = cur.toFixed(1);
  }
}

function _onAudioEnded() {
  GradientController.updatePlayhead(0, false);
  Ambient.stopBeat();
  _setPlayState(false);
}

function _onAudioError(e) {
  console.error('[Audio] Error:', e);
  _setAnalysisStatus('⚠ Stream error — check server logs');
}

function _teardownAudio() {
  _stopClockPoller();
  if (audioEl) {
    audioEl.pause();
    audioEl.removeEventListener('timeupdate', _onTimeUpdate);
    audioEl.removeEventListener('ended',      _onAudioEnded);
    audioEl.removeEventListener('error',      _onAudioError);
    audioEl.src = '';
    audioEl.load();
  }
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close().catch(() => {});
    audioCtx = null; audioSrc = null; analyserNode = null; gainNode = null;
  }
  _setPlayState(false);
}

// ─────────────────────────────────────────────────────────────
// AudioContext bootstrap — must be called from a user gesture
// ─────────────────────────────────────────────────────────────
async function _resumeContext() {
  if (!audioEl || !audioEl.src) return;

  // Create AudioContext on first call
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      gainNode     = audioCtx.createGain();
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = FFT_SIZE;
      freqData     = new Uint8Array(analyserNode.frequencyBinCount);

      // MediaElementSource bridges <audio> into the Web Audio graph
      audioSrc = audioCtx.createMediaElementSource(audioEl);
      audioSrc.connect(gainNode);
      gainNode.connect(analyserNode);
      analyserNode.connect(audioCtx.destination);

      gainNode.gain.value = parseFloat(
        document.getElementById('vol-slider')?.value ?? 0.85
      );

      console.info('[AudioContext] Created and connected');

      // Start 250ms master clock poller
      _startClockPoller();
    } catch(e) {
      console.error('[AudioContext] Setup failed:', e);
      audioCtx = null;
    }
  }

  // Resume if suspended (browser requires gesture each time)
  if (audioCtx && audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
}

// ─────────────────────────────────────────────────────────────
// MASTER CLOCK POLLER
// Every 250ms: push audioContext.currentTime → GradientController
// GradientController._lerp2() interpolates between 60Hz JSON frames,
// ambient.js.GradientController.frame(dt) handles per-render smoothing.
// ─────────────────────────────────────────────────────────────
function _startClockPoller() {
  _stopClockPoller();
  clockPoller = setInterval(() => {
    if (!audioCtx || !audioEl) return;
    const t = audioEl.currentTime;  // wall-clock position in the audio file
    const playing = !audioEl.paused && !audioEl.ended && audioEl.readyState >= 2;
    GradientController.updatePlayhead(t, playing);

    // Real-time frequency analysis (bonus: supplements the 60Hz JSON)
    if (analyserNode && freqData && playing) {
      analyserNode.getByteFrequencyData(freqData);
      _feedRealTimeFeatures();
    }
  }, 250);
}

function _stopClockPoller() {
  if (clockPoller) { clearInterval(clockPoller); clockPoller = null; }
}

// Real-time feature extraction from AnalyserNode frequency bins.
// This runs every 250ms in parallel with the GradientController timeline.
// It feeds Ambient.setAudioFeatures() directly for live responsiveness
// even before the 60Hz JSON has been parsed.
function _feedRealTimeFeatures() {
  if (!freqData) return;
  const len = freqData.length;

  // Bass: bins 0-10 (~0–860 Hz at 22050/128 Hz/bin)
  let bassSum = 0;
  for (let i = 0; i < 10; i++) bassSum += freqData[i];
  const bass = bassSum / (10 * 255);

  // Overall loudness: RMS of all bins
  let sq = 0;
  for (let i = 0; i < len; i++) sq += freqData[i] * freqData[i];
  const loud = Math.sqrt(sq / len) / 255;

  // Spectral centroid: weighted mean of frequency bins
  let wSum = 0, total = 0;
  for (let i = 0; i < len; i++) { wSum += i * freqData[i]; total += freqData[i]; }
  const centroid = total > 0 ? wSum / (total * len) : 0;

  // 8 mel-ish bands (linearly spaced across bins for simplicity)
  const melbands = new Float32Array(8);
  const binsPerBand = Math.floor(len / 8);
  for (let b = 0; b < 8; b++) {
    let s = 0;
    const start = b * binsPerBand;
    for (let i = start; i < start + binsPerBand; i++) s += freqData[i];
    melbands[b] = s / (binsPerBand * 255);
  }

  Ambient.setAudioFeatures({ loudness: loud, centroid, melbands, beat: bass > 0.55 ? bass : 0 });
}

// ─────────────────────────────────────────────────────────────
// AUDIO ANALYSIS JSON
// Fetches /audio_analysis → GradientController.loadAudioData()
// Provides the deterministic 60Hz timeline for beat/loudness sync.
// Non-blocking and non-fatal.
// ─────────────────────────────────────────────────────────────
async function _fetchAudioAnalysis(song) {
  _setAnalysisStatus('🔍 Analysing audio…');
  try {
    const url = `${API}/audio_analysis`
      + `?track=${encodeURIComponent(song.song_name)}`
      + `&artist=${encodeURIComponent(song.artist_name)}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const data = await r.json();

    if (data && (data.beats?.length || data.loudness?.length)) {
      GradientController.loadAudioData(data);
      analysisLoaded = true;
      _setAnalysisStatus(`✓ ${data.tempo?.toFixed(0)} BPM · ${data.beats?.length} beats`);
      setTimeout(() => _setAnalysisStatus(''), 4000);
    } else {
      _setAnalysisStatus('Visuals: live analysis mode');
    }
  } catch(e) {
    console.info('[Analysis] /audio_analysis unavailable:', e.message);
    _setAnalysisStatus('Visuals: live analysis mode');
  }
}

// ─────────────────────────────────────────────────────────────
// PLAYBACK CONTROLS
// ─────────────────────────────────────────────────────────────
async function togglePlay() {
  if (!audioEl || !audioEl.src) return;

  // AudioContext MUST be created/resumed inside a user gesture handler
  await _resumeContext();

  if (audioEl.paused) {
    try {
      await audioEl.play();
      _setPlayState(true);
      Ambient.startBeat();
    } catch(e) {
      console.error('[togglePlay] play() rejected:', e);
      _setAnalysisStatus('⚠ Playback blocked — tap again');
    }
  } else {
    audioEl.pause();
    _setPlayState(false);
    Ambient.stopBeat();
  }
}

function seekTo(val) {
  if (!audioEl || !isFinite(audioEl.duration)) return;
  const t = parseFloat(val);
  audioEl.currentTime = t;
  GradientController.updatePlayhead(t, !audioEl.paused);
}

function setVolume(val) {
  if (gainNode) gainNode.gain.value = parseFloat(val);
  else if (audioEl) audioEl.volume = parseFloat(val);
}

function _setPlayState(playing) {
  elPlayIco?.classList.toggle('hidden',  playing);
  elPauseIco?.classList.toggle('hidden', !playing);
}

// ─────────────────────────────────────────────────────────────
// SPACEBAR BEAT SYNC
// ─────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
  e.preventDefault();
  Ambient.syncBeat();
});

// ─────────────────────────────────────────────────────────────
// VEIL HELPERS
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// MISC HELPERS
// ─────────────────────────────────────────────────────────────
function _val(id) {
  return (document.getElementById(id)?.value || '').trim();
}
function _fmt(sec) {
  const s = Math.floor(sec), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}
function _setAuthErr(msg) {
  const el = document.getElementById('auth-error');
  if (!el) return; el.textContent = msg; el.classList.remove('hidden');
}
function _clearAuthErr() {
  document.getElementById('auth-error')?.classList.add('hidden');
}
function _setFormErr(msg) {
  const el = document.getElementById('form-err');
  if (!el) return; el.textContent = msg; el.classList.remove('hidden');
}
function _clearFormErr() {
  document.getElementById('form-err')?.classList.add('hidden');
}
function _setAnalysisStatus(msg) {
  if (elAnalysisStatus) elAnalysisStatus.textContent = msg;
}