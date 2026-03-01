/**
 * app.js — OneSong Zen Mode
 * Responsibilities:
 *   1. Auth (signup / login / logout)
 *   2. Song CRUD (load, save, display)
 *   3. YouTube IFrame API player
 *   4. 250ms playhead poller → GradientController.updatePlayhead()
 *   5. Fetch /audio_analysis → GradientController.loadAudioData()
 *   6. Ambient.setSong() for palette on song load
 *
 * REMOVED: getRecommendations(), recommendation UI, rec-btn, rec-error
 */

const API = 'https://onesong.onrender.com';

// ── Global state ──────────────────────────────────────────────
let currentUser    = null;
let authToken      = null;
let hasSong        = false;
let currentSong    = null;
let serverReady    = false;
let ytPlayer       = null;
let playheadPoller = null;

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, color='#a78bfa', spin=false) {
  let el = document.getElementById('wake-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wake-toast';
    el.style.cssText = [
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%)',
      'background:#0d0d14;border:1px solid;color:#eeeae4',
      'padding:11px 18px;border-radius:10px',
      "font-family:'DM Sans',sans-serif;font-size:13px",
      'display:flex;align-items:center;gap:9px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.6);z-index:9999',
      'transition:opacity 0.35s;white-space:nowrap',
    ].join(';');
    document.body.appendChild(el);
  }
  el.style.borderColor = color;
  el.style.opacity = '1';
  el.innerHTML = spin
    ? `<span style="width:12px;height:12px;border:2px solid rgba(167,139,250,.2);border-top-color:${color};border-radius:50%;animation:_sp 0.8s linear infinite;flex-shrink:0;display:inline-block"></span><span>${msg}</span>`
    : `<span>${msg}</span>`;
  el.style.display = 'flex';

  // Inject spin keyframes once
  if (spin && !document.getElementById('_sp-style')) {
    const s = document.createElement('style');
    s.id = '_sp-style';
    s.textContent = '@keyframes _sp{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }
}

function hideToast() {
  const el = document.getElementById('wake-toast');
  if (el) { el.style.opacity = '0'; setTimeout(()=>el&&(el.style.display='none'), 350); }
}

// ── Server health ─────────────────────────────────────────────
async function pingServer() {
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(65000) });
    if (r.ok) {
      serverReady = true;
      showToast('✓ Ready', '#4ade80');
      setTimeout(hideToast, 1800);
      return true;
    }
  } catch {
    showToast('⚠ Server offline — refresh in 30s', '#e57373');
  }
  return false;
}

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Start GPGPU engine immediately — no user gesture needed for visuals
  Ambient.init();
  showToast('⏳ Starting up…', '#a78bfa', true);
  pingServer().then(() => checkAuth());
});

// ── Auth helpers ──────────────────────────────────────────────
function checkAuth() {
  authToken = localStorage.getItem('authToken');
  const s   = localStorage.getItem('currentUser');
  if (authToken && s) { currentUser = JSON.parse(s); verifyToken(); }
  else showAuth();
}

async function verifyToken() {
  try {
    const r = await fetch(`${API}/auth/verify`, { headers:{'Authorization':`Bearer ${authToken}`} });
    if (r.ok) { showApp(); loadUserSong(); }
    else logout();
  } catch { logout(); }
}

function showAuth() {
  document.getElementById('auth-container').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  Ambient.reset();
}

function showApp() {
  document.getElementById('auth-container').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  document.getElementById('username-display').textContent = currentUser.username;
}

function showSignup() {
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('signup-form').classList.remove('hidden');
  clearAuthErr();
}
function showLogin() {
  document.getElementById('signup-form').classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
  clearAuthErr();
}

function setAuthErr(m) { const e=document.getElementById('auth-error'); e.textContent=m; e.classList.remove('hidden'); }
function clearAuthErr()  { document.getElementById('auth-error').classList.add('hidden'); }
function setFormErr(m)   { const e=document.getElementById('song-form-error'); e.textContent=m; e.classList.remove('hidden'); }
function clearFormErr()  { document.getElementById('song-form-error').classList.add('hidden'); }
function showLoad()  { document.getElementById('loading').classList.remove('hidden'); }
function hideLoad()  { document.getElementById('loading').classList.add('hidden'); }

// ── Signup ────────────────────────────────────────────────────
async function signup() {
  const email=document.getElementById('signup-email').value.trim();
  const username=document.getElementById('signup-username').value.trim();
  const password=document.getElementById('signup-password').value;
  if (!email||!username||!password) { setAuthErr('Fill in all fields'); return; }
  if (password.length<6) { setAuthErr('Password must be at least 6 characters'); return; }
  showLoad(); clearAuthErr();
  try {
    const r=await fetch(`${API}/auth/signup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,username,password})});
    const d=await r.json();
    if (r.ok) { authToken=d.token; currentUser=d.user; _storeAuth(); showApp(); showSongSelection(); }
    else setAuthErr(d.detail||'Signup failed');
  } catch { setAuthErr('Cannot connect to server'); }
  finally { hideLoad(); }
}

// ── Login ─────────────────────────────────────────────────────
async function login() {
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  if (!email||!password) { setAuthErr('Fill in all fields'); return; }
  showLoad(); clearAuthErr();
  try {
    const r=await fetch(`${API}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if (r.ok) { authToken=d.token; currentUser=d.user; _storeAuth(); showApp(); loadUserSong(); }
    else setAuthErr(d.detail||'Login failed');
  } catch { setAuthErr('Cannot connect to server'); }
  finally { hideLoad(); }
}

function _storeAuth() {
  localStorage.setItem('authToken', authToken);
  localStorage.setItem('currentUser', JSON.stringify(currentUser));
}

// ── Logout ────────────────────────────────────────────────────
function logout() {
  authToken=null; currentUser=null; hasSong=false; currentSong=null;
  localStorage.removeItem('authToken'); localStorage.removeItem('currentUser');
  stopPoller();
  if (ytPlayer?.destroy) ytPlayer.destroy();
  ytPlayer=null;
  Ambient.reset();
  showAuth();
}

// ── Load song from backend ────────────────────────────────────
async function loadUserSong() {
  showLoad();
  try {
    const r=await fetch(`${API}/user/song`,{headers:{'Authorization':`Bearer ${authToken}`}});
    const d=await r.json();
    if (r.ok && d.has_song) { hasSong=true; currentSong=d.song; displaySong(d.song); }
    else { hasSong=false; showSongSelection(); }
  } catch { showSongSelection(); }
  finally { hideLoad(); }
}

// ── YouTube IFrame API ────────────────────────────────────────
function initYT(videoId) {
  if (!window.YT) {
    const tag=document.createElement('script');
    tag.src='https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady=()=>_createPlayer(videoId);
  } else {
    _createPlayer(videoId);
  }
}

function _createPlayer(videoId) {
  if (ytPlayer) { try { ytPlayer.destroy(); } catch(e){} ytPlayer=null; }
  document.getElementById('youtube-player').innerHTML='<div id="yt-frame"></div>';

  ytPlayer = new YT.Player('yt-frame', {
    height:'100%', width:'100%', videoId,
    playerVars:{rel:0, modestbranding:1, playsinline:1},
    events:{
      onReady:    ()=>startPoller(),
      onStateChange: _onYTState,
    },
  });
}

function _onYTState(e) {
  const S=YT.PlayerState;
  if      (e.data===S.PLAYING)  { GradientController.updatePlayhead(ytPlayer.getCurrentTime(),true);  Ambient.startBeat(); }
  else if (e.data===S.PAUSED)   { GradientController.updatePlayhead(ytPlayer.getCurrentTime(),false); Ambient.stopBeat();  }
  else if (e.data===S.BUFFERING){ GradientController.updatePlayhead(ytPlayer.getCurrentTime(),false); Ambient.stopBeat();  }
  else if (e.data===S.ENDED)    { GradientController.updatePlayhead(0,false); Ambient.stopBeat(); }
}

// ── 250ms playhead poller — master clock handshake ───────────
// Polls YT every 250ms and feeds GradientController.
// GradientController.frame() (called in ambient.js at 60fps) handles
// per-frame interpolation between these coarse polls.
function startPoller() {
  stopPoller();
  playheadPoller = setInterval(()=>{
    if (!ytPlayer || typeof ytPlayer.getCurrentTime!=='function') return;
    const t=ytPlayer.getCurrentTime();
    const playing=ytPlayer.getPlayerState()===YT.PlayerState.PLAYING;
    GradientController.updatePlayhead(t, playing);
  }, 250);
}

function stopPoller() {
  if (playheadPoller) { clearInterval(playheadPoller); playheadPoller=null; }
}

// ── Spacebar beat sync ────────────────────────────────────────
document.addEventListener('keydown', e=>{
  if (e.code==='Space' && hasSong && document.activeElement.tagName!=='INPUT') {
    e.preventDefault();
    Ambient.syncBeat();
    showToast('🥁 Beat!', '#c8a96e');
    setTimeout(hideToast, 900);
  }
});

// ── Display song (the core post-login view) ───────────────────
function displaySong(song) {
  document.getElementById('song-display').classList.remove('hidden');
  document.getElementById('song-selection').classList.add('hidden');

  document.getElementById('song-name').textContent   = song.song_name;
  document.getElementById('song-artist').textContent = song.artist_name;
  document.getElementById('sync-hint').classList.remove('hidden');

  // Boot YouTube player
  initYT(song.youtube_video_id);

  // Set ambient palette from mood tags
  Ambient.setSong(song.song_name, song.artist_name, authToken);

  // Attempt to load 60Hz audio analysis timeline
  // Falls back gracefully to synthetic data if yt-dlp/Essentia unavailable on backend
  _fetchAudioAnalysis(song);
}

async function _fetchAudioAnalysis(song) {
  try {
    const r = await fetch(
      `${API}/audio_analysis?track=${encodeURIComponent(song.song_name)}&artist=${encodeURIComponent(song.artist_name)}`,
      { headers:{'Authorization':`Bearer ${authToken}`} }
    );
    if (r.ok) {
      const data = await r.json();
      // Validate shape before handing off
      if (data && (data.beats || data.loudness)) {
        GradientController.loadAudioData(data);
        console.info(`[App] Audio analysis loaded: ${data.tempo?.toFixed(1)} BPM, ${data.beats?.length} beats`);
      }
    } else {
      console.info('[App] /audio_analysis not available — visuals running on YT playhead + fallback');
    }
  } catch (err) {
    console.info('[App] Audio analysis fetch error (non-fatal):', err.message);
  }
}

// ── Song selection form ───────────────────────────────────────
function showSongSelection() {
  document.getElementById('song-display').classList.add('hidden');
  document.getElementById('song-selection').classList.remove('hidden');
  ['input-song-name','input-artist-name','input-youtube-url'].forEach(id=>{
    document.getElementById(id).value='';
  });
  document.getElementById('cancel-btn').style.display = hasSong ? '' : 'none';
  clearFormErr();
}

function cancelSongSelection() {
  document.getElementById('song-selection').classList.add('hidden');
  document.getElementById('song-display').classList.remove('hidden');
}

async function saveSong() {
  const song_name   = document.getElementById('input-song-name').value.trim();
  const artist_name = document.getElementById('input-artist-name').value.trim();
  const youtube_url = document.getElementById('input-youtube-url').value.trim();

  if (!song_name||!artist_name||!youtube_url) { setFormErr('Fill in all three fields'); return; }
  if (!youtube_url.includes('youtube.com') && !youtube_url.includes('youtu.be')) {
    setFormErr('Please enter a valid YouTube URL'); return;
  }

  showLoad(); clearFormErr();
  try {
    const r=await fetch(`${API}/user/song`,{
      method:'PUT',
      headers:{'Authorization':`Bearer ${authToken}`,'Content-Type':'application/json'},
      body:JSON.stringify({song_name,artist_name,youtube_url}),
    });
    const d=await r.json();
    if (r.ok) { hasSong=true; currentSong=d.song; displaySong(d.song); }
    else setFormErr(d.detail||'Failed to save');
  } catch { setFormErr('Cannot connect to server'); }
  finally { hideLoad(); }
}