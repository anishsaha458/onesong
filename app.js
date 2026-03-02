/**
 * app.js — OneSong  v4.1  (Robust Audio + GPGPU Boot)
 * ────────────────────────────────────────────────────────────
 * KEY FIXES vs v4.0:
 *
 *  [1] AudioContext creation moved entirely into togglePlay() gesture handler.
 *      No AudioContext is ever created outside a user gesture, preventing
 *      the "AudioContext was not allowed to start" DOMException.
 *
 *  [2] _setupAudio() is now synchronous setup only — it sets audioEl.src
 *      and wires event listeners. The AudioContext graph is built lazily
 *      inside _resumeContext() which is only called from togglePlay().
 *
 *  [3] CORS on /stream: token passed as query param (can't set Authorization
 *      header on <audio src>). The <audio> element uses crossorigin="anonymous"
 *      which tells the browser to send a CORS preflight — the backend must
 *      return Access-Control-Allow-Origin: * on the /stream route.
 *      crossorigin="anonymous" is the correct attribute for this pattern.
 *
 *  [4] Ambient.init() is now the VERY FIRST thing — called synchronously
 *      inside DOMContentLoaded before any async code. GPGPU loop starts
 *      on its internal clock immediately and is never blocked by auth/audio.
 *
 *  [5] _bootAsync() failure is fully isolated — a server timeout or auth
 *      failure cannot reach Ambient.init()'s rAF loop.
 *
 *  [6] Play button state machine: loading → playing → paused. The button
 *      is disabled while the stream is buffering to prevent double-taps.
 *
 *  [7] AudioContext graph is built only once — subsequent togglePlay() calls
 *      reuse the existing context and just call play()/pause() on audioEl.
 *
 *  [8] Volume slider falls back to audioEl.volume if gainNode not ready,
 *      so volume works even before first play.
 */

const API = 'https://onesong.onrender.com';

// ── Global state ──────────────────────────────────────────
let authToken   = null;
let currentUser = null;
let hasSong     = false;
let currentSong = null;
let serverReady = false;

// ── Audio state ───────────────────────────────────────────
let audioCtx      = null;
let audioSrc      = null;
let analyserNode  = null;
let gainNode      = null;
let audioEl       = null;
let clockPoller   = null;
let analysisLoaded = false;
let _audioReady   = false; // true once loadedmetadata fires

const FFT_SIZE = 256;
let freqData   = null;

// ── DOM refs ──────────────────────────────────────────────
let elPlayBtn, elPlayIco, elPauseIco, elProgress, elTimeCur, elTimeTot;
let elSeekSlider, elAnalysisStatus;

// ─────────────────────────────────────────────────────────
// BOOT — GPGPU FIRST, everything else async
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

  // FIX [4]: GPGPU starts immediately — synchronous, no await, no network
  // The rAF loop runs on its idle clock from frame 1 regardless of what
  // happens next. A failed init() returns false but does NOT throw.
  try {
    const gpuOk = Ambient.init();
    if(!gpuOk) console.warn('[Boot] GPGPU init returned false — CSS fallback active');
    else        console.info('[Boot] GPGPU engine started ✓');
  } catch(e) {
    console.error('[Boot] Ambient.init() threw:', e);
    // Non-fatal — page still shows UI
  }

  // FIX [5]: all network + auth work is fully isolated in async function
  _bootAsync().catch(e => console.error('[Boot] _bootAsync fatal:', e));
});

async function _bootAsync(){
  _showVeil('Waking up…');
  await _pingServer();
  _hideVeil();
  _checkAuth();
}

// ─────────────────────────────────────────────────────────
// SERVER PING
// ─────────────────────────────────────────────────────────
async function _pingServer(){
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 65000);
    const r    = await fetch(`${API}/health`, { signal: ctrl.signal });
    clearTimeout(tid);
    if(r.ok){ serverReady = true; console.info('[Boot] Server ready ✓'); }
  } catch(e){
    console.warn('[Boot] Server ping failed:', e.message);
    _showVeil('⚠ Server offline — refresh in 30s', true);
    await new Promise(res => setTimeout(res, 4000));
    _hideVeil();
  }
}

// ─────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────
function _checkAuth(){
  authToken = localStorage.getItem('authToken');
  const saved = localStorage.getItem('currentUser');
  if(authToken && saved){
    try { currentUser = JSON.parse(saved); } catch{ currentUser = null; }
  }
  if(authToken && currentUser) _verifyToken();
  else _showAuth();
}

async function _verifyToken(){
  try {
    const r = await fetch(`${API}/auth/verify`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    if(r.ok){ _showApp(); _loadUserSong(); }
    else logout();
  } catch { logout(); }
}

function _showAuth(){
  document.getElementById('auth-container').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  Ambient.reset();
}

function _showApp(){
  document.getElementById('auth-container').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  document.getElementById('user-label').textContent = currentUser?.username || '';
}

function showSignup(e){
  e?.preventDefault();
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('signup-form').classList.remove('hidden');
  _clearAuthErr();
}
function showLogin(e){
  e?.preventDefault();
  document.getElementById('signup-form').classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
  _clearAuthErr();
}

async function signup(){
  const username = _val('signup-username');
  const email    = _val('signup-email');
  const password = _val('signup-password');
  if(!username || !email || !password){ _setAuthErr('Fill in all fields'); return; }
  if(password.length < 6){ _setAuthErr('Password must be ≥ 6 characters'); return; }
  _showVeil('Creating account…');
  try {
    const r = await fetch(`${API}/auth/signup`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, username, password }),
    });
    const d = await r.json();
    if(r.ok){
      authToken = d.token; currentUser = d.user; _storeAuth();
      _hideVeil(); _showApp(); showSongSelection();
    } else { _hideVeil(); _setAuthErr(d.detail || 'Signup failed'); }
  } catch(e){ _hideVeil(); _setAuthErr('Cannot reach server'); }
}

async function login(){
  const email    = _val('login-email');
  const password = _val('login-password');
  if(!email || !password){ _setAuthErr('Fill in all fields'); return; }
  _showVeil('Signing in…');
  try {
    const r = await fetch(`${API}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const d = await r.json();
    if(r.ok){
      authToken = d.token; currentUser = d.user; _storeAuth();
      _hideVeil(); _showApp(); _loadUserSong();
    } else { _hideVeil(); _setAuthErr(d.detail || 'Login failed'); }
  } catch(e){ _hideVeil(); _setAuthErr('Cannot reach server'); }
}

function _storeAuth(){
  localStorage.setItem('authToken', authToken);
  localStorage.setItem('currentUser', JSON.stringify(currentUser));
}

function logout(){
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
async function _loadUserSong(){
  _showVeil('Loading your song…');
  try {
    const r = await fetch(`${API}/user/song`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const d = await r.json();
    _hideVeil();
    if(r.ok && d.has_song){
      hasSong = true; currentSong = d.song;
      _displaySong(d.song);
    } else {
      hasSong = false; showSongSelection();
    }
  } catch(e){
    _hideVeil();
    console.error('[loadUserSong]', e);
    showSongSelection();
  }
}

async function saveSong(){
  const song_name   = _val('inp-song');
  const artist_name = _val('inp-artist');
  const youtube_url = _val('inp-yt');
  if(!song_name || !artist_name || !youtube_url){ _setFormErr('Fill in all three fields'); return; }
  if(!youtube_url.includes('youtube.com') && !youtube_url.includes('youtu.be')){
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
    if(r.ok){ hasSong = true; currentSong = d.song; _displaySong(d.song); }
    else _setFormErr(d.detail || 'Save failed');
  } catch(e){ _hideVeil(); _setFormErr('Cannot reach server'); }
}

function showSongSelection(){
  document.getElementById('now-playing').classList.add('hidden');
  document.getElementById('song-selection').classList.remove('hidden');
  document.getElementById('cancel-btn').classList.toggle('hidden', !hasSong);
  _clearFormErr();
}

function cancelSongSelection(){
  document.getElementById('song-selection').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────
// DISPLAY SONG — isolated pipeline
// ─────────────────────────────────────────────────────────
function _displaySong(song){
  document.getElementById('song-selection').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');

  document.getElementById('song-title').textContent  = song.song_name;
  document.getElementById('song-artist').textContent = song.artist_name;

  // Reset play state UI
  _audioReady = false;
  _setPlayState(false);
  _setPlayBtnEnabled(false);

  // STAGE A: palette (non-blocking, non-fatal)
  try { Ambient.setSong(song.song_name, song.artist_name, authToken); }
  catch(e){ console.warn('[displaySong] Ambient.setSong:', e); }

  // STAGE B: wire up headless audio element (synchronous, no AudioContext yet)
  // FIX [2]: _setupAudio is now purely synchronous — sets src + event listeners
  _setupAudio(song);

  // STAGE C: 60Hz analysis JSON (non-blocking, non-fatal)
  _fetchAudioAnalysis(song).catch(e => {
    console.info('[displaySong] Audio analysis not available:', e.message);
  });
}

// ─────────────────────────────────────────────────────────
// HEADLESS AUDIO SETUP (SYNCHRONOUS — no AudioContext here)
//
// FIX [3]: crossorigin="anonymous" is set in HTML so the browser sends CORS
// headers. The backend /stream route must return Access-Control-Allow-Origin: *
// The token is passed as a query parameter because <audio src> cannot carry
// an Authorization header.
// ─────────────────────────────────────────────────────────
function _setupAudio(song){
  if(!song.youtube_video_id){
    _setAnalysisStatus('⚠ No video ID — cannot stream audio');
    return;
  }

  // Remove stale listeners before reassigning src
  audioEl.removeEventListener('loadedmetadata', _onAudioMeta);
  audioEl.removeEventListener('timeupdate',     _onTimeUpdate);
  audioEl.removeEventListener('ended',          _onAudioEnded);
  audioEl.removeEventListener('error',          _onAudioError);
  audioEl.removeEventListener('canplaythrough', _onCanPlayThrough);

  // Build stream URL — token in query string (CORS-safe for <audio> src)
  const streamUrl = `${API}/stream`
    + `?youtube_id=${encodeURIComponent(song.youtube_video_id)}`
    + `&token=${encodeURIComponent(authToken)}`;

  audioEl.src  = streamUrl;
  audioEl.load();

  // Re-attach listeners
  audioEl.addEventListener('loadedmetadata',  _onAudioMeta);
  audioEl.addEventListener('timeupdate',      _onTimeUpdate);
  audioEl.addEventListener('ended',           _onAudioEnded);
  audioEl.addEventListener('error',           _onAudioError);
  audioEl.addEventListener('canplaythrough',  _onCanPlayThrough);

  _setAnalysisStatus('⏳ Buffering audio…');
  console.info('[Audio] Stream URL set:', streamUrl);
}

function _onCanPlayThrough(){
  // Audio is buffered enough to play — enable the play button
  _audioReady = true;
  _setPlayBtnEnabled(true);
  _setAnalysisStatus('');
}

function _onAudioMeta(){
  const dur = audioEl.duration;
  if(elTimeTot && isFinite(dur)) elTimeTot.textContent = _fmt(dur);
  if(elSeekSlider) elSeekSlider.max = isFinite(dur) ? dur.toFixed(1) : '300';
  // Enable play button as soon as we have metadata (don't wait for canplaythrough)
  _audioReady = true;
  _setPlayBtnEnabled(true);
  _setAnalysisStatus('');
}

function _onTimeUpdate(){
  const cur = audioEl.currentTime;
  const dur = audioEl.duration;
  if(elTimeCur) elTimeCur.textContent = _fmt(cur);
  if(elProgress && isFinite(dur) && dur > 0)
    elProgress.style.width = `${(cur / dur) * 100}%`;
  if(elSeekSlider && isFinite(dur) && dur > 0)
    elSeekSlider.value = cur.toFixed(1);
}

function _onAudioEnded(){
  if(window.GradientController) GradientController.updatePlayhead(0, false);
  Ambient.stopBeat();
  _setPlayState(false);
}

function _onAudioError(e){
  const code = audioEl.error ? audioEl.error.code : '?';
  console.error('[Audio] MediaError code:', code, e);
  // Error codes: 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED
  if(code === 2){
    _setAnalysisStatus('⚠ Network error streaming audio — check server CORS');
  } else if(code === 4){
    _setAnalysisStatus('⚠ Audio format not supported by browser');
  } else {
    _setAnalysisStatus('⚠ Stream error (code ' + code + ')');
  }
  _setPlayBtnEnabled(false);
}

function _teardownAudio(){
  _stopClockPoller();
  if(audioEl){
    audioEl.pause();
    audioEl.removeEventListener('loadedmetadata',  _onAudioMeta);
    audioEl.removeEventListener('timeupdate',      _onTimeUpdate);
    audioEl.removeEventListener('ended',           _onAudioEnded);
    audioEl.removeEventListener('error',           _onAudioError);
    audioEl.removeEventListener('canplaythrough',  _onCanPlayThrough);
    audioEl.src = '';
    audioEl.load();
  }
  if(audioCtx && audioCtx.state !== 'closed'){
    audioCtx.close().catch(() => {});
    audioCtx = null; audioSrc = null; analyserNode = null; gainNode = null;
  }
  _audioReady = false;
  _setPlayState(false);
  _setPlayBtnEnabled(false);
}

// ─────────────────────────────────────────────────────────
// AudioContext bootstrap
// FIX [1]: ONLY called from togglePlay() — a confirmed user gesture.
// Safe to call multiple times — idempotent.
// ─────────────────────────────────────────────────────────
async function _resumeContext(){
  // Build AudioContext graph exactly once
  if(!audioCtx){
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      gainNode     = audioCtx.createGain();
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = FFT_SIZE;
      freqData     = new Uint8Array(analyserNode.frequencyBinCount);

      // FIX [7]: createMediaElementSource can only be called once per element.
      // Guard against duplicate calls.
      if(!audioSrc){
        audioSrc = audioCtx.createMediaElementSource(audioEl);
        audioSrc.connect(gainNode);
        gainNode.connect(analyserNode);
        analyserNode.connect(audioCtx.destination);
      }

      const volEl = document.getElementById('vol-slider');
      gainNode.gain.value = parseFloat(volEl?.value ?? 0.85);

      console.info('[AudioContext] Created and wired ✓');
      _startClockPoller();
    } catch(e){
      console.error('[AudioContext] Setup failed:', e);
      // Non-fatal — audio plays without analyser if AudioContext fails
      audioCtx = null;
    }
  }

  // Resume if suspended (browser suspends on background tab etc.)
  if(audioCtx && audioCtx.state === 'suspended'){
    try { await audioCtx.resume(); }
    catch(e){ console.warn('[AudioContext] resume() failed:', e); }
  }
}

// ─────────────────────────────────────────────────────────
// CLOCK POLLER — 250ms, pushes playhead to GradientController
// ─────────────────────────────────────────────────────────
function _startClockPoller(){
  _stopClockPoller();
  clockPoller = setInterval(() => {
    if(!audioEl) return;
    const t = audioEl.currentTime;
    const playing = !audioEl.paused && !audioEl.ended && audioEl.readyState >= 2;
    if(window.GradientController) GradientController.updatePlayhead(t, playing);

    if(analyserNode && freqData && playing){
      analyserNode.getByteFrequencyData(freqData);
      _feedRealTimeFeatures();
    }
  }, 250);
}

function _stopClockPoller(){
  if(clockPoller){ clearInterval(clockPoller); clockPoller = null; }
}

function _feedRealTimeFeatures(){
  if(!freqData) return;
  const len = freqData.length;

  let bassSum = 0;
  for(let i = 0; i < 10; i++) bassSum += freqData[i];
  const bass = bassSum / (10 * 255);

  let sq = 0;
  for(let i = 0; i < len; i++) sq += freqData[i] * freqData[i];
  const loud = Math.sqrt(sq / len) / 255;

  let wSum = 0, total = 0;
  for(let i = 0; i < len; i++){ wSum += i * freqData[i]; total += freqData[i]; }
  const centroid = total > 0 ? wSum / (total * len) : 0;

  const melbands = new Float32Array(8);
  const binsPerBand = Math.floor(len / 8);
  for(let b = 0; b < 8; b++){
    let s = 0;
    const start = b * binsPerBand;
    for(let i = start; i < start + binsPerBand; i++) s += freqData[i];
    melbands[b] = s / (binsPerBand * 255);
  }

  Ambient.setAudioFeatures({ loudness: loud, centroid, melbands, beat: bass > 0.55 ? bass : 0 });
}

// ─────────────────────────────────────────────────────────
// AUDIO ANALYSIS JSON
// ─────────────────────────────────────────────────────────
async function _fetchAudioAnalysis(song){
  _setAnalysisStatus('🔍 Analysing audio…');
  try {
    const url = `${API}/audio_analysis`
      + `?track=${encodeURIComponent(song.song_name)}`
      + `&artist=${encodeURIComponent(song.artist_name)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const data = await r.json();

    if(data && (data.beats?.length || data.loudness?.length)){
      if(window.GradientController) GradientController.loadAudioData(data);
      analysisLoaded = true;
      _setAnalysisStatus(`✓ ${data.tempo?.toFixed(0)} BPM · ${data.beats?.length} beats`);
      setTimeout(() => _setAnalysisStatus(''), 4000);
    } else {
      _setAnalysisStatus('Visuals: live analysis mode');
    }
  } catch(e){
    console.info('[Analysis] unavailable:', e.message);
    _setAnalysisStatus('Visuals: live analysis mode');
  }
}

// ─────────────────────────────────────────────────────────
// PLAYBACK CONTROLS
// FIX [6]: play button disabled while buffering
// ─────────────────────────────────────────────────────────
async function togglePlay(){
  if(!audioEl || !audioEl.src || audioEl.src === location.href) return;
  if(elPlayBtn && elPlayBtn.disabled) return;

  // FIX [1]: AudioContext MUST be created inside user gesture
  await _resumeContext();

  if(audioEl.paused){
    try {
      _setPlayBtnEnabled(false);
      await audioEl.play();
      _setPlayState(true);
      _setPlayBtnEnabled(true);
      Ambient.startBeat();
    } catch(e){
      console.error('[togglePlay] play() rejected:', e.name, e.message);
      _setPlayBtnEnabled(true);
      if(e.name === 'NotAllowedError'){
        _setAnalysisStatus('⚠ Playback blocked by browser — tap Play again');
      } else if(e.name === 'NotSupportedError'){
        _setAnalysisStatus('⚠ Audio format unsupported — check server codec');
      } else {
        _setAnalysisStatus('⚠ Playback failed: ' + e.message);
      }
    }
  } else {
    audioEl.pause();
    _setPlayState(false);
    Ambient.stopBeat();
  }
}

function seekTo(val){
  if(!audioEl || !isFinite(audioEl.duration)) return;
  const t = parseFloat(val);
  audioEl.currentTime = t;
  if(window.GradientController) GradientController.updatePlayhead(t, !audioEl.paused);
}

function setVolume(val){
  const v = parseFloat(val);
  // FIX [8]: update both gainNode and audioEl.volume as fallback
  if(gainNode) gainNode.gain.value = v;
  if(audioEl)  audioEl.volume = Math.min(1, v);
}

function _setPlayState(playing){
  elPlayIco?.classList.toggle('hidden',  playing);
  elPauseIco?.classList.toggle('hidden', !playing);
}

function _setPlayBtnEnabled(enabled){
  if(!elPlayBtn) return;
  elPlayBtn.disabled = !enabled;
  elPlayBtn.style.opacity = enabled ? '1' : '0.45';
  elPlayBtn.style.cursor  = enabled ? 'pointer' : 'wait';
}

// ─────────────────────────────────────────────────────────
// SPACEBAR SYNC
// ─────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if(e.code !== 'Space') return;
  if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
  e.preventDefault();
  Ambient.syncBeat();
});

// ─────────────────────────────────────────────────────────
// VEIL HELPERS
// ─────────────────────────────────────────────────────────
function _showVeil(msg, noSpinner = false){
  const veil = document.getElementById('loading-veil');
  const ring = veil?.querySelector('.veil-ring');
  const txt  = document.getElementById('loading-msg');
  if(veil) veil.classList.remove('hidden');
  if(ring) ring.style.display = noSpinner ? 'none' : '';
  if(txt)  txt.textContent = msg || '';
}
function _hideVeil(){
  document.getElementById('loading-veil')?.classList.add('hidden');
  const ring = document.querySelector('.veil-ring');
  if(ring) ring.style.display = '';
}

// ─────────────────────────────────────────────────────────
// MISC HELPERS
// ─────────────────────────────────────────────────────────
function _val(id){ return (document.getElementById(id)?.value || '').trim(); }
function _fmt(sec){
  const s = Math.floor(sec), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}
function _setAuthErr(msg){
  const el = document.getElementById('auth-error');
  if(!el) return; el.textContent = msg; el.classList.remove('hidden');
}
function _clearAuthErr(){ document.getElementById('auth-error')?.classList.add('hidden'); }
function _setFormErr(msg){
  const el = document.getElementById('form-err');
  if(!el) return; el.textContent = msg; el.classList.remove('hidden');
}
function _clearFormErr(){ document.getElementById('form-err')?.classList.add('hidden'); }
function _setAnalysisStatus(msg){ if(elAnalysisStatus) elAnalysisStatus.textContent = msg; }