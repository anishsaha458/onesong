/**
 * app.js — OneSong  v6.1
 * ─────────────────────────────────────────────────────────────
 * PATCHES vs v6.0
 * ───────────────
 * [U1] _onTimeUpdate() — progress bar uses transform:scaleX instead of
 *      width. Eliminates layout reflow on every timeupdate event (~60/sec).
 *      Requires .progress-fill to have transform-origin:left center (set
 *      in styles.css v2.0).
 *
 * [U2] _feedRealTimeFeatures() — calls window._setHudHighFreq(uHigh)
 *      after Ambient.setAudioFeatures(). This feeds the uHigh value into
 *      the progress-bar glow bridge defined in index.html, making the
 *      full-width progress track pulse with cymbal/hi-hat energy.
 *
 * All other logic identical to v6.0.
 */

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
let _playRetrying  = false;
let _playEnableTimer = null;

const FFT_SIZE = 2048;
let freqData   = null;

// ── Per-band smoothed state ────────────────────────────────
let _sBass = 0;
let _sMid  = 0;
let _sHigh = 0;

// ── Beat detection ─────────────────────────────────────────
let _prevBassRaw  = 0;
let _beatCooldown = 0;

// ── Running peak trackers ──────────────────────────────────
let _bassPeak = 0.01;
let _midPeak  = 0.01;
let _highPeak = 0.01;
const PEAK_DECAY = 0.9995;

// ── DOM refs ──────────────────────────────────────────────
let elPlayBtn, elPlayIco, elPauseIco, elProgress, elTimeCur, elTimeTot;
let elSeekSlider, elAnalysisStatus;

// ─────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  audioEl          = document.getElementById('headless-audio');
  elPlayBtn        = document.getElementById('play-btn');
  elPlayIco        = document.getElementById('ico-play');
  elPauseIco       = document.getElementById('ico-pause');
  elProgress       = document.getElementById('progress-fill');
  elTimeCur        = document.getElementById('time-cur');
  elTimeTot        = document.getElementById('time-tot');
  elSeekSlider     = document.getElementById('seek-slider');
  elAnalysisStatus = document.getElementById('analysis-status');

  try {
    const ok = Ambient.init();
    if (!ok) console.warn('[Boot] GPGPU init returned false — CSS fallback active');
    else     console.info('[Boot] GPGPU engine running ✓');
  } catch (e) {
    console.error('[Boot] Ambient.init() threw:', e);
  }

  _checkAuthFromStorage();
  _bootAsync().catch(e => console.error('[Boot] fatal:', e));
});

// ─────────────────────────────────────────────────────────
// Auth restore
// ─────────────────────────────────────────────────────────
function _checkAuthFromStorage() {
  authToken = localStorage.getItem('authToken');
  const saved = localStorage.getItem('currentUser');
  if (authToken && saved) {
    try { currentUser = JSON.parse(saved); } catch (e) { currentUser = null; }
  }
  if (authToken && currentUser) _showApp();
  else _showAuth();
}

async function _bootAsync() {
  _showVeil('CONNECTING');
  await _pingServer();
  _hideVeil();
  _checkAuth();
}

async function _pingServer() {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 30000);
    const r    = await fetch(`${API}/health`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (r.ok) {
      serverReady = true;
      const h = await r.json().catch(() => ({}));
      console.info('[Boot] Server ready ✓', { essentia: h.essentia, db: h.database });
    }
  } catch (e) {
    console.warn('[Boot] Server ping failed:', e.message);
    _showVeil('SERVER WAKING UP — ONE MOMENT', true);
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
    try { currentUser = JSON.parse(saved); } catch (e) { currentUser = null; }
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
  } catch (e) { logout(); }
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
  _showVeil('CREATING ACCOUNT');
  try {
    const r = await fetch(`${API}/auth/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, password }),
    });
    const d = await r.json();
    if (r.ok) {
      authToken = d.token; currentUser = d.user; _storeAuth();
      _hideVeil(); _showApp(); showSongSelection();
    } else { _hideVeil(); _setAuthErr(d.detail || 'Signup failed'); }
  } catch (e) { _hideVeil(); _setAuthErr('Cannot reach server'); }
}

async function login() {
  const email    = _val('login-email');
  const password = _val('login-password');
  if (!email || !password) { _setAuthErr('Fill in all fields'); return; }
  _showVeil('AUTHENTICATING');
  try {
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const d = await r.json();
    if (r.ok) {
      authToken = d.token; currentUser = d.user; _storeAuth();
      _hideVeil(); _showApp(); _loadUserSong();
    } else { _hideVeil(); _setAuthErr(d.detail || 'Login failed'); }
  } catch (e) { _hideVeil(); _setAuthErr('Cannot reach server'); }
}

function _storeAuth() {
  localStorage.setItem('authToken', authToken);
  localStorage.setItem('currentUser', JSON.stringify(currentUser));
}

function logout() {
  authToken = null; currentUser = null; hasSong = false; currentSong = null;
  localStorage.removeItem('authToken'); localStorage.removeItem('currentUser');
  _teardownAudio(); Ambient.reset(); _showAuth();
}

// ─────────────────────────────────────────────────────────
// LOAD SONG
// ─────────────────────────────────────────────────────────
async function _loadUserSong() {
  _showVeil('LOADING YOUR SONG');
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
    _hideVeil(); console.error('[loadUserSong]', e); showSongSelection();
  }
}

// ─────────────────────────────────────────────────────────
// SONG SELECTION
// ─────────────────────────────────────────────────────────
function showSongSelection() {
  document.getElementById('now-playing').classList.add('hidden');
  document.getElementById('song-selection').classList.remove('hidden');
  document.getElementById('cancel-btn').classList.toggle('hidden', !hasSong);
  _clearFormErr();
  _resetUploadUI();
}

function cancelSongSelection() {
  document.getElementById('song-selection').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');
}

function _resetUploadUI() {
  const fileInput = document.getElementById('inp-file');
  const fileLabel = document.getElementById('file-label');
  const barWrap   = document.getElementById('upload-bar-wrap');
  const bar       = document.getElementById('upload-bar');
  if (fileInput) fileInput.value = '';
  if (fileLabel) fileLabel.textContent = 'CHOOSE FILE';
  if (bar)       bar.style.width = '0%';
  if (barWrap)   barWrap.classList.add('hidden');
}

function onFileSelected(input) {
  const file  = input.files?.[0];
  if (!file) return;
  const label = document.getElementById('file-label');
  if (label) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    label.textContent = `${file.name}  (${mb} MB)`;
  }
}

async function saveSong() {
  const song_name   = _val('inp-song');
  const artist_name = _val('inp-artist');
  const fileInput   = document.getElementById('inp-file');
  const file        = fileInput?.files?.[0];

  if (!song_name)   { _setFormErr('Enter song name'); return; }
  if (!artist_name) { _setFormErr('Enter artist name'); return; }
  if (!file)        { _setFormErr('Choose an audio file'); return; }

  const allowed = ['.mp3','.wav','.flac','.ogg','.m4a','.aac','.opus','.weba'];
  const ext     = '.' + file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(ext)) {
    _setFormErr(`Unsupported format. Use: ${allowed.join(', ')}`); return;
  }
  if (file.size > 50 * 1024 * 1024) {
    _setFormErr('File must be under 50 MB'); return;
  }

  const barWrap = document.getElementById('upload-bar-wrap');
  const bar     = document.getElementById('upload-bar');
  if (barWrap) barWrap.classList.remove('hidden');
  if (bar)     bar.style.width = '0%';
  _clearFormErr();

  const form = new FormData();
  form.append('song_name',   song_name);
  form.append('artist_name', artist_name);
  form.append('file',        file);

  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/user/song/upload`);
    xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && bar)
        bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    };

    xhr.onload = () => {
      if (bar) bar.style.width = '100%';
      if (xhr.status >= 200 && xhr.status < 300) {
        const d = JSON.parse(xhr.responseText);
        hasSong = true; currentSong = d.song;
        setTimeout(() => { _displaySong(d.song); resolve(); }, 300);
      } else {
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).detail || msg; } catch (_) {}
        _setFormErr(msg);
        if (barWrap) barWrap.classList.add('hidden');
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => {
      _setFormErr('Upload failed — check your connection');
      if (barWrap) barWrap.classList.add('hidden');
      reject(new Error('Network error'));
    };
    xhr.send(form);
  }).catch(() => {});
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
  _playRetrying = false;
  _setPlayState(false);
  _setPlayBtnEnabled(false);
  _setAnalysisStatus('LOADING AUDIO');

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
  if (_playEnableTimer) { clearTimeout(_playEnableTimer); _playEnableTimer = null; }

  audioEl.removeEventListener('loadedmetadata', _onAudioMeta);
  audioEl.removeEventListener('loadeddata',     _onLoadedData);
  audioEl.removeEventListener('timeupdate',     _onTimeUpdate);
  audioEl.removeEventListener('ended',          _onAudioEnded);
  audioEl.removeEventListener('error',          _onAudioError);
  audioEl.pause();
  audioEl.src = '';
  audioEl.load();

  const uid       = currentUser?.id;
  const streamUrl = `${API}/stream/${uid}?token=${encodeURIComponent(authToken)}`;

  audioEl.crossOrigin = 'anonymous';
  audioEl.src         = streamUrl;
  audioEl.preload     = 'metadata';
  audioEl.load();

  audioEl.addEventListener('loadedmetadata', _onAudioMeta);
  audioEl.addEventListener('loadeddata',     _onLoadedData);
  audioEl.addEventListener('timeupdate',     _onTimeUpdate);
  audioEl.addEventListener('ended',          _onAudioEnded);
  audioEl.addEventListener('error',          _onAudioError);

  _playEnableTimer = setTimeout(() => {
    if (!_audioReady) {
      _audioReady = true;
      _setPlayBtnEnabled(true);
      _setAnalysisStatus('TAP PLAY TO START');
    }
  }, 12000);
}

function _onLoadedData() {
  if (!_audioReady) {
    _audioReady = true;
    _setPlayBtnEnabled(true);
    _setAnalysisStatus('');
    if (_playEnableTimer) { clearTimeout(_playEnableTimer); _playEnableTimer = null; }
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

// [U1] Progress bar uses transform:scaleX — zero layout reflow.
// .progress-fill must have transform-origin:left center (styles.css v2.0).
function _onTimeUpdate() {
  const cur = audioEl.currentTime, dur = audioEl.duration;
  if (elTimeCur) elTimeCur.textContent = _fmt(cur);
  if (elProgress && isFinite(dur) && dur > 0) {
    // [U1] scaleX instead of width — eliminates layout reflow at 60fps
    elProgress.style.transform = `scaleX(${cur / dur})`;
  }
  if (elSeekSlider && isFinite(dur) && dur > 0)
    elSeekSlider.value = cur.toFixed(1);
}

function _onAudioEnded() {
  if (window.GradientController) GradientController.updatePlayhead(0, false);
  Ambient.stopBeat();
  _setPlayState(false);
}

function _onAudioError() {
  const code = audioEl.error?.code || 0;
  const msgs = { 1:'PLAYBACK ABORTED', 2:'NETWORK ERROR', 3:'DECODE ERROR', 4:'FORMAT UNSUPPORTED' };
  console.error('[Audio] MediaError:', code, audioEl.error?.message);

  if (code === 2 && !_audioRetried && currentSong) {
    _audioRetried = true;
    _setAnalysisStatus('RETRYING');
    setTimeout(() => { if (currentSong) _setupAudio(currentSong); }, 2000);
    return;
  }
  _setAnalysisStatus(msgs[code] || `AUDIO ERROR (${code})`);
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
  if (audioCtx && audioCtx.state !== 'closed') audioCtx.close().catch(() => {});
  audioCtx = null; audioSrc = null; analyserNode = null; gainNode = null;
  _audioReady = false; _audioRetried = false; _playRetrying = false;
  _sBass = 0; _sMid = 0; _sHigh = 0; _prevBassRaw = 0; _beatCooldown = 0;
  _bassPeak = 0.01; _midPeak = 0.01; _highPeak = 0.01;
  _setPlayState(false); _setPlayBtnEnabled(false);
}

// ─────────────────────────────────────────────────────────
// AudioContext
// ─────────────────────────────────────────────────────────
async function _resumeContext() {
  if (!audioCtx) {
    try {
      audioCtx     = new (window.AudioContext || window.webkitAudioContext)();
      gainNode     = audioCtx.createGain();
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = FFT_SIZE;
      analyserNode.smoothingTimeConstant = 0.0;
      freqData = new Uint8Array(analyserNode.frequencyBinCount);

      const volEl = document.getElementById('vol-slider');
      gainNode.gain.value = parseFloat(volEl?.value ?? 0.85);

      _startClockPoller();
    } catch (e) {
      console.error('[AudioContext] Setup failed:', e);
      audioCtx = null; return;
    }
  }

  if (audioCtx && !audioSrc) {
    try {
      audioSrc = audioCtx.createMediaElementSource(audioEl);
      audioSrc.connect(gainNode);
      gainNode.connect(analyserNode);
      analyserNode.connect(audioCtx.destination);
    } catch (e) {
      console.warn('[AudioContext] createMediaElementSource:', e.message);
    }
  }

  if (audioCtx?.state === 'suspended') await audioCtx.resume();
}

// ─────────────────────────────────────────────────────────
// CLOCK POLLER — 16ms
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
  }, 16);
}

function _stopClockPoller() {
  if (clockPoller) { clearInterval(clockPoller); clockPoller = null; }
}

// ─────────────────────────────────────────────────────────
// AUDIO FEATURE EXTRACTION
// ─────────────────────────────────────────────────────────
function _feedRealTimeFeatures() {
  if (!freqData || freqData.length === 0) return;
  const len = freqData.length;

  // BASS: bins 0–2 (~0–86Hz)
  let bassSum = 0;
  for (let i = 0; i <= 2; i++) bassSum += freqData[i];
  const bassRaw = bassSum / (3 * 255);

  // MID: bins 9–46 (~387–1980Hz)
  let midSum = 0;
  for (let i = 9; i <= 46; i++) midSum += freqData[i];
  const midRaw = midSum / (38 * 255);

  // HIGH: bins 116–255 (~4996–10977Hz)
  let highSum = 0;
  for (let i = 116; i <= 255; i++) highSum += freqData[i];
  const highRaw = highSum / (140 * 255);

  // Running peaks
  _bassPeak = Math.max(0.01, Math.max(_bassPeak * PEAK_DECAY, bassRaw));
  _midPeak  = Math.max(0.01, Math.max(_midPeak  * PEAK_DECAY, midRaw));
  _highPeak = Math.max(0.01, Math.max(_highPeak * PEAK_DECAY, highRaw));

  // Normalize
  const bassNorm = Math.min(bassRaw / _bassPeak, 1.0);
  const midNorm  = Math.min(midRaw  / _midPeak,  1.0);
  const highNorm = Math.min(highRaw / _highPeak,  1.0);

  // Asymmetric lerping
  const uBass = bassNorm;
  _sMid  += (midNorm  - _sMid)  * 0.12;
  _sHigh += (highNorm - _sHigh) * 0.20;
  const uMid  = _sMid;
  const uHigh = _sHigh;

  // Full-band RMS
  let sq = 0;
  for (let i = 0; i < len; i++) sq += freqData[i] * freqData[i];
  const loud = Math.sqrt(sq / len) / 255;

  // Spectral centroid
  let wSum = 0, total = 0;
  for (let i = 0; i < len; i++) { wSum += i * freqData[i]; total += freqData[i]; }
  const centroid = total > 0 ? wSum / (total * len) : 0;

  // 8-band mel
  const melbands = new Float32Array(8);
  const logStart = Math.log(1), logEnd = Math.log(len);
  for (let b = 0; b < 8; b++) {
    const lo = Math.floor(Math.exp(logStart + (logEnd - logStart) * (b / 8)));
    const hi = Math.floor(Math.exp(logStart + (logEnd - logStart) * ((b + 1) / 8)));
    let s = 0, count = 0;
    for (let i = lo; i <= Math.min(hi, len - 1); i++) { s += freqData[i]; count++; }
    melbands[b] = count > 0 ? s / (count * 255) : 0;
  }

  // Beat detection
  _beatCooldown = Math.max(0, _beatCooldown - 1);
  const bassRiseNorm = uBass - _prevBassRaw;
  const beatFired    = _beatCooldown === 0
                    && bassRiseNorm > 0.10
                    && uBass > 0.90;
  if (beatFired) _beatCooldown = 12;
  _prevBassRaw = uBass;

  // Send to Ambient
  Ambient.setAudioFeatures({
    loudness: loud,
    centroid,
    melbands,
    beat:    beatFired ? uBass : 0,
    uBass,
    uMid,
    uHigh,
    freqData,
  });

  // [U2] Feed uHigh to HUD progress glow bridge (index.html inline script)
  if (window._setHudHighFreq) window._setHudHighFreq(uHigh);
}

// ─────────────────────────────────────────────────────────
// AUDIO ANALYSIS (Essentia JSON)
// ─────────────────────────────────────────────────────────
async function _fetchAudioAnalysis(song) {
  _setAnalysisStatus('ANALYSING');
  try {
    const params = new URLSearchParams({ track: song.song_name, artist: song.artist_name });
    const r = await fetch(`${API}/audio_analysis?${params}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!r.ok) throw new Error(`${r.status}`);
    const data = await r.json();

    if (data && (data.beats?.length || data.loudness?.length)) {
      if (window.GradientController) GradientController.loadAudioData(data);
      analysisLoaded = true;
      const bpm = data.tempo?.toFixed(0) ?? '?';
      _setAnalysisStatus(`${bpm} BPM · ${data.beats?.length ?? 0} BEATS`);
      setTimeout(() => _setAnalysisStatus(''), 4000);
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
  if (!audioEl?.src || elPlayBtn?.disabled) return;
  await _resumeContext();

  if (audioEl.paused) {
    try {
      _setPlayBtnEnabled(false);
      _setAnalysisStatus('BUFFERING');
      await audioEl.play();
      _playRetrying = false;
      _setPlayState(true);
      _setPlayBtnEnabled(true);
      _setAnalysisStatus('');
      Ambient.startBeat();
    } catch (e) {
      _setPlayBtnEnabled(true);
      if (e.name === 'NotAllowedError') {
        _setAnalysisStatus('TAP PLAY AGAIN TO START');
      } else if (e.name === 'NotSupportedError') {
        _setAnalysisStatus('FORMAT NOT SUPPORTED');
      } else if (e.name === 'AbortError' && !_playRetrying) {
        _playRetrying = true;
        _setAnalysisStatus('STREAM STARTING');
        setTimeout(() => { _playRetrying = false; if (audioEl?.paused) togglePlay(); }, 1000);
      } else {
        _setAnalysisStatus('ERROR: ' + e.message);
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
  if (window.GradientController)
    GradientController.updatePlayhead(audioEl.currentTime, !audioEl.paused);
}

function setVolume(val) {
  const v = parseFloat(val);
  if (gainNode) gainNode.gain.value = v;
  if (audioEl)  audioEl.volume = Math.min(1, v);
}

function _setPlayState(playing) {
  elPlayIco?.classList.toggle('hidden',  playing);
  elPauseIco?.classList.toggle('hidden', !playing);
  document.body.classList.toggle('is-playing', playing);
}

function _setPlayBtnEnabled(enabled) {
  if (!elPlayBtn) return;
  elPlayBtn.disabled      = !enabled;
  elPlayBtn.style.opacity = enabled ? '1' : '0.35';
  elPlayBtn.style.cursor  = enabled ? 'pointer' : 'wait';
}

// ─────────────────────────────────────────────────────────
// SPACEBAR — manual beat sync
// ─────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
  e.preventDefault();
  Ambient.syncBeat();
});

// ─────────────────────────────────────────────────────────
// VEIL
// ─────────────────────────────────────────────────────────
function _showVeil(msg, noSpinner = false) {
  const veil = document.getElementById('loading-veil');
  const ring = veil?.querySelector('.veil-scanner');
  const txt  = document.getElementById('loading-msg');
  if (veil) veil.classList.remove('hidden');
  if (ring) ring.style.display = noSpinner ? 'none' : '';
  if (txt)  txt.textContent = msg || '';
}
function _hideVeil() {
  document.getElementById('loading-veil')?.classList.add('hidden');
  const ring = document.querySelector('.veil-scanner');
  if (ring) ring.style.display = '';
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
function _val(id) { return (document.getElementById(id)?.value || '').trim(); }
function _fmt(sec) {
  if (!sec || !isFinite(sec)) return '0:00';
  const s = Math.floor(sec), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
function _setAuthErr(msg) {
  const el = document.getElementById('auth-error');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function _clearAuthErr() { document.getElementById('auth-error')?.classList.add('hidden'); }
function _setFormErr(msg) {
  const el = document.getElementById('form-err');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function _clearFormErr() { document.getElementById('form-err')?.classList.add('hidden'); }
function _setAnalysisStatus(msg) { if (elAnalysisStatus) elAnalysisStatus.textContent = msg; }